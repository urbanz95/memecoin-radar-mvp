import { decisionKey, recordLabel, recordTime, sourceRecord, canonicalDecisionSql } from './records.mjs';
import { createHash } from 'node:crypto';
import { NETWORK, QUOTE_ASSETS, isEvmAddress } from '../network.mjs';

export const OUTCOME_HORIZONS = Object.freeze({ '15m': 900000, '1h': 3600000, '24h': 86400000, '7d': 604800000 });
const clock = now => recordTime(typeof now === 'function' ? now() : now, 'OUTCOME_TIME');
const metric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nullableMetric = value => metric(value) ? value : null;
const horizon = value => { if (!Object.hasOwn(OUTCOME_HORIZONS, value)) throw new Error('MVP_INVALID_HORIZON'); return value; };

/**
 * Read-only quota-bounded queue query. `limit` bounds distinct token fetches;
 * maxJobs bounds fanout across their immutable score/profile versions. Capture
 * windows which are still open always precede expired historical-only work.
 */
export async function queryDueOutcomes(DB, { now = Date.now, limit = 4, maxJobs = Math.max(24, limit) } = {}) {
  const at = clock(now);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('MVP_INVALID_OUTCOME_LIMIT');
  if (!Number.isSafeInteger(maxJobs) || maxJobs < limit || maxJobs > 100) throw new Error('MVP_INVALID_OUTCOME_JOB_LIMIT');
  const response = await DB.prepare(`WITH candidates AS MATERIALIZED (
    SELECT j.*,d.chain_id,d.address,d.score_version,d.profile,d.policy_hash,
      d.first_decision_at,d.first_status,d.is_launch,d.baseline_price_usd,d.baseline_liquidity_usd,
      CASE WHEN j.due_at+j.allowed_lag_ms>=? THEN 0 ELSE 1 END AS capture_priority
    FROM mvp_outcome_jobs j JOIN mvp_decisions d ON d.decision_key=j.decision_key
    WHERE j.state IN ('PENDING','RETRY') AND j.due_at<=? AND j.next_attempt_at<=?
      AND ${canonicalDecisionSql('d')}
  ), tokens AS (
    SELECT chain_id,address,min(capture_priority) AS priority,
      min(CASE WHEN capture_priority=0 THEN due_at+allowed_lag_ms END) AS closing_at,
      min(next_attempt_at) AS retry_at FROM candidates GROUP BY chain_id,address
  ), selected AS (
    SELECT *,row_number() OVER (ORDER BY priority,closing_at,retry_at,chain_id,address) AS token_rank
      FROM tokens ORDER BY priority,closing_at,retry_at,chain_id,address LIMIT ?
  ), fanout AS (
    SELECT c.*,s.token_rank,row_number() OVER (PARTITION BY c.chain_id,c.address
      ORDER BY c.capture_priority,CASE WHEN c.capture_priority=0 THEN c.due_at+c.allowed_lag_ms ELSE c.next_attempt_at END,
        c.due_at,c.decision_key,c.horizon) AS job_rank
    FROM candidates c JOIN selected s ON s.chain_id=c.chain_id AND s.address=c.address
  ) SELECT * FROM fanout ORDER BY capture_priority,job_rank,token_rank LIMIT ?`).bind(at, at, at, limit, maxJobs).all();
  const rows = Array.isArray(response) ? response : response?.results;
  if (!Array.isArray(rows)) throw new Error('MVP_INVALID_OUTCOME_QUEUE_RESPONSE');
  return rows.map(row => ({ decisionKey: row.decision_key, chainId: row.chain_id, address: row.address,
    scoreVersion: row.score_version, profile: row.profile, policyHash: row.policy_hash, horizon: row.horizon,
    dueAt: row.due_at, allowedLagMs: row.allowed_lag_ms, attemptCount: row.attempt_count,
    captureState: row.capture_priority === 0 ? 'LIVE' : 'EXPIRED',
    nextAttemptAt: row.next_attempt_at, firstDecisionAt: row.first_decision_at, firstStatus: row.first_status,
    isLaunch: row.is_launch === 1, baselinePriceUsd: row.baseline_price_usd, baselineLiquidityUsd: row.baseline_liquidity_usd }));
}

