import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareWalletLedger, prepareWalletProjection, readWalletProfiles, readWalletProfile, readWalletReceipts, getWalletLedgerStats, enrichWalletTransactions } from '../src/mvp/wallet-ledger.mjs';
import { setup, TOKEN, time } from './helpers/mvp-sqlite.mjs';

const schema = await readFile(new URL('../cloudflare/migrations/0004_mvp_wallets.sql', import.meta.url), 'utf8');
const hash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
const head = { number: 100, hash: hash(100), timestamp: time / 1000 };
const event = (changes = {}) => ({ chainId: 4663, kind: 'SWAP', tokenAddress: TOKEN(1), address: TOKEN(5),
  blockNumber: 90, blockHash: hash(90), transactionHash: hash(500), logIndex: 2,
  topics: [hash(30)], data: '0x01', args: { amount0: '10', amount1: '-20' },
  pool: { type: 'v3', address: TOKEN(5), token0: TOKEN(1), token1: TOKEN(8), quoteAddress: TOKEN(8), quoteDecimals: 18, tokenDecimals: 18 }, ...changes });
const range = { kind: 'SWAP', tokenAddress: TOKEN(1), address: TOKEN(5), fromBlock: 80, toBlock: 100,
  headBlock: 100, headHash: hash(100), source: 'validated-pool-activity/v1', historyComplete: false };
function database(t) { const DB = setup(t); DB.sqlite.exec(schema); return DB; }
const count = (DB, table) => DB.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
function profile(changes = {}) { return { chainId: 4663, walletAddress: TOKEN(10), checkedAt: new Date(time).toISOString(),
  source: 'wallet-accounting/v1', evidence: ['onchain:tx:' + hash(500)], historyComplete: false,
  costsComplete: false, feesComplete: false, attributionComplete: false, clusteringComplete: false,
  realizedTradeCount: 0, netRealizedPnlUsd: null, winRatePct: null, avgHoldingSeconds: null,
  earlyEntryPct: null, maxDrawdownPct: null, lastRealizedAt: null, riskFlags: null, ...changes }; }

test('wallet migration is additive, repeatable and preserves legacy data', t => {
  const DB = setup(t); DB.sqlite.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('before-wallets', time, 100, '{}', '{}');
  DB.sqlite.exec(schema); DB.sqlite.exec(schema);
  assert.equal(count(DB, 'runs'), 1); assert.equal(count(DB, 'mvp_wallet_events'), 0);
});

test('validated events and ranges survive retries without duplicates or deleting dead-token evidence', async t => {
  const DB = database(t);
  const prepared = prepareWalletLedger(DB, { runId: 'one', observedAt: time, events: [event(), event()], ranges: [range] });
  assert.equal(count(DB, 'mvp_wallet_events'), 0);
  await DB.batch(prepared.commands); await DB.batch(prepared.commands);
  assert.equal(count(DB, 'mvp_wallet_events'), 1); assert.equal(count(DB, 'mvp_wallet_ranges'), 1);
  assert.equal(count(DB, 'mvp_wallet_receipt_jobs'), 1);
  assert.equal((await getWalletLedgerStats(DB)).events, 1);
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_wallet_events'), /APPEND_ONLY/);
  assert.throws(() => DB.sqlite.exec("UPDATE mvp_wallet_events SET event_json='{}'"), /IMMUTABLE/);
});

test('conflicting event fingerprints abort the whole fenced transaction rather than overwriting evidence', async t => {
  const DB = database(t);
  await DB.batch(prepareWalletLedger(DB, { runId: 'one', observedAt: time, events: [event()] }).commands);
  const conflict = prepareWalletLedger(DB, { runId: 'two', observedAt: time + 1, events: [event({ data: '0x02' })] });
  await assert.rejects(DB.batch(conflict.commands), /WALLET_EVENT_CONFLICT/);
  assert.equal(count(DB, 'mvp_wallet_events'), 1);
  assert.equal(JSON.parse(DB.sqlite.prepare('SELECT event_json FROM mvp_wallet_events').get().event_json).data, '0x01');
});

test('unchanged raw log is idempotent when optional pool context changes', async t => {
  const DB = database(t);
  await DB.batch(prepareWalletLedger(DB, { runId: 'one', observedAt: time, events: [event()] }).commands);
  await DB.batch(prepareWalletLedger(DB, { runId: 'two', observedAt: time + 1,
    events: [event({ pool: { ...event().pool, quoteDecimals: null } })] }).commands);
  assert.equal(count(DB, 'mvp_wallet_events'), 1);
});

test('malformed or future wallet inputs fail explicitly and never become zero-valued profiles', t => {
  const DB = database(t);
  for (const events of [[event({ blockHash: 'bad' })], [event({ chainId: 1 })], [event({ logIndex: -1 })], [event({ args: { n: 1n } })]])
    assert.throws(() => prepareWalletLedger(DB, { runId: 'bad', observedAt: time, events }), /MVP_WALLET_/);
  assert.throws(() => prepareWalletProjection(DB, { runId: 'bad', observedAt: time, profiles: [profile({ checkedAt: new Date(time + 1).toISOString() })] }), /FUTURE/);
  assert.throws(() => prepareWalletProjection(DB, { runId: 'bad', observedAt: time, profiles: [profile({ netRealizedPnlUsd: NaN })] }), /MVP_WALLET_/);
});

