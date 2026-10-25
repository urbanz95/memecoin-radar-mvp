import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QUOTE_ASSETS } from '../src/network.mjs';
import { prepareDecisionRecords, decisionKey, getMvpStats } from '../src/mvp/records.mjs';
import { queryDueOutcomes, prepareOutcomeUpdates, prepareMarketObservations, queryArchivedOutcomePoints,
  outcomeEligibility, OUTCOME_HORIZONS } from '../src/mvp/outcomes.mjs';
import { setup, decision, TOKEN, time, version, profile, policyHash } from './helpers/mvp-sqlite.mjs';

async function seed(DB, address = TOKEN(1), changes = {}) {
  await DB.batch(prepareDecisionRecords(DB, { runId: `seed-${address}`, observedAt: time, decisions: [decision(address, changes)] }).commands);
  return decisionKey(4663, address, changes.scoreVersion ?? version, changes.profile ?? profile);
}
const point = (sourceTimestamp, changes = {}) => ({ sourceTimestamp, priceUsd: 3, liquidityUsd: 120,
  source: { provider: 'dexscreener', trust: 'provider-reported' }, ...changes });
const jobState = (DB, key, h = '15m') => DB.sqlite.prepare('SELECT * FROM mvp_outcome_jobs WHERE decision_key=? AND horizon=?').get(key, h);

test('outcome queue uses first-decision horizons and never exposes not-yet-due jobs', async t => {
  const DB = setup(t); await seed(DB);
  assert.deepEqual(await queryDueOutcomes(DB, { now: time + 899999 }), []);
  const jobs = await queryDueOutcomes(DB, { now: time + 900000 });
  assert.equal(jobs.length, 1); assert.equal(jobs[0].horizon, '15m'); assert.equal(jobs[0].dueAt, time + 900000);
  assert.equal(jobs[0].baselinePriceUsd, 2);
  const allDue = await queryDueOutcomes(DB, { now: time + 604800000, limit: 100 });
  assert.deepEqual(allDue.map(job => job.horizon), ['7d', '15m', '1h', '24h']);
  await assert.rejects(queryDueOutcomes(DB, { now: time, limit: 101 }), /MVP_INVALID_OUTCOME_LIMIT/);
  const before = prepareOutcomeUpdates(DB, [{ job: jobs[0], observation: point(time + 900000) }], { runId: 'early', now: time + 899999 });
  assert.equal(before.commands.length, 0); assert.equal(before.diagnostics[0].result, 'NOT_DUE');
});

test('live capture windows cannot be starved by expired jobs or repeated score versions of one token', async t => {
  const DB = setup(t);
  for (let i = 0; i < 8; i++) await seed(DB, TOKEN(1), { scoreVersion: `version-${i}` });
  for (let i = 2; i <= 5; i++) await seed(DB, TOKEN(i));
  const jobs = await queryDueOutcomes(DB, { now: time + 3720000, limit: 4, maxJobs: 24 });
  assert.equal(new Set(jobs.map(job => job.address)).size, 4);
  assert.ok(jobs.length <= 24);
  assert.ok(jobs.slice(0, 4).every(job => job.horizon === '1h' && job.captureState === 'LIVE'));
  assert.ok(jobs.filter(job => job.horizon === '15m').every(job => job.captureState === 'EXPIRED'));
  assert.equal(jobs.filter(job => job.address === TOKEN(1) && job.horizon === '1h').length, 8,
    'one fetched point fans out to compatible versions instead of consuming extra provider addresses');
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_outcome_attempts').get().n, 0);
});

test('outcome retries preserve every job and reach a real 24-hour backoff cap', async t => {
  const DB = setup(t); const key = await seed(DB);
  const [job] = await queryDueOutcomes(DB, { now: time + 900000 });
  for (let i = 0; i < 14; i++) await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: null }],
    { runId: `backoff-${i}`, now: time + 900000 + i * 86400000 }).commands);
  const row = jobState(DB, key);
  assert.equal(row.next_attempt_at - row.last_attempt_at, 86400000);
  assert.equal(row.attempt_count, 14); assert.equal(row.state, 'RETRY');
});

