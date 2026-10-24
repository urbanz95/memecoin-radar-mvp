import { recordLabel, recordTime } from './records.mjs';
import { OUTCOME_HORIZONS } from './outcomes.mjs';

const DAY = 86400000;
const WEEK = 7 * DAY;
const START_DELAY = 15 * 60000;
const MAX_GROUP_ROWS = 1000;
const MAX_REPORT_BYTES = 262144;
export const WEEKLY_SCORE_BANDS = Object.freeze([
  Object.freeze({ id: '0-49', min: 0, maxExclusive: 50 }),
  Object.freeze({ id: '50-64', min: 50, maxExclusive: 65 }),
  Object.freeze({ id: '65-74', min: 65, maxExclusive: 75 }),
  Object.freeze({ id: '75-84', min: 75, maxExclusive: 85 }),
  Object.freeze({ id: '85-100', min: 85, maxExclusive: 101 }),
]);
const asOf = value => recordTime(typeof value === 'function' ? value() : value, 'WEEKLY_TIME');
const iso = value => new Date(value).toISOString();
function monday(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - ((date.getUTCDay() + 6) % 7) * DAY;
}
function period(now, override) {
  const start = override === undefined ? monday(now) - 2 * WEEK : recordTime(override, 'WEEK_START');
  if (start !== monday(start)) throw new Error('MVP_WEEK_START_MUST_BE_MONDAY_UTC');
  if (start < 0) throw new Error('MVP_INVALID_WEEK_START');
  return { start, end: start + WEEK, scheduledFor: start + 2 * WEEK + START_DELAY };
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
const numberOrNull = value => finite(value) ? value : null;
const percentage = (count, denominator) => denominator > 0 ? count / denominator * 100 : null;
const count = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('MVP_WEEKLY_INVALID_COUNT');
  return value;
};
function emptyHorizon(denominator = 0) {
  return { denominator, due: 0, observed: 0, returnSamples: 0, unknown: denominator, returnUnknown: denominator, notDue: 0,
    coveragePct: denominator ? 0 : null, matureCoveragePct: null, returnCoveragePct: denominator ? 0 : null,
    averageReturnPct: null, averagePriceUsd: null, averageLiquidityUsd: null,
    averageSourceLagMs: null, averageCaptureLagMs: null, numericOverflow: false };
}
function emptyBand(definition) {
  return { ...definition, decisions: 0, uniqueTokens: 0, rejected: 0, dead: 0, passed: 0, otherStatuses: 0,
    horizons: Object.fromEntries(Object.keys(OUTCOME_HORIZONS).map(h => [h, emptyHorizon()])) };
}
function horizonRow(row) {
  const denominator = count(row.decisions); const observed = count(row.observed); const returns = count(row.return_samples);
  const due = count(row.due);
  const rawAverages = [row.avg_return, row.avg_price, row.avg_liquidity, row.avg_source_lag, row.avg_capture_lag];
  return { denominator, due, observed, returnSamples: returns, unknown: denominator - observed, returnUnknown: denominator - returns,
    notDue: denominator - due, coveragePct: percentage(observed, denominator), matureCoveragePct: percentage(observed, due),
    returnCoveragePct: percentage(returns, denominator), averageReturnPct: numberOrNull(row.avg_return),
    averagePriceUsd: numberOrNull(row.avg_price), averageLiquidityUsd: numberOrNull(row.avg_liquidity),
    averageSourceLagMs: numberOrNull(row.avg_source_lag), averageCaptureLagMs: numberOrNull(row.avg_capture_lag),
    numericOverflow: rawAverages.some(value => value !== null && value !== undefined && !finite(value)) };
}
function combineMean(left, leftCount, right, rightCount) {
  if (!rightCount) return left;
  if (!leftCount) return right;
  if (!finite(left) || !finite(right)) return null;
  const total = leftCount + rightCount;
  return numberOrNull(left * (leftCount / total) + right * (rightCount / total));
}
function mergeHorizon(target, incoming) {
  const returnMean = combineMean(target.averageReturnPct, target.returnSamples, incoming.averageReturnPct, incoming.returnSamples);
  const means = {};
  for (const name of ['averagePriceUsd', 'averageLiquidityUsd', 'averageSourceLagMs', 'averageCaptureLagMs'])
    means[name] = combineMean(target[name], target.observed, incoming[name], incoming.observed);
  for (const name of ['denominator', 'due', 'observed', 'returnSamples', 'unknown', 'returnUnknown', 'notDue']) target[name] += incoming[name];
  Object.assign(target, means, { averageReturnPct: returnMean,
    coveragePct: percentage(target.observed, target.denominator), matureCoveragePct: percentage(target.observed, target.due),
    returnCoveragePct: percentage(target.returnSamples, target.denominator), numericOverflow: target.numericOverflow || incoming.numericOverflow });
}

