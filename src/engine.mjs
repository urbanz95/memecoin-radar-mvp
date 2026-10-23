import { createHash } from 'node:crypto';
import { NETWORK, QUOTE_ASSETS, isEvmAddress, normalizeAddress } from './network.mjs';

export const SECTIONS = ['chainState', 'security', 'holders', 'market', 'activity', 'liquidityProtection', 'quote'];
const BOOLEANS = new Set([
  'chainState.sequencerHealthy', 'chainState.reorgDetected',
  'security.hasBytecode', 'security.contractVerified', 'security.canMint', 'security.canPause',
  'security.canBlacklist', 'security.whitelistOnly', 'security.canChangeFees',
  'security.canConfiscate', 'security.proxyUpgradeable', 'security.hiddenPrivileges',
  'security.untrustedTransferCalls', 'security.honeypotDetected',
  'market.dexVerified', 'market.hasUnreviewedHooks',
  'security.mutableTransferRules', 'security.knownMalicious',
  'security.liquidityRemovableByCreator', 'liquidityProtection.verified',
  'quote.buySucceeded', 'quote.sellSucceeded',
]);
const PERCENTAGES = new Set([
  'security.buyTaxPct', 'security.sellTaxPct', 'security.suspiciousVolumePct',
  'holders.top1Pct', 'holders.top10Pct', 'holders.deployerPct',
  'holders.linkedInsidersPct', 'holders.bundledSupplyPct',
  'liquidityProtection.coveragePct', 'quote.buyImpactPct', 'quote.sellImpactPct',
  'quote.roundTripLossPct', 'activity.organicTraderPct', 'market.drawdownFrom7dHighPct',
]);
const SIGNED = new Set([
  'market.liquidityChange5mPct', 'market.liquidityChange1hPct',
  'market.priceChange5mPct', 'market.priceChange1hPct', 'market.priceChange24hPct',
  'market.distanceToVwap1hPct', 'activity.holderGrowth5mPct', 'activity.holderGrowth24hPct',
]);
const NONNEGATIVE = new Set([
  'market.liquidityUsd', 'market.fdvUsd', 'holders.count',
  'activity.volume5mUsd', 'activity.previous5mVolumeUsd', 'activity.volume1hUsd',
  'activity.volume24hUsd', 'activity.uniqueTraders5m', 'activity.uniqueTraders1h',
  'activity.buyVolume5mUsd', 'activity.sellVolume5mUsd',
  'activity.buyVolume1hUsd', 'activity.sellVolume1hUsd',
]);
const DERIVED = new Set([
  'lockRemainingDays', 'poolAgeMinutes', 'fdvLiquidityRatio', 'volumeAcceleration5m',
  'volumeAcceleration1h', 'netBuy5mLiquidityPct', 'netBuy1hLiquidityPct',
  'volume5mLiquidityRatio', 'volume1hLiquidityRatio',
]);
const KNOWN = new Set([...BOOLEANS, ...PERCENTAGES, ...SIGNED, ...NONNEGATIVE, ...DERIVED]);
const OPERATORS = { eq: (a, b) => a === b, gte: (a, b) => a >= b, lte: (a, b) => a <= b };
const get = (obj, path) => path.split('.').reduce((v, key) => v?.[key], obj);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const positive = (v) => finite(v) && v > 0;
const integerMetric = (name) => /(?:\.count|\.uniqueTraders5m|\.uniqueTraders1h)$/.test(name);

export function policyHash(config) {
  return createHash('sha256').update('engine-v2\n' + JSON.stringify({ config, network: NETWORK, quoteAssets: QUOTE_ASSETS })).digest('hex');
}

