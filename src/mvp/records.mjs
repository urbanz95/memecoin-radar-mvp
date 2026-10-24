import { isEvmAddress } from '../network.mjs';
import { encodeEventFeatures } from './feature-codec.mjs';

export const MVP_SCHEMA_VERSION = 1;
export const MAX_FEATURE_BYTES = 65536;
const MAX_SOURCE_BYTES = 8192;
const encoder = new TextEncoder();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function recordTime(value, label = 'TIME') {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`MVP_INVALID_${label}`);
  return parsed;
}
export function recordLabel(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`MVP_INVALID_${label}`);
  return value;
}
function identity(value, fallbackChain = 4663) {
  const address = typeof value === 'string' ? value : value?.address;
  const chainId = typeof value === 'string' ? fallbackChain : value?.chainId ?? fallbackChain;
  if (!isEvmAddress(address) || !Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('MVP_INVALID_TOKEN_IDENTITY');
  return { chainId, address: address.toLowerCase() };
}
export function decisionKey(chainId, address, scoreVersion, profile) {
  const token = identity({ chainId, address });
  recordLabel(scoreVersion, 'SCORE_VERSION', 100); recordLabel(profile, 'PROFILE', 80);
  // JSON encoding avoids delimiter collisions between version and profile.
  return JSON.stringify([token.chainId, token.address, scoreVersion, profile]);
}
function json(value, limit, code) {
  let serialized;
  try { serialized = JSON.stringify(value, (_key, item) => {
    if (item === undefined) return null;
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' ||
      (typeof item === 'number' && !Number.isFinite(item))) throw new Error('INVALID_JSON_VALUE');
    return item;
  }); } catch { throw new Error('MVP_INVALID_JSON_VALUE'); }
  if (typeof serialized !== 'string') throw new Error('MVP_INVALID_JSON_VALUE');
  if (encoder.encode(serialized).length > limit) throw new Error(code);
  return serialized;
}
export function sourceRecord(value, fallback) {
  const source = value ?? fallback;
  if (!(typeof source === 'string' && source.trim()) && !object(source)) throw new Error('MVP_SOURCE_REQUIRED');
  if (object(source) && !Object.keys(source).length) throw new Error('MVP_SOURCE_REQUIRED');
  return json({ schemaVersion: MVP_SCHEMA_VERSION, provenance: source }, MAX_SOURCE_BYTES, 'MVP_SOURCE_LIMIT_EXCEEDED');
}
const observedKeys = new Set(['observedAt', 'capturedAt', 'checkedAt', 'fetchedAt', 'asOf', 'sourceTimestamp', 'headTimestamp', 'poolCreatedAt', 'contractCreatedAt', 'timestamp', 'blockTimestamp', 'lastRealizedAt', 'firstEntryAt', 'lastEntryAt', 'holdersCheckedAt', 'liquidityFetchedAt', 'observedLastDisposalAt']);
function assertNoFuture(value, capturedAt, depth = 0) {
  if (depth > 32) throw new Error('MVP_FEATURE_DEPTH_EXCEEDED');
  if (Array.isArray(value)) { for (const item of value) assertNoFuture(item, capturedAt, depth + 1); return; }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && item !== undefined && observedKeys.has(key)) {
      const time = typeof item === 'number' ? (key === 'timestamp' || key === 'blockTimestamp' ? item * 1000 : item)
        : typeof item === 'string' ? Date.parse(item) : NaN;
      if (!Number.isFinite(time)) throw new Error('MVP_INVALID_FEATURE_TIMESTAMP');
      if (time > capturedAt) throw new Error('MVP_FUTURE_FEATURE');
    }
    assertNoFuture(item, capturedAt, depth + 1);
  }
}
export function projectDecisionFeatures(features, context) {
  if (!object(features)) throw new Error('MVP_FEATURES_REQUIRED');
  const capturedAt = recordTime(context.observedAt);
  assertNoFuture(features, capturedAt);
  assertNoFuture(context.source, capturedAt);
  const envelope = { schemaVersion: MVP_SCHEMA_VERSION, capturedAt: new Date(capturedAt).toISOString(),
    chainId: context.chainId, address: context.address, scoreVersion: context.scoreVersion, profile: context.profile,
    policyHash: context.policyHash, provenance: context.source, values: features };
  return json(envelope, MAX_FEATURE_BYTES, 'MVP_FEATURE_LIMIT_EXCEEDED');
}
function optionalMetric(decision, name, features, key) {
  const value = own(decision, name) ? decision[name] : features?.externalMarket?.[key] ?? features?.market?.[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('MVP_INVALID_BASELINE');
  return value;
}

/**
 * No reads or writes occur here. Append commands to the collector's existing
 * fenced D1 batch. Features exceeding the limit fail explicitly, never truncate.
 * seenTokens includes discoveries even when there is no evaluation or market.
 */
export function prepareDecisionRecords(DB, { runId, observedAt, seenTokens = [], decisions = [],
  chainId = 4663, scoreVersion, profile, policyHash, source = 'cloudflare-readonly-collector', allowedOutcomeLagMs = 300000,
  eventFeaturesEncoding = 'json' } = {}) {
  recordLabel(runId, 'RUN_ID');
  const at = recordTime(observedAt);
  if (!['json', 'gzip-base64/v1'].includes(eventFeaturesEncoding)) throw new Error('MVP_INVALID_EVENT_ENCODING');
  if (!Array.isArray(seenTokens) || !Array.isArray(decisions)) throw new Error('MVP_INVALID_RECORD_ARRAY');
  if (!Number.isSafeInteger(allowedOutcomeLagMs) || allowedOutcomeLagMs < 0 || allowedOutcomeLagMs > 86400000)
    throw new Error('MVP_INVALID_OUTCOME_LAG');
  const commands = []; const known = new Set();
  const addSeen = raw => {
    const token = identity(raw, chainId);
    const poolId = typeof raw === 'string' || raw?.poolId == null ? null : recordLabel(raw.poolId, 'POOL_ID', 200);
    const poolCreatedAt = typeof raw === 'string' || raw?.poolCreatedAt == null ? null : recordTime(raw.poolCreatedAt, 'POOL_CREATED_AT');
    if (poolCreatedAt !== null && poolCreatedAt > at) throw new Error('MVP_FUTURE_POOL');
    const provenance = sourceRecord(typeof raw === 'string' ? source : raw?.source, source);
    const eventKey = JSON.stringify([token.chainId, token.address, poolId]);
    if (known.has(eventKey)) return token;
    known.add(eventKey);
    commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_tokens(chain_id,address,first_seen_at,first_seen_run_id,first_seen_pool_id,first_pool_created_at,source_json) VALUES(?,?,?,?,?,?,?)')
      .bind(token.chainId, token.address, at, runId, poolId, poolCreatedAt, provenance));
    commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_token_seen_events(chain_id,address,run_id,pool_id,seen_at,pool_created_at,source_json) VALUES(?,?,?,?,?,?,?)')
      .bind(token.chainId, token.address, runId, poolId ?? '', at, poolCreatedAt, provenance));
    return token;
  };
  for (const seen of seenTokens) addSeen(seen);
  const decisionKeys = new Set();
  for (const decision of decisions) {
    if (!object(decision)) throw new Error('MVP_INVALID_DECISION');
    const token = addSeen(decision);
    const version = recordLabel(decision.scoreVersion ?? scoreVersion, 'SCORE_VERSION', 100);
    const cohort = recordLabel(decision.profile ?? profile, 'PROFILE', 80);
    const hash = recordLabel(decision.policyHash ?? policyHash, 'POLICY_HASH', 200);
    const status = recordLabel(decision.status, 'STATUS', 80);
    const key = decisionKey(token.chainId, token.address, version, cohort);
    if (decisionKeys.has(key)) throw new Error('MVP_DUPLICATE_DECISION_IN_RUN');
    decisionKeys.add(key);
    const provenanceValue = decision.source ?? source;
    const provenance = sourceRecord(provenanceValue);
    const features = projectDecisionFeatures(decision.features, { ...token, observedAt: at,
      scoreVersion: version, profile: cohort, policyHash: hash, source: provenanceValue });
    const baselinePrice = optionalMetric(decision, 'baselinePriceUsd', decision.features, 'priceUsd');
    const baselineLiquidity = optionalMetric(decision, 'baselineLiquidityUsd', decision.features, 'liquidityUsd');
    commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_decisions(decision_key,chain_id,address,score_version,profile,policy_hash,first_decision_at,first_run_id,first_status,is_launch,baseline_price_usd,baseline_liquidity_usd,features_json,source_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(key, token.chainId, token.address, version, cohort, hash, at, runId, status, decision.isLaunch === true ? 1 : 0,
        baselinePrice, baselineLiquidity, features, provenance));
    commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_decision_events(decision_key,run_id,observed_at,status,policy_hash,features_json,source_json) VALUES(?,?,?,?,?,?,?)')
      .bind(key, runId, at, status, hash, eventFeaturesEncoding === 'gzip-base64/v1' ? encodeEventFeatures(features) : features, provenance));
    // Registration derives due_at from the immutable first decision, including
    // when this is a retry or a later observation of an existing token.
    for (const [horizon, offset] of Object.entries({ '15m': 900000, '1h': 3600000, '24h': 86400000, '7d': 604800000 }))
      commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_outcome_jobs(decision_key,horizon,due_at,allowed_lag_ms,next_attempt_at) SELECT decision_key,?,first_decision_at+?,?,first_decision_at+? FROM mvp_decisions WHERE decision_key=?')
        .bind(horizon, offset, allowedOutcomeLagMs, offset, key));
  }
  return { commands, counts: { seenEvents: known.size, decisions: decisionKeys.size, outcomeJobs: decisionKeys.size * 4 } };
}

/** Constant-time counters maintained by additive ledger triggers. */
export async function getMvpStats(DB) {
  const row = await DB.prepare('SELECT * FROM mvp_stats WHERE id=1').first();
  if (!row) throw new Error('MVP_STATS_NOT_INITIALIZED');
  return { schemaVersion: 1, tokensSeen: row.tokens_seen, seenEvents: row.seen_events, decisions: row.decisions,
    decisionEvents: row.decision_events, outcomeJobs: { pending: row.outcome_jobs_pending, retry: row.outcome_jobs_retry,
      complete: row.outcome_jobs_complete }, outcomeAttempts: row.outcome_attempts, outcomesComplete: row.outcomes_complete,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null };
}
