import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareDecisionRecords, decisionKey } from '../src/mvp/records.mjs';
import { prepareOutcomeUpdates, OUTCOME_HORIZONS } from '../src/mvp/outcomes.mjs';
import { prepareWeeklyReport, getLatestWeeklyReport, WEEKLY_SCORE_BANDS } from '../src/mvp/weekly-report.mjs';
import { setup, TOKEN, policyHash, time } from './helpers/mvp-sqlite.mjs';

const migration = await readFile(new URL('../cloudflare/migrations/0005_mvp_weekly.sql', import.meta.url), 'utf8');
const WEEK_START = Date.parse('2026-10-19T00:00:00.000Z');
const REPORT_AT = Date.parse('2026-11-02T00:15:00.000Z');
const VERSION = 'weekly-v1';
function db(t) { const DB = setup(t); DB.sqlite.exec(migration); return DB; }
async function seed(DB, n, { score = 80, status = 'REJECTED', scoreVersion = VERSION, profile = 'profile_new',
  observedAt = time, shape = 'new', synthetic = false, marker = true, baseline = 10, extraFeatures = {} } = {}) {
  const features = { externalMarket: { priceUsd: baseline, liquidityUsd: 1000, fetchedAt: new Date(observedAt).toISOString() }, ...extraFeatures };
  if (shape === 'new') features.decision = { score, ...(marker ? { synthetic } : {}) };
  else if (shape === 'legacy-object') features.legacy = { score };
  else features.score = score;
  if (marker) features.snapshot = { synthetic };
  await DB.batch(prepareDecisionRecords(DB, { runId: `decision-${n}-${scoreVersion}-${profile}`, observedAt, decisions: [{
    address: TOKEN(n), status, scoreVersion, profile, policyHash, features, isLaunch: true,
  }] }).commands);
  return decisionKey(4663, TOKEN(n), scoreVersion, profile);
}
async function outcome(DB, key, h, { price = 15, liquidity = 1000, sourceLag = 1000, captureLag = 2000, collectedAt } = {}) {
  const row = DB.sqlite.prepare('SELECT * FROM mvp_outcome_jobs WHERE decision_key=? AND horizon=?').get(key, h);
  const job = { decisionKey: key, horizon: h, dueAt: row.due_at, allowedLagMs: row.allowed_lag_ms };
  const sourceAt = row.due_at + sourceLag;
  await DB.batch(prepareOutcomeUpdates(DB, [{ job, observation: { priceUsd: price, liquidityUsd: liquidity,
    sourceTimestamp: sourceAt, source: { provider: 'fixture-observation', trust: 'provider-reported' } } }],
  { runId: `outcome-${key}-${h}`, now: collectedAt ?? row.due_at + captureLag }).commands);
}
function instrument(DB) {
  const calls = []; const original = DB.prepare.bind(DB);
  DB.prepare = sql => {
    const prepared = original(sql); let values = [];
    const bind = prepared.bind.bind(prepared); prepared.bind = (...args) => { values = args; bind(...args); return prepared; };
    for (const method of ['first', 'all', 'run']) {
      const execute = prepared[method].bind(prepared);
      prepared[method] = async () => { calls.push({ sql, method, values }); return execute(); };
    }
    return prepared;
  };
  return calls;
}

test('weekly migration is additive and immutable reports survive repeat migration without changing source evidence', async t => {
  const DB = setup(t);
  DB.sqlite.exec('CREATE TABLE wallet_phase3_fixture(id TEXT PRIMARY KEY,raw_json TEXT)');
  DB.sqlite.prepare('INSERT INTO wallet_phase3_fixture VALUES(?,?)').run('wallet-source', '{"immutable":true}');
  const key = await seed(DB, 1); await outcome(DB, key, '15m');
  const before = ['mvp_decisions', 'mvp_outcomes', 'mvp_stats', 'wallet_phase3_fixture'].map(table => [table,
    DB.sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))]);
  DB.sqlite.exec(migration); DB.sqlite.exec(migration);
  for (const [table, rows] of before) assert.deepEqual(DB.sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })), rows);
  const prepared = await prepareWeeklyReport(DB, { now: REPORT_AT, scoreVersion: VERSION });
  await DB.batch(prepared.commands); DB.sqlite.exec(migration);
  assert.equal((await getLatestWeeklyReport(DB)).totals.realDecisions, 1);
  assert.throws(() => DB.sqlite.exec("UPDATE mvp_weekly_reports SET report_json='{}'"), /MVP_WEEKLY_REPORT_IMMUTABLE/);
  assert.throws(() => DB.sqlite.exec('DELETE FROM mvp_weekly_reports'), /MVP_WEEKLY_REPORT_APPEND_ONLY/);
});

