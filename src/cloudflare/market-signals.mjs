import { createHash } from 'node:crypto';
import defaultPolicy from '../../config/market-signals.json' with { type: 'json' };
import { NETWORK, QUOTE_ASSETS, isEvmAddress } from '../network.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0;
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pairId = value => typeof value === 'string' && /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
  && !/^0x0+$/.test(value);
const normalized = value => typeof value === 'string' ? value.toLowerCase() : '';
const zero = '0x' + '0'.repeat(40);
const labels = {
  BLOCKED: 'Bloqueado pelos riscos observados', STALE: 'Dados desatualizados',
  OUT_OF_SCOPE: 'Fora dos intervalos de idade', WAITING_DATA: 'A aguardar dados de mercado',
  NO_SETUP: 'Condições de mercado ainda não cumpridas', CONFIRMING: 'A confirmar atividade de mercado',
  MARKET_ALERT: 'Alerta de mercado · segurança pendente',
};
const statuses = Object.keys(labels);
const counter = () => Object.fromEntries(statuses.map(status => [status, 0]));

function validQuote(market, entry) {
  const address = normalized(market.quoteTokenAddress);
  const official = Object.entries(QUOTE_ASSETS).find(([, contract]) => contract === address);
  if (official) return market.quoteAsset === undefined || market.quoteAsset === official[0];
  // Native ETH is a distinct v4 currency. Its zero-address identifier must
  // never be accepted as an ERC-20 or silently mapped to WETH.
  return market.quoteAsset === 'ETH' && address === zero && market.poolType === 'v4'
    && entry.poolType === 'v4' && /^0x[0-9a-f]{64}$/i.test(market.pairAddress ?? '');
}

function ageCheck(entry, rule, now) {
  const age = entry.age;
  if (!object(age)) return null;
  const exact = timestamp(age.contractCreatedAt);
  if (Number.isFinite(exact)) {
    const minutes = (now - exact) / 60000;
    return minutes >= rule.ageMinMinutes && (rule.ageMaxMinutes === null || minutes <= rule.ageMaxMinutes);
  }
  const observedAt = timestamp(entry.observedAt);
  if (!Number.isFinite(observedAt) || !nonnegative(age.lowerBoundMinutes)) return null;
  const elapsed = Math.max(0, (now - observedAt) / 60000);
  const lower = age.lowerBoundMinutes + elapsed;
  if (rule.ageMaxMinutes === null) return lower >= rule.ageMinMinutes;
  if (!nonnegative(age.upperBoundMinutes) || age.upperBoundMinutes < age.lowerBoundMinutes) return null;
  return lower >= rule.ageMinMinutes && age.upperBoundMinutes + elapsed <= rule.ageMaxMinutes;
}

/**
 * Evidence-backed market attention alerts, independent of strict trade approval.
 * Source timestamps, identities and confirmation are checked on every call;
 * no missing field is filled from a native-price sample or a transaction count
 * relabelled as unique traders. All outputs explicitly retain tradeApproved:false.
 */