test('retries cannot skip an open five-minute capture window and resume backoff after its deadline', async t => {
  const DB = setup(t); await seed(DB);
  const [job] = await queryDueOutcomes(DB, { now: time + 900000 });
  for (let i = 0; i < 4; i++) {
    const at = job.dueAt + i * 60000;
    await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: null }], { runId: `live-${i}`, now: at }).commands);
    assert.equal(jobState(DB, job.decisionKey).next_attempt_at, at + 60000);
  }
  await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: null }],
    { runId: 'near-deadline', now: job.dueAt + job.allowedLagMs - 10000 }).commands);
  assert.equal(jobState(DB, job.decisionKey).next_attempt_at, job.dueAt + job.allowedLagMs);
  await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: null }],
    { runId: 'at-deadline', now: job.dueAt + job.allowedLagMs }).commands);
  assert.ok(jobState(DB, job.decisionKey).next_attempt_at > job.dueAt + job.allowedLagMs);
});

function archiveSetup(t) {
  const DB = setup(t);
  DB.sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0006_mvp_outcome_capture.sql', import.meta.url), 'utf8'));
  return DB;
}
const marketEntry = (address, fetchedAt, changes = {}) => ({ address, externalMarket: {
  source: 'dexscreener', trust: 'provider-reported', chain: 'robinhood', chainId: 4663,
  baseTokenAddress: address, pairAddress: TOKEN(900), pairKind: 'address',
  quoteTokenAddress: QUOTE_ASSETS.WETH, quoteAsset: 'WETH',
  fetchedAt: new Date(fetchedAt).toISOString(), priceUsd: 3, liquidityUsd: 120, ...changes,
} });

test('fresh provider observations are immutable, idempotent and share the collector transaction fence', async t => {
  const DB = archiveSetup(t);
  const entries = [marketEntry(TOKEN(1), time + 910000), marketEntry(TOKEN(2), time + 910000, { priceUsd: 0, liquidityUsd: 0 })];
  const prepared = prepareMarketObservations(DB, entries, { runId: 'fresh', observedAt: time + 920000 });
  assert.equal(prepared.commands.length, 2);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_market_observations').get().n, 0, 'prepare must not write');
  await assert.rejects(DB.batch([...prepared.commands, DB.prepare('INSERT OR REPLACE INTO commit_fence(id,ok) VALUES(1,0)')]), /CHECK constraint failed/);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_market_observations').get().n, 0);
  await DB.batch(prepared.commands);
  await DB.batch(prepareMarketObservations(DB, entries, { runId: 'same-source', observedAt: time + 930000 }).commands);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_market_observations').get().n, 2);
  assert.equal(DB.sqlite.prepare('SELECT price_usd FROM mvp_market_observations WHERE address=?').get(TOKEN(2)).price_usd, 0);
  assert.throws(() => DB.sqlite.exec('UPDATE mvp_market_observations SET price_usd=99'), /MVP_MARKET_OBSERVATION_IMMUTABLE/);
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_market_observations'), /MVP_MARKET_OBSERVATION_APPEND_ONLY/);
  await assert.rejects(DB.batch(prepareMarketObservations(DB, [marketEntry(TOKEN(1), time + 910000, { priceUsd: 99 })],
    { runId: 'conflict', observedAt: time + 940000 }).commands), /MVP_MARKET_OBSERVATION_CONFLICT/);
});