test('default schedule is Monday 00:15 UTC for the cohort two weeks earlier and catches up once during that week', async t => {
  const DB = db(t); const calls = instrument(DB);
  const early = await prepareWeeklyReport(DB, { now: REPORT_AT - 1, scoreVersion: VERSION });
  assert.equal(early.due, false); assert.equal(early.report, null); assert.equal(calls.length, 0);
  const scheduled = await prepareWeeklyReport(DB, { now: REPORT_AT, scoreVersion: VERSION });
  assert.equal(scheduled.due, true); assert.equal(scheduled.commands.length, 1);
  assert.equal(scheduled.report.weekStart, new Date(WEEK_START).toISOString());
  assert.equal(scheduled.report.weekEndExclusive, '2026-10-26T00:00:00.000Z');
  assert.equal(scheduled.report.scheduledFor, new Date(REPORT_AT).toISOString());
  assert.equal(calls[0].method, 'first'); assert.match(calls[0].sql, /WHERE report_key=\?/);
  assert.equal(calls.filter(call => call.sql.startsWith('WITH raw')).length, 1);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_weekly_reports').get().n, 0, 'prepare has no writes');
  await DB.batch(scheduled.commands);
  calls.length = 0;
  const friday = await prepareWeeklyReport(DB, { now: REPORT_AT + 4 * 86400000, scoreVersion: VERSION });
  assert.equal(friday.due, false); assert.deepEqual(friday.commands, []);
  assert.deepEqual(friday.report, scheduled.report);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'first'); assert.match(calls[0].sql, /WHERE report_key=\?/);
  const nextWeek = await prepareWeeklyReport(DB, { now: REPORT_AT + 7 * 86400000, scoreVersion: VERSION });
  assert.equal(nextWeek.due, true); assert.equal(nextWeek.report.weekStart, '2026-10-26T00:00:00.000Z');
});

test('an empty actual cohort yields null averages and explicit zero sample counts, never fabricated returns', async t => {
  const DB = db(t); assert.equal(await getLatestWeeklyReport(DB), null);
  const { report } = await prepareWeeklyReport(DB, { now: REPORT_AT, scoreVersion: VERSION });
  assert.equal(report.totals.sourceDecisions, 0); assert.equal(report.totals.realDecisions, 0);
  assert.deepEqual(report.bands.map(band => band.id), WEEKLY_SCORE_BANDS.map(band => band.id));
  for (const band of report.bands) for (const h of Object.values(band.horizons)) {
    assert.equal(h.denominator, 0); assert.equal(h.returnSamples, 0); assert.equal(h.averageReturnPct, null);
    assert.equal(h.coveragePct, null); assert.equal(h.averagePriceUsd, null);
  }
  assert.equal(report.noBacktest, true); assert.equal(report.noModel, true); assert.equal(report.source.networkCalls, 0);
});

