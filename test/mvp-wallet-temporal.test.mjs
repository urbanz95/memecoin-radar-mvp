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

test('A08: temporal proof persists position components and matches exact cumulative PnL beyond 180 digits', async t => {
  const DB = database(t); const divisors = [];
  const prime = n => { for (let d = 2; d * d <= n; d++) if (!(n % d)) return false; return true; };
  for (let n = 1000000001; divisors.length < 24; n += 2) if (prime(n)) divisors.push(BigInt(n));
  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
  let n = 0n; let d = 1n;
  const delta = divisors.map((q, i) => {
    const basis = 100n * (q / 2n); const profit = 60n * q - basis;
    n = n * q + profit * d; d *= q;
    const divisor = gcd(n, d); n /= divisor; d /= divisor;
    const scaled = (profit * 10n ** 18n / q).toString().padStart(19, '0');
    const value = scaled.slice(0, -18) + '.' + scaled.slice(-18).replace(/0+$/, '');
    return event(i + 1, { tokenAddress: TOKEN(100 + i), pnl: value,
      netRealizedPnlUsdExact: { numerator: profit.toString(), denominator: q.toString() },
      netRealizedPnlUsdComponents: { n: '60', d: '1', positions: { [`p:${i + 1}`]: { n: (-basis).toString(), d: q.toString() } } } });
  });
  const scaled = (n * 10n ** 18n / d).toString().padStart(19, '0');
  const p = profile(24, { netRealizedPnlUsd: scaled.slice(0, -18) + '.' + scaled.slice(-18).replace(/0+$/, ''),
    netRealizedPnlUsdExact: { numerator: n.toString(), denominator: d.toString() } });
  const prepared = await prepareWalletTemporalUpdates(DB, { runId: 'positions', observedAt: time, profiles: [p], realizedEvents: delta });
  assert.equal(prepared.profiles[0].realizationHistory.complete, true);
  assert.ok(d.toString().length > 180);
  assert.equal(Object.keys(prepared.realizationUpdates[0].summary.cumulativePnlComponents.positions).length, 24);
  await DB.batch(prepareWalletLedger(DB, { runId: 'positions', observedAt: time, profiles: prepared.profiles,
    realizedEvents: delta, realizationUpdates: prepared.realizationUpdates }).commands);
  const restored = await attachWalletTemporalEvidence(DB, [p], { now: time });
  assert.equal(restored[0].realizationHistory.complete, true);
  assert.deepEqual(restored[0].realizationHistory.summary.cumulativePnlExact, p.netRealizedPnlUsdExact);
});

test('A08: a temporal exact-memory limit defers one wallet without aborting unrelated ingestion', async t => {
  const DB = database(t);
  const delta = Array.from({ length: 120 }, (_, i) => {
    const d = ((1n << 220n) + BigInt(2 * i + 1)).toString();
    return event(i + 1, { pnl: '0', netRealizedPnlUsdExact: { numerator: '1', denominator: d },
      netRealizedPnlUsdComponents: { n: '0', d: '1', positions: { [`p:${i + 1}`]: { n: '1', d } } } });
  });
  const prepared = await prepareWalletTemporalUpdates(DB, { runId: 'resource-budget', observedAt: time,
    profiles: [profile(120)], realizedEvents: delta });
  assert.equal(prepared.realizationUpdates.length, 0);
  assert.equal(prepared.profiles[0].realizationHistory.complete, false);
  assert.equal(prepared.profiles[0].temporalRecovery.identicalReplayCanRecover, false);
  assert.equal(prepared.diagnostics[0].reason, 'WALLET_TEMPORAL_EXACT_CHECKPOINT_REQUIRED');
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_temporal_summaries').get().n, 0);
});

test('A08: realization components must match immutable exact cash PnL and cannot inflate a summary', () => {
  const forged = event(1, { netRealizedPnlUsdComponents: { n: '999', d: '1', positions: {} } });
  assert.throws(() => summary([forged]), /INVALID_PNL_COMPONENTS/);
  const valid = summary([event(1, { netRealizedPnlUsdComponents: { n: '200', d: '1', positions: {} } })]);
  valid.cumulativePnlComponents.n = '999';
  assert.equal(walletTemporalEvidence(profile(1), valid, { now: time }).complete, false);
});