test('market archive rejects cached refreshes, unknown metrics, wrong identity, stale and future source times', t => {
  const DB = archiveSetup(t); const address = TOKEN(1); const at = time + 920000;
  const invalid = [
    marketEntry(address, at, { priceUsd: undefined }), marketEntry(address, at, { liquidityUsd: null }),
    marketEntry(address, at, { chainId: 1 }), marketEntry(address, at, { baseTokenAddress: TOKEN(2) }),
    marketEntry(address, at, { quoteTokenAddress: TOKEN(3) }), marketEntry(address, at, { pairAddress: 'invalid' }),
    marketEntry(address, at + 1), marketEntry(address, at - 120001),
  ];
  assert.equal(prepareMarketObservations(DB, invalid, { runId: 'invalid', observedAt: at }).commands.length, 0);
  assert.equal(prepareMarketObservations(DB, [marketEntry(address, at)],
    { runId: 'cached', observedAt: at, refreshed: false }).commands.length, 0);
});

test('archive recovers missed windows from actual fresh points without future leakage or invented historical prices', async t => {
  const DB = archiveSetup(t); await seed(DB, TOKEN(1)); await seed(DB, TOKEN(2));
  const jobs = await queryDueOutcomes(DB, { now: time + 900000 });
  await DB.batch(prepareMarketObservations(DB, [marketEntry(TOKEN(1), time + 910000)],
    { runId: 'source-run', observedAt: time + 920000 }).commands);
  assert.ok((await queryArchivedOutcomePoints(DB, jobs, { now: time + 915000 })).every(item => item.observation === null),
    'a future collection cannot appear in an earlier historical evaluation');
  const recovered = await queryArchivedOutcomePoints(DB, jobs, { now: time + 86400000 });
  const found = recovered.find(item => item.job.address === TOKEN(1));
  assert.equal(found.observation.sourceTimestamp, time + 910000);
  assert.equal(found.observation.priceUsd, 3);
  assert.equal(found.observation.source.archive.runId, 'source-run');
  assert.equal(recovered.find(item => item.job.address === TOKEN(2)).observation, null, 'another token cannot supply missing data');
  await DB.batch(prepareOutcomeUpdates(DB, recovered, { runId: 'late-recovery', now: time + 86400000 }).commands);
  assert.equal(jobState(DB, found.job.decisionKey).state, 'COMPLETE');
  assert.equal(DB.sqlite.prepare('SELECT source_timestamp FROM mvp_outcomes').get().source_timestamp, time + 910000);
  const laterJobs = await queryDueOutcomes(DB, { now: time + 86400000 });
  const later = await queryArchivedOutcomePoints(DB, laterJobs, { now: time + 86400000 });
  assert.ok(later.filter(item => item.job.horizon !== '15m').every(item => item.observation === null));
});

test('legacy immutable outcomes can repair another score version only inside the exact original source window', async t => {
  const DB = archiveSetup(t); await seed(DB);
  const [original] = await queryDueOutcomes(DB, { now: time + 900000 });
  await DB.batch(prepareOutcomeUpdates(DB, [{ job: original, observation: point(time + 910000,
    { source: { provider: 'dexscreener', notes: 'e'.repeat(7600) } }) }],
    { runId: 'legacy-source', now: time + 920000 }).commands);
  await seed(DB, TOKEN(1), { scoreVersion: 'next-version' });
  const jobs = await queryDueOutcomes(DB, { now: time + 86400000, limit: 4 });
  const recovered = await queryArchivedOutcomePoints(DB, jobs, { now: time + 86400000 });
  const sameWindow = recovered.find(item => item.job.scoreVersion === 'next-version' && item.job.horizon === '15m');
  assert.equal(sameWindow.observation.priceUsd, 3);
  assert.equal(sameWindow.observation.sourceTimestamp, time + 910000);
  assert.equal(sameWindow.observation.source.archive.table, 'mvp_outcomes');
  assert.ok(recovered.filter(item => item.job.horizon !== '15m').every(item => item.observation === null));
  await DB.batch(prepareOutcomeUpdates(DB, [sameWindow], { runId: 'reuse-large-provenance', now: time + 86400000 }).commands);
  assert.equal(jobState(DB, sameWindow.job.decisionKey).state, 'COMPLETE',
    'an archive pointer preserves provenance without recursively exceeding the source payload limit');
});