const MARKET_MAX_AGE_MS = 120000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const zeroAddress = '0x' + '0'.repeat(40);

function marketObservation(entry, collectedAt) {
  const market = entry?.externalMarket;
  const address = lower(entry?.address);
  if (!isEvmAddress(address) || !object(market) || market.chainId !== NETWORK.chainId
    || market.chain !== NETWORK.chain || lower(market.baseTokenAddress) !== address)
    return { reason: 'MARKET_IDENTITY_INVALID' };
  if (market.source !== 'dexscreener' || market.trust !== 'provider-reported') return { reason: 'MARKET_SOURCE_INVALID' };
  const pair = lower(market.pairAddress);
  const poolId = market.poolType === 'v4' && market.pairKind === 'pool-id' && /^0x[0-9a-f]{64}$/.test(pair);
  if (!isEvmAddress(pair) && !poolId) return { reason: 'MARKET_PAIR_INVALID' };
  const quote = lower(market.quoteTokenAddress);
  const native = market.poolType === 'v4' && market.quoteAsset === 'ETH' && quote === zeroAddress;
  if (!native && (!Object.hasOwn(QUOTE_ASSETS, market.quoteAsset) || QUOTE_ASSETS[market.quoteAsset] !== quote))
    return { reason: 'MARKET_QUOTE_INVALID' };
  if (!metric(market.priceUsd) || !metric(market.liquidityUsd)) return { reason: 'PRICE_OR_LIQUIDITY_UNKNOWN' };
  let sourceAt;
  try { sourceAt = recordTime(market.fetchedAt, 'SOURCE_TIMESTAMP'); }
  catch { return { reason: 'SOURCE_TIMESTAMP_MISSING' }; }
  if (sourceAt > collectedAt) return { reason: 'FUTURE_SOURCE_TIMESTAMP' };
  if (collectedAt - sourceAt > MARKET_MAX_AGE_MS) return { reason: 'STALE_MARKET_OBSERVATION' };
  const key = createHash('sha256').update(JSON.stringify([NETWORK.chainId, address, pair, market.source, sourceAt])).digest('hex');
  return { key, chainId: NETWORK.chainId, address, pair, provider: market.source, quote, sourceAt,
    price: market.priceUsd, liquidity: market.liquidityUsd,
    source: sourceRecord({ provider: market.source, trust: market.trust, chainId: NETWORK.chainId,
      baseTokenAddress: address, pairAddress: pair, pairKind: poolId ? 'pool-id' : 'address',
      quoteTokenAddress: quote, quoteAsset: market.quoteAsset, sourceTimestamp: sourceAt }) };
}

/**
 * Preserve every valid freshly fetched source point, including rejected tokens.
 * No extra provider requests and no writes occur here. Append commands to the
 * collector's fenced batch. Cached runs must pass refreshed:false (or skip).
 * Repeated original source timestamps have the same immutable observation key.
 */
