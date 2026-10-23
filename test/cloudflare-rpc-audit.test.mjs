import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters } from 'viem';
import { FreeRpc, hex, MAX_AUDIT_BYTES } from '../src/cloudflare/rpc.mjs';
import { boundedLogs } from '../src/cloudflare/collector.mjs';
import { ageEvidence } from '../src/cloudflare/age-evidence.mjs';
import { EVENTS } from '../src/onchain/abi.mjs';
import { QUOTE_ASSETS } from '../src/network.mjs';

const TOKEN = '0x1111111111111111111111111111111111111111';
const DEPLOYER = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
const hash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytecode = '0x' + '60'.repeat(24 * 1024);

function transport(resolve) {
  const exchanges = [];
  const rpc = new FreeRpc({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); const calls = Array.isArray(body) ? body : [body];
    const values = await Promise.all(calls.map(call => resolve(call.method, call.params)));
    const results = calls.map((call, index) => ({ jsonrpc: '2.0', id: call.id, result: values[index] }));
    const response = Array.isArray(body) ? results.reverse() : results[0];
    exchanges.push({ calls, values, bytes: jsonBytes(response) });
    assert.ok(jsonBytes(response) <= 262144, 'Fixture responses must satisfy the independent transport limit');
    return Response.json(response);
  } });
  return { rpc, exchanges };
}

test('block and receipt audit retains every field used by proofs while callers receive full arrays', async () => {
  const header = { number: '0x64', timestamp: '0x1234', hash: hash(100) };
  const block = { ...header, transactions: Array.from({ length: 1500 }, (_, index) => hash(index)),
    extraData: '0x' + 'ab'.repeat(1000), logsBloom: '0x' + 'ff'.repeat(256) };
  const fields = { status: '0x1', contractAddress: TOKEN, transactionHash: hash(200), from: DEPLOYER, to: null,
    blockNumber: header.number, blockHash: header.hash, transactionIndex: '0x2' };
  const receipt = { ...fields, logs: Array.from({ length: 50 }, (_, index) => ({ data: '0x' + 'aa'.repeat(500), logIndex: hex(index) })),
    logsBloom: '0x' + 'ff'.repeat(256), cumulativeGasUsed: '0xffff' };
  const f = transport(method => method === 'eth_getBlockByNumber' ? block : receipt);
  const values = await f.rpc.batch([['eth_getBlockByNumber', ['0x64', false]], ['eth_getTransactionReceipt', [fields.transactionHash]]]);
  assert.deepEqual(values[0].value, block); assert.deepEqual(values[1].value, receipt);
  assert.equal(values[0].value.transactions.length, 1500); assert.equal(values[1].value.logs.length, 50);
  assert.deepEqual(f.rpc.audit[0].result, header); assert.deepEqual(f.rpc.audit[1].result, fields);
  assert.equal(Object.hasOwn(f.rpc.audit[1].result, 'to'), true);
  assert.equal(f.rpc.audit[1].result.to, null);
  assert.ok(jsonBytes(f.rpc.audit) < 2048);
  const absent = transport(() => ({ number: '0x1', hash: hash(1) }));
  await absent.rpc.request('eth_getBlockByNumber', ['0x1', false]);
  assert.equal(Object.hasOwn(absent.rpc.audit[0].result, 'timestamp'), false, 'Projection must not invent missing proof fields');
});