test('all five score bands include rejected and dead decisions, actual zeros, unknown scores and coverage for every horizon', async t => {
  const DB = db(t);
  const scores = [[0, 49], [50, 64], [65, 74], [75, 84], [85, 100]];
  for (let b = 0; b < scores.length; b++) for (let side = 0; side < 2; side++) {
    const key = await seed(DB, b * 2 + side + 1, { score: scores[b][side], status: side ? 'DEAD' : 'REJECTED', shape: side ? 'legacy' : 'new' });
    for (const h of Object.keys(OUTCOME_HORIZONS)) await outcome(DB, key, h,
      { price: side ? 15 : 5, liquidity: side ? 1000 : 0, sourceLag: side ? 2000 : 1000, captureLag: side ? 3000 : 2000 });
  }
  await seed(DB, 11, { score: 90, status: 'PASS' });
  await seed(DB, 12, { score: null, status: 'INCOMPLETE' });
  await seed(DB, 13, { score: '85', shape: 'legacy' });
  await seed(DB, 14, { score: 101, shape: 'legacy-object' });
  const synthetic = await seed(DB, 15, { score: 95, synthetic: true }); await outcome(DB, synthetic, '15m', { price: 100 });
  const unknownProvenance = await seed(DB, 16, { score: 95, marker: false }); await outcome(DB, unknownProvenance, '15m', { price: 100 });
  await seed(DB, 17, { observedAt: WEEK_START - 1000, score: 99 });
  await seed(DB, 18, { observedAt: WEEK_START + 7 * 86400000, score: 99 });
  const { report } = await prepareWeeklyReport(DB, { now: REPORT_AT, scoreVersion: VERSION });
  assert.equal(report.totals.sourceDecisions, 16); assert.equal(report.totals.realDecisions, 14);
  assert.equal(report.totals.syntheticExcluded, 1); assert.equal(report.totals.provenanceUnknownExcluded, 1);
  assert.equal(report.totals.unknownScoreDecisions, 3); assert.equal(report.totals.rejected, 7); assert.equal(report.totals.dead, 5);
  assert.equal(report.unknownScore.decisions, 3);
  for (const band of report.bands) {
    const denominator = band.id === '85-100' ? 3 : 2;
    assert.equal(band.decisions, denominator); assert.equal(band.rejected, 1); assert.equal(band.dead, 1);
    for (const h of Object.values(band.horizons)) {
      assert.equal(h.denominator, denominator); assert.equal(h.observed, 2); assert.equal(h.returnSamples, 2);
      assert.equal(h.averageReturnPct, 0, 'an actual zero mean remains zero');
      assert.equal(h.averagePriceUsd, 10); assert.equal(h.averageLiquidityUsd, 500);
      assert.equal(h.averageSourceLagMs, 1500); assert.equal(h.averageCaptureLagMs, 2500);
      assert.equal(h.coveragePct, 2 / denominator * 100); assert.equal(h.unknown, denominator - 2);
    }
  }
  for (const h of Object.values(report.unknownScore.horizons)) {
    assert.equal(h.denominator, 3); assert.equal(h.averageReturnPct, null); assert.equal(h.returnUnknown, 3);
  }
});

test('new unknown scores never fall back to an unrelated legacy score, and synthetic conflicts are excluded', async t => {
  const DB = db(t);
  await seed(DB, 1, { score: null, extraFeatures: { score: 99 } });
  await seed(DB, 2, { score: 90, marker: false, extraFeatures: { snapshot: { synthetic: true }, synthetic: false } });
  await seed(DB, 3, { score: 90, marker: false, extraFeatures: { snapshot: { synthetic: false }, synthetic: 'false' } });
  const { report } = await prepareWeeklyReport(DB, { now: REPORT_AT, scoreVersion: VERSION });
  assert.equal(report.totals.sourceDecisions, 3); assert.equal(report.totals.realDecisions, 1);
  assert.equal(report.totals.syntheticExcluded, 1); assert.equal(report.totals.provenanceUnknownExcluded, 1);
  assert.equal(report.unknownScore.decisions, 1); assert.equal(report.bands.at(-1).decisions, 0);
});