test('real due observation stores price, liquidity, original source timestamp and both lags idempotently', async t => {
  const DB = setup(t); const key = await seed(DB);
  const [job] = await queryDueOutcomes(DB, { now: time + 920000 });
  const updates = prepareOutcomeUpdates(DB, [{ job, observation: point(time + 910000) }], { runId: 'outcome-1', now: time + 920000 });
  await DB.batch(updates.commands); await DB.batch(updates.commands);
  let saved = { ...DB.sqlite.prepare('SELECT * FROM mvp_outcomes').get() };
  assert.equal(saved.price_usd, 3); assert.equal(saved.liquidity_usd, 120); assert.equal(saved.return_pct, 50);
  assert.equal(saved.source_timestamp, time + 910000); assert.equal(saved.source_lag_ms, 10000); assert.equal(saved.capture_lag_ms, 20000);
  assert.equal(jobState(DB, key).state, 'COMPLETE'); assert.equal(jobState(DB, key).attempt_count, 1);
  await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: point(time + 930000, { priceUsd: 99 }) }],
    { runId: 'outcome-1', now: time + 940000 }).commands);
  assert.deepEqual({ ...DB.sqlite.prepare('SELECT * FROM mvp_outcomes').get() }, saved, 'replayed run cannot replace original evidence');
  assert.equal(jobState(DB, key).attempt_count, 1);
  assert.equal((await queryDueOutcomes(DB, { now: time + 950000 })).length, 0);
  assert.throws(() => DB.sqlite.exec('UPDATE mvp_outcomes SET price_usd=0'), /MVP_OUTCOME_IMMUTABLE/);
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_outcomes'), /MVP_OUTCOME_APPEND_ONLY/);
});

test('missing and dead-token prices remain unknown and retry indefinitely without invented zero or deletions', async t => {
  const DB = setup(t); const key = await seed(DB, TOKEN(1), { status: 'DEAD' });
  const [job] = await queryDueOutcomes(DB, { now: time + 900000 });
  await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: null }], { runId: 'missing-1', now: time + 900000 }).commands);
  assert.equal(jobState(DB, key).state, 'RETRY'); assert.equal(jobState(DB, key).attempt_count, 1);
  assert.equal(jobState(DB, key).next_attempt_at, time + 960000);
  assert.equal((await queryDueOutcomes(DB, { now: time + 930000 })).length, 0);
  assert.equal((await queryDueOutcomes(DB, { now: time + 960000 })).length, 1);
  const missing = DB.sqlite.prepare('SELECT price_usd,liquidity_usd FROM mvp_outcome_attempts').get();
  assert.equal(missing.price_usd, null); assert.equal(missing.liquidity_usd, null);
  await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: point(time + 970000, { priceUsd: undefined, liquidityUsd: 0, status: 'DEAD' }) }],
    { runId: 'dead-no-price', now: time + 980000 }).commands);
  const dead = DB.sqlite.prepare('SELECT price_usd,liquidity_usd FROM mvp_outcome_attempts WHERE run_id=?').get('dead-no-price');
  assert.equal(dead.price_usd, null); assert.equal(dead.liquidity_usd, 0);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_outcomes').get().n, 0);
  // Arbitrarily many failures preserve the job and source records permanently.
  for (let i = 0; i < 25; i++) await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: null }],
    { runId: `retry-${i}`, now: time + 1000000 + i * 86400000 }).commands);
  assert.equal(jobState(DB, key).attempt_count, 27); assert.equal(jobState(DB, key).state, 'RETRY');
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_tokens').get().n, 1);
  assert.equal(DB.sqlite.prepare('SELECT first_status FROM mvp_decisions').get().first_status, 'DEAD');
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_outcome_jobs'), /MVP_OUTCOME_JOB_PRESERVED/);
});

