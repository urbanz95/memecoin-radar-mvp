import { decisionKey, recordLabel, recordTime, sourceRecord } from './records.mjs';

export const OUTCOME_HORIZONS = Object.freeze({ '15m': 900000, '1h': 3600000, '24h': 86400000, '7d': 604800000 });
const clock = now => recordTime(typeof now === 'function' ? now() : now, 'OUTCOME_TIME');
const metric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nullableMetric = value => metric(value) ? value : null;
const horizon = value => { if (!Object.hasOwn(OUTCOME_HORIZONS, value)) throw new Error('MVP_INVALID_HORIZON'); return value; };

/** Read-only quota-bounded queue query; does not claim or delete pending jobs. */
export async function queryDueOutcomes(DB, { now = Date.now, limit = 4 } = {}) {
  const at = clock(now);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('MVP_INVALID_OUTCOME_LIMIT');
  const response = await DB.prepare(`SELECT j.*,d.chain_id,d.address,d.score_version,d.profile,d.policy_hash,
    d.first_decision_at,d.first_status,d.is_launch,d.baseline_price_usd,d.baseline_liquidity_usd
    FROM mvp_outcome_jobs j JOIN mvp_decisions d ON d.decision_key=j.decision_key
    WHERE j.state IN ('PENDING','RETRY') AND j.due_at<=? AND j.next_attempt_at<=?
    ORDER BY j.due_at,j.next_attempt_at,j.decision_key,j.horizon LIMIT ?`).bind(at, at, limit).all();
  const rows = Array.isArray(response) ? response : response?.results;
  if (!Array.isArray(rows)) throw new Error('MVP_INVALID_OUTCOME_QUEUE_RESPONSE');
  return rows.map(row => ({ decisionKey: row.decision_key, chainId: row.chain_id, address: row.address,
    scoreVersion: row.score_version, profile: row.profile, policyHash: row.policy_hash, horizon: row.horizon,
    dueAt: row.due_at, allowedLagMs: row.allowed_lag_ms, attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at, firstDecisionAt: row.first_decision_at, firstStatus: row.first_status,
    isLaunch: row.is_launch === 1, baselinePriceUsd: row.baseline_price_usd, baselineLiquidityUsd: row.baseline_liquidity_usd }));
}

function assessPoint(job, observation, at) {
  const price = nullableMetric(observation?.priceUsd);
  const liquidity = nullableMetric(observation?.liquidityUsd);
  let source = sourceRecord({ status: 'UNKNOWN', reason: 'No source observation available' });
  let sourceAt = null;
  if (!observation || typeof observation !== 'object' || Array.isArray(observation))
    return { kind: 'MISSING', reason: 'MISSING_OBSERVATION', price, liquidity, sourceAt, source };
  try { source = sourceRecord(observation.source); }
  catch { return { kind: 'INVALID', reason: 'SOURCE_PROVENANCE_MISSING', price, liquidity, sourceAt, source }; }
  try { sourceAt = recordTime(observation.sourceTimestamp, 'SOURCE_TIMESTAMP'); }
  catch { return { kind: 'MISSING', reason: 'SOURCE_TIMESTAMP_MISSING', price, liquidity, sourceAt, source }; }
  if (sourceAt > at) return { kind: 'INVALID', reason: 'FUTURE_SOURCE_TIMESTAMP', price, liquidity, sourceAt, source };
  if (sourceAt < job.dueAt) return { kind: 'MISSING', reason: 'SOURCE_BEFORE_DUE', price, liquidity, sourceAt, source };
  if (sourceAt > job.dueAt + job.allowedLagMs)
    return { kind: 'MISSING', reason: 'SOURCE_OUTSIDE_CAPTURE_WINDOW', price, liquidity, sourceAt, source };
  if (price === null || liquidity === null)
    return { kind: 'MISSING', reason: 'PRICE_OR_LIQUIDITY_UNKNOWN', price, liquidity, sourceAt, source };
  return { kind: 'COMPLETE', reason: 'OBSERVED', price, liquidity, sourceAt, source };
}

/**
 * updates: [{job: queueJob, observation: {priceUsd, liquidityUsd,
 * sourceTimestamp: ISO|epochMs, source: provider/RPC provenance}}].
 * Missing points remain retryable indefinitely. Historical backfills are valid
 * only when their actual source timestamp falls inside the due capture window.
 * Append returned commands to a fenced/atomic D1 batch; no writes occur here.
 */
