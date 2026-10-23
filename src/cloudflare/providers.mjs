import { NETWORK, QUOTE_ASSETS, isEvmAddress } from '../network.mjs';

const RESPONSE_LIMIT = 128 * 1024;
const REQUEST_TIMEOUT = 3000;
const STATE_LIMIT = 32 * 1024;
const MARKET_TTL = 120000;
const SECURITY_TTL = 300000;
const PROVIDER_INTERVAL = 60000;
const ZERO = '0x' + '0'.repeat(40);
const FLAGS = ['is_honeypot', 'is_mintable', 'transfer_pausable', 'is_blacklisted', 'is_whitelisted',
  'slippage_modifiable', 'owner_change_balance', 'is_proxy', 'hidden_owner', 'external_call',
  'is_open_source', 'can_take_back_ownership', 'selfdestruct', 'cannot_buy', 'cannot_sell_all'];
// GoPlus SDK field descriptions: https://github.com/GoPlusSecurity/goplus-sdk-js/blob/main/dist/gen/model/ResponseWrapperTokenSecurityResult.js
// Only positive, directly corresponding risks reach engine fields. A provider's
// negative flag does not establish the absence of other roles or code paths.
const POSITIVE_RISKS = {
  is_honeypot: 'honeypotDetected', is_mintable: 'canMint', transfer_pausable: 'canPause',
  slippage_modifiable: 'canChangeFees', owner_change_balance: 'canConfiscate', hidden_owner: 'hiddenPrivileges',
};
const WINDOWS = ['m5', 'h1', 'h24'];
const unknown = value => value === undefined || value === null || value === '';
const flag = value => value === '0' || value === 0 ? false : value === '1' || value === 1 ? true : undefined;
function number(value, signed = false) {
  if (typeof value !== 'number' && (typeof value !== 'string' ||
      !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && (signed || parsed >= 0) ? parsed : undefined;
}
const count = value => { const n = number(value); return Number.isSafeInteger(n) ? n : undefined; };
const fraction = value => { const n = number(value); return n !== undefined && n <= 1 ? n : undefined; };
const addressOf = value => isEvmAddress(value) ? value.toLowerCase() : undefined;

async function boundedGet(url, fetchImpl) {
  const controller = new AbortController();
  let timer;
  let status;
  let activeReader;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(); void activeReader?.cancel().catch(() => {}); reject(new Error('TIMEOUT'));
    }, REQUEST_TIMEOUT);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl.call(globalThis, url, {
        method: 'GET', redirect: 'manual', headers: { accept: 'application/json' }, signal: controller.signal,
      });
      status = response.status;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { error: `HTTP_${status}`, status, retryAfter: response.headers.get('retry-after') };
      }
      const declared = response.headers.get('content-length');
      if (declared && /^\d+$/.test(declared) && Number(declared) > RESPONSE_LIMIT) {
        void response.body?.cancel().catch(() => {});
        throw new Error('RESPONSE_LIMIT');
      }
      if (!response.body) throw new Error('INVALID_JSON');
      const reader = response.body.getReader(); activeReader = reader;
      const chunks = []; let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > RESPONSE_LIMIT) {
          void reader.cancel().catch(() => {});
          throw new Error('RESPONSE_LIMIT');
        }
        chunks.push(value);
      }
      const buffer = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
      catch { throw new Error('INVALID_JSON'); }
      return { body, status, bytes };
    })()]);
  } catch (error) {
    const code = controller.signal.aborted ? 'TIMEOUT' :
      ['TIMEOUT', 'RESPONSE_LIMIT', 'INVALID_JSON'].includes(error?.message) || /^HTTP_[1-5]\d{2}$/.test(error?.message)
        ? error.message : 'REQUEST_FAILED';
    return { error: code, ...(Number.isInteger(status) ? { status } : {}) };
  } finally { clearTimeout(timer); }
}