test('reported real zero is preserved but missing, stale, future and late points cannot complete a job', async t => {
  const DB = setup(t); const key = await seed(DB);
  const [job] = await queryDueOutcomes(DB, { now: time + 900000 });
  const cases = [
    [point(time + 899999), 'SOURCE_BEFORE_DUE'],
    [point(time + 920001), 'FUTURE_SOURCE_TIMESTAMP'],
    [point(time + 1200001), 'SOURCE_OUTSIDE_CAPTURE_WINDOW', time + 1210000],
    [point(undefined), 'SOURCE_TIMESTAMP_MISSING'],
    [point(time + 910000, { priceUsd: NaN }), 'PRICE_OR_LIQUIDITY_UNKNOWN'],
    [point(time + 910000, { source: null }), 'SOURCE_PROVENANCE_MISSING'],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [observation, reason, at = time + 920000] = cases[i];
    const record = prepareOutcomeUpdates(DB, [{ job, observation }], { runId: `invalid-${i}`, now: at });
    assert.equal(record.diagnostics[0].reason, reason); await DB.batch(record.commands);
  }
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_outcomes').get().n, 0);
  await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: point(time + 910000, { priceUsd: 0, liquidityUsd: 0 }) }],
    { runId: 'observed-real-zero', now: time + 930000 }).commands);
  const outcome = DB.sqlite.prepare('SELECT * FROM mvp_outcomes').get();
  assert.equal(outcome.price_usd, 0); assert.equal(outcome.liquidity_usd, 0); assert.equal(outcome.return_pct, -100);
  assert.equal(jobState(DB, key).state, 'COMPLETE');
});

test('historical backfill uses its real due-time source timestamp and records collection delay without lookahead', async t => {
  const DB = setup(t); await seed(DB);
  const [job] = await queryDueOutcomes(DB, { now: time + 900000 });
  const lateCapture = time + 3 * 86400000;
  await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: point(time + 905000) }],
    { runId: 'historical-point', now: lateCapture }).commands);
  const saved = DB.sqlite.prepare('SELECT * FROM mvp_outcomes').get();
  assert.equal(saved.source_lag_ms, 5000); assert.equal(saved.capture_lag_ms, lateCapture - job.dueAt);
  const original = JSON.parse(DB.sqlite.prepare('SELECT features_json FROM mvp_decisions').get().features_json);
  assert.equal(original.capturedAt, new Date(time).toISOString());
  assert.equal(original.values.externalMarket.priceUsd, 2);
});

test('replayed missing attempts cannot be upgraded with changed data and outcomes roll back with fence failure', async t => {
  const DB = setup(t); await seed(DB);
  const [job] = await queryDueOutcomes(DB, { now: time + 900000 });
  await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: null }], { runId: 'same-run', now: time + 900000 }).commands);
  await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: point(time + 910000) }], { runId: 'same-run', now: time + 920000 }).commands);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_outcomes').get().n, 0);
  assert.equal(jobState(DB, job.decisionKey).attempt_count, 1);
  const valid = prepareOutcomeUpdates(DB, [{ job, observation: point(time + 910000) }], { runId: 'fenced-outcome', now: time + 920000 });
  await assert.rejects(DB.batch([...valid.commands, DB.prepare('INSERT OR REPLACE INTO commit_fence(id,ok) VALUES(1,0)')]), /CHECK constraint failed/);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_outcomes').get().n, 0);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_outcome_attempts').get().n, 1);
});

