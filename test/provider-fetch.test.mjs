import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFetch } from '../src/mvp/provider-fetch.mjs';
import { refreshMarketData } from '../src/cloudflare/providers.mjs';
import { QUOTE_ASSETS } from '../src/network.mjs';

const token = '0x1111111111111111111111111111111111111111';
const gateway = 'https://example.vercel.app/api/market';
const time = Date.parse('2026-10-23T13:00:00Z');
const pairs = [{ chainId: 'robinhood', pairAddress: '0x2222222222222222222222222222222222222222',
  baseToken: { address: token }, quoteToken: { address: QUOTE_ASSETS.WETH }, priceUsd: '0.01', liquidity: { usd: 100000 } }];

test('gateway adapter redirects only the fixed market endpoint and preserves request guards', async () => {
  const calls = []; const fetchImpl = async (url, init) => { calls.push({ url, init }); return Response.json([]); };
  assert.equal(providerFetch(fetchImpl), fetchImpl);
  const wrapped = providerFetch(fetchImpl, gateway);
  const init = { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(1000) };
  await wrapped(`https://api.dexscreener.com/tokens/v1/robinhood/${token}`, init);
  assert.equal(calls[0].url, `${gateway}?addresses=${token}`);
  assert.equal(calls[0].init, init);
  await wrapped('https://robinhood.rpc.pinax.network', { method: 'POST' });
  await wrapped(`https://api.dexscreener.com/tokens/v1/ethereum/${token}`, init);
  assert.equal(calls[1].url, 'https://robinhood.rpc.pinax.network');
  assert.match(calls[2].url, /ethereum/);
  for (const url of ['http://example.vercel.app/api/market', gateway + '?url=other', 'https://user:pass@example.com/api/market'])
    assert.throws(() => providerFetch(fetchImpl, url), /INVALID_MARKET_GATEWAY/);
});

test('cached gateway response keeps original source timestamp and expires at that source deadline', async () => {
  const sourceTime = time - 30000;
  const fetchImpl = providerFetch(async () => Response.json(pairs, { headers: { 'x-radar-fetched-at': new Date(sourceTime).toISOString() } }), gateway);
  const first = await refreshMarketData([{ address: token }], undefined, { now: () => time, fetchImpl });
  assert.equal(first.entries[0].externalMarket.fetchedAt, new Date(sourceTime).toISOString());
  assert.equal(first.entries[0].marketData.expiresAt, new Date(sourceTime + 120000).toISOString());
  const expired = await refreshMarketData([{ address: token }], first.providerState, { now: () => time + 120000, fetchImpl });
  assert.equal(expired.diagnostics.status, 'STALE_SOURCE');
  assert.equal(expired.entries[0].externalMarket, undefined);
});

test('malformed source timestamps fail closed instead of refreshing a cached price', async () => {
  const result = await refreshMarketData([{ address: token }], undefined, {
    now: () => time, fetchImpl: async () => Response.json(pairs, { headers: { 'x-radar-fetched-at': 'not-a-date' } }) });
  assert.equal(result.entries[0].externalMarket, undefined);
  assert.equal(result.diagnostics.status, 'INVALID_SOURCE_TIME');
});