function goPlus(body, address, fetchedAt, gaps) {
  if (body?.code !== 1 || !body.result || typeof body.result !== 'object' || Array.isArray(body.result)) {
    gaps.push('GOPLUS_INVALID_RESPONSE'); return undefined;
  }
  const matches = Object.entries(body.result).filter(([key]) => addressOf(key) === address);
  if (matches.length !== 1 || !matches[0][1] || typeof matches[0][1] !== 'object' || Array.isArray(matches[0][1])) {
    gaps.push('GOPLUS_TOKEN_NOT_FOUND'); return undefined;
  }
  const token = matches[0][1];
  if ([body.chain_id, body.chainId, token.chain_id, token.chainId].some(value =>
    value !== undefined && value !== NETWORK.chainId && value !== String(NETWORK.chainId)) ||
    [token.address, token.token_address, token.contract_address].some(value => value !== undefined && addressOf(value) !== address)) {
    gaps.push('GOPLUS_IDENTITY_MISMATCH'); return undefined;
  }
  const flags = {}; let invalid = false;
  for (const field of FLAGS) {
    const parsed = flag(token[field]);
    if (parsed !== undefined) flags[field] = parsed;
    else if (!unknown(token[field])) invalid = true;
  }
  const providerReported = { source: 'goplus', trust: 'provider-reported', chainId: NETWORK.chainId, address, fetchedAt, flags };
  const security = { providerReported };
  for (const [field, metric] of Object.entries(POSITIVE_RISKS)) if (flags[field] === true) security[metric] = true;
  for (const [field, metric] of [['buy_tax', 'buyTaxPct'], ['sell_tax', 'sellTaxPct']]) {
    // GoPlus uses fractions: 0.01 = 1%; 1 = 100% or inability to trade.
    // A zero only describes this provider's observation and cannot pass a gate.
    const value = fraction(token[field]);
    if (value !== undefined) {
      providerReported[metric] = value * 100;
      if (value > 0) security[metric] = value * 100;
    } else if (!unknown(token[field])) invalid = true;
  }
  const holderCount = count(token.holder_count);
  if (holderCount !== undefined) providerReported.holderCount = holderCount;
  else if (!unknown(token.holder_count)) invalid = true;
  // The documented holders array is Top10, not an exhaustive holder index.
  // Only a self-consistent enumeration covering the entire reported count may
  // yield concentration, and even that remains explicitly provider-reported.
  const holders = Array.isArray(token.holders) ? token.holders : [];
  const distribution = holders.map(holder => ({ address: addressOf(holder?.address), share: fraction(holder?.percent) }));
  // Candidates for independent balanceOf reads; never an exhaustive index.
  providerReported.holderCandidates = distribution.filter(holder => holder.address).slice(0, 10);
  const complete = holderCount > 0 && holders.length === holderCount &&
    distribution.every(holder => holder.address && holder.share !== undefined) &&
    new Set(distribution.map(holder => holder.address)).size === holderCount &&
    Math.abs(distribution.reduce((sum, holder) => sum + holder.share, 0) - 1) <= 1e-6;
  if (complete) {
    const shares = distribution.map(holder => holder.share).sort((a, b) => b - a);
    providerReported.holderDistribution = { completeAsReported: true,
      largestHolderPct: shares[0] * 100, top10HoldersPct: shares.slice(0, 10).reduce((sum, share) => sum + share, 0) * 100 };
  } else if (holders.length || holderCount !== undefined) gaps.push('GOPLUS_HOLDERS_NOT_EXHAUSTIVE');
  if (invalid) gaps.push('GOPLUS_INVALID_FIELDS');
  gaps.push('GOPLUS_SECURITY_NOT_CONCLUSIVE');
  return security;
}

function externalPairId(pair) {
  const value = typeof pair?.pairAddress === 'string' ? pair.pairAddress.toLowerCase() : '';
  const v4 = Array.isArray(pair?.labels) && pair.labels.includes('v4');
  if (v4 && /^0x[0-9a-f]{64}$/.test(value)) return value;
  return !v4 ? addressOf(value) : undefined;
}

function externalQuote(pair) {
  const value = typeof pair?.quoteToken?.address === 'string' ? pair.quoteToken.address.toLowerCase() : '';
  const known = Object.entries(QUOTE_ASSETS).find(([, address]) => address === value);
  if (known) return { address: value, symbol: known[0] };
  // Uniswap v4 represents native ETH with the zero currency. It is not WETH.
  if (value === ZERO && Array.isArray(pair?.labels) && pair.labels.includes('v4')) return { address: value, symbol: 'ETH' };
  return null;
}