test('profile projections keep unknowns, append history and remain token-address indexed', async t => {
  const DB = database(t);
  const transfer = event({ kind: 'TRANSFER', address: TOKEN(1), args: { from: TOKEN(10), to: TOKEN(11), value: '20' } });
  await DB.batch(prepareWalletLedger(DB, { runId: 'events', observedAt: time, events: [transfer] }).commands);
  await DB.batch(prepareWalletProjection(DB, { runId: 'profiles', observedAt: time, profiles: [profile()] }).commands);
  const profiles = await readWalletProfiles(DB, { tokenAddress: TOKEN(1) });
  assert.equal(profiles.length, 1); assert.equal(profiles[0].netRealizedPnlUsd, null);
  assert.equal(profiles[0].historyComplete, false); assert.equal(profiles[0].riskFlags, null);
  assert.deepEqual(await readWalletProfiles(DB, { tokenAddress: TOKEN(99) }), []);
  assert.equal(count(DB, 'mvp_wallet_profile_events'), 1);
  assert.deepEqual(await readWalletProfile(DB, TOKEN(10)), profiles[0]);
  assert.equal(await readWalletProfile(DB, TOKEN(99)), null);
  const stats = await getWalletLedgerStats(DB);
  assert.equal(stats.tracked, 1); assert.equal(stats.eligible, 0);
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_wallet_profile_events'), /APPEND_ONLY/);
});

test('reorg invalidates current projections without deleting original events, receipts or profile history', async t => {
  const DB = database(t);
  await DB.batch(prepareWalletProjection(DB, { runId: 'before', observedAt: time, profiles: [profile()] }).commands);
  assert.equal((await readWalletProfiles(DB)).length, 1);
  assert.equal((await getWalletLedgerStats(DB)).tracked, 1);
  await DB.batch(prepareWalletLedger(DB, { runId: 'reorg', observedAt: time + 1, reorgDetected: true }).commands);
  assert.deepEqual(await readWalletProfiles(DB), []);
  assert.equal(await readWalletProfile(DB, TOKEN(10)), null);
  assert.equal(count(DB, 'mvp_wallet_profile_events'), 1);
  await DB.batch(prepareWalletProjection(DB, { runId: 'after', observedAt: time + 2, profiles: [profile({ checkedAt: new Date(time + 2).toISOString() })] }).commands);
  assert.equal((await readWalletProfiles(DB)).length, 1);
  assert.equal((await getWalletLedgerStats(DB)).tracked, 1);
});

test('ledger and projections roll back when the collector lease fence fails', async t => {
  const DB = database(t);
  const prepared = prepareWalletLedger(DB, { runId: 'fence', observedAt: time, events: [event()] });
  await assert.rejects(DB.batch([...prepared.commands, DB.prepare('INSERT OR REPLACE INTO commit_fence(id,ok) VALUES(1,0)')]), /CHECK constraint/);
  assert.equal((await getWalletLedgerStats(DB)).events, 0);
});

function receiptRpc(changes = {}) {
  const calls = [];
  return { calls, requests: changes.requests ?? 20, async batch(batch) { this.requests++; calls.push(batch); return batch.map(([method]) => ({ value:
    method === 'eth_getTransactionReceipt' ? { transactionHash: hash(500), blockNumber: '0x5a', blockHash: hash(90),
      status: '0x1', from: TOKEN(10), to: TOKEN(5), gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00',
      logs: [{ address: TOKEN(1), topics: [hash(44)], data: '0x1234' }], ...changes.receipt }
    : { number: '0x5a', hash: hash(90), timestamp: '0x' + (time / 1000 - 10).toString(16), ...changes.block } })); } };
}
test('receipt enrichment retains full gas/log evidence within one bounded read-only batch', async t => {
  const DB = database(t); const rpc = receiptRpc();
  const enriched = await enrichWalletTransactions(DB, rpc, { events: [event()], head, now: () => time, maxTransactions: 2 });
  assert.equal(rpc.calls.length, 1); assert.deepEqual(rpc.calls[0].map(([method]) => method), ['eth_getTransactionReceipt', 'eth_getBlockByNumber']);
  assert.equal(enriched.receipts.length, 1); assert.equal(enriched.receipts[0].receipt.gasUsed, '0x5208');
  assert.equal(enriched.receipts[0].receipt.logs.length, 1);
  await DB.batch(prepareWalletLedger(DB, { runId: 'receipt', observedAt: time, events: [event()], ...enriched }).commands);
  assert.equal(count(DB, 'mvp_wallet_receipts'), 1);
  assert.equal(JSON.parse(DB.sqlite.prepare('SELECT receipt_json FROM mvp_wallet_receipts').get().receipt_json).receipt.effectiveGasPrice, '0x3b9aca00');
  assert.equal(DB.sqlite.prepare('SELECT state FROM mvp_wallet_receipt_jobs').get().state, 'COMPLETE');
  const replay = await readWalletReceipts(DB, { walletAddress: TOKEN(10) });
  assert.equal(replay.receipts.length, 1); assert.equal(replay.historyComplete, false);
  assert.equal(replay.scope, 'observed-receipts-only');
  const skipped = await enrichWalletTransactions(DB, rpc, { events: [event()], head, now: () => time + 1 });
  assert.equal(skipped.receipts.length, 0); assert.equal(rpc.calls.length, 1, 'completed transactions are not fetched repeatedly');
});

