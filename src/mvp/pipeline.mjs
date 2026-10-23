import { evaluateHardFilters } from './hard-filters.mjs';
import { PROFILES_CONFIG, configProfileFingerprint } from './config.mjs';

export const MVP_POLICY_HASH = configProfileFingerprint(PROFILES_CONFIG);
export const MVP_SCORE_VERSION = `mvp-new-v1:${MVP_POLICY_HASH.slice(0, 16)}`;

/** Compatibility layer over the existing scanner. Phase 2 deliberately has no
 * substitute for missing wallet history: it archives a null score, not zero. */
export function evaluateNewToken(snapshot, entry = {}, { now = Date.now() } = {}) {
  const security = evaluateHardFilters(snapshot, entry, { now });
  const wallets = { score: null, realizedPnlUsd: null, eligible: false,
    status: 'INSUFFICIENT_HISTORY', independentGroups: 0, wallets: [] };
  const gaps = [...security.gaps, { code: 'WALLET_HISTORY_UNAVAILABLE', path: 'wallets',
    message: 'Faltam compras, vendas, custo inicial e taxas verificadas para calcular PnL realizado.' }];
  return { schemaVersion: 1, chainId: snapshot.chainId, address: snapshot.address,
    symbol: snapshot.symbol ?? entry.symbol ?? null, synthetic: snapshot.synthetic !== false,
    profile: 'profile_new', direction: 'ENTRY', dryRun: true,
    scoreVersion: MVP_SCORE_VERSION, policyHash: MVP_POLICY_HASH,
    observedAt: new Date(now).toISOString(), security, wallets,
    status: ['REJECTED', 'OUT_OF_SCOPE'].includes(security.status) ? security.status : 'INCOMPLETE',
    score: null, scoreComplete: false, securityComplete: security.status === 'PASS',
    walletsComplete: false, alertEligible: false, reasons: security.reasons.slice(0, 3), gaps,
    riskFlags: security.checks.filter(check => check.passed === false).map(check => ({
      code: check.metric ?? check.code ?? 'SECURITY_FAILED', severity: 'critical',
      message: check.reason ?? check.message ?? 'Filtro duro reprovado.' })),
    chartUrl: typeof entry.poolId === 'string'
      ? `https://dexscreener.com/robinhood/${entry.poolId}` : null };
}