test('four historical 24 KiB bytecodes remain intact for callers and retain matching hashes and lengths', async () => {
  const f = transport((_method, params) => params[1] === '0x0' ? '0x' : params[1] === '0x1' ? 'invalid-hex' : bytecode);
  const blocks = [100, 1000, 2000, 3000];
  const calls = blocks.map(block => ['eth_getCode', [TOKEN, hex(block)]]);
  const values = await f.rpc.batch([...calls, ['eth_getCode', [TOKEN, '0x0']], ['eth_getCode', [TOKEN, '0x1']]]);
  for (let i = 0; i < blocks.length; i++) {
    assert.equal(values[i].value, bytecode);
    assert.deepEqual(f.rpc.audit[i].params, calls[i][1]);
    assert.equal(f.rpc.audit[i].result.codeHash, keccak256(bytecode));
    assert.equal(f.rpc.audit[i].result.bytecodeBytes, 24576);
    assert.equal(f.rpc.audit[i].result.hasBytecode, true);
    assert.equal(f.rpc.audit[i].result.validHex, true);
    assert.equal(f.rpc.audit[i].result.rawRetained, false);
  }
  assert.equal(values[4].value, '0x'); assert.equal(f.rpc.audit[4].result.hasBytecode, false);
  assert.equal(f.rpc.audit[4].result.bytecodeBytes, 0); assert.equal(f.rpc.audit[4].result.codeHash, keccak256('0x'));
  assert.equal(values[5].value, 'invalid-hex'); assert.equal(f.rpc.audit[5].result.validHex, false);
  assert.equal(f.rpc.audit[5].result.hasBytecode, null); assert.equal(f.rpc.audit[5].result.codeHash, null);
  assert.ok(!JSON.stringify(f.rpc.audit).includes(bytecode));
  assert.ok(jsonBytes(f.rpc.audit) < MAX_AUDIT_BYTES);
});

test('dense discovery ranges shrink using original logs while audit records complete-response digests and counts', async () => {
  const logs = Array.from({ length: 80 }, (_, index) => {
    const block = index * 6;
    const token = '0x' + (BigInt(TOKEN) + BigInt(index)).toString(16).padStart(40, '0');
    const pool = '0x' + (BigInt(DEPLOYER) + BigInt(index)).toString(16).padStart(40, '0');
    return { address: FACTORY, removed: false, blockNumber: hex(block), blockHash: hash(block),
      transactionHash: hash(100000 + index), logIndex: hex(index),
      topics: encodeEventTopics({ abi: [EVENTS.v2], eventName: 'PairCreated', args: { token0: QUOTE_ASSETS.WETH, token1: token } }),
      data: encodeAbiParameters(parseAbiParameters('address,uint256'), [pool, BigInt(index + 1)]) };
  });
  const f = transport((_method, [filter]) => logs.filter(log => BigInt(log.blockNumber) >= BigInt(filter.fromBlock)
    && BigInt(log.blockNumber) <= BigInt(filter.toBlock)));
  const result = await boundedLogs(f.rpc, 0, 511, 4);
  assert.ok(result.to < 511); assert.ok(result.pools.length > 0 && result.pools.length <= 4);
  assert.ok(f.rpc.requests > 1);
  const projected = f.rpc.audit[0].result;
  assert.equal(projected.logCount, 80); assert.equal(projected.sha256, sha256(logs));
  assert.equal(projected.jsonBytes, jsonBytes(logs)); assert.equal(projected.rawRetained, false);
  assert.equal(Array.isArray(projected), false, 'A digest must not impersonate a truncated raw response');
  for (let i = 0; i < f.exchanges.length; i++) {
    const original = f.exchanges[i].values[0]; const retained = f.rpc.audit[i].result;
    if (retained.rawRetained === false) {
      assert.equal(retained.sha256, sha256(original)); assert.equal(retained.logCount, original.length);
    } else assert.deepEqual(retained, original);
  }
  const raw = await f.rpc.request('eth_getLogs', [{ fromBlock: '0x0', toBlock: hex(511) }]);
  assert.deepEqual(raw, logs); assert.ok(jsonBytes(f.rpc.audit) <= MAX_AUDIT_BYTES);
});