export function validateConfig(config) {
  const fail = (message) => { throw new Error(`Configuração inválida: ${message}`); };
  if (!text(config?.version) || config.chain !== NETWORK.chain || config.chainId !== NETWORK.chainId || config.environment !== NETWORK.environment || config.mode !== 'observe') fail('version, chain=robinhood, chainId=4663, environment=mainnet e mode=observe obrigatórios');
  const data = config.data;
  if (!data || !finite(data.maxFutureSkewSeconds) || data.maxFutureSkewSeconds < 0 || !positive(data.probeAmountUsd) || !positive(data.maxHeadAgeSeconds)) fail('limites de dados inválidos');
  for (const section of SECTIONS) if (!positive(data.maxAgeSeconds?.[section])) fail(`TTL de ${section}`);
  for (const key of ['allowedQuoteAssets', 'allowedTokenStandards', 'allowedLiquidityMechanisms']) {
    if (!Array.isArray(data[key]) || !data[key].length || !data[key].every(text)) fail(key);
  }
  if (data.allowedLiquidityMechanisms.some((v) => !['burned', 'locked'].includes(v))) fail('mecanismo de liquidez não implementado');
  if (data.allowedTokenStandards.some((v) => v !== 'erc20')) fail('apenas contratos ERC-20 suportados');
  if (data.allowedQuoteAssets.some((v) => !Object.hasOwn(QUOTE_ASSETS, v))) fail('quote asset sem contrato oficial configurado');
  const gates = (items) => {
    if (!Array.isArray(items) || !items.length) fail('lista de filtros vazia');
    for (const gate of items) {
      if (!KNOWN.has(gate.metric) || !Object.hasOwn(OPERATORS, gate.op) || !text(gate.reason)) fail(`filtro ${gate.metric}`);
      if (BOOLEANS.has(gate.metric)) {
        if (gate.op !== 'eq' || typeof gate.value !== 'boolean') fail(`filtro booleano ${gate.metric}`);
      } else if (!finite(gate.value)) fail(`limiar ${gate.metric}`);
    }
  };
  gates(config.securityGates);
  if (!config.pipelines || Object.keys(config.pipelines).sort().join(',') !== 'established,new') fail('dois pipelines obrigatórios');
  for (const [id, p] of Object.entries(config.pipelines)) {
    if (!text(p.label) || !finite(p.ageMinMinutes) || p.ageMinMinutes < 0 || !(p.ageMaxMinutes === null || (finite(p.ageMaxMinutes) && p.ageMaxMinutes > p.ageMinMinutes))) fail(`idade de ${id}`);
    if (!positive(p.pollSeconds) || !finite(p.minScore) || p.minScore < 0 || p.minScore > 100) fail(`score/cadência de ${id}`);
    const c = p.confirmation;
    if (!c || !Number.isInteger(c.minObservations) || c.minObservations < 2 || !positive(c.minSpanSeconds) || !positive(c.maxGapSeconds) || c.maxGapSeconds < p.pollSeconds) fail(`confirmação de ${id}`);
    gates(p.securityGates);
    gates(p.eligibilityGates);
    if (!Array.isArray(p.score) || !p.score.length) fail(`pesos de ${id}`);
    for (const rule of p.score) {
      if (!KNOWN.has(rule.metric) || BOOLEANS.has(rule.metric) || !positive(rule.weight) || !finite(rule.floor) || !finite(rule.target) || rule.target <= rule.floor) fail(`regra de score de ${id}`);
    }
    if (Math.abs(p.score.reduce((sum, r) => sum + r.weight, 0) - 100) > 0.000001) fail(`pesos de ${id} devem somar 100`);
  }
  const a = config.pipelines.new;
  const b = config.pipelines.established;
  if (a.ageMaxMinutes === null || a.ageMaxMinutes >= b.ageMinMinutes) fail('intervalos de idade sobrepostos');
  return config;
}

