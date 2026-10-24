import { isEvmAddress } from '../network.mjs';
import { hash, hex, quantity } from '../cloudflare/rpc.mjs';
import { recordTime, recordLabel } from './records.mjs';
import { createHash } from 'node:crypto';
import { prepareWalletRealizationCommands } from './wallet-temporal.mjs';
import PROFILES_CONFIG from './config.mjs';

const whole = value => Number.isSafeInteger(value) && value >= 0;
const zero = '0x' + '0'.repeat(40);
const addr = value => isEvmAddress(value) && value.toLowerCase() !== zero ? value.toLowerCase() : null;
const fail = name => { throw new Error('MVP_WALLET_' + name); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function json(value, max = 131072) {
  let result;
  try { result = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'number' && !Number.isFinite(item)) fail('INVALID_JSON');
    return item === undefined ? null : item;
  }); } catch { fail('INVALID_JSON'); }
  if (!result || new TextEncoder().encode(result).length > max) fail('EVIDENCE_LIMIT');
  return result;
}
function eventOf(value) {
  if (!object(value) || (value.chainId ?? 4663) !== 4663 || !['SWAP', 'TRANSFER'].includes(value.kind)
    || !addr(value.tokenAddress) || !addr(value.address) || !whole(value.blockNumber) || !whole(value.logIndex)
    || !hash(value.blockHash) || !hash(value.transactionHash) || !Array.isArray(value.topics)
    || value.topics.length > 4 || value.topics.some(topic => typeof topic !== 'string' || !/^0x[0-9a-f]{64}$/i.test(topic))
    || typeof value.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value.data)) fail('INVALID_EVENT');
  const event = { ...value, chainId: 4663, tokenAddress: addr(value.tokenAddress), address: addr(value.address),
    blockHash: value.blockHash.toLowerCase(), transactionHash: value.transactionHash.toLowerCase(),
    topics: value.topics.map(topic => topic.toLowerCase()), data: value.data.toLowerCase() };
  json(event, 16384); return event;
}
function rangeOf(value) {
  if (!object(value) || (value.chainId ?? 4663) !== 4663 || !['SWAP', 'TRANSFER'].includes(value.kind)
    || !addr(value.tokenAddress) || !addr(value.address) || !whole(value.fromBlock) || !whole(value.toBlock)
    || value.toBlock < value.fromBlock || !whole(value.headBlock) || value.toBlock > value.headBlock || !hash(value.headHash)
    || typeof value.historyComplete !== 'boolean' || !value.source) fail('INVALID_RANGE');
  return { ...value, chainId: 4663, tokenAddress: addr(value.tokenAddress), address: addr(value.address) };
}
const keyOf = value => `${value.chainId ?? 4663}:${value.transactionHash}:${value.blockHash}`;
const all = async statement => (await statement.all())?.results ?? [];

