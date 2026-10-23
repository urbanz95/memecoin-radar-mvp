import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviders, refreshMarketData } from '../src/cloudflare/providers.mjs';
import { QUOTE_ASSETS } from '../src/network.mjs';
import { evaluateMarketSignals } from '../src/cloudflare/market-signals.mjs';

const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const PAIR = '0x3333333333333333333333333333333333333333';
const SECOND_PAIR = '0x4444444444444444444444444444444444444444';
const time = Date.parse('2026-10-22T12:13:20.000Z');
const now = () => time;

test('native ETH v4 provider identity reaches the market signal evaluator without schema translation', async () => {
  const response = pair({ labels: ['v4'], pairAddress: '0x' + 'a'.repeat(64),
    quoteToken: { address: '0x' + '0'.repeat(40) }, liquidity: { usd: 500000 }, fdv: 1000000,
    volume: { m5: 50000, h1: 55000, h24: 100000 }, priceChange: { m5: 10 },
    txns: { m5: { buys: 80, sells: 20 } } });
  const providers = await readProviders(TOKEN, { now, fetchImpl: fetcher(go({}), [response]) });
  assert.equal(providers.market.externalMarket.poolType, 'v4');
  const evaluated = evaluateMarketSignals([{ address: TOKEN, status: 'REVIEW', pipeline: 'new', poolType: 'v4',
    observedAt: new Date(time).toISOString(), age: { contractCreatedAt: new Date(time - 1800000).toISOString() },
    externalMarket: providers.market.externalMarket }], {}, { now: time });
  assert.equal(evaluated.entries[0].signal.status, 'CONFIRMING');
  assert.ok(!evaluated.entries[0].signal.missing.includes('marketIdentity'));
  assert.equal(evaluated.entries[0].signal.tradeApproved, false);
});
const go = token => ({ code: 1, result: { [TOKEN]: token } });
const pair = changes => ({ chainId: 'robinhood', pairAddress: PAIR,
  baseToken: { address: TOKEN }, quoteToken: { address: QUOTE_ASSETS.WETH },
  liquidity: { usd: 1000 }, ...changes });
function fetcher(goplus = go({}), dex = { pairs: [] }) {
  return async url => Response.json(url.includes('gopluslabs') ? goplus : dex);
}

test('two anonymous GETs start in parallel with canonical identity and runtime-compatible redirects', async () => {
  const calls = []; const pending = [];
  const promise = readProviders(TOKEN.toUpperCase().replace('0X', '0x'), { now, fetchImpl(url, init) {
    calls.push({ url, init }); return new Promise(resolve => pending.push(resolve));
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${TOKEN}`);
  assert.equal(calls[1].url, `https://api.dexscreener.com/token-pairs/v1/robinhood/${TOKEN}`);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.ok(init.signal instanceof AbortSignal);
  }
  pending[0](Response.json(go({}))); pending[1](Response.json({ pairs: [] }));
  const result = await promise;
  assert.equal(result.evidence.length, 2);
  assert.ok(result.evidence.every(item => item.address === TOKEN && item.chainId === 4663));
  assert.ok(result.evidence.every(item => item.fetchedAt === new Date(time).toISOString()));
});

test('chain-specific array responses accept v4 pool IDs and native ETH without relabelling it WETH', async () => {
  const poolId = '0x' + 'ab'.repeat(32);
  const result = await readProviders(TOKEN, { now, fetchImpl: fetcher(go({}), [
    pair({ labels: ['v4'], pairAddress: poolId, quoteToken: { address: '0x' + '0'.repeat(40), symbol: 'WETH' }, liquidity: { usd: 3000 } }),
    pair({ pairAddress: '0x' + 'cd'.repeat(32), liquidity: { usd: 999999 } }),
    pair({ labels: ['v4'], pairAddress: poolId, chainId: 'ethereum', liquidity: { usd: 999999 } }),
    pair({ labels: ['v4'], pairAddress: poolId, quoteToken: { address: OTHER, symbol: 'ETH' }, liquidity: { usd: 999999 } }),
    pair(),
  ]) });
  const market = result.market.externalMarket;
  assert.equal(market.pairAddress, poolId);
  assert.equal(market.pairKind, 'pool-id');
  assert.equal(market.quoteAsset, 'ETH');
  assert.equal(market.quoteTokenAddress, '0x' + '0'.repeat(40));
  assert.equal(market.liquidityUsd, 3000);
  assert.equal(result.market.dexVerified, undefined);
});

test('v4 IDs require the v4 label and native zero currency cannot masquerade as a v3 quote', async () => {
  for (const invalid of [
    pair({ pairAddress: '0x' + 'ab'.repeat(32) }),
    pair({ labels: ['v4'], pairAddress: PAIR }),
    pair({ labels: ['v3'], quoteToken: { address: '0x' + '0'.repeat(40), symbol: 'WETH' } }),
  ]) {
    const result = await readProviders(TOKEN, { now, fetchImpl: fetcher(go({}), [invalid]) });
    assert.equal(result.market, undefined);
    assert.ok(result.gaps.includes('DEXSCREENER_NO_MATCHING_PAIR'));
  }
});

test('GoPlus body rate limits persist a cooldown across different tokens without caching them as valid', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ code: 4029, message: 'too many requests' }); };
  const first = await readProviders(TOKEN, { now, fetchImpl, skipMarket: true });
  assert.deepEqual(first.gaps, ['GOPLUS_RATE_LIMITED']);
  assert.equal(first.security, undefined);
  assert.equal(first.evidence[0].apiCode, 4029);
  const second = await readProviders(OTHER, { now: () => time + 30000, fetchImpl, state: first.providerState, skipMarket: true });
  assert.equal(calls, 1);
  assert.equal(second.security, undefined);
  assert.ok(second.gaps.includes('GOPLUS_COOLDOWN'));
  assert.equal(second.evidence[0].fetchedAt, null);
  assert.equal(second.evidence[0].error, 'RATE_LIMITED');
  const third = await readProviders(OTHER, { now: () => time + 61000, fetchImpl, state: second.providerState, skipMarket: true });
  assert.equal(calls, 2);
  assert.equal(third.providerState.cache.goplus.length, 0);
  assert.ok(third.providerState.cooldowns.goplus.until >= time + 181000);
});

