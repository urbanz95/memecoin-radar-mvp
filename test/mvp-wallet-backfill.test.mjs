import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import { prepareWalletBackfillStep } from '../src/mvp/wallet-backfill.mjs';
import { prepareWalletLedger } from '../src/mvp/wallet-ledger.mjs';
import { prepareReceiptEvidence } from '../src/mvp/wallet-evidence.mjs';
import { normalizeHistoryWindow } from '../src/mvp/wallet-history-window.mjs';
import { SWAPS } from '../src/onchain/abi.mjs';
import { setup, TOKEN, time } from './helpers/mvp-sqlite.mjs';

const walletSchema = await readFile(new URL('../cloudflare/migrations/0004_mvp_wallets.sql', import.meta.url), 'utf8');
const schema = await readFile(new URL('../cloudflare/migrations/0013_mvp_wallet_backfill.sql', import.meta.url), 'utf8');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const wallet = TOKEN(10);
const hash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
const hex = n => '0x' + BigInt(n).toString(16);
const word = address => '0x' + address.slice(2).padStart(64, '0');
const head = { number: 100, hash: hash(100), timestamp: time / 1000 };
const block = number => ({ number: hex(number), hash: hash(number),
  timestamp: hex(head.timestamp - (head.number - number) * 86400) });
function transfer(index, changes = {}) {
  const number = 75 + index % 20;
  return { address: TOKEN(1 + index % 3), blockNumber: hex(number), blockHash: hash(number),
    transactionHash: hash(500 + index), logIndex: hex(index), removed: false,
    topics: [TRANSFER, word(wallet), word(TOKEN(11))], data: hex(index + 1).slice(2).padStart(64, '0').replace(/^/, '0x'), ...changes };
}
function database(t) { const DB = setup(t); DB.sqlite.exec(walletSchema); DB.sqlite.exec(schema); return DB; }
const count = (DB, table) => DB.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const jobs = DB => DB.sqlite.prepare('SELECT * FROM mvp_wallet_backfill_jobs ORDER BY job_id').all();
function rpcFixture(logs = [], options = {}) {
  const calls = [];
  const rpc = { requests: options.requests ?? 0, calls,
    async request(method, params = []) {
      this.requests++; calls.push([method, params]);
      if (options.fail?.(method, params, calls.length)) throw new Error('RPC_TRANSPORT_FAILED');
      if (method === 'eth_getBlockByNumber') return options.block?.(Number(BigInt(params[0]))) ?? block(Number(BigInt(params[0])));
      if (method === 'eth_getLogs') {
        const filter = params[0];
        assert.equal(Object.hasOwn(filter, 'address'), false, 'wallet backfill must discover transfers across all contracts');
        assert.equal(filter.topics[0].toLowerCase(), TRANSFER);
        assert.ok(filter.topics[1] === word(wallet) || filter.topics[2] === word(wallet));
        const from = Number(BigInt(filter.fromBlock)); const to = Number(BigInt(filter.toBlock));
        return logs.filter(log => Number(BigInt(log.blockNumber)) >= from && Number(BigInt(log.blockNumber)) <= to
          && filter.topics.every((value, index) => value === null || value === undefined || value.toLowerCase() === log.topics[index]?.toLowerCase()));
      }
      if (method === 'eth_getTransactionReceipt') {
        const log = logs.find(item => item.transactionHash === params[0]);
        if (!log) return null;
        return { transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash,
          status: '0x1', from: wallet, to: TOKEN(99), gasUsed: '0x5208', effectiveGasPrice: '0x1',
          logs: logs.filter(item => item.transactionHash === log.transactionHash), ...options.receipt?.(log) };
      }
      throw new Error('UNEXPECTED_RPC_METHOD:' + method);
    },
    async batch(batch) {
      // Production batch() counts the HTTP envelope; tests retain each logical
      // call as well so the backfill's stricter four-call bound is observable.
      const before = this.requests;
      const result = [];
      for (const [method, params] of batch) {
        try { result.push({ value: await this.request(method, params) }); }
        catch { result.push({ error: -32000 }); }
      }
      this.requests = before + 1;
      return result;
    } };
  return rpc;
}
async function prepare(DB, rpc, iteration = 0, changes = {}) {
  const before = rpc.calls.length;
  const result = await prepareWalletBackfillStep(DB, rpc, { runId: `backfill-${iteration}`, observedAt: time + iteration * 120000,
    head, walletAddress: wallet, maxStepRequests: 4, maxRequests: 30, chunkBlocks: 2048,
    maxLogs: 32, maxEvents: 16, maxReceipts: 1, ...changes });
  assert.ok(rpc.calls.length - before <= 4, 'each step must stay within four logical RPC calls');
  assert.ok(result.events.length <= 16, 'each step must stay within sixteen ledger events');
  assert.ok(result.receipts.length <= 1, 'each step must stay within one receipt');
  for (const window of result.historyWindows) {
    assert.equal(window.complete, false);
    assert.equal(window.openingBalanceKnown, false);
    assert.ok(normalizeHistoryWindow(window, { now: time + Math.max(iteration, 1) * 120000 + 10 * 86400000 }));
  }
  return result;
}
async function commit(DB, result, iteration) {
  prepareReceiptEvidence(result.receipts, { now: time + iteration * 120000 });
  const ledger = prepareWalletLedger(DB, { runId: `backfill-${iteration}`, observedAt: time + iteration * 120000,
    events: result.events, receipts: result.receipts });
  await DB.batch([...result.commands, ...ledger.commands]);
}
async function runSteps(DB, logs, { until, limit = 80, rpcOptions, ...options } = {}) {
  const results = []; const calls = [];
  for (let i = 0; i < limit; i++) {
    const rpc = rpcFixture(logs, rpcOptions);
    const result = await prepare(DB, rpc, i, options);
    await commit(DB, result, i); results.push(result); calls.push(...rpc.calls);
    if (until?.(result, i, calls)) break;
  }
  return { results, calls };
}