export function evaluate(snapshot, pipelineId, config, { now = Date.now(), previous = null } = {}) {
  if (snapshot && typeof snapshot === 'object') snapshot = { ...snapshot, address: normalizeAddress(snapshot.address) };
  validateConfig(config);
  const pipeline = config.pipelines[pipelineId];
  if (!Object.hasOwn(config.pipelines, pipelineId) || !pipeline || !finite(now)) throw new Error('Pipeline ou relógio inválido');
  const fingerprint = policyHash(config);
  const issues = [];
  const checks = [];
  const metrics = new Map();
  const issue = (code, path, message) => {
    if (!issues.some((i) => i.code === code && i.path === path)) issues.push({ code, path, message });
  };
  const date = (value, path, allowFuture = false) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !finite(Date.parse(value)) || new Date(Date.parse(value)).toISOString().slice(0, 19) !== value.slice(0, 19)) {
      issue('DATA_INVALID', path, 'Timestamp UTC ISO 8601 obrigatório'); return null;
    }
    const parsed = Date.parse(value);
    if (!allowFuture && parsed > now + config.data.maxFutureSkewSeconds * 1000) {
      issue('DATA_FUTURE', path, 'Timestamp no futuro'); return null;
    }
    return parsed;
  };
  const read = (path) => {
    if (metrics.has(path)) return metrics.get(path);
    let value = get(snapshot, path);
    if (DERIVED.has(path)) value = derive(path);
    else if (BOOLEANS.has(path)) {
      if (typeof value !== 'boolean') { issue('DATA_INVALID', path, 'Booleano explícito obrigatório'); value = null; }
    } else if (!finite(value) || (PERCENTAGES.has(path) && (value < 0 || value > 100)) ||
      (NONNEGATIVE.has(path) && value < 0) || (SIGNED.has(path) && value < -100) ||
      (integerMetric(path) && !Number.isInteger(value))) {
      issue('DATA_INVALID', path, 'Métrica ausente ou fora do domínio'); value = null;
    }
    metrics.set(path, value);
    return value;
  };
  const ratio = (numerator, denominator, path) => {
    if (numerator === null || denominator === null) return null;
    if (denominator <= 0) { issue('DATA_INSUFFICIENT', path, 'Denominador positivo obrigatório'); return null; }
    return numerator / denominator;
  };
  const difference = (a, b) => a === null || b === null ? null : a - b;
  const derive = (path) => {
    switch (path) {
      case 'lockRemainingDays': {
        if (snapshot.liquidityProtection?.mechanism === 'burned') return Infinity;
        const unlock = date(snapshot.liquidityProtection?.unlockAt, 'liquidityProtection.unlockAt', true);
        return unlock === null ? null : (unlock - now) / 86400000;
      }
      case 'poolAgeMinutes': {
        const created = date(snapshot.market?.oldestPoolCreatedAt, 'market.oldestPoolCreatedAt');
        return created === null ? null : (now - created) / 60000;
      }
      case 'fdvLiquidityRatio': return ratio(read('market.fdvUsd'), read('market.liquidityUsd'), path);
      case 'volumeAcceleration5m': return ratio(read('activity.volume5mUsd'), read('activity.previous5mVolumeUsd'), path);
      case 'volumeAcceleration1h': {
        const previousVolume = difference(read('activity.volume24hUsd'), read('activity.volume1hUsd'));
        return ratio(read('activity.volume1hUsd'), previousVolume === null ? null : previousVolume / 23, path);
      }
      case 'netBuy5mLiquidityPct': {
        const result = ratio(difference(read('activity.buyVolume5mUsd'), read('activity.sellVolume5mUsd')), read('market.liquidityUsd'), path);
        return result === null ? null : result * 100;
      }
      case 'netBuy1hLiquidityPct': {
        const result = ratio(difference(read('activity.buyVolume1hUsd'), read('activity.sellVolume1hUsd')), read('market.liquidityUsd'), path);
        return result === null ? null : result * 100;
      }
      case 'volume5mLiquidityRatio': return ratio(read('activity.volume5mUsd'), read('market.liquidityUsd'), path);
      case 'volume1hLiquidityRatio': return ratio(read('activity.volume1hUsd'), read('market.liquidityUsd'), path);
      default: throw new Error(`Métrica desconhecida: ${path}`);
    }
  };
  const runGates = (gates, category) => {
    for (const gate of gates) {
      const value = read(gate.metric);
      checks.push({ category, metric: gate.metric, op: gate.op, threshold: gate.value,
        value: value === Infinity ? 'permanent' : value, passed: value === null ? null : OPERATORS[gate.op](value, gate.value), reason: gate.reason });
    }
  };
  const membership = (value, values, path) => {
    if (!text(value)) issue('DATA_INVALID', path, 'Valor explícito obrigatório');
    else checks.push({ category: 'security', metric: path, value, threshold: values, op: 'in', passed: values.includes(value), reason: `${path} fora da lista permitida` });
  };
  let score = null;
  let breakdown = [];
  let state = null;
  const result = (status, extraReasons = []) => ({
    schemaVersion: 2, policyVersion: config.version, policyHash: fingerprint,
    evaluatedAt: new Date(now).toISOString(), pipeline: pipelineId,
    chain: snapshot?.chain ?? null, chainId: snapshot?.chainId ?? null, environment: snapshot?.environment ?? null, address: snapshot?.address ?? null,
    finalityStage: snapshot?.chainState?.finalityStage ?? null,
    symbol: typeof snapshot?.symbol === 'string' ? snapshot.symbol.slice(0, 32) : null,
    dataMode: snapshot?.synthetic === true ? 'synthetic' : 'unverified-input',
    evidenceExpiresAt: issues.length === 0 && finite(Date.parse(snapshot?.chainState?.headTimestamp)) && SECTIONS.every((s) => finite(Date.parse(snapshot?.[s]?.checkedAt)))
      ? new Date(Math.min(...SECTIONS.map((s) => Date.parse(snapshot[s].checkedAt) + config.data.maxAgeSeconds[s] * 1000), Date.parse(snapshot.chainState.headTimestamp) + config.data.maxHeadAgeSeconds * 1000)).toISOString() : null,
    status, score, minScore: pipeline.minScore, scoreBreakdown: breakdown, checks, issues,
    reasons: [...checks.filter((c) => c.passed === false).map((c) => c.reason), ...issues.map((i) => `${i.path}: ${i.message}`), ...extraReasons],
    nextState: { ...(state ?? { count: 0 }), policyHash: fingerprint, address: snapshot?.address, chain: snapshot?.chain, chainId: snapshot?.chainId, environment: snapshot?.environment, pipeline: pipelineId, lastStatus: status },
  });
  if (!snapshot || snapshot.schemaVersion !== 2 || typeof snapshot.synthetic !== 'boolean') issue('DATA_INVALID', 'snapshot', 'schemaVersion=2 e synthetic booleano obrigatórios');
  if (snapshot?.chain !== config.chain) issue('CHAIN_UNSUPPORTED', 'chain', 'Rede não suportada');
  if (snapshot?.chainId !== config.chainId || snapshot?.environment !== config.environment) issue('NETWORK_MISMATCH', 'chainId', 'Apenas Robinhood Chain mainnet 4663; testnet não é mercado real');
  if (!isEvmAddress(snapshot?.address)) issue('DATA_INVALID', 'address', 'Contrato EVM de 20 bytes inválido ou endereço zero');
  if (issues.length) return result('INCOMPLETE');
  const contractCreated = date(snapshot.contractCreatedAt, 'contractCreatedAt');
  const ageMinutes = contractCreated === null ? null : (now - contractCreated) / 60000;
  if (ageMinutes !== null && (ageMinutes < pipeline.ageMinMinutes || (pipeline.ageMaxMinutes !== null && ageMinutes > pipeline.ageMaxMinutes))) return result('OUT_OF_SCOPE', ['Idade do contrato fora do intervalo deste pipeline']);
  for (const section of SECTIONS) {
    const group = snapshot[section];
    const at = date(group?.checkedAt, `${section}.checkedAt`);
    if (at !== null && now - at > config.data.maxAgeSeconds[section] * 1000) issue('DATA_STALE', `${section}.checkedAt`, 'Dados expirados');
    if (!text(group?.source) || !Array.isArray(group?.evidence) || !group.evidence.length || !group.evidence.every(text)) issue('PROVENANCE_MISSING', section, 'Fonte e referências de evidência obrigatórias');
  }
  if (snapshot.chainState?.rpcChainId !== config.chainId) issue('NETWORK_MISMATCH', 'chainState.rpcChainId', 'eth_chainId do RPC tem de corresponder à mainnet');
  const headTimestamp = date(snapshot.chainState?.headTimestamp, 'chainState.headTimestamp');
  if (headTimestamp !== null && now - headTimestamp > config.data.maxHeadAgeSeconds * 1000) issue('CHAIN_STALE', 'chainState.headTimestamp', 'Cabeça da rede desatualizada');
  if (!Number.isSafeInteger(snapshot.chainState?.blockNumber) || snapshot.chainState.blockNumber < 0 || typeof snapshot.chainState?.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(snapshot.chainState.blockHash) || /^0x0{64}$/.test(snapshot.chainState.blockHash)) issue('DATA_INVALID', 'chainState', 'Número e hash do bloco obrigatórios');
  if (!['sequencer', 'posted', 'finalized'].includes(snapshot.chainState?.finalityStage)) issue('DATA_INVALID', 'chainState.finalityStage', 'Etapa de confirmação da rede obrigatória');
  membership(snapshot.security?.tokenStandard, config.data.allowedTokenStandards, 'security.tokenStandard');
  membership(snapshot.market?.quoteAsset, config.data.allowedQuoteAssets, 'market.quoteAsset');
  const quoteSymbol = snapshot.market?.quoteAsset;
  if (!isEvmAddress(snapshot.market?.quoteAssetAddress)) issue('DATA_INVALID', 'market.quoteAssetAddress', 'Contrato do quote asset obrigatório');
  else if (Object.hasOwn(QUOTE_ASSETS, quoteSymbol)) checks.push({ category: 'security', metric: 'market.quoteAssetAddress', op: 'eq', threshold: QUOTE_ASSETS[quoteSymbol], value: normalizeAddress(snapshot.market.quoteAssetAddress), passed: normalizeAddress(snapshot.market.quoteAssetAddress) === QUOTE_ASSETS[quoteSymbol], reason: 'Símbolo do quote asset não corresponde ao contrato oficial' });
  membership(snapshot.liquidityProtection?.mechanism, config.data.allowedLiquidityMechanisms, 'liquidityProtection.mechanism');
  if (!finite(snapshot.quote?.amountUsd) || Math.abs(snapshot.quote.amountUsd - config.data.probeAmountUsd) > 0.01) issue('PROBE_SIZE_MISMATCH', 'quote.amountUsd', 'Simulação deve usar o montante configurado');
  runGates([...config.securityGates, ...pipeline.securityGates], 'security');
  runGates(pipeline.eligibilityGates, 'eligibility');
  const poolAge = read('poolAgeMinutes');
  if (poolAge !== null && ageMinutes !== null && poolAge > ageMinutes + 1) issue('DATA_INCONSISTENT', 'market.oldestPoolCreatedAt', 'Pool anterior à criação do contrato');
  if (read('holders.top1Pct') > read('holders.top10Pct')) issue('DATA_INCONSISTENT', 'holders', 'Top 1 superior ao top 10');
  if (read('holders.deployerPct') > read('holders.linkedInsidersPct')) issue('DATA_INCONSISTENT', 'holders', 'Insiders devem incluir o criador');
  const windows = pipelineId === 'new' ? ['5m'] : ['1h'];
  for (const window of windows) {
    const buys = read(`activity.buyVolume${window}Usd`);
    const sells = read(`activity.sellVolume${window}Usd`);
    const volume = read(`activity.volume${window}Usd`);
    if (buys !== null && sells !== null && volume !== null && Math.abs(buys + sells - volume) > Math.max(1, volume * 0.01)) issue('DATA_INCONSISTENT', `activity.volume${window}Usd`, 'Compras + vendas devem corresponder ao volume (tolerância 1%)');
  }
  if (checks.some((c) => c.category === 'security' && c.passed === false)) return result('BLOCKED');
  if (issues.length) return result('INCOMPLETE');
  if (checks.some((c) => c.category === 'eligibility' && c.passed === false)) return result('WATCH');
  let total = 0;
  for (const rule of pipeline.score) {
    const value = read(rule.metric);
    if (value === null) continue;
    const points = Math.max(0, Math.min(1, (value - rule.floor) / (rule.target - rule.floor))) * rule.weight;
    total += points;
    breakdown.push({ metric: rule.metric, value, points: Math.round(points * 100) / 100, weight: rule.weight });
  }
  if (issues.length) { breakdown = []; return result('INCOMPLETE'); }
  score = Math.round(total * 100) / 100;
  if (total < pipeline.minScore) return result('WATCH', ['Score abaixo do limiar']);
  const marketAt = Date.parse(snapshot.market.checkedAt);
  const validPrevious = previous?.policyHash === fingerprint && previous?.address === snapshot.address && previous?.chain === snapshot.chain &&
    previous?.chainId === snapshot.chainId && previous?.environment === snapshot.environment && Number.isSafeInteger(previous.lastBlockNumber) && typeof previous.lastBlockHash === 'string' &&
    previous?.pipeline === pipelineId && Number.isInteger(previous.count) && previous.count > 0 && finite(previous.firstObservedAtMs) &&
    finite(previous.lastObservedAtMs) && finite(previous.lastMarketAtMs) && previous.firstObservedAtMs <= previous.lastObservedAtMs &&
    previous.lastObservedAtMs <= now && now - previous.lastObservedAtMs <= pipeline.confirmation.maxGapSeconds * 1000;
  if (validPrevious && marketAt < previous.lastMarketAtMs) return result('INCOMPLETE', ['Evidência de mercado recuou no tempo']);
  const blockNumber = snapshot.chainState.blockNumber;
  const blockHash = snapshot.chainState.blockHash.toLowerCase();
  if (validPrevious && (blockNumber < previous.lastBlockNumber || (blockNumber === previous.lastBlockNumber && blockHash !== previous.lastBlockHash))) return result('INCOMPLETE', ['Bloco recuou ou o hash mudou; possível reorganização']);
  state = validPrevious ? { ...previous } : { count: 0, firstObservedAtMs: now, lastObservedAtMs: now, lastMarketAtMs: null, lastBlockNumber: null };
  if (state.lastMarketAtMs === null || (marketAt > state.lastMarketAtMs && blockNumber > state.lastBlockNumber)) {
    state.count++;
    state.lastObservedAtMs = now;
    state.lastMarketAtMs = marketAt;
    state.lastBlockNumber = blockNumber;
    state.lastBlockHash = blockHash;
  }
  const confirmed = state.count >= pipeline.confirmation.minObservations && state.lastObservedAtMs - state.firstObservedAtMs >= pipeline.confirmation.minSpanSeconds * 1000;
  return result(confirmed ? 'CANDIDATE' : 'CONFIRMING', confirmed ? [] : ['A aguardar observações distintas e tempo mínimo de confirmação']);
}