test('weekly averages use immutable first features and baseline, never later decision observations', async t => {
  const DB = db(t); const key = await seed(DB, 1, { score: 75, status: 'REJECTED' });
  await outcome(DB, key, '15m', { price: 15 });
  await DB.batch(prepareDecisionRecords(DB, { runId: 'later-reassessment', observedAt: time + 60000, decisions: [{
    address: TOKEN(1), status: 'DEAD', scoreVersion: VERSION, profile: 'profile_new', policyHash,
    features: { decision: { score: 99, synthetic: false }, externalMarket: { priceUsd: 100, liquidityUsd: 0 } },
  }] }).commands);
  const { report } = await prepareWeeklyReport(DB, { now: REPORT_AT, scoreVersion: VERSION });
  assert.equal(report.bands.find(band => band.id === '75-84').decisions, 1);
  assert.equal(report.bands.at(-1).decisions, 0);
  assert.equal(report.bands.find(band => band.id === '75-84').horizons['15m'].averageReturnPct, 50);
  assert.equal(report.totals.rejected, 1); assert.equal(report.totals.dead, 0);
});

test('future-collected or missing outcomes stay unknown; explicitly observed dead-token zero stays a real loss', async t => {
  const DB = db(t);
  const zero = await seed(DB, 1, { score: 80, status: 'DEAD' }); await outcome(DB, zero, '15m', { price: 0, liquidity: 0 });
  const delayed = await seed(DB, 2, { score: 80 }); await outcome(DB, delayed, '15m', { price: 30, collectedAt: REPORT_AT + 86400000 });
  const missing = await seed(DB, 3, { score: 80 });
  const row = DB.sqlite.prepare("SELECT * FROM mvp_outcome_jobs WHERE decision_key=? AND horizon='15m'").get(missing);
  await DB.batch(prepareOutcomeUpdates(DB, [{ job: { decisionKey: missing, horizon: '15m', dueAt: row.due_at, allowedLagMs: row.allowed_lag_ms }, observation: null }],
    { runId: 'missing-observation', now: row.due_at + 1000 }).commands);
  const { report } = await prepareWeeklyReport(DB, { now: REPORT_AT, scoreVersion: VERSION });
  const h = report.bands.find(band => band.id === '75-84').horizons['15m'];
  assert.equal(h.denominator, 3); assert.equal(h.observed, 1); assert.equal(h.unknown, 2); assert.equal(h.returnSamples, 1);
  assert.equal(h.averageReturnPct, -100); assert.equal(h.averagePriceUsd, 0); assert.equal(h.averageLiquidityUsd, 0);
});

