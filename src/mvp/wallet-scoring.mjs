import PROFILES_CONFIG from './config.mjs';
import { NETWORK, isEvmAddress } from '../network.mjs';

const defaults = PROFILES_CONFIG.profiles.profile_new;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const percentage = value => finite(value) && value >= 0 && value <= 100;
const normalized = value => typeof value === 'string' ? value.toLowerCase() : null;
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 64
  && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 240);
const source = value => typeof value === 'string' && value.length > 0 && value.length <= 240;
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const pair = value => typeof value === 'string' && /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) && !/^0x0+$/i.test(value);
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19)
  ? Date.parse(value) : NaN;
const clamp = value => Math.max(0, Math.min(1, value));
const round = value => Math.round(value * 100) / 100;
const walletConfig = config => config?.profiles?.profile_new?.walletScoring ?? config?.walletScoring ?? config ?? defaults.walletScoring;
const momentumConfig = config => config?.profiles?.profile_new?.momentum ?? config?.momentum ?? config ?? defaults.momentum;
const pushGap = (gaps, code, path, message) => { if (!gaps.some(gap => gap.code === code && gap.path === path)) gaps.push({ code, path, message }); };
const clock = now => { if (!finite(now)) throw new Error('MVP_SCORE_CLOCK_INVALID'); };

function pnlFeature(value, cap) {
  // Compare exact fixed-point integers before converting only a capped ratio
  // to Number. Money is neither rounded nor replaced in the returned profile.
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,77})(?:\.\d{1,36})?$/.test(value)
    || !Number.isSafeInteger(cap) || cap <= 0) return null;
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = value.replace(/^-/, '').split('.');
  const magnitude = BigInt(integer + fraction);
  const signed = negative ? -magnitude : magnitude;
  const denominator = BigInt(cap) * 10n ** BigInt(fraction.length);
  const bounded = signed <= 0n ? 0n : signed >= denominator ? denominator : signed;
  return { raw: value, positive: signed > 0n, ratio: Number(bounded * 1000000n / denominator) / 1000000 };
}

/** Manual, capped scoring of reliable realized FIFO metrics. This is a ranking
 * hypothesis, not fitted performance or a probability of a profitable trade. */
