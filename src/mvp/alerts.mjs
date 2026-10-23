import { isEvmAddress } from '../network.mjs';
import { recordLabel, recordTime } from './records.mjs';

const MAX_TEXT = 4096;
const MAX_ENVELOPE_BYTES = 16384;
const sensitive = /\b(?:TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|chat_id|bot_token|authorization)\s*[:=]|\b(?:bot)?\d{6,}:[A-Za-z0-9_-]{20,}/i;
const critical = /HONEYPOT|BLACKLIST|MINT|PAUS|CONFISCAT|PROXY|DELEGAT|INSIDER|BUNDLE|SYBIL|RUG|MALICIOUS|HIDDEN|EMPTY_LIQUIDITY|NO_LIQUIDITY|LIQUIDITY_REMOV|SELL_(?:FAILED|REVERT|BLOCK)|TRANSFER_RESTRICT|SOURCE_MISMATCH|UNVERIFIED|UNAVAILABLE|MISSING|INCOMPLETE|FAILED|INVALID|UNKNOWN|UNSAFE|UNTRUSTED|UNREVIEWED|CRITICAL|HIGH_RISK|RISK_DETECTED|BLOCKED|(?:BUY|SELL).*TAX|TAX.*(?:HIGH|ABOVE|POSITIVE)|CONCENTRATION/;
const completeScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const address = value => { if (!isEvmAddress(value)) throw new Error('MVP_ALERT_INVALID_ADDRESS'); return value.toLowerCase(); };
const assertPlain = value => { if (typeof value !== 'string' || sensitive.test(value)) throw new Error('MVP_ALERT_SENSITIVE_OR_INVALID_TEXT'); };
function text(value, limit) {
  assertPlain(value);
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+|tg:\/\/\S+|www\.\S+/gi, '[link removido]').replace(/@/g, '')
    .replace(/\s+/g, ' ').trim();
  const characters = [...clean];
  return characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : clean;
}
function identifier(value, label, max = 200) {
  recordLabel(value, label, max); assertPlain(value);
  if (/https?:\/\/|tg:\/\/|www\./i.test(value)) throw new Error('MVP_ALERT_INVALID_IDENTIFIER');
  return value;
}
function chartLink(value) {
  if (typeof value !== 'string') throw new Error('MVP_ALERT_CHART_REQUIRED');
  let parsed; try { parsed = new URL(value); } catch { throw new Error('MVP_ALERT_INVALID_CHART'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'dexscreener.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('MVP_ALERT_INVALID_CHART');
  const match = /^\/robinhood\/(0x(?:[0-9a-f]{40}|[0-9a-f]{64}))\/?$/i.exec(parsed.pathname);
  if (!match || /^0x0+$/.test(match[1])) throw new Error('MVP_ALERT_INVALID_CHART');
  return `https://dexscreener.com/robinhood/${match[1].toLowerCase()}`;
}
function riskFlags(value) {
  if (!Array.isArray(value) || value.length > 8) throw new Error('MVP_ALERT_INVALID_FLAGS');
  return value.map(flag => {
    const code = typeof flag === 'string' ? flag : flag?.code;
    assertPlain(code);
    if (!code.trim() || code.length > 240) throw new Error('MVP_ALERT_INVALID_FLAGS');
    const severity = typeof flag === 'object' ? String(flag.severity ?? '').toUpperCase() : '';
    const normalized = code.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
    if (critical.test(normalized) || ['HIGH', 'CRITICAL', 'BLOCKED', 'FAILED'].includes(severity))
      throw new Error('MVP_ALERT_HIGH_RISK');
    if (typeof flag === 'object' && !['INFO', 'LOW', 'WARNING', ''].includes(severity)) throw new Error('MVP_ALERT_INVALID_FLAGS');
    return text(code, 80);
  });
}
function enforceDryRun(options) {
  if (options.dryRun !== undefined && options.dryRun !== true) throw new Error('MVP_ALERT_DRY_RUN_REQUIRED');
}

/** Plain Telegram-compatible text only. No parse_mode, token, chat ID or network. */
export function formatDryRunAlert(decision, options = {}) {
  enforceDryRun(options);
  const minScore = options.minScore ?? 75;
  if (!completeScore(minScore) || minScore < 75) throw new Error('MVP_ALERT_INVALID_MIN_SCORE');
  if (!decision || typeof decision !== 'object' || decision.status !== 'PASS' || decision.profile !== 'profile_new'
    || decision.direction !== 'ENTRY' || decision.chainId !== 4663 || decision.scoreComplete !== true
    || decision.walletsComplete !== true || decision.securityComplete !== true || decision.eligible === false)
    throw new Error('MVP_ALERT_INELIGIBLE');
  if (!completeScore(decision.score) || decision.score < minScore) throw new Error('MVP_ALERT_INCOMPLETE_SCORE');
  if (decision.synthetic !== undefined && typeof decision.synthetic !== 'boolean') throw new Error('MVP_ALERT_INVALID_SYNTHETIC');
  const tokenAddress = address(decision.address);
  const decisionId = identifier(decision.decisionId, 'ALERT_DECISION_ID', 500);
  const scoreVersion = identifier(decision.scoreVersion, 'ALERT_SCORE_VERSION', 100);
  const observedAt = new Date(recordTime(decision.observedAt, 'ALERT_OBSERVED_AT')).toISOString();
  const symbol = typeof decision.symbol === 'string' ? text(decision.symbol, 40) : '';
  if (!Array.isArray(decision.reasons) || decision.reasons.length < 3) throw new Error('MVP_ALERT_THREE_REASONS_REQUIRED');
  const reasons = decision.reasons.slice(0, 3).map(reason => text(reason, 160));
  if (reasons.some(reason => !reason)) throw new Error('MVP_ALERT_THREE_REASONS_REQUIRED');
  if (!Array.isArray(decision.wallets) || decision.wallets.length < 1 || decision.wallets.length > 8)
    throw new Error('MVP_ALERT_INCOMPLETE_WALLETS');
  const wallets = decision.wallets.map(wallet => {
    if (!wallet || !completeScore(wallet.score) || wallet.eligible !== true || !Number.isSafeInteger(wallet.realizedTrades)
      || wallet.realizedTrades < 5) throw new Error('MVP_ALERT_INCOMPLETE_WALLETS');
    if (wallet.synthetic === true && decision.synthetic !== true) throw new Error('MVP_ALERT_SYNTHETIC_WALLET');
    const walletAddress = address(wallet.address);
    const clusterId = identifier(wallet.clusterId, 'ALERT_CLUSTER_ID', 80);
    return { address: walletAddress, score: wallet.score, clusterId, realizedTrades: wallet.realizedTrades, eligible: true };
  });
  if (new Set(wallets.map(wallet => wallet.address)).size !== wallets.length) throw new Error('MVP_ALERT_DUPLICATE_WALLET');
  if (new Set(wallets.map(wallet => wallet.clusterId)).size !== wallets.length) throw new Error('MVP_ALERT_DEPENDENT_WALLET_GROUPS');
  const flags = riskFlags(decision.riskFlags);
  const chartUrl = chartLink(decision.chartUrl);
  const synthetic = decision.synthetic === true;
  const lines = [`[NOVO] ${symbol || tokenAddress}`, synthetic ? 'SINTÉTICO · DRY RUN · sem envio' : 'DRY RUN · sem envio',
    `Contrato: ${tokenAddress}`, `Score: ${decision.score}/100 · ${scoreVersion}`, 'Motivos:',
    ...reasons.map((reason, index) => `${index + 1}. ${reason}`), 'Carteiras:',
    ...wallets.map(wallet => `${wallet.address} · ${wallet.score}/100 · ${wallet.realizedTrades} trades realizados · cluster ${text(wallet.clusterId, 40)}`),
    `Flags reportadas: ${flags.length ? flags.join(' · ') : 'nenhuma'}`, `Gráfico: ${chartUrl}`, `Observado em: ${observedAt}`];
  const message = lines.join('\n');
  if (message.length > MAX_TEXT) throw new Error('MVP_ALERT_TEXT_LIMIT_EXCEEDED');
  const envelope = { schemaVersion: 1, kind: 'mvp-dry-run-alert', dryRun: true, state: 'DRY_RUN', synthetic,
    decisionId, chainId: 4663, address: tokenAddress, symbol: symbol || null, profile: 'profile_new', direction: 'ENTRY',
    score: decision.score, minScore, scoreVersion, observedAt, reasons, wallets, riskFlags: flags, chartUrl, text: message };
  if (new TextEncoder().encode(JSON.stringify(envelope)).length > MAX_ENVELOPE_BYTES) throw new Error('MVP_ALERT_ENVELOPE_LIMIT_EXCEEDED');
  return envelope;
}

/** Prepare append-only previews for the collector's existing fenced D1 batch. */
export function prepareDryRunAlerts(DB, decisions, options = {}) {
  enforceDryRun(options);
  const runId = identifier(options.runId, 'ALERT_RUN_ID');
  const createdAt = recordTime(options.observedAt ?? (typeof options.now === 'function' ? options.now() : options.now ?? Date.now()), 'ALERT_CREATED_AT');
  const destinationKey = options.destinationKey ?? 'telegram:dry-run:default';
  if (typeof destinationKey !== 'string' || !/^telegram:dry-run:[a-z][a-z0-9_-]{0,47}$/.test(destinationKey))
    throw new Error('MVP_ALERT_INVALID_DESTINATION_ALIAS');
  if (!Array.isArray(decisions)) throw new Error('MVP_ALERT_INVALID_ARRAY');
  const commands = []; const accepted = []; const diagnostics = []; const seen = new Set();
  for (let index = 0; index < decisions.length; index++) {
    const decision = decisions[index];
    try {
      const envelope = formatDryRunAlert(decision, options);
      if (recordTime(envelope.observedAt) > createdAt) throw new Error('MVP_ALERT_FUTURE_OBSERVATION');
      const episodeId = identifier(decision.episodeId ?? options.episodeId ?? envelope.decisionId, 'ALERT_EPISODE_ID', 500);
      const key = JSON.stringify([envelope.decisionId, envelope.scoreVersion, episodeId, destinationKey]);
      if (seen.has(key)) { diagnostics.push({ index, reason: 'DUPLICATE_IN_RUN' }); continue; }
      seen.add(key);
      const stored = { ...envelope, episodeId, destination: 'telegram-dry-run' };
      commands.push(DB.prepare(`INSERT OR IGNORE INTO mvp_alert_outbox
        (outbox_key,decision_id,score_version,episode_id,destination_key,run_id,synthetic,chain_id,address,profile,direction,
         score,observed_at,created_at,message_text,envelope_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(key, envelope.decisionId, envelope.scoreVersion, episodeId, destinationKey, runId, envelope.synthetic ? 1 : 0,
          4663, envelope.address, envelope.profile, envelope.direction, envelope.score, recordTime(envelope.observedAt),
          createdAt, envelope.text, JSON.stringify(stored)));
      accepted.push(stored); diagnostics.push({ index, reason: 'DRY_RUN_PREPARED' });
    } catch (error) {
      const reason = typeof error?.message === 'string' && /^MVP_[A-Z0-9_]+$/.test(error.message) ? error.message : 'MVP_ALERT_INVALID';
      diagnostics.push({ index, reason });
    }
  }
  return { commands, accepted, diagnostics, dryRun: true };
}

/** Public projections use an explicit field whitelist, never raw configuration. */
export async function getRecentDryRunAlerts(DB, { limit = 5 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('MVP_ALERT_INVALID_LIMIT');
  const response = await DB.prepare("SELECT envelope_json,created_at FROM mvp_alert_outbox WHERE state='DRY_RUN' ORDER BY created_at DESC,outbox_key LIMIT ?")
    .bind(limit).all();
  const rows = Array.isArray(response) ? response : response?.results;
  if (!Array.isArray(rows)) throw new Error('MVP_ALERT_INVALID_QUERY_RESPONSE');
  return rows.map(row => {
    const value = JSON.parse(row.envelope_json);
    return { schemaVersion: 1, dryRun: true, state: 'DRY_RUN', synthetic: value.synthetic === true,
      decisionId: value.decisionId, chainId: value.chainId, address: value.address, symbol: value.symbol,
      profile: value.profile, direction: value.direction, score: value.score, scoreVersion: value.scoreVersion,
      minScore: value.minScore,
      observedAt: value.observedAt, createdAt: new Date(row.created_at).toISOString(), reasons: value.reasons,
      wallets: value.wallets.map(wallet => ({ address: wallet.address, score: wallet.score, clusterId: wallet.clusterId,
        realizedTrades: wallet.realizedTrades, eligible: wallet.eligible === true })),
      riskFlags: value.riskFlags, chartUrl: value.chartUrl, text: value.text };
  });
}
export async function getDryRunAlertStats(DB) {
  const row = await DB.prepare('SELECT queued_dry_run,synthetic,last_created_at FROM mvp_outbox_stats WHERE id=1').first();
  if (!row) throw new Error('MVP_OUTBOX_STATS_NOT_INITIALIZED');
  return { schemaVersion: 1, dryRun: true, queuedDryRun: row.queued_dry_run, synthetic: row.synthetic,
    lastCreatedAt: row.last_created_at == null ? null : new Date(row.last_created_at).toISOString() };
}