test('security cache preserves the original evidence date and expires after five minutes', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json(go({ is_honeypot: '1' })); };
  const first = await readProviders(TOKEN, { now, fetchImpl, skipMarket: true });
  const second = await readProviders(TOKEN, { now: () => time + 240000, fetchImpl, state: first.providerState, skipMarket: true });
  assert.equal(calls, 1);
  assert.equal(second.security.honeypotDetected, true);
  assert.equal(second.security.providerReported.fetchedAt, new Date(time).toISOString());
  assert.equal(second.evidence[0].fetchedAt, new Date(time).toISOString());
  assert.equal(second.evidence[0].cacheHit, true);
  const third = await readProviders(TOKEN, { now: () => time + 301000, fetchImpl: async () => {
    calls++; return new Response('', { status: 429 });
  }, state: second.providerState, skipMarket: true });
  assert.equal(calls, 2);
  assert.equal(third.security, undefined);
  assert.ok(third.gaps.includes('GOPLUS_RATE_LIMITED'));
});

test('bulk market refresh maps exact token identities in one request and leaves native analysis dates unchanged', async () => {
  const calls = [];
  const entries = [TOKEN, OTHER].map(address => ({ address, observedAt: '2026-10-22T12:00:00.000Z',
    native: { activeLiquidity: true }, safety: { holders: { checkedAt: '2026-10-22T11:59:00.000Z' } } }));
  const result = await refreshMarketData(entries, undefined, { now, fetchImpl: async url => {
    calls.push(url); return Response.json([
      pair({ volume: { m5: 125, h1: 1000, h24: 5000 }, txns: { m5: { buys: 7, sells: 2 } }, priceChange: { m5: 4 } }),
      pair({ pairAddress: SECOND_PAIR, baseToken: { address: OTHER }, liquidity: { usd: 2000 } }),
      pair({ chainId: 'ethereum', baseToken: { address: OTHER }, liquidity: { usd: 999999 } }),
    ]);
  } });
  assert.deepEqual(calls, [`https://api.dexscreener.com/tokens/v1/robinhood/${TOKEN},${OTHER}`]);
  assert.equal(result.diagnostics.refreshed, 2);
  assert.equal(result.entries[0].externalMarket.baseTokenAddress, TOKEN);
  assert.equal(result.entries[1].externalMarket.baseTokenAddress, OTHER);
  assert.equal(result.entries[1].externalMarket.liquidityUsd, 2000);
  assert.deepEqual(result.entries[0].externalMarket.volumeUsd, { m5: 125, h1: 1000, h24: 5000 });
  for (const entry of result.entries) {
    assert.equal(entry.observedAt, entries[0].observedAt);
    assert.deepEqual(entry.native, { activeLiquidity: true });
    assert.equal(entry.safety.holders.checkedAt, '2026-10-22T11:59:00.000Z');
    assert.equal(entry.externalMarket.fetchedAt, new Date(time).toISOString());
  }
  assert.equal(entries[0].externalMarket, undefined);
});