export function scoreWalletProfile(profile, { now = Date.now(), config } = {}) {
  clock(now);
  const cfg = walletConfig(config);
  const gaps = []; const reasons = []; const components = [];
  const at = time(profile?.checkedAt); const last = time(profile?.lastRealizedAt);
  const pnl = pnlFeature(profile?.netRealizedPnlUsd, cfg.targets.netRealizedPnlUsd);
  let score = null;
  const features = { realizedTradeCount: whole(profile?.realizedTradeCount) ? profile.realizedTradeCount : null,
    netRealizedPnlUsd: pnl?.raw ?? null,
    winRatePct: percentage(profile?.winRatePct) ? profile.winRatePct : null,
    avgHoldingSeconds: finite(profile?.avgHoldingSeconds) && profile.avgHoldingSeconds >= 0 ? profile.avgHoldingSeconds : null,
    earlyEntryPct: percentage(profile?.earlyEntryPct) ? profile.earlyEntryPct : null,
    maxDrawdownPct: percentage(profile?.maxDrawdownPct) ? profile.maxDrawdownPct : null,
    lastRealizedAt: Number.isFinite(last) ? profile.lastRealizedAt : null,
    timeDecayFactor: null, baseScore: null, pnlCappedAtUsd: cfg.targets.netRealizedPnlUsd };
  const finish = status => ({ version: cfg.version, chainId: whole(profile?.chainId) ? profile.chainId : null,
    walletAddress: isEvmAddress(profile?.walletAddress) ? normalized(profile.walletAddress) : null, status, eligible: status === 'ELIGIBLE',
    score: status === 'EXCLUDED' ? 0 : score, components, features, realizedTradeCount: features.realizedTradeCount,
    gaps, reasons, checkedAt: Number.isFinite(at) ? profile.checkedAt : null, evaluatedAt: new Date(now).toISOString(),
    evidenceExpiresAt: Number.isFinite(at) ? new Date(at + cfg.maxProfileAgeSeconds * 1000).toISOString() : null,
    riskFlags: object(profile?.riskFlags) ? Object.fromEntries(['insider', 'bundler', 'washTrading']
      .map(flag => [flag, typeof profile.riskFlags[flag] === 'boolean' ? profile.riskFlags[flag] : null])) : null,
    source: source(profile?.source) ? profile.source : null, evidence: refs(profile?.evidence) ? [...profile.evidence] : [] });
  if (!object(profile) || profile.chainId !== NETWORK.chainId || !isEvmAddress(profile.walletAddress)
    || !source(profile.source) || !refs(profile.evidence) || !Number.isFinite(at)
    || now - at > cfg.maxProfileAgeSeconds * 1000 || at > now + cfg.maxFutureSkewSeconds * 1000) {
    pushGap(gaps, 'WALLET_PROVENANCE_UNPROVEN', 'profile', 'Faltam identidade, proveniência ou dados recentes da carteira.');
    return finish('INCOMPLETE');
  }
  const flags = profile.riskFlags;
  if (object(flags) && ['insider', 'bundler', 'washTrading'].some(flag => flags[flag] === true)) {
    reasons.push('A carteira tem prova de participação como insider, bundler ou wash trading.'); return finish('EXCLUDED');
  }
  for (const field of ['historyComplete', 'costsComplete', 'feesComplete', 'attributionComplete', 'clusteringComplete'])
    if (profile[field] !== true) pushGap(gaps, 'WALLET_HISTORY_INCOMPLETE', field, `A prova de ${field} permanece incompleta.`);
  for (const field of ['insider', 'bundler', 'washTrading']) if (!object(flags) || flags[field] !== false)
    pushGap(gaps, 'WALLET_RISK_UNPROVEN', `riskFlags.${field}`, 'A análise de risco da carteira não está concluída.');
  if (!whole(profile.realizedTradeCount)) pushGap(gaps, 'WALLET_TRADES_UNPROVEN', 'realizedTradeCount', 'Falta uma contagem de trades realizados e conciliados.');
  if (!pnl) pushGap(gaps, 'WALLET_PNL_UNPROVEN', 'netRealizedPnlUsd', 'O PnL realizado líquido ainda não está comprovado em USD decimais.');
  for (const field of ['winRatePct', 'earlyEntryPct', 'maxDrawdownPct']) if (!percentage(profile[field]))
    pushGap(gaps, 'WALLET_METRIC_UNPROVEN', field, 'Uma métrica de desempenho da carteira permanece desconhecida.');
  if (!finite(profile.avgHoldingSeconds) || profile.avgHoldingSeconds < 0)
    pushGap(gaps, 'WALLET_METRIC_UNPROVEN', 'avgHoldingSeconds', 'O tempo médio de posição não está comprovado.');
  if (!Number.isFinite(last) || last > now || last > at)
    pushGap(gaps, 'WALLET_RECENCY_UNPROVEN', 'lastRealizedAt', 'A última realização não tem uma data válida anterior à avaliação.');
  if (gaps.length) return finish('INCOMPLETE');
  if (profile.realizedTradeCount < cfg.minRealizedTrades) {
    reasons.push(`A carteira ainda não tem ${cfg.minRealizedTrades} trades realizados comprovados.`); return finish('INELIGIBLE');
  }
  if (!pnl.positive) { score = 0; reasons.push('O PnL realizado líquido não é positivo.'); return finish('INELIGIBLE'); }
  const ratios = { profit: pnl.ratio, winRate: clamp(profile.winRatePct / cfg.targets.winRatePct),
    earlyEntry: clamp(profile.earlyEntryPct / cfg.targets.earlyEntryPct),
    drawdown: clamp(1 - profile.maxDrawdownPct / cfg.targets.drawdownCapPct),
    holding: clamp(profile.avgHoldingSeconds / cfg.targets.holdingSeconds) };
  for (const [component, ratio] of Object.entries(ratios)) components.push({ component, score: round(ratio * 100),
    weight: cfg.weights[component], weightedPoints: round(ratio * cfg.weights[component]) });
  const baseScore = Object.entries(ratios).reduce((sum, [component, ratio]) => sum + ratio * cfg.weights[component], 0);
  const decay = 2 ** (-(now - last) / (cfg.timeDecayHalfLifeDays * 86400000));
  features.baseScore = round(baseScore); features.timeDecayFactor = decay;
  score = round(baseScore * decay);
  if (score < cfg.minScore) reasons.push('O score manual, após decaimento temporal, está abaixo do mínimo.');
  return finish(score >= cfg.minScore ? 'ELIGIBLE' : 'INELIGIBLE');
}

/** Aggregate proven buyers, counting each connected coordinated cluster once.
 * Absence of a known relationship is never promoted to proven independence. */