/** Prepare only: caller appends every statement to its existing lease-fenced batch. */
export function prepareWalletLedger(DB, { runId, observedAt, ranges = [], events = [], receipts = [], attempts = [], profiles = [],
  realizedEvents = [], realizationUpdates = [], reorgDetected = false } = {}) {
  recordLabel(runId, 'RUN_ID'); observedAt = recordTime(observedAt);
  if (![ranges, events, receipts, attempts, profiles, realizedEvents, realizationUpdates].every(Array.isArray)
    || events.length > 128 || ranges.length > 16 || receipts.length > 8 || realizedEvents.length > 128
    || realizationUpdates.length > 128) fail('INPUT_LIMIT');
  const commands = []; const unique = new Map();
  if (reorgDetected) {
    commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_wallet_reorgs(run_id,observed_at) VALUES(?,?)').bind(runId, observedAt));
    commands.push(DB.prepare("UPDATE mvp_wallet_receipt_jobs SET state='RETRY',next_attempt_at=?,last_reason='REORG_REVALIDATION' WHERE state='COMPLETE'").bind(observedAt));
  }
  for (const original of events) {
    const event = eventOf(original); const encoded = json(event, 16384); const key = `${event.chainId}:${event.blockHash}:${event.logIndex}`;
    const fingerprint = createHash('sha256').update(JSON.stringify([event.chainId, event.blockHash, event.logIndex,
      event.transactionHash, event.blockNumber, event.tokenAddress, event.kind, event.address, event.topics, event.data])).digest('hex');
    if (unique.has(key)) { if (unique.get(key) !== fingerprint) fail('EVENT_CONFLICT'); continue; } unique.set(key, fingerprint);
    commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_wallet_events(chain_id,block_hash,log_index,transaction_hash,block_number,token_address,kind,observed_at,fingerprint,event_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(4663, event.blockHash, event.logIndex, event.transactionHash, event.blockNumber, event.tokenAddress, event.kind, observedAt, fingerprint, encoded));
    if (event.kind === 'SWAP') commands.push(DB.prepare("INSERT OR IGNORE INTO mvp_wallet_receipt_jobs(chain_id,transaction_hash,block_hash,block_number,next_attempt_at) VALUES(?,?,?,?,?)")
      .bind(4663, event.transactionHash, event.blockHash, event.blockNumber, observedAt));
    if (event.kind === 'TRANSFER') for (const wallet of new Set([addr(event.args?.from), addr(event.args?.to)].filter(Boolean)))
      commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_wallet_token_members(chain_id,token_address,wallet_address,first_observed_at) VALUES(?,?,?,?)').bind(4663, event.tokenAddress, wallet, observedAt));
  }
  for (const value of ranges) {
    const range = rangeOf(value);
    commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_wallet_ranges(run_id,chain_id,kind,token_address,source_address,from_block,to_block,observed_at,range_json) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(runId, 4663, range.kind, range.tokenAddress, range.address, range.fromBlock, range.toBlock, observedAt, json(range, 8192)));
  }
  for (const value of receipts) {
    const receipt = value.receipt; const block = value.block;
    if (!object(receipt) || !object(block) || !hash(receipt.transactionHash) || !hash(receipt.blockHash) || !whole(block.number)
      || receipt.blockHash.toLowerCase() !== block.hash?.toLowerCase() || quantity(receipt.blockNumber) !== block.number
      || !whole(block.timestamp) || block.timestamp * 1000 > observedAt || !Array.isArray(receipt.logs)) fail('INVALID_RECEIPT');
    commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_wallet_receipts(chain_id,transaction_hash,block_hash,block_number,observed_at,run_id,wallet_address,generation,receipt_json) VALUES(?,?,?,?,?,?,?,(SELECT generation FROM mvp_wallet_epoch WHERE id=1),?)')
      .bind(4663, receipt.transactionHash.toLowerCase(), receipt.blockHash.toLowerCase(), block.number, observedAt, runId, addr(receipt.from), json(value)));
    commands.push(DB.prepare("UPDATE mvp_wallet_receipt_jobs SET state='COMPLETE',attempts=attempts+1,last_reason=NULL WHERE chain_id=4663 AND transaction_hash=? AND block_hash=? AND state!='COMPLETE'")
      .bind(receipt.transactionHash.toLowerCase(), receipt.blockHash.toLowerCase()));
    const wallet = addr(receipt.from); const token = addr(value.tokenAddress);
    if (wallet && token) commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_wallet_token_members(chain_id,token_address,wallet_address,first_observed_at) VALUES(?,?,?,?)').bind(4663, token, wallet, observedAt));
  }
  for (const attempt of attempts) {
    if (!hash(attempt.transactionHash) || !hash(attempt.blockHash) || !whole(attempt.blockNumber)) fail('INVALID_ATTEMPT');
    recordLabel(attempt.reason, 'RECEIPT_REASON', 80);
    commands.push(DB.prepare("UPDATE mvp_wallet_receipt_jobs SET state='RETRY',attempts=attempts+1,next_attempt_at=?+min(86400000,60000*(1<<min(attempts,10))),last_reason=? WHERE chain_id=4663 AND transaction_hash=? AND block_hash=? AND state!='COMPLETE'")
      .bind(observedAt, attempt.reason, attempt.transactionHash.toLowerCase(), attempt.blockHash.toLowerCase()));
  }
  if (realizedEvents.length || realizationUpdates.length) commands.push(...prepareWalletRealizationCommands(DB,
    { runId, observedAt, realizedEvents, realizationUpdates }));
  if (profiles.length) commands.push(...prepareWalletProjection(DB, { runId, observedAt, profiles }).commands);
  return { commands, counts: { events: unique.size, ranges: ranges.length, receipts: receipts.length, profiles: profiles.length,
    realizations: realizedEvents.length, temporalSummaries: realizationUpdates.length } };
}