test('constant-time counters exactly track unique inserts, retries and completion even on replay and rollback', async t => {
  const DB = setup(t); await seed(DB);
  let stats = await getMvpStats(DB);
  assert.equal(stats.tokensSeen, 1); assert.equal(stats.decisions, 1); assert.equal(stats.decisionEvents, 1);
  assert.deepEqual(stats.outcomeJobs, { pending: 4, retry: 0, complete: 0 });
  const [job] = await queryDueOutcomes(DB, { now: time + 900000 });
  const missing = prepareOutcomeUpdates(DB, [{ job, observation: null }], { runId: 'missing-stats', now: time + 900000 });
  await DB.batch(missing.commands); await DB.batch(missing.commands);
  stats = await getMvpStats(DB);
  assert.deepEqual(stats.outcomeJobs, { pending: 3, retry: 1, complete: 0 }); assert.equal(stats.outcomeAttempts, 1);
  const valid = prepareOutcomeUpdates(DB, [{ job, observation: point(time + 910000) }], { runId: 'complete-stats', now: time + 920000 });
  await DB.batch(valid.commands); await DB.batch(valid.commands);
  stats = await getMvpStats(DB);
  assert.deepEqual(stats.outcomeJobs, { pending: 3, retry: 0, complete: 1 });
  assert.equal(stats.outcomeAttempts, 2); assert.equal(stats.outcomesComplete, 1);
  await assert.rejects(DB.batch([...prepareDecisionRecords(DB, { runId: 'roll-stats', observedAt: time, decisions: [decision(TOKEN(2))] }).commands,
    DB.prepare('INSERT OR REPLACE INTO commit_fence(id,ok) VALUES(1,0)')]), /CHECK constraint failed/);
  assert.deepEqual(await getMvpStats(DB), stats);
});

test('calibration gate requires 300 unique launches with all four complete nonfuture outcomes in one score/profile cohort', async t => {
  const DB = setup(t);
  const tokens = Array.from({ length: 300 }, (_, i) => TOKEN(i + 1));
  await DB.batch(prepareDecisionRecords(DB, { runId: 'launch-cohort', observedAt: time, decisions: tokens.map(address => decision(address)) }).commands);
  const all = DB.sqlite.prepare('SELECT decision_key,horizon,due_at,allowed_lag_ms FROM mvp_outcome_jobs').all();
  const at = time + OUTCOME_HORIZONS['7d'] + 20000;
  const updates = all.map(row => ({ job: { decisionKey: row.decision_key, horizon: row.horizon, dueAt: row.due_at, allowedLagMs: row.allowed_lag_ms },
    observation: point(row.due_at + 10000) }));
  const finalKey = decisionKey(4663, tokens.at(-1), version, profile);
  const beforeFinal = updates.filter(update => !(update.job.decisionKey === finalKey && update.job.horizon === '7d'));
  await DB.batch(prepareOutcomeUpdates(DB, beforeFinal, { runId: 'complete-299', now: at }).commands);
  let gate = await outcomeEligibility(DB, { scoreVersion: version, profile, now: at, minLaunches: 1 });
  assert.equal(gate.minimumUniqueLaunches, 300); assert.equal(gate.uniqueLaunchesWithCompleteOutcomes, 299); assert.equal(gate.eligible, false);
  assert.equal((await outcomeEligibility(DB, { scoreVersion: version, profile, now: time + 86400000 })).uniqueLaunchesWithCompleteOutcomes, 0,
    'records collected in the future cannot be used in a historical gate');
  await DB.batch(prepareOutcomeUpdates(DB, updates.filter(update => update.job.decisionKey === finalKey && update.job.horizon === '7d'),
    { runId: 'complete-300', now: at }).commands);
  gate = await outcomeEligibility(DB, { scoreVersion: version, profile, now: at });
  assert.equal(gate.uniqueLaunchesWithCompleteOutcomes, 300); assert.equal(gate.eligible, true);
  assert.equal((await outcomeEligibility(DB, { scoreVersion: version, profile: 'SCOUT', now: at })).eligible, false);
  assert.equal((await outcomeEligibility(DB, { scoreVersion: 'other-version', profile, now: at })).eligible, false);
  assert.equal((await getMvpStats(DB)).outcomesComplete, 1200);
});