function aggregateSql(version, dimension = 'token') {
  const sourceIndex = version === undefined ? 'mvp_decisions_week_time' : 'mvp_decisions_week_version';
  const scoreExpression = dimension === 'wallet'
    ? `CASE WHEN json_extract(d.features_json,'$.values.decision.wallets.status')='READY'
      AND json_type(d.features_json,'$.values.decision.wallets.score') IN ('integer','real')
      THEN json_extract(d.features_json,'$.values.decision.wallets.score') END`
    : `CASE WHEN json_type(d.features_json,'$.values.decision')='object'
        THEN CASE WHEN json_type(d.features_json,'$.values.decision.score') IN ('integer','real') THEN json_extract(d.features_json,'$.values.decision.score') END
        WHEN json_type(d.features_json,'$.values.legacy')='object'
        THEN CASE WHEN json_type(d.features_json,'$.values.legacy.score') IN ('integer','real') THEN json_extract(d.features_json,'$.values.legacy.score') END
        ELSE CASE WHEN json_type(d.features_json,'$.values.score') IN ('integer','real') THEN json_extract(d.features_json,'$.values.score') END END`;
  return `WITH raw AS (
    SELECT d.decision_key,d.chain_id,d.address,d.score_version,d.profile,d.first_decision_at,d.first_status,d.baseline_price_usd,
      ${scoreExpression} AS raw_score,
      CASE WHEN json_type(d.features_json,'$.values.decision.synthetic')='true'
          OR json_type(d.features_json,'$.values.snapshot.synthetic')='true' OR json_type(d.features_json,'$.values.synthetic')='true' THEN 1
        WHEN (json_type(d.features_json,'$.values.decision.synthetic') IS NOT NULL AND json_type(d.features_json,'$.values.decision.synthetic') NOT IN ('true','false','null'))
          OR (json_type(d.features_json,'$.values.snapshot.synthetic') IS NOT NULL AND json_type(d.features_json,'$.values.snapshot.synthetic') NOT IN ('true','false','null'))
          OR (json_type(d.features_json,'$.values.synthetic') IS NOT NULL AND json_type(d.features_json,'$.values.synthetic') NOT IN ('true','false','null')) THEN NULL
        WHEN json_type(d.features_json,'$.values.decision.synthetic')='false'
          OR json_type(d.features_json,'$.values.snapshot.synthetic')='false' OR json_type(d.features_json,'$.values.synthetic')='false' THEN 0
        ELSE NULL END AS synthetic
    FROM mvp_decisions d INDEXED BY ${sourceIndex}
    WHERE d.first_decision_at>=? AND d.first_decision_at<? ${version === undefined ? '' : 'AND d.score_version=?'}
  ), base AS (
    SELECT raw.*,CASE WHEN raw_score>=0 AND raw_score<50 THEN '0-49'
      WHEN raw_score>=50 AND raw_score<65 THEN '50-64' WHEN raw_score>=65 AND raw_score<75 THEN '65-74'
      WHEN raw_score>=75 AND raw_score<85 THEN '75-84' WHEN raw_score>=85 AND raw_score<=100 THEN '85-100'
      ELSE 'UNKNOWN' END AS band FROM raw
  ), horizons(horizon,offset_ms) AS (VALUES('15m',900000),('1h',3600000),('24h',86400000),('7d',604800000)), real AS (
    SELECT b.*,h.horizon,h.offset_ms,o.price_usd,o.liquidity_usd,o.return_pct,o.source_lag_ms,o.capture_lag_ms,
      CASE WHEN o.return_pct IS NOT NULL AND b.baseline_price_usd>0
        AND abs(o.return_pct-(o.price_usd/b.baseline_price_usd-1)*100)<=0.000000001*max(1,abs(o.return_pct))
        THEN o.return_pct END AS verified_return
    FROM base b CROSS JOIN horizons h
    LEFT JOIN mvp_outcomes o ON o.decision_key=b.decision_key AND o.horizon=h.horizon
      AND o.due_at=b.first_decision_at+h.offset_ms AND o.collected_at<=? AND o.source_timestamp<=?
      AND o.source_timestamp>=o.due_at AND o.source_timestamp<=o.due_at+o.allowed_lag_ms
      AND o.source_timestamp<=o.collected_at
    WHERE b.synthetic=0
  )
  SELECT 'TOTALS' AS kind,NULL AS score_version,NULL AS profile,NULL AS band,NULL AS horizon,
    count(*) AS decisions,count(DISTINCT printf('%d:%s',chain_id,address)) AS unique_tokens,
    count(DISTINCT CASE WHEN synthetic=0 THEN printf('%d:%s',chain_id,address) END) AS real_unique_tokens,
    coalesce(sum(synthetic=0),0) AS real_decisions,coalesce(sum(synthetic=1),0) AS synthetic_excluded,
    coalesce(sum(synthetic IS NULL),0) AS provenance_unknown,
    coalesce(sum(synthetic=0 AND band='UNKNOWN'),0) AS unknown_scores,
    coalesce(sum(synthetic=0 AND first_status IN ('REJECTED','BLOCKED')),0) AS rejected,
    coalesce(sum(synthetic=0 AND first_status='DEAD'),0) AS dead,
    coalesce(sum(synthetic=0 AND first_status='PASS'),0) AS passed,
    NULL AS due,NULL AS observed,NULL AS return_samples,NULL AS avg_return,NULL AS avg_price,NULL AS avg_liquidity,NULL AS avg_source_lag,NULL AS avg_capture_lag
  FROM base
  UNION ALL
  SELECT 'BAND' AS kind,score_version,profile,band,horizon,count(*) AS decisions,
    count(DISTINCT printf('%d:%s',chain_id,address)) AS unique_tokens,NULL AS real_unique_tokens,
    NULL AS real_decisions,NULL AS synthetic_excluded,NULL AS provenance_unknown,NULL AS unknown_scores,
    coalesce(sum(first_status IN ('REJECTED','BLOCKED')),0) AS rejected,coalesce(sum(first_status='DEAD'),0) AS dead,
    coalesce(sum(first_status='PASS'),0) AS passed,
    coalesce(sum(first_decision_at+offset_ms<=?),0) AS due,
    count(price_usd) AS observed,count(verified_return) AS return_samples,
    avg(verified_return) AS avg_return,avg(price_usd) AS avg_price,avg(liquidity_usd) AS avg_liquidity,
    avg(source_lag_ms) AS avg_source_lag,avg(capture_lag_ms) AS avg_capture_lag
  FROM real GROUP BY score_version,profile,band,horizon
  LIMIT ${MAX_GROUP_ROWS + 2}`;
}

