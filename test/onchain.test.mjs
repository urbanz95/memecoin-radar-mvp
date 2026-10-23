import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeAbiParameters, parseAbiParameters, encodeEventTopics, decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { RpcClient, RpcError, hex } from '../src/onchain/rpc.mjs';
import { EVENTS, SWAPS, ERC20, V2, V3, V4, EIP1967, topic } from '../src/onchain/abi.mjs';
import { decodePool, discover } from '../src/onchain/discovery.mjs';
import { deploymentEvidence } from '../src/onchain/reader.mjs';
import { quotePrice, swapQuoteFlow, poolActivity } from '../src/onchain/pools.mjs';
import { collectOnce, selectTargets, validateCollectorConfig } from '../src/onchain/collect.mjs';
import { QUOTE_ASSETS } from '../src/network.mjs';

const TOKEN = '0x1111111111111111111111111111111111111111';
const POOL = '0x3333333333333333333333333333333333333333';
const SENDER = '0x4444444444444444444444444444444444444444';
const FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
const TX = '0x' + 'ab'.repeat(32);
const blockHash = (n) => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
const config = JSON.parse(await readFile(new URL('../config/collector.json', import.meta.url)));
const policy = JSON.parse(await readFile(new URL('../config/policies.json', import.meta.url)));
const response = (body, status = 200) => ({ ok: status === 200, status, body: { cancel: async () => {} }, text: async () => JSON.stringify(body) });

test('RPC recusa testnet e métodos de escrita antes de os enviar', async () => {
  let called = 0;
  const rpc = new RpcClient({ retries: 0, fetchImpl: async (_url, options) => {
    called++; const body = JSON.parse(options.body); return response({ jsonrpc: '2.0', id: body.id, result: '0xb626' });
  } });
  await assert.rejects(rpc.assertMainnet(), /mainnet/);
  await assert.rejects(rpc.request('eth_sendRawTransaction', ['0xab']), /leitura/);
  await assert.rejects(rpc.request('eth_sendTransaction', [{}]), /leitura/);
  assert.equal(called, 1);
});

test('RPC valida envelope e não inclui URL/segredos nos erros ou evidência', async () => {
  const secret = 'private-key-in-rpc-url';
  const rpc = new RpcClient({ url: `https://example.invalid/${secret}`, retries: 0,
    fetchImpl: async (url) => { throw new Error(`Falhou em ${url}`); } });
  await assert.rejects(rpc.assertMainnet(), (error) => !error.message.includes(secret));
  assert.ok(!JSON.stringify(rpc.audit).includes(secret));
  const invalid = new RpcClient({ retries: 0, fetchImpl: async () => response({ jsonrpc: '2.0', id: 999, result: '0x1237' }) });
  await assert.rejects(invalid.assertMainnet(), /INVALID_ENVELOPE/);
});

test('RPC faz retry limitado após 429 e divide intervalos de logs recusados', async () => {
  let attempts = 0;
  const rpc = new RpcClient({ retries: 1, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (++attempts === 1) return response({}, 429);
    return response({ jsonrpc: '2.0', id: body.id, result: '0x1237' });
  } });
  assert.equal(await rpc.assertMainnet(), 4663);
  assert.equal(attempts, 2);
  const ranges = [];
  const logs = new RpcClient({ retries: 0, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); const filter = body.params[0];
    ranges.push([Number(BigInt(filter.fromBlock)), Number(BigInt(filter.toBlock))]);
    return response({ jsonrpc: '2.0', id: body.id, ...(ranges.at(-1)[1] - ranges.at(-1)[0] > 1
      ? { error: { code: -32005, message: 'range limit exceeded' } } : { result: [] }) });
  } });
  assert.deepEqual(await logs.logs(FACTORY, [topic(EVENTS.v2)], 0, 3), []);
  assert.deepEqual(ranges, [[0, 3], [0, 1], [2, 3]]);
});

function creationLog(number = 10) {
  return { address: FACTORY, topics: encodeEventTopics({ abi: [EVENTS.v2], eventName: 'PairCreated', args: { token0: TOKEN, token1: QUOTE_ASSETS.USDG } }),
    data: encodeAbiParameters(parseAbiParameters('address, uint256'), [POOL, 1n]),
    blockNumber: hex(number), blockHash: blockHash(number), transactionHash: TX, logIndex: '0x0', removed: false };
}