export function prepareMarketObservations(DB, entries, { runId, observedAt, refreshed = true } = {}) {
  recordLabel(runId, 'RUN_ID'); const at = clock(observedAt);
  if (!Array.isArray(entries) || entries.length > 100) throw new Error('MVP_INVALID_MARKET_OBSERVATIONS');
  if (typeof refreshed !== 'boolean') throw new Error('MVP_INVALID_MARKET_REFRESH');
  const commands = []; const diagnostics = []; const seen = new Map();
  const counts = { considered: entries.length, prepared: 0, skipped: 0, duplicates: 0 };
  if (!refreshed) return { commands, counts: { ...counts, skipped: entries.length }, diagnostics };
  for (const entry of entries) {
    const point = marketObservation(entry, at);
    if (point.reason) { counts.skipped++; diagnostics.push({ address: entry?.address ?? null, reason: point.reason }); continue; }
    const previous = seen.get(point.key);
    if (previous) {
      if (point.price !== previous.price || point.liquidity !== previous.liquidity) throw new Error('MVP_MARKET_OBSERVATION_CONFLICT');
      counts.duplicates++; continue;
    }
    seen.set(point.key, point); counts.prepared++;
    commands.push(DB.prepare(`INSERT OR IGNORE INTO mvp_market_observations
      (observation_key,chain_id,address,pair_address,provider,quote_address,source_timestamp,collected_at,
        price_usd,liquidity_usd,run_id,source_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(point.key, point.chainId, point.address, point.pair, point.provider, point.quote, point.sourceAt, at,
        point.price, point.liquidity, runId, point.source));
  }
  return { commands, counts, diagnostics };
}

/** Exact-window reuse of immutable observations; current prices are never backdated. */
export async function queryArchivedOutcomePoints(DB, jobs, { now = Date.now } = {}) {
  const at = clock(now);
  if (!Array.isArray(jobs) || jobs.length > 100) throw new Error('MVP_INVALID_ARCHIVE_JOBS');
  const wanted = jobs.map((job, index) => {
    if (!object(job) || !Number.isSafeInteger(job.chainId) || job.chainId < 1 || !isEvmAddress(job.address))
      throw new Error('MVP_INVALID_OUTCOME_JOB');
    recordLabel(job.decisionKey, 'DECISION_KEY', 500); horizon(job.horizon);
    const due = recordTime(job.dueAt, 'DUE_AT');
    if (!Number.isSafeInteger(job.allowedLagMs) || job.allowedLagMs < 0 || job.allowedLagMs > 86400000)
      throw new Error('MVP_INVALID_OUTCOME_LAG');
    return [index, job.chainId, lower(job.address), due, due + job.allowedLagMs];
  });
  if (!wanted.length) return [];
  const response = await DB.prepare(`WITH wanted AS (
    SELECT json_extract(value,'$[0]') AS job_index,json_extract(value,'$[1]') AS chain_id,
      json_extract(value,'$[2]') AS address,json_extract(value,'$[3]') AS due_at,
      json_extract(value,'$[4]') AS closes_at FROM json_each(?)
  ), points AS (
    SELECT w.job_index,m.source_timestamp,m.collected_at,m.price_usd,m.liquidity_usd,m.source_json,m.run_id,
      'mvp_market_observations' AS archive_table,m.observation_key AS archive_key
    FROM wanted w JOIN mvp_market_observations m ON m.chain_id=w.chain_id AND m.address=w.address
      AND m.source_timestamp>=w.due_at AND m.source_timestamp<=w.closes_at
    WHERE m.source_timestamp<=? AND m.collected_at<=?
    UNION ALL
    SELECT w.job_index,o.source_timestamp,o.collected_at,o.price_usd,o.liquidity_usd,o.source_json,o.run_id,
      'mvp_outcomes' AS archive_table,json_array(o.decision_key,o.horizon) AS archive_key
    FROM wanted w JOIN mvp_decisions d ON d.chain_id=w.chain_id AND d.address=w.address
      JOIN mvp_outcomes o ON o.decision_key=d.decision_key
        AND o.source_timestamp>=w.due_at AND o.source_timestamp<=w.closes_at
    WHERE o.source_timestamp<=? AND o.collected_at<=? AND ${canonicalDecisionSql('d')}
  ), ranked AS (
    SELECT *,row_number() OVER (PARTITION BY job_index ORDER BY source_timestamp,collected_at,archive_table,archive_key) AS rank
    FROM points WHERE price_usd>=0 AND liquidity_usd>=0 AND source_timestamp<=collected_at
  ) SELECT * FROM ranked WHERE rank=1 ORDER BY job_index`).bind(JSON.stringify(wanted), at, at, at, at).all();
  const rows = Array.isArray(response) ? response : response?.results;
  if (!Array.isArray(rows)) throw new Error('MVP_INVALID_OUTCOME_ARCHIVE_RESPONSE');
  const points = new Map(rows.map(row => {
    const stored = JSON.parse(row.source_json);
    // Keep the original provider provenance and identify the immutable evidence
    // used for this recovery, rather than claiming it was observed this run.
    const original = stored?.provenance;
    const provider = object(original) ? original.provider ?? original.source : original;
    const source = { provider: typeof provider === 'string' && provider.length <= 160 ? provider : 'archived-observation',
      trust: object(original) && typeof original.trust === 'string' && original.trust.length <= 80 ? original.trust : 'archived',
      chainId: wanted[row.job_index][1], baseTokenAddress: wanted[row.job_index][2],
      archive: { table: row.archive_table, key: row.archive_key, runId: row.run_id, collectedAt: row.collected_at } };
    if (object(original) && typeof original.pairAddress === 'string' && /^0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/.test(original.pairAddress))
      source.pairAddress = original.pairAddress;
    return [row.job_index, { priceUsd: row.price_usd, liquidityUsd: row.liquidity_usd,
      sourceTimestamp: row.source_timestamp, source }];
  }));
  return jobs.map((job, index) => ({ job, observation: points.get(index) ?? null }));
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
        AND a.source_timestamp<=a.attempted_at AND a.price_usd IS NOT NULL AND a.liquidity_usd IS NOT NULL
        AND ${canonicalDecisionSql('d')}`)
      .bind(job.decisionKey, job.horizon, runId));
    commands.push(DB.prepare(`UPDATE mvp_outcome_jobs SET
      state=CASE WHEN EXISTS(SELECT 1 FROM mvp_outcomes o WHERE o.decision_key=mvp_outcome_jobs.decision_key AND o.horizon=mvp_outcome_jobs.horizon)
        THEN 'COMPLETE' ELSE 'RETRY' END,
      attempt_count=(SELECT count(*) FROM mvp_outcome_attempts a WHERE a.decision_key=mvp_outcome_jobs.decision_key AND a.horizon=mvp_outcome_jobs.horizon),
      last_attempt_at=(SELECT max(attempted_at) FROM mvp_outcome_attempts a WHERE a.decision_key=mvp_outcome_jobs.decision_key AND a.horizon=mvp_outcome_jobs.horizon),
      last_reason=(SELECT reason FROM mvp_outcome_attempts a WHERE a.decision_key=mvp_outcome_jobs.decision_key AND a.horizon=mvp_outcome_jobs.horizon ORDER BY attempted_at DESC,run_id DESC LIMIT 1),
      next_attempt_at=CASE WHEN EXISTS(SELECT 1 FROM mvp_outcomes o WHERE o.decision_key=mvp_outcome_jobs.decision_key AND o.horizon=mvp_outcome_jobs.horizon)
        THEN NULL ELSE (SELECT CASE WHEN max(attempted_at)<mvp_outcome_jobs.due_at+mvp_outcome_jobs.allowed_lag_ms
          THEN min(max(attempted_at)+60000,mvp_outcome_jobs.due_at+mvp_outcome_jobs.allowed_lag_ms)
          ELSE max(attempted_at)+min(86400000,60000*(1 << min(11,max(0,count(*)-1)))) END
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
      AND ${canonicalDecisionSql('d')}
    GROUP BY d.chain_id,d.address HAVING count(DISTINCT o.horizon)=4
  )`).bind(scoreVersion, profile, at, at, at).first();
  const count = Number(row?.total ?? 0);
  return { schemaVersion: 1, scoreVersion, profile, asOf: new Date(at).toISOString(), minimumUniqueLaunches: minimum,
    uniqueLaunchesWithCompleteOutcomes: count, eligible: count >= minimum,
    reason: count >= minimum ? 'MINIMUM_OUTCOMES_RECORDED' : 'INSUFFICIENT_COMPLETE_LAUNCH_OUTCOMES' };
}

export { decisionKey };