async function aggregate(DB, window, scoreVersion, at, dimension = 'token') {
  const values = [window.start, window.end, ...(scoreVersion === undefined ? [] : [scoreVersion]), at, at, at];
  const result = await DB.prepare(aggregateSql(scoreVersion, dimension)).bind(...values).all();
  const rows = Array.isArray(result) ? result : result?.results;
  if (!Array.isArray(rows) || rows[0]?.kind !== 'TOTALS') throw new Error('MVP_WEEKLY_INVALID_AGGREGATE');
  if (rows.length > MAX_GROUP_ROWS + 1) throw new Error('MVP_WEEKLY_GROUP_LIMIT_EXCEEDED');
  const totals = rows[0]; const bands = WEEKLY_SCORE_BANDS.map(emptyBand); const unknownScore = emptyBand({ id: 'UNKNOWN', min: null, maxExclusive: null });
  for (const pooled of [...bands, unknownScore]) { pooled.uniqueTokens = null; pooled.tokenCohortMemberships = 0; }
  const cohorts = new Map();
  for (const row of rows.slice(1)) {
    if (!Object.hasOwn(OUTCOME_HORIZONS, row.horizon)) throw new Error('MVP_WEEKLY_INVALID_HORIZON');
    const definition = row.band === 'UNKNOWN' ? unknownScore : bands.find(band => band.id === row.band);
    if (!definition) throw new Error('MVP_WEEKLY_INVALID_BAND');
    const cohortKey = JSON.stringify([row.score_version, row.profile]);
    if (!cohorts.has(cohortKey)) cohorts.set(cohortKey, { scoreVersion: row.score_version, profile: row.profile,
      decisions: 0, rejected: 0, dead: 0, passed: 0, otherStatuses: 0,
      bands: WEEKLY_SCORE_BANDS.map(emptyBand), unknownScore: emptyBand({ id: 'UNKNOWN', min: null, maxExclusive: null }) });
    const cohort = cohorts.get(cohortKey);
    const target = row.band === 'UNKNOWN' ? cohort.unknownScore : cohort.bands.find(band => band.id === row.band);
    const h = horizonRow(row); target.horizons[row.horizon] = h;
    mergeHorizon(definition.horizons[row.horizon], h);
    // Each decision appears once per horizon; count cohort/band denominators
    // only on 15m, never four times and never filter rejected/dead decisions.
    if (row.horizon === '15m') {
      for (const item of [target, definition]) {
        item.decisions += count(row.decisions);
        if (item === definition) item.tokenCohortMemberships += count(row.unique_tokens);
        else item.uniqueTokens += count(row.unique_tokens);
        item.rejected += count(row.rejected); item.dead += count(row.dead); item.passed += count(row.passed);
        item.otherStatuses = item.decisions - item.rejected - item.dead - item.passed;
      }
      cohort.decisions += count(row.decisions); cohort.rejected += count(row.rejected); cohort.dead += count(row.dead); cohort.passed += count(row.passed);
      cohort.otherStatuses = cohort.decisions - cohort.rejected - cohort.dead - cohort.passed;
    }
  }
  return { totals, bands, unknownScore, cohorts: [...cohorts.values()] };
}