test('backfill migration is additive and repeatable', t => {
  const DB = database(t);
  DB.sqlite.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('before-backfill', time, 100, '{}', '{}');
  DB.sqlite.exec(schema);
  assert.equal(count(DB, 'runs'), 1);
  for (const table of ['mvp_wallet_backfill_jobs', 'mvp_wallet_backfill_pages', 'mvp_wallet_backfill_receipt_queue', 'mvp_wallet_backfill_unresolved_receipts'])
    assert.equal(count(DB, table), 0);
});

test('preparation never writes and a rejected collector fence rolls all progress back', async t => {
  const DB = database(t); const result = await prepare(DB, rpcFixture());
  assert.equal(jobs(DB).length, 0);
  assert.ok(result.commands.length > 0);
  await assert.rejects(DB.batch([...result.commands, DB.prepare('INSERT OR REPLACE INTO commit_fence(id,ok) VALUES(1,0)')]), /CHECK constraint/);
  assert.equal(jobs(DB).length, 0);
  assert.equal(count(DB, 'mvp_wallet_backfill_pages'), 0);
  await DB.batch(result.commands);
  assert.equal(jobs(DB).length, 1);
});

test('restart keeps the original thirty day anchor and resolves the first block at its boundary', async t => {
  const DB = database(t); const first = await prepare(DB, rpcFixture()); await commit(DB, first, 0);
  const laterHead = { number: 105, hash: hash(105), timestamp: head.timestamp + 5 * 86400 };
  const windows = [...first.historyWindows];
  for (let i = 1; i < 30; i++) {
    const result = await prepare(DB, rpcFixture(), i, { head: laterHead, observedAt: time + 5 * 86400000 + i * 120000 });
    await DB.batch(result.commands); windows.push(...result.historyWindows);
    if (windows.some(window => window.fromBlock !== null)) break;
  }
  assert.ok(windows.length > 0);
  for (const window of windows) {
    assert.equal(window.startAt, new Date(time - 30 * 86400000).toISOString());
    assert.equal(window.endAt, new Date(time).toISOString());
    assert.equal(window.toBlock, 100); assert.equal(window.toBlockHash, hash(100));
  }
  const resolved = windows.find(window => window.fromBlock !== null);
  assert.ok(resolved, 'binary search should eventually resolve the boundary across fresh invocations');
  assert.equal(resolved.fromBlock, 70); assert.equal(resolved.fromBlockHash, hash(70));
  assert.equal(jobs(DB).length, 1);
});