export function evaluateMarketSignals(entries, previousState = {}, { now = Date.now(), policy = defaultPolicy } = {}) {
  if (!finite(now)) throw new Error('MARKET_SIGNAL_CLOCK_INVALID');
  const fingerprint = hash(policy);
  const state = {};
  for (const [key, prior] of Object.entries(object(previousState) ? previousState : {})) {
    const rule = prior && Object.hasOwn(policy.pipelines, prior.pipeline) ? policy.pipelines[prior.pipeline] : null;
    if (object(prior) && rule && prior.policyHash === fingerprint && Number.isSafeInteger(prior.count) && prior.count > 0
      && isEvmAddress(prior.address) && key === `${prior.pipeline}:${normalized(prior.address)}`
      && typeof prior.sourceKey === 'string' && prior.sourceKey.length > 0
      && finite(prior.firstSourceAtMs) && finite(prior.lastSourceAtMs) && prior.firstSourceAtMs <= prior.lastSourceAtMs
      && prior.lastSourceAtMs <= now + policy.maxFutureSkewSeconds * 1000
      && now - prior.lastSourceAtMs <= rule.confirmation.maxGapSeconds * 1000) state[key] = prior;
  }
  const evaluatedAt = new Date(now).toISOString();
  const candidates = (Array.isArray(entries) ? entries : []).filter(object);
  const blockedAddresses = new Set(candidates.filter(entry => entry.status === 'BLOCKED'
    || (Array.isArray(entry.risks) && entry.risks.length)).map(entry => normalized(entry.address)));
  const evaluated = candidates.map(entry => {
    const pipeline = Object.hasOwn(policy.pipelines, entry.pipeline) ? entry.pipeline : 'unclassified';
    const rule = policy.pipelines[pipeline];
    const key = `${pipeline}:${normalized(entry.address)}`;
    const checks = []; const missing = []; const reasons = [];
    const market = object(entry.externalMarket) ? entry.externalMarket : null;
    const sourceAt = timestamp(market?.fetchedAt);
    const observationAt = timestamp(entry.observedAt);
    let score = null;
    const check = (id, label, value, threshold, passed) => {
      checks.push({ id, label, value: value ?? null, threshold, passed });
      if (passed === null) missing.push(id);
      else if (!passed) reasons.push(label);
    };
    const finish = (status, extra = {}) => {
      if (!['CONFIRMING', 'MARKET_ALERT'].includes(status)) delete state[key];
      return { ...entry, signal: {
        kind: status === 'MARKET_ALERT' ? 'MARKET_ALERT' : 'MARKET_OBSERVATION',
        status, label: labels[status], pipeline, score, minScore: policy.minScore,
        checks, reasons, missing, evaluatedAt,
        observedAt: Number.isFinite(sourceAt) ? new Date(sourceAt).toISOString() : null,
        expiresAt: Number.isFinite(sourceAt) && Number.isFinite(observationAt)
          ? new Date(Math.min(sourceAt + policy.maxMarketAgeSeconds * 1000,
            observationAt + policy.maxObservationAgeSeconds * 1000)).toISOString() : null,
        tradeApproved: false, policyVersion: policy.version, policyHash: fingerprint,
        source: market?.source ?? null, pairAddress: market?.pairAddress ?? null,
        ...extra,
      } };
    };
    if (entry.status === 'BLOCKED' || blockedAddresses.has(normalized(entry.address))) {
      reasons.push('Existem riscos observados; o alerta de mercado foi bloqueado.');
      return finish('BLOCKED');
    }
    if (!isEvmAddress(entry.address)) {
      missing.push('address'); reasons.push('Contrato de token inválido ou ausente.');
      return finish('WAITING_DATA');
    }
    if (!Number.isFinite(observationAt)) {
      missing.push('observedAt'); return finish('WAITING_DATA');
    }
    if (now - observationAt > policy.maxObservationAgeSeconds * 1000
      || observationAt - now > policy.maxFutureSkewSeconds * 1000) {
      reasons.push('A observação do contrato perdeu atualidade.'); return finish('STALE');
    }
    if (!rule) {
      reasons.push('A idade comprovada ainda não pertence a um dos dois pipelines.'); return finish('OUT_OF_SCOPE');
    }
    const age = ageCheck(entry, rule, now);
    const ageValue = entry.age?.contractCreatedAt ?? (object(entry.age)
      ? { lowerBoundMinutes: entry.age.lowerBoundMinutes ?? null, upperBoundMinutes: entry.age.upperBoundMinutes ?? null } : null);
    check('age', 'Idade comprovada no intervalo do pipeline', ageValue,
      { minMinutes: rule.ageMinMinutes, maxMinutes: rule.ageMaxMinutes }, age);
    if (age === false) return finish('OUT_OF_SCOPE');
    if (age === null) return finish('WAITING_DATA');
    if (!market) { missing.push('externalMarket'); return finish('WAITING_DATA'); }
    const identity = market.chainId === NETWORK.chainId && (!market.chain || market.chain === NETWORK.chain)
      && normalized(market.baseTokenAddress) === normalized(entry.address) && pairId(market.pairAddress)
      && (market.pairAddress.length === 42 || (market.poolType === 'v4' && entry.poolType === 'v4'))
      && validQuote(market, entry) && typeof market.source === 'string' && market.source.length > 0;
    check('marketIdentity', 'Rede, token, par e moeda de cotação identificados', identity, true, identity);
    if (!identity) { missing.push('marketIdentity'); return finish('WAITING_DATA'); }
    if (!Number.isFinite(sourceAt)) { missing.push('externalMarket.fetchedAt'); return finish('WAITING_DATA'); }
    if (now - sourceAt > policy.maxMarketAgeSeconds * 1000
      || sourceAt - now > policy.maxFutureSkewSeconds * 1000) {
      reasons.push('As métricas de mercado expiraram ou têm data futura inválida.'); return finish('STALE');
    }
    const read = (value, id, integer = false) => {
      if (!nonnegative(value) || (integer && !Number.isSafeInteger(value))) { missing.push(id); return null; }
      return value;
    };
    const liquidity = read(market.liquidityUsd, 'liquidityUsd');
    const fdv = read(market.fdvUsd, 'fdvUsd');
    const volumes = market.volumeUsd ?? {};
    const window = rule.priceChangeWindow;
    const volume = read(volumes[rule.volumeWindow]
      ?? (rule.volumeWindow === 'm5' ? market.volume5mUsd : market.volume24hUsd), `volumeUsd.${rule.volumeWindow}`);
    const changeValue = market.priceChangePct?.[window]
      ?? (window === 'm5' ? market.priceChange5mPct : market.priceChange1hPct);
    const change = finite(changeValue) && changeValue >= -100 ? changeValue : null;
    if (change === null) missing.push(`priceChangePct.${window}`);
    const buys = read(market.txns?.[window]?.buys, `txns.${window}.buys`, true);
    const sells = read(market.txns?.[window]?.sells, `txns.${window}.sells`, true);
    const totalTransactions = buys !== null && sells !== null ? buys + sells : null;
    const transactions = Number.isSafeInteger(totalTransactions) ? totalTransactions : null;
    if (totalTransactions !== null && transactions === null) missing.push('transactions');
    const buyShare = transactions > 0 ? buys / transactions * 100 : transactions === 0 ? 0 : null;
    const recentVolume = read(volumes[window]
      ?? (window === 'm5' ? market.volume5mUsd : market.volume1hUsd), `volumeUsd.${window}`);
    const totalWindow = pipeline === 'new' ? 'h1' : 'h24';
    const totalVolume = read(volumes[totalWindow]
      ?? (totalWindow === 'h24' ? market.volume24hUsd : market.volume1hUsd), `volumeUsd.${totalWindow}`);
    let acceleration = null;
    if (recentVolume !== null && totalVolume !== null && totalVolume > recentVolume)
      acceleration = recentVolume / ((totalVolume - recentVolume) / (pipeline === 'new' ? 11 : 23));
    else missing.push('accelerationBaseline');
    if (acceleration !== null && !finite(acceleration)) { acceleration = null; missing.push('accelerationBaseline'); }
    const criterion = (id, label, value, threshold, passes) => check(id, label, value, threshold, value === null ? null : passes(value));
    criterion('liquidityUsd', 'Liquidez mínima em USD reportados', liquidity, rule.liquidityMinUsd, value => value >= rule.liquidityMinUsd);
    criterion('fdvUsd', 'FDV dentro do intervalo', fdv, { min: rule.fdvMinUsd, max: rule.fdvMaxUsd }, value => value >= rule.fdvMinUsd && value <= rule.fdvMaxUsd);
    criterion('volumeUsd', `Volume ${rule.volumeWindow} mínimo em USD reportados`, volume, rule.volumeMinUsd, value => value >= rule.volumeMinUsd);
    criterion('transactions', `Transações ${window} reportadas (não traders únicos)`, transactions, rule.minTransactions, value => value >= rule.minTransactions);
    criterion('buySharePct', `Percentagem de compras nas transações ${window}`, buyShare, rule.minBuySharePct, value => value >= rule.minBuySharePct);
    criterion('acceleration', pipeline === 'new' ? 'Volume 5m / média dos 55m anteriores' : 'Volume 1h / média das 23h anteriores', acceleration,
      rule.accelerationMin, value => value >= rule.accelerationMin);
    criterion('priceChangePct', `Variação de preço ${window} dentro do intervalo`, change,
      { min: rule.priceChangeMinPct, max: rule.priceChangeMaxPct }, value => value >= rule.priceChangeMinPct && value <= rule.priceChangeMaxPct);
    if (liquidity !== null && volume !== null && change !== null) {
      const clamp = value => Math.max(0, Math.min(1, value));
      const weights = policy.scoreWeights; const targets = rule.scoreTargets;
      score = Math.round((clamp(liquidity / targets.liquidityUsd) * weights.liquidity
        + clamp(volume / targets.volumeUsd) * weights.volume
        + clamp(change / targets.momentumPct) * weights.momentum) * 10) / 10;
      check('score', 'Score do alerta de mercado', score, policy.minScore, score >= policy.minScore);
    }
    if (missing.length) { missing.splice(0, missing.length, ...new Set(missing)); return finish('WAITING_DATA'); }
    if (checks.some(item => item.passed === false)) return finish('NO_SETUP');
    const prior = state[key];
    if (prior && sourceAt < prior.lastSourceAtMs) {
      reasons.push('A data da fonte recuou; a confirmação foi reiniciada.');
      return finish('WAITING_DATA');
    }
    const sourceKey = `${market.source}:${normalized(market.pairAddress)}:${normalized(market.quoteTokenAddress)}`;
    const sameSeries = prior && prior.sourceKey === sourceKey
      && sourceAt - prior.lastSourceAtMs <= rule.confirmation.maxGapSeconds * 1000;
    const progress = sameSeries ? { ...prior } : { policyHash: fingerprint, pipeline, address: normalized(entry.address),
      sourceKey, count: 0, firstSourceAtMs: sourceAt, lastSourceAtMs: null };
    if (progress.lastSourceAtMs === null || sourceAt > progress.lastSourceAtMs) {
      progress.count++; progress.lastSourceAtMs = sourceAt;
    }
    state[key] = progress;
    const spanSeconds = (progress.lastSourceAtMs - progress.firstSourceAtMs) / 1000;
    const confirmed = progress.count >= rule.confirmation.minObservations && spanSeconds >= rule.confirmation.minSpanSeconds;
    const confirmation = { observations: progress.count, minObservations: rule.confirmation.minObservations,
      spanSeconds, minSpanSeconds: rule.confirmation.minSpanSeconds };
    if (!confirmed) reasons.push('A aguardar observações de mercado distintas e tempo mínimo de confirmação.');
    return finish(confirmed ? 'MARKET_ALERT' : 'CONFIRMING', { confirmation });
  });
  const tracked = Object.entries(state).sort(([, a], [, b]) => b.lastSourceAtMs - a.lastSourceAtMs).slice(0, policy.maxTrackedStates);
  const summary = { total: evaluated.length, counts: counter(), pipelines: Object.fromEntries(['new', 'established', 'unclassified']
    .map(pipeline => [pipeline, { total: 0, counts: counter() }])), marketAlerts: 0, tradeApproved: false,
    policyVersion: policy.version, criteria: policy.pipelines, minScore: policy.minScore, scope: policy.scope };
  for (const entry of evaluated) {
    const { status, pipeline } = entry.signal;
    summary.counts[status]++; summary.pipelines[pipeline].total++; summary.pipelines[pipeline].counts[status]++;
    if (status === 'MARKET_ALERT') summary.marketAlerts++;
  }
  return { entries: evaluated, state: Object.fromEntries(tracked), summary };
}

