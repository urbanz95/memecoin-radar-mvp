import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setup, TOKEN, time } from './helpers/mvp-sqlite.mjs';
import profiles from '../src/mvp/config.mjs';
import { prepareWalletLedger } from '../src/mvp/wallet-ledger.mjs';
import { advanceWalletTemporalSummary, walletTemporalEvidence, prepareWalletTemporalUpdates,
  attachWalletTemporalEvidence } from '../src/mvp/wallet-temporal.mjs';
import { scoreWalletProfile } from '../src/mvp/wallet-scoring.mjs';

const walletSchema = await readFile(new URL('../cloudflare/migrations/0004_mvp_wallets.sql', import.meta.url), 'utf8');
const temporalSchema = await readFile(new URL('../cloudflare/migrations/0008_mvp_wallet_realizations.sql', import.meta.url), 'utf8');
const iso = value => new Date(value).toISOString();
const hash = n => '0x' + BigInt(n + 1).toString(16).padStart(64, '0');
const wallet = TOKEN(10);
function event(index, { timestamp = time, pnl = '200', ...changes } = {}) {
  const blockHash = hash(index); const transactionHash = hash(index + 1000); const logIndex = 1;
  return { schemaVersion: 1, accountingVersion: 'fifo-receipt-net-usd/v1',
    id: `4663:${blockHash}:${transactionHash}:${logIndex}:${wallet}`, disposalIndex: index,
    chainId: 4663, walletAddress: wallet, tokenAddress: TOKEN(20), transactionHash, blockHash,
    blockNumber: index, logIndex, timestamp: iso(timestamp), netRealizedPnlUsd: pnl,
    netRealizedPnlUsdExact: { numerator: pnl, denominator: '1' }, holdingSeconds: 300,
    earlyEntryPct: 100, drawdownPct: 0, source: 'synthetic-proven-accounting', evidence: ['fixture:realization'], ...changes };
}
function profile(count = 5, changes = {}) {
  return { chainId: 4663, walletAddress: wallet, checkedAt: iso(time), source: 'synthetic-fifo',
    evidence: ['fixture:complete-history'], historyComplete: true, costsComplete: true, feesComplete: true,
    attributionComplete: true, clusteringComplete: true, realizedTradeCount: count,
    netRealizedPnlUsd: String(count * 200), netRealizedPnlUsdExact: { numerator: String(count * 200), denominator: '1' },
    winRatePct: 100, avgHoldingSeconds: 300, earlyEntryPct: 100, maxDrawdownPct: 0,
    lastRealizedAt: iso(time), riskFlags: { insider: false, bundler: false, washTrading: false }, ...changes };
}
function database(t) { const DB = setup(t); DB.sqlite.exec(walletSchema); DB.sqlite.exec(temporalSchema); return DB; }
const summary = events => advanceWalletTemporalSummary(null, events, { observedAt: time });
const scored = (p, s) => scoreWalletProfile({ ...p, realizationHistory: walletTemporalEvidence(p, s, { now: time }) }, { now: time });
const events = n => Array.from({ length: n }, (_, i) => event(i + 1));

test('per-disposal decay cannot rejuvenate old profit with one tiny fresh sale', () => {
  const old = time - 30 * 86400000;
  const historical = Array.from({ length: 4 }, (_, i) => event(i + 1, { timestamp: old, pnl: '250' }));
  const current = [...historical, event(5, { pnl: '0', earlyEntryPct: 100 })];
  const p = profile(5, { netRealizedPnlUsd: '1000', netRealizedPnlUsdExact: { numerator: '1000', denominator: '1' }, winRatePct: 80 });
  const result = scored(p, summary(current));
  assert.equal(result.status, 'INELIGIBLE'); assert.equal(result.features.timeDecayFactor, 0.6);
  assert.ok(result.score < 60, 'a new zero-profit sale cannot reset old performance to score 100');
  assert.equal(result.features.netRealizedPnlUsd, '1000');
});

test('recent losses weigh more than equally sized old gains despite positive lifetime PnL', () => {
  const current = [...Array.from({ length: 4 }, (_, i) => event(i + 1,
    { timestamp: time - 60 * 86400000, pnl: '300' })), event(5, { pnl: '-400', drawdownPct: 20 })];
  const p = profile(5, { netRealizedPnlUsd: '800', netRealizedPnlUsdExact: { numerator: '800', denominator: '1' }, winRatePct: 80, maxDrawdownPct: 20 });
  assert.equal(scored(p, summary(current)).score, 0);
});