function dexScreener(body, address, fetchedAt, gaps) {
  const values = Array.isArray(body) ? body : body?.pairs;
  if (values !== null && !Array.isArray(values)) {
    gaps.push('DEXSCREENER_INVALID_RESPONSE'); return undefined;
  }
  const pairs = (values ?? []).filter(pair => pair?.chainId === 'robinhood' &&
    addressOf(pair.baseToken?.address) === address && externalPairId(pair) && externalQuote(pair));
  // A deterministic choice between valid external pairs; this never selects or
  // replaces the native pool whose RPC evidence the collector already holds.
  pairs.sort((a, b) => (number(b.liquidity?.usd) ?? -1) - (number(a.liquidity?.usd) ?? -1) ||
    externalPairId(a).localeCompare(externalPairId(b)));
  if (!pairs.length) { gaps.push('DEXSCREENER_NO_MATCHING_PAIR'); return undefined; }
  const pair = pairs[0];
  const quote = externalQuote(pair);
  const externalMarket = { source: 'dexscreener', trust: 'provider-reported', chain: 'robinhood', chainId: NETWORK.chainId,
    baseTokenAddress: address, quoteTokenAddress: quote.address, quoteAsset: quote.symbol,
    pairAddress: externalPairId(pair), pairKind: Array.isArray(pair.labels) && pair.labels.includes('v4') ? 'pool-id' : 'address', fetchedAt };
  const poolType = Array.isArray(pair.labels) ? pair.labels.find(label => ['v2', 'v3', 'v4'].includes(label)) : null;
  if (poolType) externalMarket.poolType = poolType;
  if (Number.isSafeInteger(pair.pairCreatedAt) && pair.pairCreatedAt >= 0) externalMarket.pairCreatedAt = pair.pairCreatedAt;
  for (const [field, value] of [['priceUsd', pair.priceUsd], ['liquidityUsd', pair.liquidity?.usd], ['fdvUsd', pair.fdv], ['marketCapUsd', pair.marketCap]]) {
    const parsed = number(value); if (parsed !== undefined) externalMarket[field] = parsed;
  }
  const volumeUsd = {}; const txns = {}; const priceChangePct = {};
  for (const window of WINDOWS) {
    const volume = number(pair.volume?.[window]); if (volume !== undefined) volumeUsd[window] = volume;
    const change = number(pair.priceChange?.[window], true); if (change !== undefined) priceChangePct[window] = change;
    const buys = count(pair.txns?.[window]?.buys); const sells = count(pair.txns?.[window]?.sells);
    if (buys !== undefined || sells !== undefined) txns[window] = {
      ...(buys !== undefined ? { buys } : {}), ...(sells !== undefined ? { sells } : {}),
    };
  }
  if (Object.keys(volumeUsd).length) externalMarket.volumeUsd = volumeUsd;
  if (Object.keys(txns).length) externalMarket.txns = txns;
  if (Object.keys(priceChangePct).length) externalMarket.priceChangePct = priceChangePct;
  gaps.push('DEXSCREENER_MARKET_NOT_VERIFIED_ONCHAIN');
  return { externalMarket };
}

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const clock = now => { try { const value = now(); return Number.isFinite(value) ? value : NaN; } catch { return NaN; } };
const ttl = provider => provider === 'goplus' ? SECURITY_TTL : MARKET_TTL;
function fresh(value, time, maxAge) {
  const observed = Date.parse(value);
  return Number.isFinite(observed) && time - observed >= 0 && time - observed <= maxAge;
}
function providerState(state, time) {
  const normalized = { version: 1, cooldowns: {}, cache: {}, sources: {} };
  if (state?.version === 1 && state.sources && typeof state.sources === 'object' && !Array.isArray(state.sources)) {
    for (const [key, value] of Object.entries(state.sources).slice(0, 40))
      if (typeof value === 'string' && /^https:\/\/api\.dexscreener\.com\/tokens\/v1\/robinhood\/0x[0-9a-f]{40}(?:,0x[0-9a-f]{40}){0,19}$/i.test(value))
        normalized.sources[key] = value;
  }
  for (const provider of ['goplus', 'dexscreener']) {
    const prior = state?.version === 1 ? state.cooldowns?.[provider] : null;
    normalized.cooldowns[provider] = {
      until: Number.isFinite(prior?.until) && prior.until <= time + 3600000 ? Math.max(0, prior.until) : 0,
      nextRequestAt: Number.isFinite(prior?.nextRequestAt) && prior.nextRequestAt <= time + 3600000 ? Math.max(0, prior.nextRequestAt) : 0,
      failures: Number.isSafeInteger(prior?.failures) ? Math.min(10, Math.max(0, prior.failures)) : 0,
      ...(typeof prior?.lastError === 'string' && /^[A-Z0-9_]{1,60}$/.test(prior.lastError) ? { lastError: prior.lastError } : {}),
    };
    normalized.cache[provider] = (state?.version === 1 && Array.isArray(state.cache?.[provider]) ? state.cache[provider] : [])
      .slice(0, 40).filter(item => addressOf(item?.address) === item?.address && fresh(item.fetchedAt, time, ttl(provider))
        && (provider === 'goplus' ? item.value?.security?.providerReported?.address === item.address
          && item.value.security.providerReported.chainId === NETWORK.chainId && item.value.security.providerReported.fetchedAt === item.fetchedAt
          : item.value?.market?.externalMarket?.baseTokenAddress === item.address
            && item.value.market.externalMarket.chainId === NETWORK.chainId && item.value.market.externalMarket.fetchedAt === item.fetchedAt))
      .map(item => ({ address: item.address, fetchedAt: item.fetchedAt, value: structuredClone(item.value),
        gaps: Array.isArray(item.gaps) ? item.gaps.filter(value => typeof value === 'string').slice(0, 16) : [],
        evidence: item.evidence && typeof item.evidence === 'object' ? structuredClone(item.evidence) : {} }));
  }
  return trimState(normalized);
}
function trimState(state) {
  for (const provider of ['goplus', 'dexscreener']) {
    state.cache[provider].sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt));
    state.cache[provider].splice(20);
  }
  const removeUnusedSources = () => {
    const referenced = new Set(Object.values(state.cache).flatMap(records => records.map(record => record.evidence?.sourceRef)).filter(Boolean));
    for (const key of Object.keys(state.sources)) if (!referenced.has(key)) delete state.sources[key];
  };
  removeUnusedSources();
  while (bytes(state) > STATE_LIMIT) {
    const candidates = ['goplus', 'dexscreener'].filter(provider => state.cache[provider].length);
    if (!candidates.length) break;
    candidates.sort((a, b) => Date.parse(state.cache[a].at(-1).fetchedAt) - Date.parse(state.cache[b].at(-1).fetchedAt));
    state.cache[candidates[0]].pop();
    removeUnusedSources();
  }
  return state;
}
function cached(state, provider, address, time) {
  return state.cache[provider].find(item => item.address === address && fresh(item.fetchedAt, time, ttl(provider)));
}
function cacheValue(state, provider, address, fetchedAt, value, gaps, evidence) {
  state.cache[provider] = state.cache[provider].filter(item => item.address !== address);
  const compact = { ...evidence };
  if (provider === 'dexscreener' && evidence.source?.startsWith('https://api.dexscreener.com/tokens/v1/robinhood/')) {
    const key = `dexscreener:${fetchedAt}`;
    state.sources[key] = evidence.source;
    compact.sourceRef = key; delete compact.source;
  }
  state.cache[provider].unshift({ address, fetchedAt, value: structuredClone(value), gaps: [...gaps], evidence: compact });
  trimState(state);
}
function retryDelay(value, time) {
  if (typeof value !== 'string') return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - time;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(3600000, seconds) : 0;
}
const bodyRateLimited = body => body?.code === 4029 || body?.code === 429 || body?.statusCode === 429 || body?.status === 429
  || (typeof body?.message === 'string' && /too many requests|rate.?limit/i.test(body.message));