export function aggregateWalletSignal(profiles, { tokenAddress, entries = [], now = Date.now(), config } = {}) {
  clock(now);
  const cfg = walletConfig(config);
  const gaps = []; const reasons = []; const grouped = []; const wallets = [];
  const sourceProfiles = Array.isArray(profiles) ? profiles : [];
  const sourceEntries = Array.isArray(entries) ? entries : [];
  let excludedWallets = 0; let incompleteWallets = 0;
  const finish = (status, score = null, expiresAt = null) => ({ version: cfg.version, status, score,
    independentGroups: grouped.length, minIndependentGroups: cfg.minIndependentGroups,
    eligibleWallets: wallets.length, excludedWallets, incompleteWallets, groups: grouped, wallets,
    gaps, reasons, evaluatedAt: new Date(now).toISOString(), evidenceExpiresAt: expiresAt });
  if (!isEvmAddress(tokenAddress) || sourceProfiles.length > cfg.maxWallets || sourceEntries.length > cfg.maxEntries) {
    pushGap(gaps, 'WALLET_INPUT_UNBOUNDED', 'wallets', 'A identidade ou os limites do conjunto de carteiras não são válidos.');
    return finish('INCOMPLETE');
  }
  const byWallet = new Map();
  for (const profile of sourceProfiles) {
    if (!object(profile) || !isEvmAddress(profile.walletAddress) || profile.chainId !== NETWORK.chainId) continue;
    const address = normalized(profile.walletAddress); const prior = byWallet.get(address);
    if (!prior || profile.status === 'EXCLUDED' || (prior.status !== 'EXCLUDED' && time(profile.checkedAt) > time(prior.checkedAt))) byWallet.set(address, profile);
  }
  const eligible = new Map();
  for (const [address, profile] of byWallet) {
    if (profile.status === 'EXCLUDED') { excludedWallets++; continue; }
    if (profile.version === cfg.version && profile.status === 'ELIGIBLE' && profile.eligible === true
      && finite(profile.score) && profile.score >= cfg.minScore && profile.score <= 100
      && whole(profile.realizedTradeCount) && profile.realizedTradeCount >= cfg.minRealizedTrades
      && time(profile.evidenceExpiresAt) >= now && time(profile.evaluatedAt) <= now + cfg.maxFutureSkewSeconds * 1000) eligible.set(address, profile);
    else { incompleteWallets++; pushGap(gaps, 'WALLET_PROFILE_INCOMPLETE', `walletProfiles.${address}`, 'Uma carteira não tem desempenho elegível e comprovado.'); }
  }
  const parent = new Map();
  const find = id => {
    if (!parent.has(id)) parent.set(id, id);
    let root = id; while (parent.get(root) !== root) root = parent.get(root);
    let node = id; while (parent.get(node) !== node) { const next = parent.get(node); parent.set(node, root); node = next; }
    return root;
  };
  const join = (left, right) => { const a = find(left); const b = find(right); if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); };
  const buyers = new Map();
  for (const entry of sourceEntries) {
    if (!object(entry) || !isEvmAddress(entry.walletAddress)) continue;
    const address = normalized(entry.walletAddress); if (!eligible.has(address)) continue;
    const at = time(entry.observedAt); const first = time(entry.firstEntryAt);
    const valid = entry.chainId === NETWORK.chainId && normalized(entry.tokenAddress) === normalized(tokenAddress)
      && entry.attributionVerified === true && entry.entryType === 'buy' && source(entry.source) && refs(entry.evidence)
      && Number.isFinite(at) && now - at <= cfg.maxEntryAgeSeconds * 1000 && at <= now + cfg.maxFutureSkewSeconds * 1000
      && Number.isFinite(first) && first <= now && first <= at + cfg.maxFutureSkewSeconds * 1000
      && entry.clusteringComplete === true && source(entry.clusterId) && entry.clusterId.length <= 128 && refs(entry.clusterEvidence);
    if (!valid) { pushGap(gaps, 'WALLET_ENTRY_UNPROVEN', `walletEntries.${address}`, 'A entrada ou a independência da carteira ainda não está comprovada.'); continue; }
    const existing = buyers.get(address);
    if (existing) { join(existing.clusterId, entry.clusterId); existing.expiresAt = Math.min(existing.expiresAt, at + cfg.maxEntryAgeSeconds * 1000); }
    else { find(entry.clusterId); buyers.set(address, { clusterId: entry.clusterId, expiresAt: at + cfg.maxEntryAgeSeconds * 1000 }); }
  }
  const clusterMap = new Map();
  for (const [address, entry] of buyers) {
    const profile = eligible.get(address); const clusterId = find(entry.clusterId);
    const wallet = { address, walletAddress: address, score: profile.score, clusterId,
      realizedTrades: profile.realizedTradeCount, realizedTradeCount: profile.realizedTradeCount, eligible: true };
    const group = clusterMap.get(clusterId) ?? { clusterId, wallets: [], score: 0, evidenceExpiresAtMs: Infinity };
    group.wallets.push(wallet); group.evidenceExpiresAtMs = Math.min(group.evidenceExpiresAtMs, time(profile.evidenceExpiresAt), entry.expiresAt);
    clusterMap.set(clusterId, group); wallets.push(wallet);
  }
  for (const group of [...clusterMap.values()].sort((a, b) => a.clusterId.localeCompare(b.clusterId))) grouped.push({
    clusterId: group.clusterId, wallets: group.wallets, score: round(group.wallets.reduce((sum, wallet) => sum + wallet.score, 0) / group.wallets.length),
    evidenceExpiresAt: new Date(group.evidenceExpiresAtMs).toISOString() });
  if (grouped.length < cfg.minIndependentGroups) {
    pushGap(gaps, 'WALLET_INDEPENDENCE_INSUFFICIENT', 'wallets.independentGroups', 'Faltam pelo menos dois grupos independentes de compradores elegíveis.');
    return finish('INCOMPLETE');
  }
  const score = round(grouped.reduce((sum, group) => sum + group.score, 0) / grouped.length);
  return finish('READY', score, new Date(Math.min(...grouped.map(group => time(group.evidenceExpiresAt)))).toISOString());
}

