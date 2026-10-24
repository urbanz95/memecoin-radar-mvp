import { evaluateHardFilters } from './hard-filters.mjs';
import { PROFILES_CONFIG, configProfileFingerprint } from './config.mjs';
import { createHash } from 'node:crypto';
import { policyHash } from '../engine.mjs';
import legacyPolicy from '../../config/policies.json' with { type: 'json' };
import { scoreWalletProfile, aggregateWalletSignal, scoreLaunchMomentum, scoreNewProfile } from './wallet-scoring.mjs';

export const MVP_POLICY_HASH = createHash('sha256').update(JSON.stringify({
  profiles: configProfileFingerprint(PROFILES_CONFIG), hardFilters: policyHash(legacyPolicy),
  method: 'mvp-new-v3-wallet-realization-decay-momentum' })).digest('hex');
export const MVP_SCORE_VERSION = `mvp-new-v3:${MVP_POLICY_HASH.slice(0, 16)}`;

function chartUrl(entry) {
  const external = entry.externalMarket?.pairAddress;
  let pair = typeof external === 'string' && /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(external) ? external : null;
  if (!pair && typeof entry.poolId === 'string') {
    const match = /^(?:v[23]:(0x[0-9a-f]{40})|v4:(0x[0-9a-f]{64}))$/i.exec(entry.poolId);
    pair = match?.[1] ?? match?.[2] ?? null;
  }
  return pair && !/^0x0+$/i.test(pair) ? `https://dexscreener.com/robinhood/${pair.toLowerCase()}` : null;
}

/** Reuse scanner evidence; no LLM, price prediction or trade execution. */
export function evaluateNewToken(snapshot, entry = {}, { now = Date.now(),
  walletProfiles = [], walletEntries = [], momentumObservations = [] } = {}) {
  const profile = PROFILES_CONFIG.profiles.profile_new;
  const security = evaluateHardFilters(snapshot, entry, { now });
  const scoredWallets = walletProfiles.map(value => scoreWalletProfile(value, { now }));
  const aggregated = aggregateWalletSignal(scoredWallets, { tokenAddress: snapshot.address, entries: walletEntries, now });
  const wallets = { ...aggregated, realizedPnlUsd: null, wallets: (aggregated.wallets ?? []).slice(0, 8).map(value => ({
    address: value.address ?? value.walletAddress, score: value.score, clusterId: value.clusterId,
    realizedTrades: value.realizedTrades ?? value.realizedTradeCount ?? value.features?.realizedTradeCount,
    eligible: value.status === 'ELIGIBLE' || value.eligible === true })) };
  const momentum = scoreLaunchMomentum(momentumObservations, { now });
  const combined = scoreNewProfile({ security, wallets, momentum }, profile.weights);
  const score = security.status === 'PASS' && wallets.status === 'READY' && momentum.status === 'READY'
    && typeof combined.score === 'number' && Number.isFinite(combined.score) ? combined.score : null;
  const status = ['REJECTED', 'OUT_OF_SCOPE'].includes(security.status) ? security.status
    : score === null ? 'INCOMPLETE' : score >= profile.minScore ? 'PASS' : 'WATCH';
  const gaps = [...security.gaps, ...(wallets.gaps ?? []), ...(momentum.gaps ?? []),
    ...(!walletProfiles.length ? [{ code: 'WALLET_HISTORY_UNAVAILABLE', path: 'wallets',
      message: 'Faltam compras, vendas, custo inicial e taxas verificadas para calcular PnL realizado.' }] : [])];
  const reasons = score === null ? [...security.reasons, ...gaps.map(gap => gap.message ?? gap.code)].slice(0, 3)
    : [`${wallets.independentGroups} grupos de carteiras com histórico comprovado · score ${wallets.score}/100.`,
      'Filtros duros de segurança e proveniência cumprem o perfil.',
      `Momentum de holders e liquidez comprovado · score ${momentum.score}/100.`];
  return { schemaVersion: 1, chainId: snapshot.chainId, address: snapshot.address,
    symbol: snapshot.symbol ?? entry.symbol ?? null, synthetic: snapshot.synthetic !== false,
    profile: 'profile_new', direction: 'ENTRY', dryRun: true,
    scoreVersion: MVP_SCORE_VERSION, policyHash: MVP_POLICY_HASH,
    observedAt: new Date(now).toISOString(), security, wallets, momentum,
    status, score, scoreComplete: score !== null, securityComplete: security.status === 'PASS',
    walletsComplete: wallets.status === 'READY', alertEligible: status === 'PASS', reasons, gaps,
    riskFlags: security.checks.filter(check => check.passed === false).map(check => ({
      code: check.metric ?? check.code ?? 'SECURITY_FAILED', severity: 'critical',
      message: check.reason ?? check.message ?? 'Filtro duro reprovado.' })).concat({ code: 'UNCALIBRATED_MVP', severity: 'INFO' }),
    chartUrl: chartUrl(entry) };
}