test('receipt mismatch or missing receipt remains retryable and exposes no private provider error', async t => {
  const DB = database(t); const rpc = receiptRpc({ receipt: { blockHash: hash(91) } });
  const enriched = await enrichWalletTransactions(DB, rpc, { events: [event()], head, now: () => time });
  assert.deepEqual(enriched.receipts, []); assert.equal(enriched.attempts[0].reason, 'RECEIPT_CANONICAL_MISMATCH');
  await DB.batch(prepareWalletLedger(DB, { runId: 'retry', observedAt: time, events: [event()], ...enriched }).commands);
  const job = DB.sqlite.prepare('SELECT * FROM mvp_wallet_receipt_jobs').get();
  assert.equal(job.state, 'RETRY'); assert.ok(job.next_attempt_at > time);
  const deferred = await enrichWalletTransactions(DB, rpc, { events: [event()], head, now: () => time + 1 });
  assert.equal(deferred.receipts.length, 0); assert.equal(rpc.calls.length, 1, 'repeated swap observations respect backoff');
  const skipped = await enrichWalletTransactions(DB, receiptRpc({ requests: 30 }), { events: [event()], head, now: () => time });
  assert.deepEqual(skipped.receipts, []); assert.equal(skipped.diagnostics[0], 'WALLET_RPC_BUDGET_DEFERRED');
});

test('eligible counter requires proof completeness and resets on reorg without losing tracked history', async t => {
  const DB = database(t);
  const complete = profile({ eligible: true, historyComplete: true, costsComplete: true, feesComplete: true,
    attributionComplete: true, clusteringComplete: true, realizedTradeCount: 5, netRealizedPnlUsd: '12.5',
    winRatePct: 60, avgHoldingSeconds: 300, earlyEntryPct: 80, maxDrawdownPct: 10,
    lastRealizedAt: new Date(time).toISOString(), riskFlags: { insider: false, bundler: false, washTrading: false } });
  await DB.batch(prepareWalletProjection(DB, { runId: 'qualified', observedAt: time, profiles: [complete] }).commands);
  assert.equal((await getWalletLedgerStats(DB)).eligible, 1);
  await DB.batch(prepareWalletLedger(DB, { runId: 'reorg', observedAt: time + 1, reorgDetected: true }).commands);
  assert.equal((await getWalletLedgerStats(DB)).eligible, 0);
  await DB.batch(prepareWalletProjection(DB, { runId: 'unknown-again', observedAt: time + 2,
    profiles: [profile({ checkedAt: new Date(time + 2).toISOString(), eligible: true })] }).commands);
  const stats = await getWalletLedgerStats(DB);
  assert.equal(stats.tracked, 1); assert.equal(stats.eligible, 0);
});

test('a receipt surviving a reorg is revalidated into the new generation without overwriting the old proof', async t => {
  const DB = database(t); const rpc = receiptRpc();
  const before = await enrichWalletTransactions(DB, rpc, { events: [event()], head, now: () => time });
  await DB.batch(prepareWalletLedger(DB, { runId: 'before', observedAt: time, events: [event()], ...before }).commands);
  await DB.batch(prepareWalletLedger(DB, { runId: 'reorg', observedAt: time + 1, reorgDetected: true }).commands);
  assert.equal((await readWalletReceipts(DB, { walletAddress: TOKEN(10) })).receipts.length, 0);
  const after = await enrichWalletTransactions(DB, rpc, { events: [], head, now: () => time + 2 });
  assert.equal(after.receipts.length, 1);
  await DB.batch(prepareWalletLedger(DB, { runId: 'after', observedAt: time + 2, ...after }).commands);
  assert.equal(count(DB, 'mvp_wallet_receipts'), 2);
  assert.equal((await readWalletReceipts(DB, { walletAddress: TOKEN(10) })).receipts.length, 1);
});

test('a retried profile observation cannot silently rewrite the immutable projection history', async t => {
  const DB = database(t);
  const prepared = prepareWalletProjection(DB, { runId: 'profile-retry', observedAt: time, profiles: [profile()] });
  await DB.batch(prepared.commands); await DB.batch(prepared.commands);
  const changed = prepareWalletProjection(DB, { runId: 'profile-retry', observedAt: time,
    profiles: [profile({ source: 'different-but-same-run' })] });
  await assert.rejects(DB.batch(changed.commands), /WALLET_PROFILE_CONFLICT/);
  assert.equal((await getWalletLedgerStats(DB)).tracked, 1);
});