function assertReportSize(report) {
  const serialized = JSON.stringify(report);
  if (new TextEncoder().encode(serialized).length > MAX_REPORT_BYTES) throw new Error('MVP_WEEKLY_REPORT_LIMIT_EXCEEDED');
  return serialized;
}

async function storedWalletExtension(DB, key) {
  const row = await DB.prepare('SELECT extension_json FROM mvp_weekly_wallet_bands WHERE report_key=? AND extension_version=1').bind(key).first();
  return row ? JSON.parse(row.extension_json) : null;
}

function withWalletExtension(report, extension) {
  if (!extension) return report;
  const cohorts = new Map(extension.cohorts.map(cohort => [JSON.stringify([cohort.scoreVersion, cohort.profile]), cohort]));
  const combined = { ...report,
    totals: { ...report.totals, unknownWalletScoreDecisions: extension.unknownWalletScoreDecisions },
    walletScoreReport: extension.metadata, walletScoreBands: extension.walletScoreBands, walletUnknownScore: extension.walletUnknownScore,
    cohorts: report.cohorts.map(cohort => ({ ...cohort,
      walletScoreBands: cohorts.get(JSON.stringify([cohort.scoreVersion, cohort.profile]))?.walletScoreBands ?? null,
      walletUnknownScore: cohorts.get(JSON.stringify([cohort.scoreVersion, cohort.profile]))?.walletUnknownScore ?? null })) };
  assertReportSize(combined);
  return combined;
}