test('RPC não aceita logs removidos, fora do intervalo ou de outra factory', async () => {
  for (const mutate of [(l) => { l.removed = true; }, (l) => { l.blockNumber = '0x99'; }, (l) => { l.address = TOKEN; }]) {
    const log = creationLog(); mutate(log);
    const rpc = new RpcClient({ retries: 0, fetchImpl: async (_url, options) => response({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: [log] }) });
    await assert.rejects(rpc.logs(FACTORY, [topic(EVENTS.v2)], 0, 20));
  }
});

test('eventos de criação são descodificados e IDs v4 falsos são recusados', () => {
  const pool = decodePool(creationLog(), config.venues[0]);
  assert.equal(pool.address, POOL); assert.equal(pool.token0, TOKEN); assert.equal(pool.createdBlock, 10);
  const key = [TOKEN, QUOTE_ASSETS.USDG, 3000, 60, '0x' + '0'.repeat(40)];
  const id = keccak256(encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), key));
  const log = { ...creationLog(), address: config.venues[2].address,
    topics: encodeEventTopics({ abi: [EVENTS.v4], eventName: 'Initialize', args: { id, currency0: TOKEN, currency1: QUOTE_ASSETS.USDG } }),
    data: encodeAbiParameters(parseAbiParameters('uint24, int24, address, uint160, int24'), [3000, 60, key[4], 2n ** 96n, 0]) };
  assert.equal(decodePool(log, config.venues[2]).poolId, id);
  log.topics[1] = '0x' + 'ff'.repeat(32);
  assert.throws(() => decodePool(log, config.venues[2]), /Pool ID/);
});

test('preços em quote respeitam decimals e orientação sem inventar USD', () => {
  const pool = { type: 'v2', token0: TOKEN, token1: QUOTE_ASSETS.USDG };
  const price = quotePrice(pool, { reserve0: (100n * 10n ** 18n).toString(), reserve1: (200n * 10n ** 6n).toString() }, 18, 6);
  assert.equal(price.value, '2');
  const inverse = { type: 'v3', token0: QUOTE_ASSETS.WETH, token1: TOKEN };
  assert.equal(quotePrice(inverse, { sqrtPriceX96: (2n ** 97n).toString() }, 18, 18).value, '0.25');
  assert.equal(quotePrice(pool, { reserve0: '0', reserve1: '0' }, 18, 6), null);
});

function swapLog(type, number = 200) {
  const id = '0x' + '11'.repeat(32);
  const args = type === 'v3' ? { sender: SENDER, recipient: SENDER } : { id, sender: SENDER };
  const data = type === 'v3'
    ? encodeAbiParameters(parseAbiParameters('int256,int256,uint160,uint128,int24'), [-5n, 10n, 2n ** 96n, 100n, 0])
    : encodeAbiParameters(parseAbiParameters('int128,int128,uint160,uint128,int24,uint24'), [5n, -10n, 2n ** 96n, 100n, 0, 3000]);
  return { ...creationLog(number), topics: encodeEventTopics({ abi: [SWAPS[type]], eventName: 'Swap', args }), data,
    transactionHash: blockHash(number + 1000) };
}

test('a direção dos fluxos v3 e v4 é interpretada segundo a convenção de cada versão', () => {
  for (const type of ['v3', 'v4']) {
    const pool = { type, token0: TOKEN, token1: QUOTE_ASSETS.USDG, poolId: '0x' + '11'.repeat(32) };
    assert.deepEqual(swapQuoteFlow(swapLog(type), pool), { buyQuoteRaw: 10n, sellQuoteRaw: 0n });
  }
});

test('janelas de 5m contíguas não se sobrepõem e cap de swaps não produz volume completo', async () => {
  const pool = { type: 'v3', address: POOL, token0: TOKEN, token1: QUOTE_ASSETS.USDG, createdBlock: 0 };
  const logs = [99, 100, 199, 200].map((n) => swapLog('v3', n));
  const rpc = { logs: async () => logs };
  const result = await poolActivity(rpc, pool, { number: 500 }, { '24h': 0, '1h': 50, '10m': 100, '5m': 200 }, 0, config);
  assert.equal(result.windows['5m'].volumeQuoteRaw, '10');
  assert.equal(result.windows.previous5m.volumeQuoteRaw, '20');
  assert.equal(result.windows['1h'].volumeQuoteRaw, '40');
  assert.equal(result.windows['1h'].transactionCount, 4);
  assert.equal(result.windows['1h'].uniqueTraders, undefined);
  assert.equal((await poolActivity(rpc, pool, { number: 500 }, { '24h': 0 }, 0, { ...config, maxSwapsPerPool: 2 })).complete, false);
});