test('concurrent prepared cursors cannot overwrite committed progress', async t => {
  const DB = database(t);
  await DB.batch((await prepare(DB, rpcFixture())).commands);
  const left = await prepare(DB, rpcFixture(), 1);
  const right = await prepare(DB, rpcFixture(), 2);
  await DB.batch(left.commands);
  const before = jobs(DB);
  await assert.rejects(DB.batch(right.commands));
  assert.deepEqual(jobs(DB), before);
});

test('RPC failure persists retry progress without pretending the transfer scan completed', async t => {
  const DB = database(t);
  const result = await prepare(DB, rpcFixture([], { fail: () => true }));
  assert.equal(result.events.length, 0); assert.equal(result.receipts.length, 0);
  assert.ok(result.diagnostics.length > 0);
  await DB.batch(result.commands);
  const [job] = jobs(DB);
  assert.ok(job.attempts >= 1); assert.ok(job.next_attempt_at > time); assert.ok(job.last_reason);
  assert.notEqual(job.state, 'COMPLETE');
  const before = jobs(DB);
  const nextRpc = rpcFixture();
  const deferred = await prepare(DB, nextRpc, 0);
  await DB.batch(deferred.commands);
  assert.equal(nextRpc.calls.length, 0);
  assert.deepEqual(jobs(DB), before);
});

test('exhausted shared RPC budget defers safely without network calls', async t => {
  const DB = database(t); const rpc = rpcFixture([], { requests: 30 });
  const result = await prepare(DB, rpc);
  assert.equal(rpc.calls.length, 0); assert.equal(result.events.length, 0);
  assert.ok(result.diagnostics.length > 0);
});

test('a slightly future collector head defers backfill before database or RPC work', async () => {
  const DB = { prepare() { throw Error('FUTURE_HEAD_MUST_NOT_READ_DATABASE'); } };
  const rpc = { requests: 0, request() { throw Error('FUTURE_HEAD_MUST_NOT_CALL_RPC'); } };
  const result = await prepareWalletBackfillStep(DB, rpc, { runId: 'future-head', observedAt: time,
    head: { ...head, timestamp: head.timestamp + 10 }, walletAddress: wallet });
  assert.deepEqual(result.commands, []); assert.deepEqual(result.events, []);
  assert.deepEqual(result.receipts, []); assert.deepEqual(result.historyWindows, []);
  assert.deepEqual(result.diagnostics, ['WALLET_BACKFILL_FUTURE_HEAD_DEFERRED']);
});

test('durable transfer pages drain past the event cap without losing from/to duplicate logs', async t => {
  const DB = database(t);
  const logs = Array.from({ length: 20 }, (_, index) => transfer(index, { topics: [TRANSFER, word(wallet), word(wallet)] }));
  const { calls } = await runSteps(DB, logs, { until: (_result, _i, seen) => count(DB, 'mvp_wallet_events') === logs.length
    && seen.filter(([method]) => method === 'eth_getLogs').some(([, [filter]]) => filter.topics[2] === word(wallet)) });
  assert.equal(count(DB, 'mvp_wallet_events'), logs.length);
  const values = DB.sqlite.prepare('SELECT event_json FROM mvp_wallet_events').all().map(row => JSON.parse(row.event_json));
  assert.deepEqual(new Set(values.map(event => event.transactionHash)), new Set(logs.map(log => log.transactionHash)));
  assert.ok(calls.some(([method, [filter]]) => method === 'eth_getLogs' && filter.topics[1] === word(wallet)));
  assert.ok(calls.some(([method, [filter]]) => method === 'eth_getLogs' && filter.topics[2] === word(wallet)));
  assert.ok(count(DB, 'mvp_wallet_backfill_pages') > 0);
});

test('oversized log ranges split and retain every transfer instead of truncating to maxLogs', async t => {
  const DB = database(t); const logs = Array.from({ length: 40 }, (_, index) => transfer(index));
  const { calls } = await runSteps(DB, logs, { until: () => count(DB, 'mvp_wallet_events') === logs.length });
  assert.equal(count(DB, 'mvp_wallet_events'), logs.length);
  const ranges = calls.filter(([method]) => method === 'eth_getLogs').map(([, [filter]]) => [Number(BigInt(filter.fromBlock)), Number(BigInt(filter.toBlock))]);
  assert.ok(ranges.length > 1);
  assert.ok(ranges.some(([from, to]) => to - from < 30));
});