/** Preserve bounded, still-valid confirmations when the collector rotates tokens.
 * Default runScan semantics remain a complete snapshot replacement for the CLI.
 */
export function mergeIncrementalEvaluationState(previous, next, {
  now = Date.now(), policyHash, pipelines = defaultPolicy.pipelines, maxEntries = 128, reorg = false,
} = {}) {
  if (!finite(now) || typeof policyHash !== 'string' || !Number.isSafeInteger(maxEntries) || maxEntries < 1)
    throw new Error('INCREMENTAL_EVALUATION_OPTIONS_INVALID');
  const merged = { ...(reorg ? {} : object(previous) ? previous : {}), ...(object(next) ? next : {}) };
  return Object.fromEntries(Object.entries(merged).filter(([, item]) => {
    const rule = item && pipelines && Object.hasOwn(pipelines, item.pipeline) ? pipelines[item.pipeline] : null;
    return object(item) && rule && item.policyHash === policyHash && isEvmAddress(item.address)
      && item.chain === NETWORK.chain && item.chainId === NETWORK.chainId && item.environment === NETWORK.environment
      && Number.isSafeInteger(item.count) && item.count > 0
      && finite(item.lastObservedAtMs) && item.lastObservedAtMs <= now
      && now - item.lastObservedAtMs <= rule.confirmation.maxGapSeconds * 1000;
  }).sort(([, a], [, b]) => b.lastObservedAtMs - a.lastObservedAtMs).slice(0, maxEntries));
}