test('inconsistent stored return labels cannot override the immutable baseline', async t => {
  const DB = db(t); const key = await seed(DB, 1, { score: 80 });
  const job = DB.sqlite.prepare("SELECT * FROM mvp_outcome_jobs WHERE decision_key=? AND horizon='15m'").get(key);
  DB.sqlite.prepare(`INSERT INTO mvp_outcomes(decision_key,horizon,run_id,due_at,allowed_lag_ms,source_timestamp,collected_at,
    source_lag_ms,capture_lag_ms,price_usd,liquidity_usd,return_pct,source_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(key, '15m', 'inconsistent-fixture-label', job.due_at, job.allowed_lag_ms, job.due_at + 1000, job.due_at + 2000,
      1000, 2000, 15, 1000, 999, '{"provider":"fixture"}');
  const { report } = await prepareWeeklyReport(DB, { now: REPORT_AT, scoreVersion: VERSION });
  const h = report.bands.find(band => band.id === '75-84').horizons['15m'];
  assert.equal(h.observed, 1); assert.equal(h.returnSamples, 0); assert.equal(h.averageReturnPct, null); assert.equal(h.returnUnknown, 1);
});

test('score versions and profiles remain separate and pooled token membership is never presented as unique tokens', async t => {
  const DB = db(t);
  await seed(DB, 1, { score: 90, scoreVersion: 'v1', profile: 'profile_new' });
  await seed(DB, 1, { score: 90, scoreVersion: 'v2', profile: 'legacy_new' });
  const all = await prepareWeeklyReport(DB, { now: REPORT_AT }); await DB.batch(all.commands);
  assert.equal(all.report.totals.realDecisions, 2); assert.equal(all.report.totals.uniqueRealTokens, 1);
  assert.equal(all.report.cohorts.length, 2); assert.equal(all.report.bands.at(-1).uniqueTokens, null);
  assert.equal(all.report.bands.at(-1).tokenCohortMemberships, 2);
  for (const cohort of all.report.cohorts) assert.equal(cohort.bands.at(-1).uniqueTokens, 1);
  const v1 = await prepareWeeklyReport(DB, { now: REPORT_AT + 1000, scoreVersion: 'v1' }); await DB.batch(v1.commands);
  assert.equal(v1.report.totals.realDecisions, 1); assert.equal(v1.report.cohorts[0].profile, 'profile_new');
  const v2 = await prepareWeeklyReport(DB, { now: REPORT_AT + 2000, scoreVersion: 'v2' }); await DB.batch(v2.commands);
  assert.equal((await getLatestWeeklyReport(DB, { scoreVersion: 'v1' })).scoreVersion, 'v1');
  assert.equal((await getLatestWeeklyReport(DB)).scoreVersion, 'v2');
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_weekly_reports').get().n, 3);
});

test('report insertion is idempotent and rolls back atomically with a failed collector fence', async t => {
  const DB = db(t); const key = await seed(DB, 1); await outcome(DB, key, '15m');
  const before = DB.sqlite.prepare('SELECT features_json FROM mvp_decisions').get().features_json;
  const first = await prepareWeeklyReport(DB, { now: REPORT_AT, scoreVersion: VERSION });
  await assert.rejects(DB.batch([...first.commands, DB.prepare('INSERT OR REPLACE INTO commit_fence(id,ok) VALUES(1,0)')]), /CHECK constraint failed/);
  assert.equal(await getLatestWeeklyReport(DB), null);
  const retry = await prepareWeeklyReport(DB, { now: REPORT_AT + 1000, scoreVersion: VERSION });
  await DB.batch(retry.commands); await DB.batch(retry.commands);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_weekly_reports').get().n, 1);
  assert.equal(DB.sqlite.prepare('SELECT features_json FROM mvp_decisions').get().features_json, before);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_outcomes').get().n, 1);
});

test('weekly aggregate uses a bounded decision-time index and subsequent minute polls perform only the PK lookup', async t => {
  const DB = db(t); await seed(DB, 1); const calls = instrument(DB);
  const first = await prepareWeeklyReport(DB, { now: REPORT_AT, scoreVersion: VERSION });
  const aggregate = calls.find(call => call.sql.startsWith('WITH raw'));
  const plan = DB.sqlite.prepare('EXPLAIN QUERY PLAN ' + aggregate.sql).all(...aggregate.values);
  assert.ok(plan.some(row => /SEARCH d USING INDEX mvp_decisions_week_version.*score_version=.*first_decision_at/.test(row.detail)));
  assert.equal(plan.some(row => /SCAN d\b/.test(row.detail)), false);
  await DB.batch(first.commands); calls.length = 0;
  for (let minute = 1; minute <= 3; minute++) await prepareWeeklyReport(DB, { now: REPORT_AT + minute * 60000, scoreVersion: VERSION });
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.method === 'first' && /WHERE report_key=\?/.test(call.sql)));
});

test('weekStart overrides require UTC Mondays, wait for maturity and do not replace a newer latest cohort', async t => {
  const DB = db(t);
  await assert.rejects(prepareWeeklyReport(DB, { now: REPORT_AT, weekStart: '2026-10-20T00:00:00Z' }), /MVP_WEEK_START_MUST_BE_MONDAY_UTC/);
  const future = await prepareWeeklyReport(DB, { now: REPORT_AT, weekStart: '2026-10-26T00:00:00Z' });
  assert.equal(future.due, false); assert.equal(future.report, null);
  await DB.batch((await prepareWeeklyReport(DB, { now: REPORT_AT })).commands);
  await DB.batch((await prepareWeeklyReport(DB, { now: REPORT_AT + 1000, weekStart: '2026-10-12T00:00:00Z' })).commands);
  assert.equal((await getLatestWeeklyReport(DB)).weekStart, new Date(WEEK_START).toISOString());
});