test('gateway timestamps generated during the fetch are checked against receipt time rather than request start', async () => {
  let current = time;
  const result = await refreshMarketData([{ address: TOKEN }], undefined, { now: () => current,
    fetchImpl: async () => {
      current += 1250;
      return Response.json([pair()], { headers: { 'x-radar-fetched-at': new Date(current).toISOString() } });
    } });
  assert.equal(result.diagnostics.status, 'REFRESHED');
  assert.equal(result.entries[0].externalMarket.fetchedAt, new Date(current).toISOString());
  assert.equal(result.entries[0].marketData.expiresAt, new Date(current + 120000).toISOString());
});

test('source data that expires during a fetch is not refreshed or assigned a new timestamp', async () => {
  let current = time;
  const sourceTime = time - 119000;
  const result = await refreshMarketData([{ address: TOKEN }], undefined, { now: () => current,
    fetchImpl: async () => {
      current += 2000;
      return Response.json([pair()], { headers: { 'x-radar-fetched-at': new Date(sourceTime).toISOString() } });
    } });
  assert.equal(result.diagnostics.status, 'STALE_SOURCE');
  assert.equal(result.entries[0].externalMarket, undefined);
  assert.equal(result.providerState.cache.dexscreener.length, 0);
});

test('fallback cache that expires during a failed request is removed at response time', async () => {
  const first = await refreshMarketData([{ address: TOKEN }], undefined, { now, fetchImpl: async () => Response.json([pair()]) });
  let current = time + 119000;
  const second = await refreshMarketData(first.entries, first.providerState, { now: () => current,
    fetchImpl: async () => { current += 2000; return new Response('', { status: 429 }); } });
  assert.equal(second.diagnostics.status, 'RATE_LIMITED');
  assert.equal(second.entries[0].externalMarket, undefined);
});

test('bulk and single market requests share the persisted provider cooldown and honor Retry-After', async () => {
  let calls = 0;
  const first = await refreshMarketData([{ address: TOKEN }], undefined, { now, fetchImpl: async () => {
    calls++; return new Response('', { status: 429, headers: { 'retry-after': '180' } });
  } });
  assert.equal(first.diagnostics.status, 'RATE_LIMITED');
  assert.equal(first.entries[0].externalMarket, undefined);
  const second = await readProviders(OTHER, { now: () => time + 120000, state: first.providerState,
    fetchImpl: async url => { if (!url.includes('gopluslabs')) calls++; return Response.json(go({})); } });
  assert.equal(calls, 1);
  assert.ok(second.gaps.includes('DEXSCREENER_COOLDOWN'));
  assert.equal(second.providerState.cooldowns.dexscreener.until, time + 180000);
  const third = await refreshMarketData([{ address: OTHER }], second.providerState, { now: () => time + 181000,
    fetchImpl: async () => { calls++; return Response.json([pair({ baseToken: { address: OTHER } })]); } });
  assert.equal(calls, 2);
  assert.equal(third.entries[0].externalMarket.baseTokenAddress, OTHER);
});

test('bulk failures retain only unexpired market evidence and never advance its timestamp', async () => {
  let calls = 0;
  const first = await refreshMarketData([{ address: TOKEN, observedAt: 'native-original' }], undefined,
    { now, fetchImpl: async () => { calls++; return Response.json([pair()]); } });
  const cached = await refreshMarketData(first.entries, first.providerState, { now: () => time + 30000,
    fetchImpl: () => { throw Error('request interval must suppress network'); } });
  assert.equal(cached.diagnostics.status, 'REQUEST_INTERVAL');
  assert.equal(cached.entries[0].externalMarket.fetchedAt, new Date(time).toISOString());
  const limited = await refreshMarketData(cached.entries, cached.providerState, { now: () => time + 61000,
    fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '300' } }); } });
  assert.equal(limited.entries[0].externalMarket.fetchedAt, new Date(time).toISOString());
  assert.equal(limited.entries[0].observedAt, 'native-original');
  const expired = await refreshMarketData(limited.entries, limited.providerState, { now: () => time + 121000,
    fetchImpl: () => { throw Error('cooldown must suppress network'); } });
  assert.equal(calls, 2);
  assert.equal(expired.entries[0].externalMarket, undefined);
  assert.equal(expired.entries[0].marketData.status, 'COOLDOWN');
});

