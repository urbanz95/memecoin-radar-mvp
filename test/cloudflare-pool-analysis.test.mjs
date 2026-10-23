import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, parseAbiParameters } from 'viem';
import { analysePool } from '../src/cloudflare/pool-analysis.mjs';
import { FreeRpc, hex } from '../src/cloudflare/rpc.mjs';
import { ERC20, V2, V3, V4, SWAPS } from '../src/onchain/abi.mjs';
import { QUOTE_ASSETS } from '../src/network.mjs';

const TOKEN = '0x8888888888888888888888888888888888888888';
const POOL = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x3333333333333333333333333333333333333333';
const STATE_VIEW = '0x4444444444444444444444444444444444444444';
const OTHER = '0x5555555555555555555555555555555555555555';
const ZERO = '0x' + '0'.repeat(40);
const hash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
const head = { number: 1000, hash: hash(1000), timestamp: 1800000000 };
const token = { decimals: 18, totalSupplyRaw: (1000000n * 10n ** 18n).toString(), symbol: '<unsafe-token>' };

function makePool(type = 'v2') {
  return { id: `${type}:${POOL}`, type, address: POOL, factory: FACTORY,
    token0: type === 'v2' ? QUOTE_ASSETS.USDG : QUOTE_ASSETS.WETH, token1: TOKEN,
    fee: 3000, createdBlock: 100, createdBlockHash: hash(100),
    stateView: STATE_VIEW, poolId: hash(5000), hooks: ZERO };
}

function swap(pool, side, raw, index = 0) {
  const event = SWAPS[pool.type];
  const indexed = pool.type === 'v2' ? { sender: OTHER, to: OTHER }
    : pool.type === 'v3' ? { sender: OTHER, recipient: OTHER } : { id: pool.poolId, sender: OTHER };
  const quoteFlow = side === 'buy' ? raw : -raw;
  const parameters = pool.type === 'v2' ? 'uint256,uint256,uint256,uint256'
    : pool.type === 'v3' ? 'int256,int256,uint160,uint128,int24'
      : 'int128,int128,uint160,uint128,int24,uint24';
  const values = pool.type === 'v2' ? (side === 'buy' ? [raw, 0n, 0n, 1n] : [0n, 1n, raw, 0n])
    : pool.type === 'v3' ? [quoteFlow, -quoteFlow, 2n ** 97n, 100n, 0]
      : [-quoteFlow, quoteFlow, 2n ** 97n, 100n, 0, 3000];
  return { address: pool.address, removed: false, topics: encodeEventTopics({ abi: [event], eventName: 'Swap', args: indexed }),
    data: encodeAbiParameters(parseAbiParameters(parameters), values), blockNumber: hex(995), blockHash: hash(995),
    transactionHash: hash(10000 + index), logIndex: hex(index) };
}

function fixture(pool = makePool(), options = {}) {
  const requests = [];
  const rpc = new FreeRpc({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); const calls = Array.isArray(body) ? body : [body];
    requests.push(calls);
    const results = calls.map(call => {
      let result;
      if (call.method === 'eth_getLogs') result = options.logs ?? [];
      else {
        assert.equal(call.method, 'eth_call');
        assert.equal(call.params[1], hex(head.number), 'Every state read must be pinned to the observed block');
        const to = call.params[0].to.toLowerCase();
        const abi = to === pool.address ? (pool.type === 'v2' ? V2 : V3)
          : to === pool.factory ? (pool.type === 'v2' ? V2 : V3)
            : to === pool.stateView ? V4 : ERC20;
        const { functionName } = decodeFunctionData({ abi, data: call.params[0].data });
        if (options.errorFunction === functionName) return { jsonrpc: '2.0', id: call.id,
          error: { code: -32000, message: 'private-rpc-key must not reach the analysis' } };
        const values = {
          factory: options.factory ?? pool.factory, token0: pool.token0, token1: pool.token1,
          getPair: options.indexed ?? pool.address, getPool: options.indexed ?? pool.address,
          getReserves: options.reserves ?? [200000000n, 100n * 10n ** 18n, 100],
          fee: pool.fee,
          slot0: [2n ** 97n, 0, 0, 0, 0, 0, true],
          getSlot0: [2n ** 97n, 0, 0, 3000],
          liquidity: options.liquidity ?? 1000000n,
          getLiquidity: options.liquidity ?? 1000000n,
          balanceOf: to === pool.token0 ? 40n * 10n ** 18n : 160n * 10n ** 18n,
          decimals: options.quoteDecimals ?? (pool.type === 'v2' ? 6 : 18),
        };
        result = encodeFunctionResult({ abi, functionName, result: values[functionName] });
      }
      return { jsonrpc: '2.0', id: call.id, result };
    });
    // Exercise the real FreeRpc envelope mapper, not a fake positional RPC API.
    return new Response(JSON.stringify(Array.isArray(body) ? results.reverse() : results[0]));
  } });
  rpc.requests = options.initialRequests ?? 0;
  return { rpc, requests };
}