function profileOf(profile, observedAt) {
  if (!object(profile) || profile.chainId !== 4663 || !addr(profile.walletAddress)) fail('INVALID_PROFILE');
  const checkedAt = recordTime(profile.checkedAt);
  if (checkedAt > observedAt) fail('FUTURE_PROFILE');
  recordLabel(profile.source, 'WALLET_SOURCE', 160);
  if (!Array.isArray(profile.evidence) || profile.evidence.length > 64 || !profile.evidence.length
    || profile.evidence.some(value => typeof value !== 'string' || value.length > 512)) fail('INVALID_PROFILE_EVIDENCE');
  for (const field of ['historyComplete', 'costsComplete', 'feesComplete', 'attributionComplete', 'clusteringComplete'])
    if (typeof profile[field] !== 'boolean') fail('INVALID_PROFILE_COMPLETENESS');
  if (profile.realizedTradeCount !== null && !whole(profile.realizedTradeCount)) fail('INVALID_PROFILE_TRADES');
  const value = { ...profile, walletAddress: addr(profile.walletAddress) };
  // Temporal evidence has its own bounded projection. Keep profile events
  // compatible without copying the same summary into every immutable row.
  delete value.realizationHistory;
  for (const field of ['netRealizedPnlUsd', 'winRatePct', 'avgHoldingSeconds', 'earlyEntryPct', 'maxDrawdownPct', 'lastRealizedAt', 'riskFlags'])
    if (value[field] === undefined) value[field] = null;
  if (value.netRealizedPnlUsd !== null && !(typeof value.netRealizedPnlUsd === 'number' && Number.isFinite(value.netRealizedPnlUsd))
    && !(typeof value.netRealizedPnlUsd === 'string' && value.netRealizedPnlUsd.length <= 100 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.netRealizedPnlUsd))) fail('INVALID_PROFILE_PNL');
  for (const field of ['winRatePct', 'earlyEntryPct', 'maxDrawdownPct'])
    if (value[field] !== null && !(typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= 0 && value[field] <= 100)) fail('INVALID_PROFILE_METRIC');
  if (value.avgHoldingSeconds !== null && !(typeof value.avgHoldingSeconds === 'number' && Number.isFinite(value.avgHoldingSeconds) && value.avgHoldingSeconds >= 0)) fail('INVALID_PROFILE_METRIC');
  if (value.lastRealizedAt !== null && recordTime(value.lastRealizedAt) > observedAt) fail('FUTURE_PROFILE');
  if (value.riskFlags !== null) {
    if (Array.isArray(value.riskFlags)) {
      if (value.riskFlags.length > 64 || value.riskFlags.some(flag => typeof flag !== 'string' || flag.length > 160)) fail('INVALID_PROFILE_RISKS');
    } else if (!object(value.riskFlags) || Object.keys(value.riskFlags).some(key => !['insider', 'bundler', 'washTrading'].includes(key))
      || Object.values(value.riskFlags).some(flag => typeof flag !== 'boolean' && flag !== null)) fail('INVALID_PROFILE_RISKS');
  }
  json(value, 32768); return { value, checkedAt };
}
function eligibleProfile(profile) {
  return profile.eligible === true && ['historyComplete', 'costsComplete', 'feesComplete', 'attributionComplete', 'clusteringComplete'].every(key => profile[key] === true)
    && profile.realizedTradeCount >= 5 && object(profile.riskFlags)
    && ['insider', 'bundler', 'washTrading'].every(key => profile.riskFlags[key] === false)
    && ['netRealizedPnlUsd', 'winRatePct', 'avgHoldingSeconds', 'earlyEntryPct', 'maxDrawdownPct', 'lastRealizedAt'].every(key => profile[key] !== null && profile[key] !== undefined);
}
export function prepareWalletProjection(DB, { runId, observedAt, profiles = [] } = {}) {
  recordLabel(runId, 'RUN_ID'); observedAt = recordTime(observedAt);
  if (!Array.isArray(profiles) || profiles.length > 128) fail('PROFILE_LIMIT');
  const commands = [];
  for (const original of profiles) {
    const { value, checkedAt } = profileOf(original, observedAt); const encoded = json(value, 32768);
    commands.push(DB.prepare('INSERT OR IGNORE INTO mvp_wallet_profile_events(chain_id,wallet_address,run_id,observed_at,generation,profile_json) VALUES(?,?,?,?,(SELECT generation FROM mvp_wallet_epoch WHERE id=1),?)')
      .bind(4663, value.walletAddress, runId, observedAt, encoded));
    commands.push(DB.prepare('INSERT INTO mvp_wallet_profiles(chain_id,wallet_address,checked_at,generation,profile_json,eligible) VALUES(?,?,?,(SELECT generation FROM mvp_wallet_epoch WHERE id=1),?,?) ON CONFLICT(chain_id,wallet_address) DO UPDATE SET checked_at=excluded.checked_at,generation=excluded.generation,profile_json=excluded.profile_json,eligible=excluded.eligible WHERE excluded.checked_at>=mvp_wallet_profiles.checked_at OR excluded.generation>mvp_wallet_profiles.generation')
      .bind(4663, value.walletAddress, checkedAt, encoded, eligibleProfile(value) ? 1 : 0));
  }
  return { commands, count: profiles.length };
}