test('A08: additive exact components enrich legacy replay without changing immutable cash identity or JSON', async t => {
  const DB = database(t); const delta = events(5);
  const first = await prepareWalletTemporalUpdates(DB, { runId: 'legacy-facts', observedAt: time,
    profiles: [profile()], realizedEvents: delta });
  await DB.batch(prepareWalletLedger(DB, { runId: 'legacy-facts', observedAt: time,
    realizedEvents: delta, realizationUpdates: first.realizationUpdates }).commands);
  const original = DB.sqlite.prepare('SELECT event_id,event_json,fingerprint FROM mvp_wallet_realizations ORDER BY disposal_index').all();
  const enriched = delta.map(value => ({ ...value, netRealizedPnlUsdComponents: { n: '200', d: '1', positions: {} } }));
  const replay = await prepareWalletTemporalUpdates(DB, { runId: 'component-replay', observedAt: time,
    profiles: [profile()], realizedEvents: enriched });
  assert.equal(replay.profiles[0].realizationHistory.complete, true);
  assert.equal(replay.realizationUpdates.length, 0);
  await DB.batch(prepareWalletLedger(DB, { runId: 'component-replay', observedAt: time,
    realizedEvents: enriched, realizationUpdates: replay.realizationUpdates }).commands);
  assert.deepEqual(DB.sqlite.prepare('SELECT event_id,event_json,fingerprint FROM mvp_wallet_realizations ORDER BY disposal_index').all(), original,
    'component enrichment is not a correction to the immutable economic facts');
  const changedCash = { ...enriched[0], netRealizedPnlUsd: '201',
    netRealizedPnlUsdExact: { numerator: '201', denominator: '1' }, netRealizedPnlUsdComponents: { n: '201', d: '1', positions: {} } };
  await assert.rejects(prepareWalletTemporalUpdates(DB, { runId: 'conflicting-cash', observedAt: time,
    realizedEvents: [changedCash] }), /EVENT_CONFLICT/);
  const rejected = await prepareWalletTemporalUpdates(DB, { runId: 'conflicting-components', observedAt: time,
    realizedEvents: [{ ...enriched[0], netRealizedPnlUsdComponents: { n: '999', d: '1', positions: {} } }] });
  assert.deepEqual(rejected.realizedEvents, []);
  assert.equal(rejected.rejectedRealizations, 1);
  assert.equal(rejected.diagnostics[0].cause, 'MVP_WALLET_TEMPORAL_INVALID_PNL_COMPONENTS');
});

test('A08: malformed realization evidence quarantines its wallet while valid independent evidence can commit', async t => {
  const DB = database(t); const other = TOKEN(11);
  const valid = event(1, { walletAddress: other });
  valid.id = `4663:${valid.blockHash}:${valid.transactionHash}:1:${other}`;
  const oversized = event(1, { evidence: Array.from({ length: 64 }, (_, index) => 'e'.repeat(236) + String(index).padStart(4, '0')) });
  const prepared = await prepareWalletTemporalUpdates(DB, { runId: 'isolate-evidence', observedAt: time,
    profiles: [profile(1), profile(1, { walletAddress: other })], realizedEvents: [oversized, valid] });
  assert.equal(prepared.profiles[0].realizationHistory.complete, false);
  assert.equal(prepared.profiles[0].temporalRecovery.blocksScoring, true);
  assert.equal(prepared.profiles[1].realizationHistory.complete, true);
  assert.equal(prepared.realizedEvents.length, 1);
  assert.equal(prepared.rejectedRealizations, 1);
  assert.equal(prepared.diagnostics[0].cause, 'MVP_WALLET_TEMPORAL_EVIDENCE_LIMIT');
  await DB.batch(prepareWalletLedger(DB, { runId: 'isolate-evidence', observedAt: time,
    profiles: prepared.profiles, realizedEvents: prepared.realizedEvents, realizationUpdates: prepared.realizationUpdates }).commands);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_realizations').get().n, 1);
});

test('A08: an unattributable invalid realization quarantines scoring for the batch and cannot be unblocked by cached summary', async t => {
  const DB = database(t); const valid = event(1);
  const first = await prepareWalletTemporalUpdates(DB, { runId: 'known-facts', observedAt: time,
    profiles: [profile(1)], realizedEvents: [valid] });
  await DB.batch(prepareWalletLedger(DB, { runId: 'known-facts', observedAt: time,
    realizedEvents: first.realizedEvents, realizationUpdates: first.realizationUpdates }).commands);
  const prepared = await prepareWalletTemporalUpdates(DB, { runId: 'unattributable', observedAt: time,
    profiles: [profile(1)], realizedEvents: [valid, { ...event(2), walletAddress: 'unknown' }] });
  assert.equal(prepared.profiles[0].realizationHistory.complete, false);
  assert.equal(prepared.realizationUpdates.length, 0);
  assert.equal(prepared.realizedEvents.length, 1, 'valid immutable facts are retained with the explicit batch quarantine');
  assert.equal(prepared.diagnostics[0].scope, 'BATCH');
  const attached = await attachWalletTemporalEvidence(DB, prepared.profiles, { now: time });
  assert.equal(attached[0].realizationHistory.complete, false);
});

test('A08: validated realization output deduplicates equivalent facts and clears quarantine only on a valid retry', async t => {
  const DB = database(t); const valid = event(1);
  const quarantined = await prepareWalletTemporalUpdates(DB, { runId: 'bad-input', observedAt: time,
    profiles: [profile(1)], realizedEvents: [{ ...valid, holdingSeconds: null }] });
  assert.equal(quarantined.profiles[0].realizationHistory.complete, false);
  const unchanged = await prepareWalletTemporalUpdates(DB, { runId: 'no-proof', observedAt: time,
    profiles: quarantined.profiles });
  assert.equal(unchanged.profiles[0].realizationHistory.complete, false);
  const retry = await prepareWalletTemporalUpdates(DB, { runId: 'valid-retry', observedAt: time,
    profiles: quarantined.profiles, realizedEvents: [valid, { ...valid, netRealizedPnlUsdComponents: { n: '200', d: '1', positions: {} } }] });
  assert.equal(retry.profiles[0].realizationHistory.complete, true);
  assert.equal(retry.profiles[0].temporalRecovery, undefined);
  assert.equal(retry.realizedEvents.length, 1);
  assert.equal(retry.duplicateRealizations, 1);
  assert.equal(retry.rejectedRealizations, 0);
});