export function prepareOutcomeUpdates(DB, updates, { runId, now = Date.now } = {}) {
  recordLabel(runId, 'RUN_ID'); const at = clock(now);
  if (!Array.isArray(updates)) throw new Error('MVP_INVALID_OUTCOME_UPDATES');
  const commands = []; const diagnostics = []; const unique = new Set();
  for (const update of updates) {
    const job = update?.job ?? update;
    if (!job || typeof job !== 'object') throw new Error('MVP_INVALID_OUTCOME_JOB');
    recordLabel(job.decisionKey, 'DECISION_KEY', 500); horizon(job.horizon);
    const dueAt = recordTime(job.dueAt, 'DUE_AT');
    if (!Number.isSafeInteger(job.allowedLagMs) || job.allowedLagMs < 0 || job.allowedLagMs > 86400000)
      throw new Error('MVP_INVALID_OUTCOME_LAG');
    const id = JSON.stringify([job.decisionKey, job.horizon]);
    if (unique.has(id)) throw new Error('MVP_DUPLICATE_OUTCOME_UPDATE');
    unique.add(id);
    if (at < dueAt) { diagnostics.push({ decisionKey: job.decisionKey, horizon: job.horizon, result: 'NOT_DUE' }); continue; }
    const point = assessPoint(job, update.observation ?? update.point ?? null, at);
    diagnostics.push({ decisionKey: job.decisionKey, horizon: job.horizon, result: point.kind, reason: point.reason });
    commands.push(DB.prepare(`INSERT OR IGNORE INTO mvp_outcome_attempts
      (decision_key,horizon,run_id,attempted_at,result_kind,reason,source_timestamp,price_usd,liquidity_usd,source_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(job.decisionKey, job.horizon, runId, at, point.kind, point.reason,
      point.sourceAt, point.price, point.liquidity, point.source));
    // Read from the immutable attempt just inserted, not the replay's arguments.
    // A repeated runId cannot replace an earlier missing attempt with a new point.
    commands.push(DB.prepare(`INSERT OR IGNORE INTO mvp_outcomes
      (decision_key,horizon,run_id,due_at,allowed_lag_ms,source_timestamp,collected_at,source_lag_ms,capture_lag_ms,
       price_usd,liquidity_usd,return_pct,source_json)
      SELECT a.decision_key,a.horizon,a.run_id,j.due_at,j.allowed_lag_ms,a.source_timestamp,a.attempted_at,
        a.source_timestamp-j.due_at,a.attempted_at-j.due_at,a.price_usd,a.liquidity_usd,
        CASE WHEN d.baseline_price_usd>0 AND abs(a.price_usd/d.baseline_price_usd)<1.0e306
          THEN (a.price_usd/d.baseline_price_usd-1)*100 ELSE NULL END,a.source_json
      FROM mvp_outcome_attempts a JOIN mvp_outcome_jobs j ON j.decision_key=a.decision_key AND j.horizon=a.horizon
        JOIN mvp_decisions d ON d.decision_key=a.decision_key
      WHERE a.decision_key=? AND a.horizon=? AND a.run_id=? AND a.result_kind='COMPLETE'
        AND a.source_timestamp>=j.due_at AND a.source_timestamp<=j.due_at+j.allowed_lag_ms
        AND a.source_timestamp<=a.attempted_at AND a.price_usd IS NOT NULL AND a.liquidity_usd IS NOT NULL`)
      .bind(job.decisionKey, job.horizon, runId));
    commands.push(DB.prepare(`UPDATE mvp_outcome_jobs SET
      state=CASE WHEN EXISTS(SELECT 1 FROM mvp_outcomes o WHERE o.decision_key=mvp_outcome_jobs.decision_key AND o.horizon=mvp_outcome_jobs.horizon)
        THEN 'COMPLETE' ELSE 'RETRY' END,
      attempt_count=(SELECT count(*) FROM mvp_outcome_attempts a WHERE a.decision_key=mvp_outcome_jobs.decision_key AND a.horizon=mvp_outcome_jobs.horizon),
      last_attempt_at=(SELECT max(attempted_at) FROM mvp_outcome_attempts a WHERE a.decision_key=mvp_outcome_jobs.decision_key AND a.horizon=mvp_outcome_jobs.horizon),
      last_reason=(SELECT reason FROM mvp_outcome_attempts a WHERE a.decision_key=mvp_outcome_jobs.decision_key AND a.horizon=mvp_outcome_jobs.horizon ORDER BY attempted_at DESC,run_id DESC LIMIT 1),
      next_attempt_at=CASE WHEN EXISTS(SELECT 1 FROM mvp_outcomes o WHERE o.decision_key=mvp_outcome_jobs.decision_key AND o.horizon=mvp_outcome_jobs.horizon)
        THEN NULL ELSE (SELECT max(attempted_at)+min(86400000,60000*(1 << min(10,max(0,count(*)-1))))
          FROM mvp_outcome_attempts a WHERE a.decision_key=mvp_outcome_jobs.decision_key AND a.horizon=mvp_outcome_jobs.horizon) END
      WHERE decision_key=? AND horizon=?`).bind(job.decisionKey, job.horizon));
  }
  return { commands, diagnostics };
}

/** Count each launch once within one explicit immutable score/profile cohort. */
export async function outcomeEligibility(DB, { scoreVersion, profile, now = Date.now, minLaunches = 300 } = {}) {
  recordLabel(scoreVersion, 'SCORE_VERSION', 100); recordLabel(profile, 'PROFILE', 80);
  const at = clock(now);
  if (!Number.isSafeInteger(minLaunches) || minLaunches < 0) throw new Error('MVP_INVALID_MIN_LAUNCHES');
  const minimum = Math.max(300, minLaunches);
  const row = await DB.prepare(`SELECT count(*) AS total FROM (
    SELECT d.chain_id,d.address FROM mvp_decisions d JOIN mvp_outcomes o ON o.decision_key=d.decision_key
    WHERE d.score_version=? AND d.profile=? AND d.is_launch=1 AND d.first_decision_at<=? AND d.baseline_price_usd>0
      AND o.collected_at<=? AND o.source_timestamp<=? AND o.return_pct IS NOT NULL
    GROUP BY d.chain_id,d.address HAVING count(DISTINCT o.horizon)=4
  )`).bind(scoreVersion, profile, at, at, at).first();
  const count = Number(row?.total ?? 0);
  return { schemaVersion: 1, scoreVersion, profile, asOf: new Date(at).toISOString(), minimumUniqueLaunches: minimum,
    uniqueLaunchesWithCompleteOutcomes: count, eligible: count >= minimum,
    reason: count >= minimum ? 'MINIMUM_OUTCOMES_RECORDED' : 'INSUFFICIENT_COMPLETE_LAUNCH_OUTCOMES' };
}

export { decisionKey };