test('a successful no-match response removes old markets and malformed batch responses never mint evidence', async () => {
  const first = await refreshMarketData([{ address: TOKEN }], undefined, { now, fetchImpl: async () => Response.json([pair()]) });
  const empty = await refreshMarketData(first.entries, first.providerState, { now: () => time + 61000,
    fetchImpl: async () => Response.json([]) });
  assert.equal(empty.entries[0].externalMarket, undefined);
  assert.equal(empty.entries[0].marketData.status, 'NO_MATCHING_PAIR');
  const malformed = await refreshMarketData([{ address: TOKEN }], undefined, { now,
    fetchImpl: async () => Response.json({ pairs: [pair()] }) });
  assert.equal(malformed.diagnostics.status, 'INVALID_RESPONSE');
  assert.equal(malformed.entries[0].externalMarket, undefined);
  assert.equal(malformed.providerState.cache.dexscreener.length, 0);
});

test('persisted provider state is bounded with twenty large security reports and a bulk market response', async () => {
  const tokens = Array.from({ length: 20 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
  let state;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const read = await readProviders(token, { state, skipMarket: true, now: () => time + i * 61000,
      fetchImpl: async () => Response.json({ code: 1, result: { [token]: { holder_count: '10000',
        holders: tokens.slice(0, 10).map(address => ({ address, percent: '0.0001' })), is_mintable: '1' } } }) });
    state = read.providerState;
    assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 32768);
  }
  const final = await refreshMarketData(tokens.map(address => ({ address })), state, { now: () => time + 20 * 61000,
    fetchImpl: async () => Response.json(tokens.map((address, i) => pair({ baseToken: { address }, liquidity: { usd: i + 1000 },
      priceUsd: '0.001', fdv: 1000000, volume: { m5: 20000, h1: 100000, h24: 1000000 },
      txns: { m5: { buys: 123, sells: 50 }, h1: { buys: 200, sells: 100 }, h24: { buys: 1000, sells: 1500 } },
      priceChange: { m5: 1, h1: 5, h24: 10 } }))) });
  assert.ok(Buffer.byteLength(JSON.stringify(final.providerState)) <= 32768);
  assert.equal(final.diagnostics.requested, 20);
  assert.equal(final.entries.filter(entry => entry.externalMarket).length, 20);
  const roundTrip = await readProviders(tokens[0], { now: () => time + 20 * 61000 + 1000,
    state: JSON.parse(JSON.stringify(final.providerState)), fetchImpl: async url => {
      assert.ok(url.includes('gopluslabs')); return Response.json({ code: 1, result: { [tokens[0]]: {} } });
    } });
  const evidence = roundTrip.evidence.find(item => item.provider === 'dexscreener');
  assert.equal(evidence.source, `https://api.dexscreener.com/tokens/v1/robinhood/${tokens.join(',')}`);
  assert.equal(evidence.fetchedAt, new Date(time + 20 * 61000).toISOString());
});

test('invalid address or clock causes no provider request', async () => {
  let calls = 0; const fetchImpl = () => { calls++; throw new Error('must not fetch'); };
  for (const address of ['ETH', '0x' + '0'.repeat(40), 'https://example.invalid/private']) {
    const result = await readProviders(address, { fetchImpl, now });
    assert.deepEqual(result, { gaps: ['PROVIDER_ADDRESS_INVALID'], evidence: [] });
  }
  assert.deepEqual(await readProviders(TOKEN, { fetchImpl, now: () => NaN }), { gaps: ['PROVIDER_CLOCK_INVALID'], evidence: [] });
  assert.equal(calls, 0);
});