test('legacy aggregates without realization coverage remain unknown and half-life changes require replay', () => {
  const p = profile();
  assert.equal(scoreWalletProfile(p, { now: time }).status, 'INCOMPLETE');
  const old = summary(events(5)); const tuned = structuredClone(profiles);
  tuned.profiles.profile_new.walletScoring.timeDecayHalfLifeDays = 45;
  const proof = walletTemporalEvidence(p, old, { config: tuned, now: time });
  assert.equal(proof.complete, false); assert.ok(proof.gaps.includes('WALLET_TEMPORAL_METHOD_MISMATCH'));
  const mismatch = walletTemporalEvidence(profile(6), old, { now: time });
  assert.equal(mismatch.complete, false);
  const legacy = structuredClone(profiles); legacy.profiles.profile_new.walletScoring.version = 'wallet-manual-v1';
  assert.equal(scoreWalletProfile(p, { now: time, config: legacy }).status, 'INCOMPLETE',
    'legacy configuration cannot restore the unsafe lifetime aggregate fallback');
});

test('floating-point cancellation cannot manufacture weighted profit from huge offsetting disposals', () => {
  const big = '1' + '0'.repeat(70);
  const delta = [event(1, { pnl: big }), event(2, { pnl: '-' + big }),
    event(3, { pnl: big }), event(4, { pnl: '-' + big }), event(5, { pnl: '1' })];
  const p = profile(5, { netRealizedPnlUsd: '1', netRealizedPnlUsdExact: { numerator: '1', denominator: '1' }, winRatePct: 60 });
  const result = scored(p, summary(delta));
  assert.equal(result.score, 0); assert.equal(result.status, 'INELIGIBLE');
  assert.equal(result.features.netRealizedPnlUsd, '1', 'exact realized cash PnL is preserved');
});

test('realization continuity, canonical ordering, identity and exact cumulative PnL are mandatory', () => {
  for (const invalid of [event(2), event(1, { timestamp: time + 1 }), event(1, { chainId: 1 }),
    event(1, { holdingSeconds: null }), event(1, { netRealizedPnlUsdExact: { numerator: '999', denominator: '1' } })])
    assert.throws(() => summary([invalid]), /MVP_WALLET_TEMPORAL_/);
  const s = summary(events(5));
  assert.equal(walletTemporalEvidence(profile(5, { netRealizedPnlUsdExact: { numerator: '999', denominator: '1' } }), s, { now: time }).complete, false);
  assert.throws(() => advanceWalletTemporalSummary(s, [event(6, { blockNumber: 4 })], { observedAt: time }), /ORDER|CURSOR/);
});

test('incremental accumulator equals a full replay and has no 128-lifetime-disposal ceiling', async t => {
  const DB = database(t);
  const first = await prepareWalletTemporalUpdates(DB, { runId: 'first', observedAt: time, profiles: [profile(128)], realizedEvents: events(128) });
  await DB.batch(prepareWalletLedger(DB, { runId: 'first', observedAt: time, profiles: first.profiles,
    realizedEvents: events(128), realizationUpdates: first.realizationUpdates }).commands);
  const rest = [event(129), event(130)];
  const second = await prepareWalletTemporalUpdates(DB, { runId: 'second', observedAt: time, profiles: [profile(130)], realizedEvents: rest });
  assert.equal(second.profiles[0].realizationHistory.complete, true);
  assert.equal(second.profiles[0].realizationHistory.summary.disposalCount, 130);
  assert.deepEqual(second.profiles[0].realizationHistory.summary.weighted, summary(events(130)).weighted);
  await DB.batch(prepareWalletLedger(DB, { runId: 'second', observedAt: time, profiles: second.profiles,
    realizedEvents: rest, realizationUpdates: second.realizationUpdates }).commands);
  const restored = await attachWalletTemporalEvidence(DB, [profile(130)], { now: time });
  assert.equal(restored[0].realizationHistory.complete, true);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_realizations').get().n, 130);
});