function failProvider(state, name, error, time, retryAfter) {
  const control = state.cooldowns[name];
  control.failures = Math.min(10, control.failures + 1);
  control.lastError = error;
  control.until = time + Math.max(PROVIDER_INTERVAL * 2 ** Math.min(5, control.failures - 1), retryDelay(retryAfter, time));
}
function evidenceFor(provider, address, url, fetchedAt) {
  return { provider, source: url, trust: 'provider-reported', chainId: NETWORK.chainId, address, fetchedAt };
}
function cacheEvidence(record, state) {
  const evidence = { ...record.evidence, result: 'cached', cacheHit: true, fetchedAt: record.fetchedAt };
  if (evidence.sourceRef) { evidence.source = state.sources[evidence.sourceRef]; delete evidence.sourceRef; }
  return evidence;
}

/** Anonymous, read-only enrichment. Persist returned providerState across cron cycles. */
export async function readProviders(address, { fetchImpl = fetch, now = Date.now, state, skipMarket = false } = {}) {
  const result = { gaps: [], evidence: [] }; const normalized = addressOf(address);
  if (!normalized) { result.gaps.push('PROVIDER_ADDRESS_INVALID'); return result; }
  let fetchedAt; const time = clock(now);
  try { fetchedAt = new Date(time).toISOString(); }
  catch { result.gaps.push('PROVIDER_CLOCK_INVALID'); return result; }
  const nextState = providerState(state, time);
  const providers = [
    { name: 'goplus', prefix: 'GOPLUS', url: `https://api.gopluslabs.io/api/v1/token_security/${NETWORK.chainId}?contract_addresses=${normalized}` },
    ...(!skipMarket ? [{ name: 'dexscreener', prefix: 'DEXSCREENER', url: `https://api.dexscreener.com/token-pairs/v1/robinhood/${normalized}` }] : []),
  ];
  const responses = await Promise.all(providers.map(provider => {
    const record = cached(nextState, provider.name, normalized, time);
    if (record) return { cached: record };
    const control = nextState.cooldowns[provider.name];
    if (time < Math.max(control.until, control.nextRequestAt)) return { deferred: true };
    control.nextRequestAt = time + PROVIDER_INTERVAL;
    return boundedGet(provider.url, fetchImpl);
  }));
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index]; const response = responses[index];
    if (response.cached) {
      Object.assign(result, structuredClone(response.cached.value));
      result.gaps.push(...response.cached.gaps); result.evidence.push(cacheEvidence(response.cached, nextState)); continue;
    }
    if (response.deferred) {
      const control = nextState.cooldowns[provider.name];
      result.gaps.push(`${provider.prefix}_COOLDOWN`);
      result.evidence.push({ ...evidenceFor(provider.name, normalized, provider.url, null), result: 'deferred',
        error: control.lastError ?? 'REQUEST_INTERVAL', nextAttemptAt: new Date(Math.max(control.until, control.nextRequestAt)).toISOString() });
      continue;
    }
    const evidence = { ...evidenceFor(provider.name, normalized, provider.url, fetchedAt), ...(response.status ? { httpStatus: response.status } : {}),
      ...(response.bytes !== undefined ? { responseBytes: response.bytes } : {}) };
    if (response.error) {
      evidence.error = response.error; result.gaps.push(`${provider.prefix}_${response.error}`);
      if (response.status === 429) result.gaps.push(`${provider.prefix}_RATE_LIMITED`);
      failProvider(nextState, provider.name, response.status === 429 ? 'RATE_LIMITED' : response.error, time, response.retryAfter);
    } else if (provider.name === 'goplus') {
      if (Number.isSafeInteger(response.body?.code)) evidence.apiCode = response.body.code;
      if (typeof response.body?.message === 'string') evidence.apiMessage = response.body.message.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
      const before = result.gaps.length;
      const limited = bodyRateLimited(response.body);
      const security = limited ? (result.gaps.push('GOPLUS_RATE_LIMITED'), undefined) : goPlus(response.body, normalized, fetchedAt, result.gaps);
      if (security) result.security = security;
      evidence.result = security ? 'reported' : 'unavailable';
      evidence.gaps = result.gaps.slice(before, before + 4);
      if (security) {
        nextState.cooldowns.goplus.failures = 0; nextState.cooldowns.goplus.until = 0; delete nextState.cooldowns.goplus.lastError;
        cacheValue(nextState, 'goplus', normalized, fetchedAt, { security }, result.gaps.slice(before), evidence);
      } else failProvider(nextState, 'goplus', limited ? 'RATE_LIMITED' : 'INVALID_RESPONSE', time);
    } else {
      const before = result.gaps.length;
      const limited = bodyRateLimited(response.body);
      const market = limited ? (result.gaps.push('DEXSCREENER_RATE_LIMITED'), undefined)
        : dexScreener(response.body, normalized, fetchedAt, result.gaps);
      if (market) result.market = market;
      evidence.result = market ? 'reported' : 'unavailable';
      evidence.gaps = result.gaps.slice(before, before + 4);
      if (market) cacheValue(nextState, 'dexscreener', normalized, fetchedAt, { market }, result.gaps.slice(before), evidence);
      if (limited || result.gaps.slice(before).includes('DEXSCREENER_INVALID_RESPONSE'))
        failProvider(nextState, 'dexscreener', limited ? 'RATE_LIMITED' : 'INVALID_RESPONSE', time);
      else { nextState.cooldowns.dexscreener.failures = 0; nextState.cooldowns.dexscreener.until = 0; delete nextState.cooldowns.dexscreener.lastError; }
    }
    result.evidence.push(evidence);
  }
  result.providerState = trimState(nextState);
  return result;
}