async function prepareWalletExtension(DB, report, at) {
  const cutoff = recordTime(report.dataCutoff, 'WEEKLY_WALLET_CUTOFF');
  const result = await aggregate(DB, { start: recordTime(report.weekStart, 'WEEK_START'), end: recordTime(report.weekEndExclusive, 'WEEK_END') },
    report.scoreVersion ?? undefined, cutoff, 'wallet');
  const expected = report.totals;
  const matches = [['decisions', 'sourceDecisions'], ['unique_tokens', 'uniqueSourceTokens'], ['real_unique_tokens', 'uniqueRealTokens'],
    ['real_decisions', 'realDecisions'], ['synthetic_excluded', 'syntheticExcluded'], ['provenance_unknown', 'provenanceUnknownExcluded'],
    ['rejected', 'rejected'], ['dead', 'dead'], ['passed', 'passed']].every(([source, target]) => count(result.totals[source]) === expected[target])
    && result.cohorts.length === report.cohorts.length && result.cohorts.every(cohort => report.cohorts.some(prior =>
      prior.scoreVersion === cohort.scoreVersion && prior.profile === cohort.profile && prior.decisions === cohort.decisions));
  const extension = { metadata: { schemaVersion: 1, status: matches ? 'READY' : 'COHORT_CHANGED', generatedAt: iso(at), dataCutoff: report.dataCutoff,
    source: 'Immutable first-decision values.decision.wallets.score, only when wallets.status is READY and score is numeric 0–100.',
    returns: 'Token price returns grouped by decision-time aggregate wallet quality; not realized wallet PnL.',
    unknowns: 'Legacy, missing, incomplete and invalid wallet scores remain UNKNOWN; rejected and dead tokens remain in the denominator.',
    ...(matches ? {} : { reason: 'The immutable historical report cohort differs from the current ledger; wallet groups cannot be reconstructed safely.' }) },
    unknownWalletScoreDecisions: matches ? count(result.totals.unknown_scores) : null,
    walletScoreBands: matches ? result.bands : null, walletUnknownScore: matches ? result.unknownScore : null,
    cohorts: matches ? result.cohorts.map(cohort => ({ scoreVersion: cohort.scoreVersion, profile: cohort.profile,
      walletScoreBands: cohort.bands, walletUnknownScore: cohort.unknownScore })) : [] };
  const serialized = assertReportSize(extension);
  // A racing insert of an older base report must not attach an extension built
  // from a different cutoff. The next cron call can enrich that stored report.
  const command = DB.prepare(`INSERT OR IGNORE INTO mvp_weekly_wallet_bands
    (report_key,extension_version,generated_at,data_cutoff,source_decisions,extension_json)
    SELECT ?,1,?,?,?,? FROM mvp_weekly_reports WHERE report_key=? AND generated_at=? AND source_decisions=?`)
    .bind(report.reportKey, at, cutoff, expected.sourceDecisions, serialized, report.reportKey, cutoff, expected.sourceDecisions);
  return { command, extension };
}

/**
 * Descriptive weekly ledger report, not a backtest/model. Default cohort is two
 * UTC weeks ago, due Monday 00:15 UTC so the final 7d capture window can mature.
 * Original reports remain immutable; additive wallet groups share their cutoff.
 * Repeated cron calls use two primary-key lookups and do no aggregate.
 */