test('realizations and summaries are idempotent, immutable and reject conflicting stale projections', async t => {
  const DB = database(t); const p = profile(); const delta = events(5);
  const prepared = await prepareWalletTemporalUpdates(DB, { runId: 'one', observedAt: time, profiles: [p], realizedEvents: delta });
  const commands = prepareWalletLedger(DB, { runId: 'one', observedAt: time, realizedEvents: delta,
    realizationUpdates: prepared.realizationUpdates }).commands;
  await DB.batch(commands); await DB.batch(commands);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_realizations').get().n, 5);
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_wallet_realizations'), /APPEND_ONLY/);
  const fresh = await prepareWalletTemporalUpdates(DB, { runId: 'two', observedAt: time, profiles: [profile(6)], realizedEvents: [event(6)] });
  const stale = await prepareWalletTemporalUpdates(DB, { runId: 'stale', observedAt: time, profiles: [profile(6)], realizedEvents: [event(6, { pnl: '201' })] });
  await DB.batch(prepareWalletLedger(DB, { runId: 'two', observedAt: time, realizedEvents: [event(6)], realizationUpdates: fresh.realizationUpdates }).commands);
  await assert.rejects(DB.batch(prepareWalletLedger(DB, { runId: 'stale', observedAt: time,
    realizedEvents: [event(6, { pnl: '201' })], realizationUpdates: stale.realizationUpdates }).commands), /CONFLICT|CHECK/);
});

test('failed collector fence rolls back temporal data and reorg never reuses old-generation coverage', async t => {
  const DB = database(t); const delta = events(5);
  const prepared = await prepareWalletTemporalUpdates(DB, { runId: 'one', observedAt: time, profiles: [profile()], realizedEvents: delta });
  const commands = prepareWalletLedger(DB, { runId: 'one', observedAt: time, realizedEvents: delta, realizationUpdates: prepared.realizationUpdates }).commands;
  await assert.rejects(DB.batch([...commands, DB.prepare('INSERT OR REPLACE INTO commit_fence(id,ok) VALUES(1,0)')]), /CHECK/);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_realizations').get().n, 0);
  await DB.batch(commands);
  await DB.batch(prepareWalletLedger(DB, { runId: 'reorg', observedAt: time + 1, reorgDetected: true }).commands);
  assert.equal((await attachWalletTemporalEvidence(DB, [profile()], { now: time + 1 }))[0].realizationHistory.complete, false);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_realizations').get().n, 5);
});

test('a temporal summary cannot advance without its complete immutable disposal delta', async t => {
  const DB = database(t); const delta = events(5);
  const prepared = await prepareWalletTemporalUpdates(DB, { runId: 'missing-ledger', observedAt: time,
    profiles: [profile()], realizedEvents: delta });
  await assert.rejects(DB.batch(prepareWalletLedger(DB, { runId: 'missing-ledger', observedAt: time,
    realizationUpdates: prepared.realizationUpdates }).commands), /CHECK/);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_temporal_summaries').get().n, 0);
});

test('new-generation in-memory evidence survives attachment before the collector commits its reorg', async t => {
  const DB = database(t); const delta = events(5);
  const projected = await prepareWalletTemporalUpdates(DB, { runId: 'reorg', observedAt: time,
    profiles: [profile()], realizedEvents: delta, reorgDetected: true });
  assert.equal(projected.profiles[0].realizationHistory.complete, true);
  const restored = await attachWalletTemporalEvidence(DB, projected.profiles, { now: time, reorgDetected: true });
  assert.equal(restored[0].realizationHistory.complete, true);
  assert.equal(restored[0].realizationHistory.summary.generation, 1);
});

test('an old summary flag does not block a current matching summary and future collections stay unavailable', async t => {
  const DB = database(t); const delta = events(5);
  const prepared = await prepareWalletTemporalUpdates(DB, { runId: 'known', observedAt: time, profiles: [profile()], realizedEvents: delta });
  await DB.batch(prepareWalletLedger(DB, { runId: 'known', observedAt: time,
    realizedEvents: delta, realizationUpdates: prepared.realizationUpdates }).commands);
  const forged = structuredClone(prepared.profiles[0]);
  forged.realizationHistory.summary.scoreVersion = 'old-method';
  assert.equal((await attachWalletTemporalEvidence(DB, [forged], { now: time }))[0].realizationHistory.complete, true);
  DB.sqlite.prepare('UPDATE mvp_wallet_temporal_summaries SET observed_at=?').run(time + 1000);
  assert.equal((await attachWalletTemporalEvidence(DB, [profile()], { now: time }))[0].realizationHistory.complete, false);
});