/** Refresh up to twenty exact token identities in one official batch request. */
export async function refreshMarketData(entries, state, { fetchImpl = fetch, now = Date.now } = {}) {
  const time = clock(now);
  if (!Number.isFinite(time)) return { entries: Array.isArray(entries) ? entries : [], providerState: state, diagnostics: { status: 'INVALID_CLOCK' } };
  const nextState = providerState(state, time);
  const input = (Array.isArray(entries) ? entries : []).filter(entry => entry && addressOf(entry.address));
  const addresses = [...new Set(input.map(entry => addressOf(entry.address)))].slice(0, 20);
  const requested = new Set(addresses);
  const diagnostics = { provider: 'dexscreener', status: 'NO_TOKENS', requested: addresses.length, refreshed: 0, cached: 0 };
  const source = `https://api.dexscreener.com/tokens/v1/robinhood/${addresses.join(',')}`;
  const control = nextState.cooldowns.dexscreener;
  if (addresses.length && time >= Math.max(control.until, control.nextRequestAt)) {
    control.nextRequestAt = time + PROVIDER_INTERVAL;
    const response = await boundedGet(source, fetchImpl);
    diagnostics.httpStatus = response.status ?? null;
    if (response.error || bodyRateLimited(response.body)) {
      diagnostics.status = response.status === 429 || bodyRateLimited(response.body) ? 'RATE_LIMITED' : response.error;
      failProvider(nextState, 'dexscreener', diagnostics.status, time, response.retryAfter);
    } else if (!Array.isArray(response.body)) {
      diagnostics.status = 'INVALID_RESPONSE'; failProvider(nextState, 'dexscreener', 'INVALID_RESPONSE', time);
    } else {
      diagnostics.status = 'REFRESHED'; control.failures = 0; control.until = 0; delete control.lastError;
      const fetchedAt = new Date(time).toISOString();
      for (const address of addresses) {
        const gaps = []; const market = dexScreener(response.body, address, fetchedAt, gaps);
        // A successful complete response without this token invalidates its old
        // market immediately; an HTTP failure may retain only unexpired cache.
        nextState.cache.dexscreener = nextState.cache.dexscreener.filter(item => item.address !== address);
        if (market) {
          const evidence = { ...evidenceFor('dexscreener', address, source, fetchedAt), httpStatus: response.status, result: 'reported' };
          cacheValue(nextState, 'dexscreener', address, fetchedAt, { market }, gaps, evidence);
          diagnostics.refreshed++;
        }
      }
    }
  } else if (addresses.length) {
    diagnostics.status = control.until > time ? 'COOLDOWN' : 'REQUEST_INTERVAL';
  }
  if (addresses.length) diagnostics.nextAttemptAt = new Date(Math.max(control.until, control.nextRequestAt)).toISOString();
  const output = input.map(entry => {
    const address = addressOf(entry.address); const record = cached(nextState, 'dexscreener', address, time);
    const updated = { ...entry };
    delete updated.externalMarket;
    if (record) {
      updated.externalMarket = structuredClone(record.value.market.externalMarket);
      if (diagnostics.status !== 'REFRESHED') diagnostics.cached++;
    }
    updated.marketData = { status: record ? 'AVAILABLE' : !requested.has(address) ? 'NOT_REQUESTED'
      : diagnostics.status === 'REFRESHED' ? 'NO_MATCHING_PAIR' : diagnostics.status,
      ...(record ? { fetchedAt: record.fetchedAt, expiresAt: new Date(Date.parse(record.fetchedAt) + MARKET_TTL).toISOString() } : {}),
      ...(diagnostics.nextAttemptAt ? { nextAttemptAt: diagnostics.nextAttemptAt } : {}) };
    return updated;
  });
  return { entries: output, providerState: trimState(nextState), diagnostics };
}