export async function readWalletProfiles(DB, { tokenAddress, limit = 32 } = {}) {
  if (!whole(limit) || limit < 1 || limit > 128 || tokenAddress !== undefined && !addr(tokenAddress)) fail('INVALID_PROFILE_QUERY');
  const sql = tokenAddress
    ? 'SELECT p.profile_json FROM mvp_wallet_token_members m JOIN mvp_wallet_profiles p ON p.chain_id=m.chain_id AND p.wallet_address=m.wallet_address WHERE m.chain_id=4663 AND m.token_address=? AND p.generation=(SELECT generation FROM mvp_wallet_epoch WHERE id=1) ORDER BY p.checked_at DESC,p.wallet_address LIMIT ?'
    : 'SELECT profile_json FROM mvp_wallet_profiles WHERE generation=(SELECT generation FROM mvp_wallet_epoch WHERE id=1) ORDER BY checked_at DESC,wallet_address LIMIT ?';
  const rows = await all(tokenAddress ? DB.prepare(sql).bind(addr(tokenAddress), limit) : DB.prepare(sql).bind(limit));
  return rows.map(row => JSON.parse(row.profile_json));
}
export async function readWalletProfile(DB, walletAddress) {
  if (!addr(walletAddress)) fail('INVALID_PROFILE_QUERY');
  const row = await DB.prepare('SELECT profile_json FROM mvp_wallet_profiles WHERE chain_id=4663 AND wallet_address=? AND generation=(SELECT generation FROM mvp_wallet_epoch WHERE id=1)').bind(addr(walletAddress)).first();
  return row ? JSON.parse(row.profile_json) : null;
}
export async function getWalletLedgerStats(DB, { now = Date.now(), config } = {}) {
  const evaluatedAt = recordTime(typeof now === 'function' ? now() : now);
  const cfg = config?.profiles?.profile_new?.walletScoring ?? config?.walletScoring ?? config ?? PROFILES_CONFIG.profiles.profile_new.walletScoring;
  const maxProfileAgeSeconds = cfg.maxProfileAgeSeconds;
  if (!Number.isSafeInteger(maxProfileAgeSeconds) || maxProfileAgeSeconds < 1 || maxProfileAgeSeconds > 600)
    fail('INVALID_PROFILE_TTL');
  // The immutable profile/counter records describe the last evaluation. Current
  // eligibility additionally needs a fresh profile in the active generation.
  // The covering index limits this count to eligible profiles in the TTL window.
  const value = await DB.prepare(`SELECT s.*,e.generation,e.last_reorg_at,
    (SELECT count(*) FROM mvp_wallet_profiles p WHERE p.chain_id=4663 AND p.generation=e.generation
      AND p.eligible=1 AND p.checked_at>=? AND p.checked_at<=?) AS eligible_current
    FROM mvp_wallet_stats s JOIN mvp_wallet_epoch e ON e.id=s.id WHERE s.id=1`)
    .bind(evaluatedAt - maxProfileAgeSeconds * 1000, evaluatedAt).first();
  return { schemaVersion: 1, events: value?.events ?? 0, ranges: value?.ranges ?? 0, receipts: value?.receipts ?? 0,
    tracked: value?.tracked ?? 0, eligible: value?.eligible_current ?? 0, historicalEligible: value?.eligible ?? 0,
    eligibilityAsOf: new Date(evaluatedAt).toISOString(), maxProfileAgeSeconds,
    profileObservations: value?.profile_observations ?? 0, generation: value?.generation ?? 0,
    lastReorgAt: value?.last_reorg_at ? new Date(value.last_reorg_at).toISOString() : null,
    updatedAt: value?.updated_at ? new Date(value.updated_at).toISOString() : null };
}