/** Two canonical, source-dated points measure actual holder/liquidity growth.
 * Re-reading cached counts or a market cache never manufactures a new point. */
export function scoreLaunchMomentum(observations, { now = Date.now(), config } = {}) {
  clock(now);
  const cfg = momentumConfig(config); const gaps = []; const reasons = []; const components = [];
  const features = { holderGrowthPct: null, liquidityGrowthPct: null, holderSpanSeconds: null, liquiditySpanSeconds: null };
  const finish = (status, score = null, evidenceExpiresAt = null) => ({ version: cfg.version, status, score,
    features, components, gaps, reasons, evaluatedAt: new Date(now).toISOString(), evidenceExpiresAt });
  if (!Array.isArray(observations) || observations.length < 2 || observations.length > cfg.maxObservations) {
    pushGap(gaps, 'MOMENTUM_HISTORY_INSUFFICIENT', 'momentum', 'São necessárias duas observações reais dentro dos limites de retenção.'); return finish('INCOMPLETE');
  }
  const points = [...observations].sort((a, b) => time(a?.observedAt) - time(b?.observedAt));
  const identity = normalized(points.at(-1)?.address);
  for (const point of points) {
    const at = time(point?.observedAt); const holdersAt = time(point?.holdersCheckedAt); const liquidityAt = time(point?.liquidityFetchedAt);
    if (!object(point) || point.chainId !== NETWORK.chainId || !isEvmAddress(point.address) || normalized(point.address) !== identity
      || !source(point.source) || !refs(point.evidence) || point.canonical !== true || !whole(point.blockNumber) || !hash(point.blockHash) || !pair(point.pairAddress)
      || !Number.isFinite(at) || at > now + cfg.maxFutureSkewSeconds * 1000 || point.holdersComplete !== true
      || !whole(point.holdersCount) || !finite(point.liquidityUsd) || point.liquidityUsd < 0
      || !Number.isFinite(holdersAt) || !Number.isFinite(liquidityAt)
      || holdersAt > at + cfg.maxFutureSkewSeconds * 1000 || liquidityAt > at + cfg.maxFutureSkewSeconds * 1000
      || at - holdersAt > cfg.maxHoldersAgeSeconds * 1000 || at - liquidityAt > cfg.maxLiquidityAgeSeconds * 1000) {
      pushGap(gaps, 'MOMENTUM_PROOF_UNPROVEN', 'momentum.observations', 'Faltam identidade, cobertura ou datas originais de provas canónicas de crescimento.'); return finish('INCOMPLETE');
    }
  }
  const after = points.at(-1); const afterAt = time(after.observedAt);
  if (now - afterAt > cfg.maxObservationAgeSeconds * 1000 || now - time(after.holdersCheckedAt) > cfg.maxHoldersAgeSeconds * 1000
    || now - time(after.liquidityFetchedAt) > cfg.maxLiquidityAgeSeconds * 1000) {
    pushGap(gaps, 'MOMENTUM_STALE', 'momentum.observations', 'As provas mais recentes de crescimento perderam atualidade.'); return finish('INCOMPLETE');
  }
  const before = points.slice(0, -1).reverse().find(point => {
    const span = (afterAt - time(point.observedAt)) / 1000;
    const holderSpan = (time(after.holdersCheckedAt) - time(point.holdersCheckedAt)) / 1000;
    const liquiditySpan = (time(after.liquidityFetchedAt) - time(point.liquidityFetchedAt)) / 1000;
    return point.source === after.source && normalized(point.pairAddress) === normalized(after.pairAddress)
      && point.blockNumber < after.blockNumber && normalized(point.blockHash) !== normalized(after.blockHash)
      && [span, holderSpan, liquiditySpan].every(value => value >= cfg.minObservationSpanSeconds && value <= cfg.maxObservationSpanSeconds);
  });
  if (!before || before.holdersCount <= 0 || before.liquidityUsd <= 0) {
    pushGap(gaps, 'MOMENTUM_BASELINE_UNPROVEN', 'momentum.baseline', 'Falta uma base positiva comparável, com blocos e datas de fonte que avancem realmente.'); return finish('INCOMPLETE');
  }
  const holderGrowth = (after.holdersCount - before.holdersCount) / before.holdersCount * 100;
  const liquidityGrowth = (after.liquidityUsd - before.liquidityUsd) / before.liquidityUsd * 100;
  if (!finite(holderGrowth) || !finite(liquidityGrowth)) {
    pushGap(gaps, 'MOMENTUM_GROWTH_INVALID', 'momentum.growth', 'O crescimento observado excede o domínio numérico válido.'); return finish('INCOMPLETE');
  }
  Object.assign(features, { holderGrowthPct: holderGrowth, liquidityGrowthPct: liquidityGrowth,
    holderSpanSeconds: (time(after.holdersCheckedAt) - time(before.holdersCheckedAt)) / 1000,
    liquiditySpanSeconds: (time(after.liquidityFetchedAt) - time(before.liquidityFetchedAt)) / 1000 });
  const ratios = { holders: clamp(holderGrowth / cfg.holderGrowthTargetPct), liquidity: clamp(liquidityGrowth / cfg.liquidityGrowthTargetPct) };
  for (const [component, ratio] of Object.entries(ratios)) components.push({ component, score: round(ratio * 100),
    weight: cfg.weights[component], weightedPoints: round(ratio * cfg.weights[component]) });
  const score = round(Object.entries(ratios).reduce((sum, [component, ratio]) => sum + ratio * cfg.weights[component], 0));
  return finish('READY', score, new Date(Math.min(afterAt + cfg.maxObservationAgeSeconds * 1000,
    time(after.holdersCheckedAt) + cfg.maxHoldersAgeSeconds * 1000,
    time(after.liquidityFetchedAt) + cfg.maxLiquidityAgeSeconds * 1000)).toISOString());
}