test('only explicit positive risks and positive fractional taxes enter engine security fields', async () => {
  const result = await readProviders(TOKEN, { now, fetchImpl: fetcher(go({
    is_honeypot: '1', is_mintable: 1, transfer_pausable: '1', slippage_modifiable: '1',
    owner_change_balance: '1', hidden_owner: '1', is_blacklisted: '1', is_whitelisted: '1',
    is_proxy: '1', external_call: '1', is_open_source: '1', buy_tax: '0.015', sell_tax: '0',
  })) });
  for (const key of ['honeypotDetected', 'canMint', 'canPause', 'canChangeFees', 'canConfiscate', 'hiddenPrivileges']) {
    assert.equal(result.security[key], true);
  }
  assert.equal(result.security.buyTaxPct, 1.5);
  assert.equal(result.security.sellTaxPct, undefined);
  for (const key of ['canBlacklist', 'whitelistOnly', 'proxyUpgradeable', 'untrustedTransferCalls', 'contractVerified']) {
    assert.equal(result.security[key], undefined);
  }
  assert.equal(result.security.providerReported.sellTaxPct, 0);
  assert.equal(result.security.providerReported.flags.is_proxy, true);
  assert.equal(result.security.providerReported.trust, 'provider-reported');
  const negatives = await readProviders(TOKEN, { now, fetchImpl: fetcher(go({
    is_honeypot: '0', is_mintable: 0, transfer_pausable: '0', buy_tax: '0', sell_tax: 0,
  })) });
  assert.deepEqual(Object.keys(negatives.security), ['providerReported']);
  assert.equal(negatives.security.providerReported.flags.is_honeypot, false);
});

test('missing or malformed flags and numbers remain unknown rather than becoming false or zero', async () => {
  const result = await readProviders(TOKEN, { now, fetchImpl: fetcher(go({
    is_honeypot: true, is_mintable: 'false', transfer_pausable: '', hidden_owner: '2',
    buy_tax: '1.2', sell_tax: '-0.01', holder_count: 'Infinity',
  })) });
  assert.deepEqual(result.security.providerReported.flags, {});
  assert.deepEqual(Object.keys(result.security), ['providerReported']);
  assert.equal(result.security.providerReported.buyTaxPct, undefined);
  assert.equal(result.security.providerReported.holderCount, undefined);
  assert.ok(result.gaps.includes('GOPLUS_INVALID_FIELDS'));
  assert.ok(result.gaps.includes('GOPLUS_SECURITY_NOT_CONCLUSIVE'));
});

test('GoPlus rejects mismatched chain, contract and ambiguous result addresses', async () => {
  const bodies = [
    { code: 1, result: { [OTHER]: { is_honeypot: '1' } } },
    { code: 1, chain_id: 1, result: { [TOKEN]: { is_honeypot: '1' } } },
    go({ contract_address: OTHER, is_honeypot: '1' }),
    { code: 0, result: { [TOKEN]: { is_honeypot: '1' } } },
    { code: 1, result: { [TOKEN]: {}, [TOKEN.toUpperCase().replace('0X', '0x')]: null } },
  ];
  // Use an address containing letters to exercise duplicate-case ambiguity.
  const alpha = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const ambiguous = await readProviders(alpha, { now, fetchImpl: fetcher({ code: 1, result: {
    [alpha]: { is_honeypot: '1' }, [alpha.toUpperCase().replace('0X', '0x')]: { is_honeypot: '1' },
  } }) });
  assert.equal(ambiguous.security, undefined);
  for (const body of bodies) {
    const result = await readProviders(TOKEN, { now, fetchImpl: fetcher(body) });
    assert.equal(result.security, undefined);
  }
});

test('holder concentrations need a complete unique self-consistent reported enumeration', async () => {
  const holders = [{ address: TOKEN, percent: '0.6' }, { address: OTHER, percent: '0.4' }];
  for (const token of [
    { holder_count: '100', holders },
    { holder_count: '2', holders: [holders[0], holders[0]] },
    { holder_count: '2', holders: [{ address: TOKEN, percent: '0.1' }, holders[1]] },
    { holder_count: '2', holders: [{ address: TOKEN }, holders[1]] },
  ]) {
    const result = await readProviders(TOKEN, { now, fetchImpl: fetcher(go(token)) });
    assert.equal(result.security.providerReported.holderDistribution, undefined);
    assert.ok(result.gaps.includes('GOPLUS_HOLDERS_NOT_EXHAUSTIVE'));
    assert.equal(result.holders, undefined);
  }
  const complete = await readProviders(TOKEN, { now, fetchImpl: fetcher(go({ holder_count: '2', holders })) });
  assert.deepEqual(complete.security.providerReported.holderDistribution, {
    completeAsReported: true, largestHolderPct: 60, top10HoldersPct: 100,
  });
  assert.equal(complete.holders, undefined);
});