function archiveRpc({ direct = false, fail = false } = {}) {
  return {
    request: async (method, params) => {
      if (fail) throw new RpcError(method, -32000);
      if (method === 'eth_getCode') return Number(BigInt(params[1])) >= 5 ? '0x6000' : '0x';
      if (method === 'eth_getTransactionReceipt') return { contractAddress: TOKEN, status: '0x1', blockHash: blockHash(5) };
      throw new Error('unexpected');
    },
    block: async (n) => ({ number: n, timestamp: 1000 + n, hash: blockHash(n), transactions: [{ hash: TX, to: direct ? null : FACTORY, from: SENDER }] }),
  };
}

test('fronteira de bytecode não é tratada como data de deployment sem recibo de criação', async () => {
  const boundary = await deploymentEvidence(archiveRpc(), TOKEN, { number: 10 });
  assert.equal(boundary.status, 'historical-code-boundary-only');
  assert.equal(boundary.contractCreatedAt, undefined);
  const direct = await deploymentEvidence(archiveRpc({ direct: true }), TOKEN, { number: 10 });
  assert.equal(direct.status, 'proven-direct-creation-receipt');
  assert.equal(direct.contractCreatedAt, new Date(1005 * 1000).toISOString());
  assert.equal((await deploymentEvidence(archiveRpc({ fail: true }), TOKEN, { number: 10 })).contractCreatedAt, undefined);
});

test('prova de CREATE2 exige trace bem sucedido, hash do código e recibo canónico', async () => {
  const code = '0x6000';
  const rpc = { block: async () => ({ number: 5, hash: blockHash(5), timestamp: 1005 }), request: async (method) => {
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x5', blockHash: blockHash(5), contractAddress: null };
    if (method === 'debug_traceTransaction') return { type: 'CALL', calls: [{ type: 'CREATE2', to: TOKEN, from: FACTORY, output: code }] };
    throw new RpcError(method, -32000);
  } };
  const good = await deploymentEvidence(rpc, TOKEN, { number: 10 }, { candidateCreations: [TX], codeHash: keccak256(code) });
  assert.equal(good.status, 'proven-create-call-trace-and-bytecode');
  assert.equal((await deploymentEvidence(rpc, TOKEN, { number: 10 }, { candidateCreations: [TX], codeHash: keccak256('0x6001') })).contractCreatedAt, undefined);
});

test('amostras históricas não são declaradas como um backfill completo e falha não avança o cursor', async () => {
  const small = { ...config, venues: [config.venues[0]], chunkSize: 10, maxRecentChunksPerVenue: 1, backfillChunksPerVenue: 1, historicalSampleChunksPerVenue: 1 };
  const rpc = { findBlockAtOrAfter: async (time) => time < 0 ? 0 : 90,
    request: async () => '0x6000', logs: async () => [], block: async (n) => ({ hash: blockHash(n) }) };
  const head = { number: 100, timestamp: 10000000, hash: blockHash(100) };
  const first = await discover(rpc, head, small);
  const key = `v2:${FACTORY}`;
  assert.equal(first.venues[key].fullHistoryComplete, false);
  assert.ok(first.venues[key].ranges.some((r) => r.kind === 'historical-sample-not-exhaustive'));
  rpc.logs = async () => { throw new RpcError('eth_getLogs', -32005); };
  const next = await discover(rpc, head, small, first);
  assert.equal(next.venues[key].lastScanned, first.venues[key].lastScanned);
  assert.equal(next.venues[key].backfillCursor, first.venues[key].backfillCursor);
  assert.ok(next.venues[key].error);
});

test('seleção reserva lugares para contratos recentes e roda os restantes pelo menos observado', () => {
  const catalog = [100, 90, 20, 10].map((n) => ({ type: 'v2', token0: '0x' + n.toString(16).padStart(40, '0'), token1: QUOTE_ASSETS.USDG, createdBlock: n }));
  const first = selectTargets(catalog, {}, 2);
  assert.equal(first.selected.length, 2);
  assert.equal(first.selected[0].pools[0].createdBlock, 100);
  assert.equal(first.selected[1].pools[0].createdBlock, 10);
  const next = selectTargets(catalog, { [first.selected[1].address]: { lastEnrichedAtMs: 10 } }, 2);
  assert.equal(next.selected[1].pools[0].createdBlock, 20);
});

test('configuração do collector valida rede, orçamento e limites', () => {
  validateCollectorConfig(config);
  for (const mutate of [(c) => { c.chainId = 46630; }, (c) => { c.maxRpcRequests = -1; }, (c) => { c.chunkSize = 0; }, (c) => { c.venues = []; }]) {
    const invalid = structuredClone(config); mutate(invalid); assert.throws(() => validateCollectorConfig(invalid));
  }
});

