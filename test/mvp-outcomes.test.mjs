import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDecisionRecords, decisionKey, getMvpStats } from '../src/mvp/records.mjs';
import { queryDueOutcomes, prepareOutcomeUpdates, outcomeEligibility, OUTCOME_HORIZONS } from '../src/mvp/outcomes.mjs';
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
  assert.deepEqual(allDue.map(job => job.horizon), ['15m', '1h', '24h', '7d']);
  await assert.rejects(queryDueOutcomes(DB, { now: time, limit: 101 }), /MVP_INVALID_OUTCOME_LIMIT/);
  const before = prepareOutcomeUpdates(DB, [{ job: jobs[0], observation: point(time + 900000) }], { runId: 'early', now: time + 899999 });
  assert.equal(before.commands.length, 0); assert.equal(before.diagnostics[0].result, 'NOT_DUE');
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