/** Complete manual 50/30/20 composition; unknown components retain null and
 * never cause the remaining weights to be scaled up. */
export function scoreNewProfile({ security, wallets, momentum } = {}, weights = defaults.weights) {
  const names = ['wallets', 'security', 'momentum'];
  if (!object(weights) || Object.keys(weights).length !== names.length || names.some(name => !finite(weights[name]) || weights[name] <= 0)
    || Math.abs(names.reduce((sum, name) => sum + weights[name], 0) - 100) > 1e-9) throw new Error('MVP_SCORE_WEIGHTS_INVALID');
  const gaps = []; const values = { security, wallets, momentum };
  const valid = { security: security?.status === 'PASS' && security.securityComplete === true && security.score === 100,
    wallets: wallets?.status === 'READY' && wallets.independentGroups >= defaults.walletScoring.minIndependentGroups,
    momentum: momentum?.status === 'READY' };
  const components = names.map(component => {
    const value = values[component]; const known = valid[component] && finite(value?.score) && value.score >= 0 && value.score <= 100;
    if (!known) pushGap(gaps, 'MVP_SCORE_COMPONENT_UNKNOWN', component, 'Um componente obrigatório do score permanece desconhecido.');
    return { component, score: known ? value.score : null, weight: weights[component], weightedPoints: known ? round(value.score * weights[component] / 100) : null };
  });
  if (security?.status === 'REJECTED') return { status: 'REJECTED', score: 0, scoreComplete: false, components, gaps, aboveThreshold: false };
  if (security?.status === 'OUT_OF_SCOPE') return { status: 'OUT_OF_SCOPE', score: null, scoreComplete: false, components, gaps, aboveThreshold: false };
  if (gaps.length) return { status: 'INCOMPLETE', score: null, scoreComplete: false, components, gaps, aboveThreshold: false };
  const score = round(components.reduce((sum, component) => sum + component.score * component.weight / 100, 0));
  return { status: 'READY', score, scoreComplete: true, components, gaps, aboveThreshold: score >= defaults.minScore };
}
