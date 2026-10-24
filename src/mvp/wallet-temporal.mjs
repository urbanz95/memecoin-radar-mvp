import { createHash } from 'node:crypto';
import PROFILES_CONFIG from './config.mjs';
import { isEvmAddress } from '../network.mjs';
import { recordTime, recordLabel } from './records.mjs';

export const WALLET_TEMPORAL_METHOD = 'exponential-realized-disposals/v1';
const ACCOUNTING = 'fifo-receipt-net-usd/v1';
const DAY = 86400000;
const fail = code => { throw Error(`MVP_WALLET_TEMPORAL_${code}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const addr = value => isEvmAddress(value) && !/^0x0{40}$/i.test(value) ? value.toLowerCase() : null;
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 64
  && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 240);
const cfgOf = config => config?.profiles?.profile_new?.walletScoring ?? config?.walletScoring ?? config
  ?? PROFILES_CONFIG.profiles.profile_new.walletScoring;
const atOf = value => recordTime(typeof value === 'function' ? value() : value);
const all = async statement => (await statement.all())?.results ?? [];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a || 1n; };
function rational(value) {
  if (!object(value) || typeof value.numerator !== 'string' || !/^-?\d{1,180}$/.test(value.numerator)
    || typeof value.denominator !== 'string' || !/^[1-9]\d{0,179}$/.test(value.denominator)) fail('INVALID_EXACT_PNL');
  const n = BigInt(value.numerator); const d = BigInt(value.denominator); const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
const packed = value => ({ numerator: value.n.toString(), denominator: value.d.toString() });
function plus(a, b) {
  const n = a.n * b.d + b.n * a.d; const d = a.d * b.d; const divisor = gcd(n, d);
  const result = { n: n / divisor, d: d / divisor }; rational(packed(result)); return result;
}
function money(value) {
  const scale = 10n ** 18n; let n = value.n * scale / value.d;
  if (value.n < 0n && value.n * scale % value.d) n--;
  const sign = n < 0n ? '-' : ''; const digits = (n < 0n ? -n : n).toString().padStart(19, '0');
  const tail = digits.slice(-18).replace(/0+$/, '');
  return sign + digits.slice(0, -18) + (tail ? '.' + tail : '');
}
function encoded(value, limit = 16384) {
  const result = JSON.stringify(value);
  if (new TextEncoder().encode(result).length > limit) fail('EVIDENCE_LIMIT');
  return result;
}
function eventOf(value, observedAt) {
  if (!object(value) || value.schemaVersion !== 1 || value.accountingVersion !== ACCOUNTING || value.chainId !== 4663
    || !addr(value.walletAddress) || !addr(value.tokenAddress) || !whole(value.disposalIndex) || value.disposalIndex < 1
    || !whole(value.blockNumber) || !whole(value.logIndex) || !hash(value.blockHash) || !hash(value.transactionHash)
    || typeof value.timestamp !== 'string' || !refs(value.evidence) || typeof value.source !== 'string' || !value.source
    || value.source.length > 240 || !finite(value.holdingSeconds) || value.holdingSeconds < 0
    || !finite(value.earlyEntryPct) || value.earlyEntryPct < 0 || value.earlyEntryPct > 100
    || !finite(value.drawdownPct) || value.drawdownPct < 0 || value.drawdownPct > 100) fail('INVALID_REALIZATION');
  const at = atOf(value.timestamp); if (at > observedAt) fail('FUTURE_REALIZATION');
  const event = { ...value, walletAddress: addr(value.walletAddress), tokenAddress: addr(value.tokenAddress),
    blockHash: value.blockHash.toLowerCase(), transactionHash: value.transactionHash.toLowerCase(), timestamp: new Date(at).toISOString() };
  if (event.id !== `4663:${event.blockHash}:${event.transactionHash}:${event.logIndex}:${event.walletAddress}`) fail('INVALID_EVENT_ID');
  const exact = rational(value.netRealizedPnlUsdExact);
  if (money(exact) !== value.netRealizedPnlUsd || !Number.isFinite(Number(value.netRealizedPnlUsd))) fail('PNL_MISMATCH');
  event.netRealizedPnlUsdExact = packed(exact); encoded(event);
  return event;
}
// Context refs can be enriched later; reconciled cash facts cannot change.
const eventFingerprint = event => digest([event.schemaVersion, event.accountingVersion, event.id, event.disposalIndex,
  event.chainId, event.walletAddress, event.tokenAddress, event.blockNumber, event.blockHash, event.transactionHash,
  event.logIndex, event.timestamp, event.netRealizedPnlUsdExact, event.holdingSeconds, event.earlyEntryPct, event.drawdownPct]);
const cursor = event => ({ disposalIndex: event.disposalIndex, blockNumber: event.blockNumber, blockHash: event.blockHash,
  transactionHash: event.transactionHash, logIndex: event.logIndex, timestamp: event.timestamp, eventId: event.id });
function validateSummary(value, cfg, generation) {
  if (!object(value) || value.schemaVersion !== 1 || value.method !== WALLET_TEMPORAL_METHOD
    || value.accountingVersion !== ACCOUNTING || value.scoreVersion !== cfg.version || value.halfLifeDays !== cfg.timeDecayHalfLifeDays
    || value.chainId !== 4663 || !addr(value.walletAddress) || value.generation !== generation
    || !whole(value.disposalCount) || value.disposalCount < 1 || !object(value.weighted)
    || !refs(value.evidence) || !object(value.firstCursor) || !object(value.lastCursor)
    || value.firstCursor.disposalIndex !== 1 || value.lastCursor.disposalIndex !== value.disposalCount
    || !whole(value.lastCursor.blockNumber) || !hash(value.lastCursor.blockHash) || !hash(value.lastCursor.transactionHash)
    || !whole(value.lastCursor.logIndex) || value.anchorAt !== value.lastCursor.timestamp) fail('INVALID_SUMMARY');
  atOf(value.anchorAt); rational(value.cumulativePnlExact);
  const w = value.weighted;
  if (!['count', 'wins', 'netPnlUsd', 'pnlErrorUsd', 'holdingSeconds', 'earlyEntryPct', 'drawdownPct'].every(key => finite(w[key]))
    || w.count <= 0 || w.count > value.disposalCount * (1 + 1e-12) || w.wins < 0 || w.wins > w.count * (1 + 1e-12)
    || w.pnlErrorUsd < 0 || w.holdingSeconds < 0 || w.earlyEntryPct < 0 || w.earlyEntryPct > 100 * w.count * (1 + 1e-12)
    || w.drawdownPct < 0 || w.drawdownPct > 100 * w.count * (1 + 1e-12)) fail('INVALID_ACCUMULATOR');
  encoded(value); return value;
}

/** Pure incremental sufficient statistics; all monetary accounting stays exact.
 * Floating point is used only for the ranking hypothesis, with a conservative
 * error bound to prevent cancellation from manufacturing weighted profit. */
export function advanceWalletTemporalSummary(previous, events, { observedAt = Date.now(), config, generation = 0 } = {}) {
  const at = atOf(observedAt); const cfg = cfgOf(config);
  if (!whole(generation) || !Array.isArray(events) || !events.length || events.length > 512) fail('INPUT_LIMIT');
  const values = events.map(event => eventOf(event, at)).sort((a, b) => a.disposalIndex - b.disposalIndex);
  let state = previous ? structuredClone(validateSummary(previous, cfg, generation)) : null;
  for (const event of values) {
    if (!state) state = { schemaVersion: 1, method: WALLET_TEMPORAL_METHOD, accountingVersion: ACCOUNTING,
      scoreVersion: cfg.version, halfLifeDays: cfg.timeDecayHalfLifeDays, chainId: 4663, walletAddress: event.walletAddress,
      generation, disposalCount: 0, anchorAt: event.timestamp, firstCursor: cursor(event), lastCursor: null,
      cumulativePnlExact: { numerator: '0', denominator: '1' },
      weighted: { count: 0, wins: 0, netPnlUsd: 0, pnlErrorUsd: 0, holdingSeconds: 0, earlyEntryPct: 0, drawdownPct: 0 },
      source: 'mvp-wallet-realizations/v1', evidence: [] };
    if (event.walletAddress !== state.walletAddress || event.disposalIndex !== state.disposalCount + 1) fail('CURSOR_GAP');
    const last = state.lastCursor;
    if (last && (Date.parse(event.timestamp) < Date.parse(state.anchorAt) || event.blockNumber < last.blockNumber
      || event.blockNumber === last.blockNumber && (event.blockHash !== last.blockHash || event.logIndex <= last.logIndex))) fail('CURSOR_ORDER');
    const decay = 2 ** (-(Date.parse(event.timestamp) - Date.parse(state.anchorAt)) / (cfg.timeDecayHalfLifeDays * DAY));
    const w = state.weighted; const priorPnl = w.netPnlUsd * decay; const newPnl = Number(event.netRealizedPnlUsd);
    for (const key of ['count', 'wins', 'holdingSeconds', 'earlyEntryPct', 'drawdownPct']) w[key] *= decay;
    w.count++; if (rational(event.netRealizedPnlUsdExact).n > 0n) w.wins++;
    w.holdingSeconds += event.holdingSeconds; w.earlyEntryPct += event.earlyEntryPct; w.drawdownPct += event.drawdownPct;
    w.netPnlUsd = priorPnl + newPnl;
    w.pnlErrorUsd = w.pnlErrorUsd * decay + Number.EPSILON * 8 * (Math.abs(priorPnl) + Math.abs(newPnl) + Math.abs(w.netPnlUsd));
    state.cumulativePnlExact = packed(plus(rational(state.cumulativePnlExact), rational(event.netRealizedPnlUsdExact)));
    state.disposalCount++; state.anchorAt = event.timestamp; state.lastCursor = cursor(event);
    state.evidence = [...new Set([...state.evidence, ...event.evidence])].slice(0, 64);
  }
  return validateSummary(state, cfg, generation);
}

/** Attach no guessed history: old lifetime profiles require verified replay. */
export function walletTemporalEvidence(profile, summary, { now = Date.now(), config } = {}) {
  const at = atOf(now); const cfg = cfgOf(config); const gaps = [];
  if (!summary) gaps.push('WALLET_TEMPORAL_HISTORY_MISSING');
  else if (summary.scoreVersion !== cfg.version || summary.halfLifeDays !== cfg.timeDecayHalfLifeDays)
    gaps.push('WALLET_TEMPORAL_METHOD_MISMATCH');
  else {
    try {
      validateSummary(summary, cfg, summary.generation);
      if (summary.walletAddress !== addr(profile?.walletAddress) || profile?.chainId !== 4663
        || !whole(profile.realizedTradeCount) || profile.realizedTradeCount !== summary.disposalCount
        || Date.parse(summary.anchorAt) > at || summary.anchorAt !== profile.lastRealizedAt
        || !['historyComplete', 'costsComplete', 'feesComplete', 'attributionComplete'].every(key => profile[key] === true))
        gaps.push('WALLET_TEMPORAL_COVERAGE_MISMATCH');
      const expected = rational(profile?.netRealizedPnlUsdExact); const actual = rational(summary.cumulativePnlExact);
      if (expected.n * actual.d !== actual.n * expected.d || money(actual) !== profile?.netRealizedPnlUsd)
        gaps.push('WALLET_TEMPORAL_PNL_MISMATCH');
    } catch { gaps.push('WALLET_TEMPORAL_PROOF_INVALID'); }
  }
  return { schemaVersion: 1, method: WALLET_TEMPORAL_METHOD, complete: gaps.length === 0,
    expectedDisposals: whole(profile?.realizedTradeCount) ? profile.realizedTradeCount : null,
    observedDisposals: summary?.disposalCount ?? 0, limitHit: false, source: 'mvp-wallet-realizations/v1',
    summary: gaps.length ? null : summary, gaps };
}

async function summaryRows(DB, profiles, cfg, generation) {
  const wallets = [...new Set(profiles.map(profile => addr(profile?.walletAddress)).filter(Boolean))];
  if (!wallets.length) return [];
  return all(DB.prepare(`SELECT * FROM mvp_wallet_temporal_summaries WHERE chain_id=4663 AND generation=?
    AND score_version=? AND half_life_days=? AND wallet_address IN (SELECT value FROM json_each(?))`)
    .bind(generation, cfg.version, cfg.timeDecayHalfLifeDays, JSON.stringify(wallets)));
}
export async function attachWalletTemporalEvidence(DB, profiles, { now = Date.now(), config, reorgDetected = false } = {}) {
  if (!Array.isArray(profiles) || profiles.length > 128) fail('PROFILE_LIMIT');
  if (!profiles.length) return [];
  const cfg = cfgOf(config); const epoch = await DB.prepare('SELECT generation FROM mvp_wallet_epoch WHERE id=1').first();
  const generation = (epoch?.generation ?? 0) + (reorgDetected ? 1 : 0);
  const currentAttached = profile => profile.realizationHistory?.complete === true
    && profile.realizationHistory?.summary?.generation === generation
    && walletTemporalEvidence(profile, profile.realizationHistory.summary, { now, config }).complete;
  const rows = (await summaryRows(DB, profiles.filter(profile => !currentAttached(profile)), cfg, generation))
    .filter(row => row.observed_at <= atOf(now));
  const byWallet = new Map(rows.map(row => [row.wallet_address, row]));
  return profiles.map(profile => {
    const attached = profile.realizationHistory?.summary;
    const row = byWallet.get(addr(profile.walletAddress)); let summary = null;
    if (currentAttached(profile)) summary = attached;
    else if (row && digest(JSON.parse(row.summary_json)) === row.fingerprint) summary = JSON.parse(row.summary_json);
    return { ...profile, realizationHistory: walletTemporalEvidence(profile, summary, { now, config }) };
  });
}

/** Read-only preparation. Caller persists returned deltas in its existing fence. */
export async function prepareWalletTemporalUpdates(DB, { runId, observedAt = Date.now(), profiles = [], realizedEvents = [],
  config, reorgDetected = false } = {}) {
  recordLabel(runId, 'RUN_ID'); const at = atOf(observedAt); const cfg = cfgOf(config);
  if (!Array.isArray(profiles) || profiles.length > 128 || !Array.isArray(realizedEvents) || realizedEvents.length > 128) fail('INPUT_LIMIT');
  if (!profiles.length && !realizedEvents.length) return { profiles: [], realizationUpdates: [], diagnostics: [] };
  const epoch = await DB.prepare('SELECT generation FROM mvp_wallet_epoch WHERE id=1').first();
  const generation = (epoch?.generation ?? 0) + (reorgDetected ? 1 : 0);
  const normalized = realizedEvents.map(value => eventOf(value, at));
  const identities = new Map();
  for (const event of normalized) {
    const key = `${event.walletAddress}:${event.id}`; const fingerprint = eventFingerprint(event);
    if (identities.has(key) && identities.get(key) !== fingerprint) fail('EVENT_CONFLICT');
    identities.set(key, fingerprint);
  }
  const rows = reorgDetected ? [] : await summaryRows(DB, [...profiles, ...normalized], cfg, generation);
  const byWallet = new Map(rows.map(row => [row.wallet_address, row])); const updates = []; const diagnostics = [];
  const summaries = new Map();
  for (const row of rows) {
    if (row.observed_at > at) fail('FUTURE_SUMMARY');
    const parsed = JSON.parse(row.summary_json); if (digest(parsed) !== row.fingerprint) fail('SUMMARY_FINGERPRINT');
    summaries.set(row.wallet_address, validateSummary(parsed, cfg, generation));
  }
  for (const wallet of new Set(normalized.map(event => event.walletAddress))) {
    const previous = summaries.get(wallet) ?? null;
    const unique = [...new Map(normalized.filter(event => event.walletAddress === wallet).map(event => [event.id, event])).values()];
    const fresh = [];
    for (const event of unique) {
      if (previous && event.disposalIndex <= previous.disposalCount) {
        const stored = await DB.prepare('SELECT fingerprint FROM mvp_wallet_realizations WHERE chain_id=4663 AND wallet_address=? AND generation=? AND event_id=?')
          .bind(wallet, generation, event.id).first();
        if (stored?.fingerprint !== eventFingerprint(event)) fail('EVENT_CONFLICT');
      } else fresh.push(event);
    }
    if (!fresh.length) continue;
    try {
      const next = advanceWalletTemporalSummary(previous, fresh, { observedAt: at, config, generation });
      summaries.set(wallet, next);
      updates.push({ walletAddress: wallet, generation, scoreVersion: cfg.version, halfLifeDays: cfg.timeDecayHalfLifeDays,
        expectedFingerprint: byWallet.get(wallet)?.fingerprint ?? null, expectedDisposalCount: previous?.disposalCount ?? 0,
        summary: next, fingerprint: digest(next) });
    } catch (error) {
      // Preserve every realization, but never invent missing earlier disposals.
      if (!/CURSOR_GAP/.test(error.message)) throw error;
      diagnostics.push({ walletAddress: wallet, reason: 'WALLET_TEMPORAL_REPLAY_REQUIRED' });
    }
  }
  return { profiles: profiles.map(profile => ({ ...profile,
    realizationHistory: walletTemporalEvidence(profile, summaries.get(addr(profile.walletAddress)) ?? null, { now: at, config }) })),
    realizationUpdates: updates, diagnostics };
}

/** Sync, additive commands used by prepareWalletLedger; never writes directly. */
export function prepareWalletRealizationCommands(DB, { runId, observedAt, realizedEvents = [], realizationUpdates = [] } = {}) {
  if (!Array.isArray(realizedEvents) || realizedEvents.length > 128 || !Array.isArray(realizationUpdates) || realizationUpdates.length > 128) fail('INPUT_LIMIT');
  const at = atOf(observedAt); const commands = []; const seen = new Map();
  for (const raw of realizedEvents) {
    const event = eventOf(raw, at); const fingerprint = eventFingerprint(event); const key = `${event.walletAddress}:${event.id}`;
    if (seen.has(key)) { if (seen.get(key) !== fingerprint) fail('EVENT_CONFLICT'); continue; } seen.set(key, fingerprint);
    commands.push(DB.prepare(`INSERT OR IGNORE INTO mvp_wallet_realizations
      (chain_id,wallet_address,generation,event_id,disposal_index,block_number,block_hash,transaction_hash,event_timestamp,observed_at,run_id,fingerprint,event_json)
      VALUES(4663,?,(SELECT generation FROM mvp_wallet_epoch WHERE id=1),?,?,?,?,?,?,?,?,?,?)`)
      .bind(event.walletAddress, event.id, event.disposalIndex, event.blockNumber, event.blockHash, event.transactionHash,
        Date.parse(event.timestamp), at, runId, fingerprint, encoded(event)));
  }
  for (const update of realizationUpdates) {
    const s = update.summary;
    if (!object(update) || !whole(update.generation) || !addr(update.walletAddress) || s?.walletAddress !== update.walletAddress
      || s.generation !== update.generation || s.scoreVersion !== update.scoreVersion || s.halfLifeDays !== update.halfLifeDays
      || !whole(update.expectedDisposalCount) || update.expectedDisposalCount >= s.disposalCount
      || update.fingerprint !== digest(s) || update.expectedFingerprint !== null && !/^[a-f0-9]{64}$/.test(update.expectedFingerprint)) fail('INVALID_UPDATE');
    validateSummary(s, { version: update.scoreVersion, timeDecayHalfLifeDays: update.halfLifeDays }, update.generation);
    const keys = [update.walletAddress, update.generation, update.scoreVersion, update.halfLifeDays];
    commands.push(DB.prepare(`INSERT OR REPLACE INTO mvp_wallet_temporal_guard(id,ok) VALUES(1,CASE WHEN
      (SELECT generation FROM mvp_wallet_epoch WHERE id=1)=? AND (
        (COALESCE((SELECT fingerprint FROM mvp_wallet_temporal_summaries WHERE chain_id=4663 AND wallet_address=? AND generation=? AND score_version=? AND half_life_days=?),'')=?
        AND COALESCE((SELECT disposal_count FROM mvp_wallet_temporal_summaries WHERE chain_id=4663 AND wallet_address=? AND generation=? AND score_version=? AND half_life_days=?),0)=?
        AND (SELECT count(*) FROM mvp_wallet_realizations WHERE chain_id=4663 AND wallet_address=? AND generation=?
          AND disposal_index>? AND disposal_index<=?)=?)
        OR EXISTS(SELECT 1 FROM mvp_wallet_temporal_summaries WHERE chain_id=4663 AND wallet_address=? AND generation=? AND score_version=? AND half_life_days=? AND run_id=? AND fingerprint=?))
      THEN 1 ELSE 0 END)`).bind(update.generation, ...keys, update.expectedFingerprint ?? '',
      ...keys, update.expectedDisposalCount, update.walletAddress, update.generation,
      update.expectedDisposalCount, s.disposalCount, s.disposalCount - update.expectedDisposalCount,
      ...keys, runId, update.fingerprint));
    commands.push(DB.prepare(`INSERT INTO mvp_wallet_temporal_summaries
      (chain_id,wallet_address,generation,score_version,half_life_days,disposal_count,observed_at,run_id,fingerprint,summary_json)
      VALUES(4663,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain_id,wallet_address,generation,score_version,half_life_days)
      DO UPDATE SET disposal_count=excluded.disposal_count,observed_at=excluded.observed_at,run_id=excluded.run_id,
        fingerprint=excluded.fingerprint,summary_json=excluded.summary_json`)
      .bind(...keys, s.disposalCount, at, runId, update.fingerprint, encoded(s)));
  }
  return commands;
}