export async function prepareWeeklyReport(DB, { now = Date.now, scoreVersion, weekStart } = {}) {
  const at = asOf(now); const window = period(at, weekStart);
  if (scoreVersion !== undefined) recordLabel(scoreVersion, 'WEEKLY_SCORE_VERSION', 100);
  const key = JSON.stringify([window.start, scoreVersion ?? null]);
  if (at < window.scheduledFor) return { commands: [], report: null, due: false };
  const prior = await DB.prepare('SELECT report_json FROM mvp_weekly_reports WHERE report_key=?').bind(key).first();
  if (prior) {
    const report = JSON.parse(prior.report_json); const stored = await storedWalletExtension(DB, key);
    if (stored) return { commands: [], report: withWalletExtension(report, stored), due: false };
    const prepared = await prepareWalletExtension(DB, report, at);
    return { commands: [prepared.command], report: withWalletExtension(report, prepared.extension), due: false };
  }
  const { totals, bands, unknownScore, cohorts } = await aggregate(DB, window, scoreVersion, at);
  const report = { schemaVersion: 1, kind: 'mvp-weekly-observation-report', reportKey: key,
    scoreVersion: scoreVersion ?? null, weekStart: iso(window.start), weekEndExclusive: iso(window.end),
    scheduledFor: iso(window.scheduledFor), generatedAt: iso(at), dataCutoff: iso(at),
    source: { decisions: 'mvp_decisions.first_decision_at + immutable features_json', outcomes: 'mvp_outcomes', networkCalls: 0 },
    totals: { sourceDecisions: count(totals.decisions), uniqueSourceTokens: count(totals.unique_tokens),
      uniqueRealTokens: count(totals.real_unique_tokens),
      realDecisions: count(totals.real_decisions), syntheticExcluded: count(totals.synthetic_excluded),
      provenanceUnknownExcluded: count(totals.provenance_unknown), unknownScoreDecisions: count(totals.unknown_scores),
      rejected: count(totals.rejected), dead: count(totals.dead), passed: count(totals.passed) },
    bands, unknownScore, cohorts,
    methodology: { denominator: 'All real first decisions in the cohort, including rejected and dead tokens; unknown scores are separate.',
      synthetic: 'Explicit synthetic observations excluded; missing or invalid synthetic provenance excluded and counted separately.',
      returns: 'Mean stored price return against the immutable first-decision baseline; not executed trade PnL and not a backtest.',
      unknowns: 'Missing/stale/not-yet-captured outcomes remain unknown; no dead-token zero is fabricated.',
      versions: scoreVersion === undefined ? 'All versions included; separate version/profile cohorts are provided. Pooled counts can repeat a token across versions/profiles.' : 'Only the requested score version; profiles remain separate.',
      schedule: 'Monday 00:15 UTC; cohort two UTC weeks earlier; catch-up once later in the same reporting week.' },
    noBacktest: true, noModel: true };
  const serialized = assertReportSize(report);
  const command = DB.prepare(`INSERT OR IGNORE INTO mvp_weekly_reports
    (report_key,score_version,week_start,week_end,scheduled_for,generated_at,source_decisions,real_decisions,synthetic_excluded,provenance_unknown_excluded,report_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(key, scoreVersion ?? null, window.start, window.end, window.scheduledFor, at,
      report.totals.sourceDecisions, report.totals.realDecisions, report.totals.syntheticExcluded, report.totals.provenanceUnknownExcluded, serialized);
  const prepared = await prepareWalletExtension(DB, report, at);
  return { commands: [command, prepared.command], report: withWalletExtension(report, prepared.extension), due: true };
}

export async function getLatestWeeklyReport(DB, { scoreVersion } = {}) {
  if (scoreVersion !== undefined) recordLabel(scoreVersion, 'WEEKLY_SCORE_VERSION', 100);
  const query = scoreVersion === undefined ? DB.prepare('SELECT report_json FROM mvp_weekly_reports ORDER BY week_start DESC,generated_at DESC LIMIT 1')
    : DB.prepare('SELECT report_json FROM mvp_weekly_reports WHERE score_version=? ORDER BY week_start DESC,generated_at DESC LIMIT 1').bind(scoreVersion);
  const row = await query.first();
  if (!row) return null;
  const report = JSON.parse(row.report_json);
  return withWalletExtension(report, await storedWalletExtension(DB, report.reportKey));
}