/** One additional batch at most. All intermediate event blocks get canonical headers. */
export async function enrichWalletTransactions(DB, rpc, { events = [], head, now = Date.now, maxTransactions = 2, maxRequests = 30 } = {}) {
  const observedAt = recordTime(typeof now === 'function' ? now() : now);
  if (!whole(maxTransactions) || maxTransactions < 1 || maxTransactions > 4 || !whole(maxRequests) || maxRequests > 30
    || !whole(head?.number) || !hash(head?.hash) || !whole(head?.timestamp)) fail('INVALID_ENRICHMENT_CONFIG');
  const result = { receipts: [], attempts: [], diagnostics: [] };
  if (!whole(rpc?.requests) || rpc.requests >= maxRequests) { result.diagnostics.push('WALLET_RPC_BUDGET_DEFERRED'); return result; }
  const pending = await all(DB.prepare("SELECT j.*,e.event_json FROM mvp_wallet_receipt_jobs j JOIN mvp_wallet_events e ON e.chain_id=j.chain_id AND e.transaction_hash=j.transaction_hash AND e.block_hash=j.block_hash AND e.kind='SWAP' WHERE j.state IN ('PENDING','RETRY') AND j.next_attempt_at<=? ORDER BY j.next_attempt_at,j.block_number DESC LIMIT ?").bind(observedAt, maxTransactions * 4));
  const selected = new Map();
  for (const value of [...pending.map(row => JSON.parse(row.event_json)), ...events.filter(value => value.kind === 'SWAP')]) {
    const event = eventOf(value); if (event.blockNumber > head.number) continue;
    const key = keyOf(event); if (selected.has(key)) { selected.get(key).events.push(event); continue; }
    if (selected.size < maxTransactions) selected.set(key, { ...event, events: [event] });
  }
  if (!selected.size) return result;
  // Avoid querying already-complete newly observed swaps again in later samples.
  for (const [key, event] of selected) {
    const done = await DB.prepare("SELECT state,next_attempt_at FROM mvp_wallet_receipt_jobs WHERE chain_id=4663 AND transaction_hash=? AND block_hash=?").bind(event.transactionHash, event.blockHash).first();
    if (done?.state === 'COMPLETE' || done && done.next_attempt_at > observedAt) selected.delete(key);
  }
  if (!selected.size) return result;
  const items = [...selected.values()]; const calls = items.flatMap(event => [['eth_getTransactionReceipt', [event.transactionHash]], ['eth_getBlockByNumber', [hex(event.blockNumber), false]]]);
  let values;
  try { values = await rpc.batch(calls); }
  catch { for (const event of items) result.attempts.push({ ...event, reason: 'WALLET_RECEIPT_RPC_UNAVAILABLE' }); return result; }
  for (let i = 0; i < items.length; i++) {
    const event = items[i]; let reason = 'RECEIPT_UNAVAILABLE';
    try {
      const receipt = values?.[i * 2]?.value; const rawBlock = values?.[i * 2 + 1]?.value;
      if (!receipt || !rawBlock || !Array.isArray(receipt.logs)) throw Error(reason);
      const block = { number: quantity(rawBlock.number), hash: rawBlock.hash?.toLowerCase(), timestamp: quantity(rawBlock.timestamp) };
      reason = 'RECEIPT_CANONICAL_MISMATCH';
      if (receipt.transactionHash?.toLowerCase() !== event.transactionHash || receipt.blockHash?.toLowerCase() !== event.blockHash
        || quantity(receipt.blockNumber) !== event.blockNumber || block.number !== event.blockNumber || block.hash !== event.blockHash
        || block.timestamp > head.timestamp || block.timestamp * 1000 > observedAt
        || block.number === head.number && block.hash !== head.hash.toLowerCase()) throw Error(reason);
      json(receipt, 120000);
      const captured = { receipt, block, pool: event.pool ?? null, tokenAddress: event.tokenAddress, events: event.events,
        source: 'canonical-readonly-receipt/v1' };
      reason = 'WALLET_RECEIPT_EVIDENCE_LIMIT'; json(captured);
      result.receipts.push(captured);
    } catch { result.attempts.push({ chainId: 4663, transactionHash: event.transactionHash, blockHash: event.blockHash, blockNumber: event.blockNumber, reason }); }
  }
  return result;
}

/** Bounded replay of observed receipts, never a claim of complete wallet history. */
export async function readWalletReceipts(DB, { walletAddress, limit = 64 } = {}) {
  if (!addr(walletAddress) || !whole(limit) || limit < 1 || limit > 128) fail('INVALID_RECEIPT_QUERY');
  const rows = await all(DB.prepare('SELECT receipt_json FROM mvp_wallet_receipts WHERE chain_id=4663 AND wallet_address=? AND generation=(SELECT generation FROM mvp_wallet_epoch WHERE id=1) ORDER BY block_number DESC,transaction_hash DESC LIMIT ?')
    .bind(addr(walletAddress), limit + 1));
  return { receipts: rows.slice(0, limit).reverse().map(row => JSON.parse(row.receipt_json)),
    historyComplete: false, scope: 'observed-receipts-only', limitHit: rows.length > limit };
}