test('slots de proxy correspondem exatamente ao standard EIP-1967', () => {
  for (const [name, value] of Object.entries(EIP1967)) {
    const expected = '0x' + (BigInt(keccak256(toHex(`eip1967.proxy.${name}`))) - 1n).toString(16).padStart(64, '0');
    assert.equal(value, expected);
  }
});

test('reorganização do checkpoint invalida o catálogo e não mantém proofs da branch anterior', async () => {
  const previous = { checkpoint: { number: 10, hash: blockHash(10) }, catalog: [{ id: 'old-branch-pool', factory: FACTORY }], venues: {} };
  const rpc = { findBlockAtOrAfter: async () => 90, block: async () => ({ hash: blockHash(999) }),
    request: async () => '0x6000', logs: async () => [] };
  const result = await discover(rpc, { number: 100, timestamp: 10000000, hash: blockHash(100) }, {
    ...config, venues: [config.venues[0]], historicalSampleChunksPerVenue: 0, backfillChunksPerVenue: 0 }, previous);
  assert.equal(result.reorgDetected, true);
  assert.deepEqual(result.catalog, []);
});

test('recolha inteira alimenta os pipelines sem inventar segurança, USD ou aprovação', async () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const headTimestamp = now / 1000;
  const abi = [...ERC20, ...V2, ...V3, ...V4];
  let latestCalls = 0;
  const rpc = { id: 0, audit: [], requestCount: 0,
    assertMainnet: async () => 4663,
    findBlockAtOrAfter: async (time) => Math.max(0, 1000 - Math.floor((headTimestamp - time) / 60)),
    block: async (number = 'latest') => {
      const n = number === 'latest' ? 1000 + latestCalls++ : number;
      return { number: n, timestamp: headTimestamp - (1000 - n) * 60, hash: blockHash(n),
        transactions: n === 5 ? [{ hash: TX, to: null, from: SENDER }] : [] };
    },
    logs: async (_address, topics, from, to) => topics[0] === topic(EVENTS.v2) && from <= 10 && to >= 10 ? [creationLog()] : [],
    request: async (method, params) => {
      rpc.id++; rpc.requestCount++;
      if (method === 'eth_getCode') return Number(BigInt(params[1])) >= 5 ? '0x6000' : '0x';
      if (method === 'eth_getStorageAt') return '0x' + '0'.repeat(64);
      if (method === 'eth_getTransactionReceipt') return { contractAddress: TOKEN, status: '0x1', blockHash: blockHash(5), blockNumber: '0x5' };
      if (method === 'eth_getBlockByNumber') return { hash: blockHash(Number(BigInt(params[0]))) };
      if (method === 'eth_call') {
        const { functionName } = decodeFunctionData({ abi, data: params[0].data });
        const values = { symbol: 'RPC_TEST', decimals: params[0].to === TOKEN ? 18 : 6, totalSupply: 1000000000000000000000n,
          owner: '0x' + '0'.repeat(40), paused: false, factory: FACTORY, token0: TOKEN, token1: QUOTE_ASSETS.USDG,
          getPair: POOL, getReserves: [100n * 10n ** 18n, 200n * 10n ** 6n, 0] };
        return encodeFunctionResult({ abi, functionName, result: values[functionName] });
      }
      throw new RpcError(method, 'UNEXPECTED_TEST_METHOD');
    },
  };
  const collected = await collectOnce({ config: { ...config, venues: [config.venues[0]], backfillChunksPerVenue: 0,
    historicalSampleChunksPerVenue: 0, recentHours: 48 }, policy, rpc, now: () => now + 1000 });
  assert.equal(collected.payload.snapshots.length, 1);
  const snapshot = collected.payload.snapshots[0];
  assert.equal(snapshot.synthetic, false);
  assert.ok(snapshot.contractCreatedAt);
  assert.equal(snapshot.security.hasBytecode, true);
  assert.equal(snapshot.security.canMint, undefined);
  assert.equal(snapshot.security.canPause, undefined); // paused=false não prova ausência da capacidade.
  assert.equal(snapshot.security.contractVerified, undefined);
  assert.equal(snapshot.market.liquidityUsd, undefined);
  assert.equal(snapshot.activity.volume5mUsd, undefined);
  assert.equal(collected.payload.operationalStatus, 'PARTIAL');
  assert.equal(collected.payload.alerts.length, 0);
  assert.ok(collected.payload.results.every((r) => r.status !== 'CANDIDATE'));
  assert.equal(collected.evidence.market[0].pools[0].priceInQuote.value, '2');
});