test('32 batches of eight calls retain all IDs within the audit bound despite huge params and projected values', async () => {
  const hugeData = '0x' + 'ab'.repeat(12000);
  const largeHeader = { number: '0x1', hash: hash(1), timestamp: 'f'.repeat(10000) };
  const rawCall = '0x' + '12'.repeat(600);
  const f = transport(method => method === 'eth_getBlockByNumber' ? largeHeader : rawCall);
  const calls = Array.from({ length: 8 }, (_, index) => index % 2 === 0
    ? ['eth_getBlockByNumber', ['0x1', false]]
    : ['eth_call', [{ to: TOKEN, data: hugeData }, 'latest']]);
  for (let batch = 0; batch < 32; batch++) {
    const values = await f.rpc.batch(calls);
    assert.deepEqual(values[0].value, largeHeader); assert.equal(values[1].value, rawCall);
    assert.equal(f.rpc.audit.length, (batch + 1) * 8, 'Compaction must not silently drop prior calls');
    assert.ok(jsonBytes(f.rpc.audit) <= MAX_AUDIT_BYTES, `Audit overflow after batch ${batch + 1}`);
    if (batch === 0) {
      assert.equal(f.rpc.audit[1].params.rawRetained, false);
      assert.equal(f.rpc.audit[1].params.sha256, sha256(calls[1][1]));
      assert.equal(f.rpc.audit[1].result.sha256, sha256(rawCall));
    }
  }
  assert.equal(f.rpc.requests, 32);
  assert.equal(new Set(f.rpc.audit.map(entry => entry.id)).size, 256);
  assert.ok(f.rpc.audit.every(entry => entry.method === 'eth_call' || entry.method === 'eth_getBlockByNumber'));
  assert.ok(f.rpc.audit.some(entry => entry.method === 'eth_getBlockByNumber' && entry.result.rawRetained === false),
    'The fixture must exercise aggregate compaction, not just per-record projection');
});

test('real FreeRpc projection preserves age-window and direct-receipt proofs with cumulative oversized RPC evidence', async () => {
  const head = { number: 10000000, timestamp: 1792671000, hash: hash(10000000) };
  const missingSource = async () => Response.json({}, { status: 404 });
  for (const exact of [false, true]) {
    const poolAge = exact ? 1200 : 600;
    const created = { number: head.number - poolAge, timestamp: head.timestamp - poolAge, hash: hash(head.number - poolAge) };
    const tx = hash(20000000);
    const pool = { createdBlock: created.number, createdBlockHash: created.hash, ...(exact ? { creationTransactionHash: tx } : {}) };
    const f = transport((method, params) => {
      if (method === 'eth_getBlockByNumber') {
        const number = Number(BigInt(params[0]));
        return { number: hex(number), timestamp: hex(head.timestamp - (head.number - number)), hash: hash(number),
          transactions: Array.from({ length: 512 }, (_, index) => hash(index)) };
      }
      if (method === 'eth_getCode') return Number(BigInt(params[1])) >= head.number - 1200 ? bytecode : '0x';
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', contractAddress: TOKEN, transactionHash: tx,
        from: DEPLOYER, to: null, blockNumber: hex(created.number), blockHash: created.hash, transactionIndex: '0x1',
        logs: Array.from({ length: 20 }, () => ({ data: '0x' + 'aa'.repeat(500) })) };
      throw new Error('Unexpected proof method');
    });
    const result = await ageEvidence(f.rpc, TOKEN, pool, head, created, { fetchImpl: missingSource, now: () => head.timestamp * 1000 });
    assert.equal(result.classification, 'new');
    if (exact) {
      assert.equal(result.basis, 'direct-creation-receipt');
      assert.equal(result.contractCreatedAt, new Date(created.timestamp * 1000).toISOString());
      assert.equal(result.deployer, DEPLOYER);
    } else {
      assert.equal(result.basis, 'code-existence-bounds'); assert.equal(result.contractCreatedAt, undefined);
      assert.ok(result.lowerBoundMinutes >= 15 && result.upperBoundMinutes <= 48 * 60);
    }
    assert.ok(result.evidence.every(entry => entry.blockHash && Number.isSafeInteger(entry.blockNumber)));
    assert.ok(f.exchanges.reduce((sum, exchange) => sum + exchange.bytes, 0) > 262144,
      'This regression fixture must exceed the former cumulative evidence budget');
    assert.ok(jsonBytes(f.rpc.audit) <= MAX_AUDIT_BYTES);
    assert.ok(jsonBytes({ rpc: f.rpc.audit, tokenFacts: result.evidence }) < 262144);
    assert.ok(f.rpc.requests <= 4);
  }
});