test('canonical receipt decodes catalog swaps with exact identity and unknown quote decimals', async t => {
  const DB = database(t); const log = transfer(0);
  const pool = { id: `v2:${TOKEN(25)}`, type: 'v2', address: TOKEN(25), token0: TOKEN(1), token1: TOKEN(8), createdBlock: 10 };
  DB.sqlite.prepare('INSERT INTO pools(id,address,created_block,pool_json) VALUES(?,?,?,?)')
    .run(pool.id, pool.address, pool.createdBlock, JSON.stringify(pool));
  const swap = { ...log, address: pool.address, logIndex: '0x20',
    topics: encodeEventTopics({ abi: [SWAPS.v2], eventName: 'Swap', args: { sender: wallet, to: wallet } }),
    data: encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256'), [0n, 100n, 50n, 0n]) };
  const { results } = await runSteps(DB, [log], { targetForPool: value => value.id === pool.id
    ? { targetAddress: TOKEN(1), quoteAddress: TOKEN(8), quoteDecimals: null } : null,
  rpcOptions: { receipt: () => ({ logs: [log, swap] }) }, until: result => result.receipts.length === 1 });
  const values = results.flatMap(result => result.receipts);
  assert.equal(values.length, 1);
  const [captured] = values;
  assert.equal(captured.receipt.transactionHash, log.transactionHash);
  assert.equal(captured.events.length, 1); assert.equal(captured.events[0].kind, 'SWAP');
  assert.equal(captured.events[0].address, pool.address); assert.equal(captured.events[0].tokenAddress, TOKEN(1));
  assert.equal(captured.events[0].pool.quoteDecimals, null);
  assert.equal(captured.events[0].args.amount1In, '100');
  assert.equal(count(DB, 'mvp_wallet_receipts'), 1);
});

test('transactions without a matching catalog swap retain unresolved receipt evidence', async t => {
  const DB = database(t); const log = transfer(0);
  const { results } = await runSteps(DB, [log], { until: () => count(DB, 'mvp_wallet_backfill_unresolved_receipts') > 0 });
  assert.ok(count(DB, 'mvp_wallet_backfill_unresolved_receipts') > 0);
  const row = DB.sqlite.prepare('SELECT * FROM mvp_wallet_backfill_unresolved_receipts LIMIT 1').get();
  assert.equal(row.transaction_hash, log.transactionHash); assert.equal(row.block_hash, log.blockHash);
  assert.ok(row.reason); assert.ok(row.evidence_json.includes(log.transactionHash));
  assert.equal(results.flatMap(result => result.events).filter(event => event.kind === 'SWAP').length, 0);
  for (const captured of results.flatMap(result => result.receipts)) assert.deepEqual(captured.events, []);
});

test('v4 manager address alone cannot match a different catalog pool ID', async t => {
  const DB = database(t); const log = transfer(0);
  const poolId = hash(700); const unknownId = hash(701);
  const pool = { id: `v4:${poolId}`, type: 'v4', address: TOKEN(25), poolId,
    token0: TOKEN(1), token1: TOKEN(8), createdBlock: 10 };
  DB.sqlite.prepare('INSERT INTO pools(id,address,created_block,pool_json) VALUES(?,?,?,?)')
    .run(pool.id, pool.address, pool.createdBlock, JSON.stringify(pool));
  const swap = { ...log, address: pool.address, logIndex: '0x20',
    topics: encodeEventTopics({ abi: [SWAPS.v4], eventName: 'Swap', args: { id: unknownId, sender: wallet } }),
    data: encodeAbiParameters(parseAbiParameters('int128, int128, uint160, uint128, int24, uint24'), [50n, -100n, 1n, 1n, 0, 3000]) };
  const { results } = await runSteps(DB, [log], { targetForPool: () => ({ targetAddress: TOKEN(1), quoteAddress: TOKEN(8), quoteDecimals: 18 }),
    rpcOptions: { receipt: () => ({ logs: [log, swap] }) },
    until: () => count(DB, 'mvp_wallet_backfill_unresolved_receipts') > 0 });
  assert.equal(results.flatMap(result => result.events).filter(event => event.kind === 'SWAP').length, 0);
  for (const captured of results.flatMap(result => result.receipts)) assert.deepEqual(captured.events, []);
  assert.ok(count(DB, 'mvp_wallet_backfill_unresolved_receipts') > 0);
});

test('dense single block responses larger than maxLogs drain every durable page', async t => {
  const DB = database(t);
  const logs = Array.from({ length: 40 }, (_, index) => transfer(index, { blockNumber: '0x50', blockHash: hash(80) }));
  const { calls } = await runSteps(DB, logs, { until: () => count(DB, 'mvp_wallet_events') === logs.length });
  assert.equal(count(DB, 'mvp_wallet_events'), logs.length);
  assert.ok(calls.some(([method, [filter]]) => method === 'eth_getLogs' && filter.fromBlock === '0x50' && filter.toBlock === '0x50'));
  const rows = DB.sqlite.prepare('SELECT logs_json,cursor,log_count FROM mvp_wallet_backfill_pages').all();
  assert.ok(rows.length >= 2, 'the dense block must retain multiple bounded pages');
  assert.equal(rows.reduce((sum, row) => sum + row.cursor, 0), logs.length);
  assert.ok(rows.every(row => row.log_count <= 32));
});

test('anchor and resolved boundary reorgs suppress emissions and invalidate scan coverage', async t => {
  for (const changedNumber of [100, 70]) {
    await t.test(`changed block ${changedNumber}`, async st => {
      const DB = database(st);
      await runSteps(DB, [], { until: result => result.historyWindows.some(window => window.fromBlock !== null) });
      const before = count(DB, 'mvp_wallet_events');
      const rpc = rpcFixture([transfer(0)], { block: number => number === changedNumber
        ? { ...block(number), hash: hash(900 + number) } : block(number) });
      const result = await prepare(DB, rpc, 40);
      assert.equal(result.events.length, 0); assert.equal(result.receipts.length, 0);
      assert.ok(result.historyWindows.every(window => window.canonical === false && window.scanComplete === false));
      await DB.batch(result.commands);
      assert.equal(jobs(DB).at(-1).state, 'REORG');
      assert.equal(count(DB, 'mvp_wallet_events'), before);
    });
  }
});

test('receipt with more than sixteen known swaps resumes its event cursor without dropping logs', async t => {
  const DB = database(t); const log = transfer(0, { blockNumber: '0x50', blockHash: hash(80) });
  const pool = { id: `v2:${TOKEN(25)}`, type: 'v2', address: TOKEN(25), token0: TOKEN(1), token1: TOKEN(8), createdBlock: 10 };
  DB.sqlite.prepare('INSERT INTO pools(id,address,created_block,pool_json) VALUES(?,?,?,?)')
    .run(pool.id, pool.address, pool.createdBlock, JSON.stringify(pool));
  const swaps = Array.from({ length: 20 }, (_, index) => ({ ...log, address: pool.address, logIndex: hex(100 + index),
    topics: encodeEventTopics({ abi: [SWAPS.v2], eventName: 'Swap', args: { sender: wallet, to: wallet } }),
    data: encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256'), [0n, BigInt(index + 1), 50n, 0n]) }));
  const { results } = await runSteps(DB, [log], { targetForPool: () => ({ targetAddress: TOKEN(1), quoteAddress: TOKEN(8), quoteDecimals: null }),
    rpcOptions: { receipt: () => ({ logs: [log, ...swaps] }) }, until: result => result.receipts.length === 1 });
  const emitted = results.flatMap(result => result.events).filter(event => event.kind === 'SWAP');
  assert.equal(emitted.length, swaps.length);
  assert.equal(new Set(emitted.map(event => event.logIndex)).size, swaps.length);
  assert.equal(count(DB, 'mvp_wallet_events'), swaps.length + 1);
  const captured = results.flatMap(result => result.receipts);
  assert.equal(captured.length, 1); assert.equal(captured[0].events.length, swaps.length);
  assert.equal(count(DB, 'mvp_wallet_receipts'), 1);
  const queue = DB.sqlite.prepare('SELECT state,event_cursor FROM mvp_wallet_backfill_receipt_queue').get();
  assert.equal(queue.state, 'COMPLETE'); assert.equal(queue.event_cursor, swaps.length);
});

test('replaying identical prepared commands is idempotent', async t => {
  const DB = database(t); const result = await prepare(DB, rpcFixture([transfer(0)]));
  await DB.batch(result.commands);
  const before = jobs(DB);
  await DB.batch(result.commands);
  assert.deepEqual(jobs(DB), before);
  assert.equal(jobs(DB).length, 1);
});

test('a changed wallet epoch rejects stale prepared cursor commands', async t => {
  const DB = database(t);
  await DB.batch((await prepare(DB, rpcFixture())).commands);
  const stale = await prepare(DB, rpcFixture(), 1);
  await DB.batch(prepareWalletLedger(DB, { runId: 'reorg-generation', observedAt: time + 120000, reorgDetected: true }).commands);
  assert.equal(DB.sqlite.prepare('SELECT generation FROM mvp_wallet_epoch').get().generation, 1);
  const before = jobs(DB);
  await assert.rejects(DB.batch(stale.commands));
  assert.deepEqual(jobs(DB), before);
});

test('receipt read on the final RPC slot persists raw bytes and resumes its header without refetching', async t => {
  const DB = database(t); const log = transfer(0);
  let receiptCalls = 0; let capturedRaw = false;
  for (let i = 0; i < 50; i++) {
    const rpc = rpcFixture([log]);
    const result = await prepare(DB, rpc, i, { maxStepRequests: 3 });
    assert.ok(rpc.calls.length <= 3);
    receiptCalls += rpc.calls.filter(([method]) => method === 'eth_getTransactionReceipt').length;
    await commit(DB, result, i);
    if (receiptCalls > 0) {
      const row = DB.sqlite.prepare('SELECT state,receipt_json FROM mvp_wallet_backfill_receipt_queue').get();
      const captured = JSON.parse(row.receipt_json);
      assert.equal(row.state, 'CAPTURED');
      assert.equal(captured.receipt.transactionHash, log.transactionHash); assert.equal(captured.block, null);
      assert.equal(result.receipts.length, 0);
      capturedRaw = true;
      break;
    }
  }
  assert.equal(capturedRaw, true, 'a final-slot receipt must be durable before its header can be fetched');
  let completed = false;
  for (let i = 50; i < 60; i++) {
    const rpc = rpcFixture([log]); const result = await prepare(DB, rpc, i);
    receiptCalls += rpc.calls.filter(([method]) => method === 'eth_getTransactionReceipt').length;
    await commit(DB, result, i);
    if (result.receipts.length) { completed = true; break; }
  }
  assert.equal(completed, true); assert.equal(receiptCalls, 1);
  assert.equal(count(DB, 'mvp_wallet_receipts'), 1);
});

test('oversized known swap evidence remains unresolved without aborting the collector ledger batch', async t => {
  const DB = database(t); const log = transfer(0);
  const pool = { id: `v2:${TOKEN(25)}`, type: 'v2', address: TOKEN(25), token0: TOKEN(1), token1: TOKEN(8), createdBlock: 10 };
  DB.sqlite.prepare('INSERT INTO pools(id,address,created_block,pool_json) VALUES(?,?,?,?)')
    .run(pool.id, pool.address, pool.createdBlock, JSON.stringify(pool));
  // viem accepts trailing ABI data in strict mode. The ledger still requires
  // each fully decoded event, including its pool, to fit within sixteen KiB.
  const swap = { ...log, address: pool.address, logIndex: '0x20',
    topics: encodeEventTopics({ abi: [SWAPS.v2], eventName: 'Swap', args: { sender: wallet, to: wallet } }),
    data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), [0n, 100n, 50n, 0n]) + '00'.repeat(10000) };
  const { results } = await runSteps(DB, [log], { targetForPool: () => ({ targetAddress: TOKEN(1), quoteAddress: TOKEN(8), quoteDecimals: 18 }),
    rpcOptions: { receipt: () => ({ logs: [log, swap] }) },
    until: result => result.diagnostics.includes('WALLET_BACKFILL_EVENT_EVIDENCE_LIMIT') });
  assert.ok(results.some(result => result.diagnostics.includes('WALLET_BACKFILL_EVENT_EVIDENCE_LIMIT')));
  assert.equal(results.flatMap(result => result.events).filter(event => event.kind === 'SWAP').length, 0);
  assert.equal(results.flatMap(result => result.receipts).length, 0);
  assert.equal(count(DB, 'mvp_wallet_events'), 1, 'normal transfer ingestion still commits');
  assert.equal(DB.sqlite.prepare('SELECT state FROM mvp_wallet_backfill_receipt_queue').get().state, 'RETRY');
  const row = DB.sqlite.prepare('SELECT * FROM mvp_wallet_backfill_unresolved_receipts WHERE reason=?')
    .get('WALLET_BACKFILL_EVENT_EVIDENCE_LIMIT');
  assert.ok(row); assert.ok(Buffer.byteLength(row.evidence_json) <= 131072);
});

test('oversized raw and deferred receipts retain one bounded digest across retries', async t => {
  for (const maxStepRequests of [3, 4]) await t.test(`receipt budget ${maxStepRequests}`, async st => {
    const DB = database(st); const log = transfer(0);
    const rpcOptions = { receipt: () => ({ oversizedProviderField: 'x'.repeat(150000) }) };
    const { results } = await runSteps(DB, [log], { maxStepRequests, rpcOptions,
      until: result => result.diagnostics.includes('WALLET_BACKFILL_RECEIPT_EVIDENCE_LIMIT') });
    assert.ok(results.some(result => result.diagnostics.includes('WALLET_BACKFILL_RECEIPT_EVIDENCE_LIMIT')));
    let rows = DB.sqlite.prepare('SELECT * FROM mvp_wallet_backfill_unresolved_receipts WHERE reason=?')
      .all('WALLET_BACKFILL_RECEIPT_EVIDENCE_LIMIT');
    assert.equal(rows.length, 1);
    const first = rows[0]; const proof = JSON.parse(first.evidence_json);
    assert.equal(proof.evidenceFormat, 'json-sha256-v1'); assert.equal(proof.rawRetained, false);
    assert.equal(proof.reason, 'WALLET_BACKFILL_RAW_EVIDENCE_LIMIT'); assert.ok(proof.jsonBytes > 131072);
    assert.equal(proof.sha256, first.evidence_hash); assert.ok(Buffer.byteLength(first.evidence_json) <= 131072);
    const original = JSON.stringify({ receipt: await rpcFixture([log], rpcOptions)
      .request('eth_getTransactionReceipt', [log.transactionHash]), source: 'canonical-erc20-wallet-backfill/v1' });
    assert.equal(proof.sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(proof.jsonBytes, Buffer.byteLength(original));
    const queue = DB.sqlite.prepare('SELECT * FROM mvp_wallet_backfill_receipt_queue').get();
    assert.equal(queue.state, 'RETRY'); assert.equal(queue.receipt_json, null);
    const beforeAttempts = queue.attempts;
    for (let i = 100; i < 103; i++) {
      const rpc = rpcFixture([log], rpcOptions); const result = await prepare(DB, rpc, i);
      await commit(DB, result, i);
    }
    rows = DB.sqlite.prepare('SELECT * FROM mvp_wallet_backfill_unresolved_receipts WHERE reason=?')
      .all('WALLET_BACKFILL_RECEIPT_EVIDENCE_LIMIT');
    assert.equal(rows.length, 1, 'the same immutable raw evidence must not be copied at each retry timestamp');
    assert.deepEqual(rows[0], first);
    assert.ok(DB.sqlite.prepare('SELECT attempts FROM mvp_wallet_backfill_receipt_queue').get().attempts > beforeAttempts);
    assert.equal(count(DB, 'mvp_wallet_receipts'), 0);
    assert.ok(results.every(result => result.counts.financialComplete === false));
  });
});

test('receipt queue and immutable archive enforce byte limits even for multibyte JSON', async t => {
  const DB = database(t); const result = await prepare(DB, rpcFixture()); await DB.batch(result.commands);
  const jobId = jobs(DB)[0].job_id; const large = JSON.stringify({ raw: 'é'.repeat(70000) });
  assert.ok(large.length < 131072); assert.ok(Buffer.byteLength(large) > 131072);
  await assert.rejects(DB.prepare(`INSERT INTO mvp_wallet_backfill_receipt_queue
    (job_id,transaction_hash,block_hash,block_number,next_attempt_at,receipt_json) VALUES(?,?,?,?,?,?)`)
    .bind(jobId, hash(500), hash(75), 75, time, large).run(), /CHECK constraint/);
  await assert.rejects(DB.prepare(`INSERT INTO mvp_wallet_backfill_unresolved_receipts
    (job_id,transaction_hash,block_hash,observed_at,reason,evidence_hash,evidence_json) VALUES(?,?,?,?,?,?,?)`)
    .bind(jobId, hash(500), hash(75), time, 'TEST_LIMIT', createHash('sha256').update(large).digest('hex'), large).run(), /CHECK constraint/);
});