test('Dex selects only exact Robinhood base and official quote pairs without overwriting native market', async () => {
  const result = await readProviders(TOKEN, { now, fetchImpl: fetcher(go({}), { pairs: [
    pair({ chainId: 'ethereum', liquidity: { usd: 999999 } }),
    pair({ chainId: 'robinhood-testnet', liquidity: { usd: 999999 } }),
    pair({ baseToken: { address: OTHER }, liquidity: { usd: 999999 } }),
    pair({ quoteToken: { address: OTHER, symbol: 'WETH' }, liquidity: { usd: 999999 } }),
    pair({ pairAddress: SECOND_PAIR, quoteToken: { address: QUOTE_ASSETS.USDG.toUpperCase().replace('0X', '0x') }, liquidity: { usd: 2000 } }),
    pair(),
  ] }) });
  assert.deepEqual(Object.keys(result.market), ['externalMarket']);
  const market = result.market.externalMarket;
  assert.equal(market.pairAddress, SECOND_PAIR); assert.equal(market.quoteTokenAddress, QUOTE_ASSETS.USDG);
  assert.equal(market.baseTokenAddress, TOKEN); assert.equal(market.chainId, 4663);
  assert.equal(market.trust, 'provider-reported'); assert.equal(market.liquidityUsd, 2000);
  assert.equal(result.market.liquidityUsd, undefined);
});

test('Dex preserves published zero and signed changes but never fills absent or invalid metrics', async () => {
  const result = await readProviders(TOKEN, { now, fetchImpl: fetcher(go({}), { pairs: [pair({
    priceUsd: '0.000004156', liquidity: { usd: -10 }, fdv: 4157, marketCap: null,
    volume: { m5: 0, h1: -1, h24: 'NaN' }, priceChange: { m5: -25, h1: '0', h24: 'Infinity' },
    txns: { m5: { buys: 0, sells: 2 }, h1: { buys: -1, sells: 0.5 } },
  })] }) });
  const market = result.market.externalMarket;
  assert.equal(market.priceUsd, 0.000004156); assert.equal(market.fdvUsd, 4157);
  assert.equal(market.liquidityUsd, undefined); assert.equal(market.marketCapUsd, undefined);
  assert.deepEqual(market.volumeUsd, { m5: 0 });
  assert.deepEqual(market.priceChangePct, { m5: -25, h1: 0 });
  assert.deepEqual(market.txns, { m5: { buys: 0, sells: 2 } });
  assert.ok(result.gaps.includes('DEXSCREENER_MARKET_NOT_VERIFIED_ONCHAIN'));
});

test('HTTP, redirect, oversized and malformed responses fail closed while the other provider survives', async () => {
  const cases = [
    [() => new Response('', { status: 302, headers: { location: 'https://unexpected.invalid/private' } }), 'HTTP_302'],
    [() => new Response('', { status: 429 }), 'HTTP_429'],
    [() => new Response('x'.repeat(131073)), 'RESPONSE_LIMIT'],
    [() => new Response('{}', { headers: { 'content-length': '131073' } }), 'RESPONSE_LIMIT'],
    [() => new Response('not JSON'), 'INVALID_JSON'],
    [() => { throw new Error('https://private.invalid/?key=secret-key'); }, 'REQUEST_FAILED'],
  ];
  for (const [failure, code] of cases) {
    const result = await readProviders(TOKEN, { now, fetchImpl: async url =>
      url.includes('gopluslabs') ? failure() : Response.json({ pairs: [pair()] }) });
    assert.equal(result.security, undefined); assert.ok(result.market?.externalMarket);
    assert.ok(result.gaps.includes(`GOPLUS_${code}`));
    assert.equal(JSON.stringify(result).includes('secret-key'), false);
    assert.equal(JSON.stringify(result).includes('unexpected.invalid'), false);
  }
});

test('both request and body deadlines are bounded to three seconds with no retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = []; let requests = 0;
  const promise = readProviders(TOKEN, { now, fetchImpl: async (_url, init) => {
    requests++; signals.push(init.signal); return new Promise(() => {});
  } });
  t.mock.timers.tick(3000);
  const result = await promise;
  assert.equal(requests, 2); assert.ok(signals.every(signal => signal.aborted));
  assert.deepEqual(result.gaps, ['GOPLUS_TIMEOUT', 'DEXSCREENER_TIMEOUT']);
  let cancelled = 0;
  const bodyPromise = readProviders(TOKEN, { now, fetchImpl: async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled++; },
  })) });
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(3000);
  const bodyResult = await bodyPromise;
  assert.deepEqual(bodyResult.gaps, ['GOPLUS_TIMEOUT', 'DEXSCREENER_TIMEOUT']);
  assert.equal(cancelled, 2);
});