test('v2 verifies identity despite reordered batches and reads USDG units without assuming USD parity', async () => {
  const pool = makePool(); const f = fixture(pool, { logs: [swap(pool, 'buy', 10000000n), swap(pool, 'sell', 4000000n, 1)] });
  const result = await analysePool(f.rpc, pool, head, token);
  assert.equal(result.identityVerified, true); assert.equal(result.activeLiquidity, true);
  assert.deepEqual(result.priceInQuote, { value: '2', quoteAsset: 'USDG' });
  assert.equal(result.poolState.reserve0, '200000000'); assert.equal(result.poolState.quoteDecimals, 6);
  assert.deepEqual(f.requests.map(calls => calls.length), [5, 1, 1]);
  assert.ok(f.requests.every(calls => calls.length <= 8));
  assert.equal(result.activity.buyQuote, '10'); assert.equal(result.activity.sellQuote, '4');
  assert.equal(result.activity.volumeQuote, '14'); assert.equal(result.activity.transactionCount, 2);
  assert.equal(result.activity.fromBlock, 489); assert.equal(result.activity.toBlock, 1000);
  assert.equal(result.activity.fromTimestamp, null);
  assert.ok(result.gaps.includes('USD_CONVERSION_UNAVAILABLE'));
  assert.equal(result.liquidityUsd, undefined); assert.equal(result.approved, undefined);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('v3 confirms the indexed pool, fee and balances with at most two state batches', async () => {
  const pool = makePool('v3'); const f = fixture(pool, { logs: [swap(pool, 'buy', 10n * 10n ** 18n), swap(pool, 'sell', 4n * 10n ** 18n, 1)] });
  const result = await analysePool(f.rpc, pool, head, token);
  assert.equal(result.identityVerified, true); assert.equal(result.activeLiquidity, true);
  assert.deepEqual(result.priceInQuote, { value: '0.25', quoteAsset: 'WETH' });
  assert.equal(result.poolState.token0BalanceRaw, (40n * 10n ** 18n).toString());
  assert.equal(result.poolState.token1BalanceRaw, (160n * 10n ** 18n).toString());
  assert.deepEqual(f.requests.map(calls => calls.length), [7, 3, 1]);
  assert.equal(result.activity.buyQuote, '10'); assert.equal(result.activity.sellQuote, '4');
  assert.ok(result.gaps.includes('CLMM_BALANCES_ARE_NOT_EXECUTABLE_DEPTH'));
  assert.equal(result.poolState.liquidityUsd, undefined);
});

test('v4 inverts BalanceDelta signs and reports unreviewed hooks without claiming DEX approval', async () => {
  const pool = { ...makePool('v4'), hooks: OTHER }; const f = fixture(pool, {
    logs: [swap(pool, 'buy', 10n * 10n ** 18n), swap(pool, 'sell', 4n * 10n ** 18n, 1)],
  });
  const result = await analysePool(f.rpc, pool, head, token);
  assert.equal(result.identityVerified, null); assert.equal(result.activeLiquidity, true);
  assert.ok(result.risks.some(item => item.code === 'UNREVIEWED_HOOKS'));
  assert.equal(result.activity.buyQuote, '10'); assert.equal(result.activity.sellQuote, '4');
  assert.deepEqual(f.requests.map(calls => calls.length), [3, 1]);
  assert.equal(result.dexVerified, undefined);
  const filter = f.requests.at(-1)[0].params[0];
  assert.equal(filter.topics[1], pool.poolId, 'Shared v4 manager events must be filtered by pool ID');
});

test('native ETH v4 uses 18 decimals without ERC20 calls to zero and preserves quote identity and safety gaps', async () => {
  const pool = { ...makePool('v4'), token0: ZERO, hooks: OTHER };
  const f = fixture(pool, { logs: [swap(pool, 'buy', 10n * 10n ** 18n), swap(pool, 'sell', 4n * 10n ** 18n, 1)] });
  const result = await analysePool(f.rpc, pool, head, token);
  assert.deepEqual(f.requests.map(calls => calls.length), [2, 1]);
  assert.ok(f.requests.flat().every(call => call.method !== 'eth_call' || call.params[0].to !== ZERO));
  assert.equal(result.poolState.quoteDecimals, 18);
  assert.deepEqual(result.priceInQuote, { value: '0.25', quoteAsset: 'ETH' });
  assert.equal(result.activity.quoteAsset, 'ETH');
  assert.equal(result.activity.buyQuote, '10'); assert.equal(result.activity.sellQuote, '4');
  assert.equal(result.activity.volumeQuote, '14');
  assert.equal(result.identityVerified, null); assert.equal(result.activeLiquidity, true);
  assert.ok(result.risks.some(item => item.code === 'UNREVIEWED_HOOKS'));
  assert.ok(result.gaps.includes('V4_POOL_IDENTITY_NOT_FULLY_VERIFIED'));
  assert.ok(result.gaps.includes('USD_CONVERSION_UNAVAILABLE'));
  assert.ok(!result.gaps.includes('QUOTE_DECIMALS_UNAVAILABLE'));
  assert.equal(result.liquidityUsd, undefined); assert.equal(result.dexVerified, undefined); assert.equal(result.approved, undefined);
});

test('zero currency is not treated as an ERC20 quote outside v4 or as a token paired with another quote', async () => {
  for (const pool of [
    { ...makePool('v2'), token0: ZERO },
    { ...makePool('v3'), token0: ZERO },
    { ...makePool('v4'), token0: ZERO, token1: QUOTE_ASSETS.WETH },
  ]) {
    const f = fixture(pool);
    const result = await analysePool(f.rpc, pool, head, token);
    assert.ok(result.gaps.includes('SUPPORTED_QUOTE_UNAVAILABLE'));
    assert.equal(f.requests.length, 0); assert.equal(result.priceInQuote, undefined);
  }
});

test('factory mismatch is a known risk and prevents using prices or swaps as verified observations', async () => {
  const f = fixture(makePool(), { factory: OTHER });
  const result = await analysePool(f.rpc, makePool(), head, token);
  assert.equal(result.identityVerified, false);
  assert.ok(result.risks.some(item => item.code === 'POOL_IDENTITY_MISMATCH'));
  assert.equal(result.priceInQuote, undefined); assert.equal(result.activity, undefined);
  assert.equal(f.requests.length, 1);
});

test('factory index must independently recognize the expected pool', async () => {
  const f = fixture(makePool(), { indexed: ZERO });
  const result = await analysePool(f.rpc, makePool(), head, token);
  assert.equal(result.identityVerified, false); assert.equal(f.requests.length, 2);
  assert.ok(result.checks.some(item => item.metric === 'pool.factoryIndex' && item.passed === false));
});

test('empty reserves and zero CLMM liquidity are explicit risks rather than missing data or approval', async () => {
  for (const type of ['v2', 'v3', 'v4']) {
    const pool = makePool(type); const f = fixture(pool, { reserves: [0n, 100n, 100], liquidity: 0n });
    const result = await analysePool(f.rpc, pool, head, token);
    assert.equal(result.activeLiquidity, false);
    assert.ok(result.risks.some(item => item.code === 'EMPTY_LIQUIDITY'));
    assert.equal(result.approved, undefined);
  }
});

test('an unavailable contract read remains unknown and never exposes raw provider errors', async () => {
  const f = fixture(makePool(), { errorFunction: 'factory' });
  const result = await analysePool(f.rpc, makePool(), head, token);
  assert.equal(result.identityVerified, null);
  assert.ok(result.gaps.includes('POOL_READ_UNAVAILABLE:factory'));
  assert.ok(!JSON.stringify(result).includes('private-rpc-key'));
  assert.ok(!result.risks.some(item => item.code === 'POOL_IDENTITY_MISMATCH'));
});

test('pool analysis respects an absolute request ceiling and preserves two final caller requests', async () => {
  const pool = makePool('v3'); const f = fixture(pool, { initialRequests: 27 });
  await analysePool(f.rpc, pool, head, token, { maxRequests: 30 });
  assert.equal(f.rpc.requests, 30); assert.equal(f.requests.length, 3);
  const nearLimit = fixture(pool, { initialRequests: 29 });
  const unknown = await analysePool(nearLimit.rpc, pool, head, token);
  assert.equal(nearLimit.rpc.requests, 30); assert.equal(unknown.identityVerified, null);
  assert.equal(unknown.activity, undefined);
  assert.ok(unknown.gaps.includes('ACTIVITY_RPC_BUDGET_DEFERRED'));
  const exhausted = fixture(pool, { initialRequests: 30 });
  assert.equal((await analysePool(exhausted.rpc, pool, head, token)).identityVerified, null);
  assert.equal(exhausted.requests.length, 0);
});

test('invalid quote decimals do not create a price or formatted monetary totals', async () => {
  const pool = makePool(); const f = fixture(pool, { quoteDecimals: 37, logs: [swap(pool, 'buy', 123n)] });
  const result = await analysePool(f.rpc, pool, head, token);
  assert.equal(result.priceInQuote, undefined); assert.equal(result.poolState.quoteDecimals, null);
  assert.equal(result.activity.buyQuoteRaw, '123'); assert.equal(result.activity.buyQuote, undefined);
});

test('activity deduplicates block/transaction/log IDs and counts transactions rather than unique traders', async () => {
  const pool = makePool(); const first = swap(pool, 'buy', 1000000n); const second = { ...swap(pool, 'buy', 2000000n, 1), transactionHash: first.transactionHash };
  const f = fixture(pool, { logs: [first, first, second] });
  const result = await analysePool(f.rpc, pool, head, token);
  assert.equal(result.activity.swaps, 2); assert.equal(result.activity.transactionCount, 1);
  assert.equal(result.activity.buyQuote, '3');
  assert.equal(result.activity.uniqueTraders, undefined); assert.equal(result.activity.organicTraderPct, undefined);
});

test('activity refuses invalid identity, topic, canonical hashes or block range without publishing zero volume', async () => {
  const pool = makePool(); const original = swap(pool, 'buy', 100n);
  for (const changes of [{ address: OTHER }, { topics: [hash(2)] }, { blockHash: '0x' + '0'.repeat(64) },
    { transactionHash: 'not-a-hash' }, { blockNumber: hex(488) }, { blockNumber: hex(head.number) },
    { removed: true }, { logIndex: 'bad' }]) {
    const f = fixture(pool, { logs: [{ ...original, ...changes }] });
    const result = await analysePool(f.rpc, pool, head, token);
    assert.equal(result.activity, undefined);
    assert.ok(result.gaps.includes('ACTIVITY_UNAVAILABLE_OR_INVALID'));
  }
});

test('activity rejects mixed forks or one transaction attributed to inconsistent blocks', async () => {
  const pool = makePool(); const first = swap(pool, 'buy', 1n);
  for (const second of [
    { ...swap(pool, 'sell', 1n, 1), blockHash: hash(996) },
    { ...swap(pool, 'sell', 1n, 1), blockNumber: hex(996), blockHash: hash(996), transactionHash: first.transactionHash },
    { ...swap(pool, 'sell', 1n, 1), logIndex: first.logIndex },
  ]) {
    const f = fixture(pool, { logs: [first, second] });
    const result = await analysePool(f.rpc, pool, head, token);
    assert.equal(result.activity, undefined);
    assert.ok(result.gaps.includes('ACTIVITY_UNAVAILABLE_OR_INVALID'));
  }
});

test('a dense activity sample is marked incomplete instead of truncating or claiming full-window totals', async () => {
  const pool = makePool(); const f = fixture(pool, { logs: Array.from({ length: 65 }, (_, i) => swap(pool, 'buy', 1n, i)) });
  const result = await analysePool(f.rpc, pool, head, token);
  assert.equal(result.activity.complete, false);
  assert.equal(result.activity.reason, 'ACTIVITY_LOG_LIMIT_EXCEEDED');
  assert.equal(result.activity.volumeQuoteRaw, undefined); assert.equal(f.requests.length, 3);
});
