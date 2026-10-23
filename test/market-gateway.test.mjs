import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketGateway } from '../src/mvp/market-gateway.mjs';
import nodeHandler from '../api/market.mjs';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PAIR = '0xcccccccccccccccccccccccccccccccccccccccc';
const ZERO = '0x' + '0'.repeat(40);
const time = Date.parse('2026-10-23T12:00:00.000Z');
const pair = changes => ({ chainId: 'robinhood', dexId: 'uniswap', pairAddress: PAIR,
  baseToken: { address: A }, quoteToken: { address: ZERO, symbol: 'ETH' }, ...changes });
const request = (addresses = A, options = {}) => new Request('https://radar.example/api/market?addresses=' + addresses, options);
const privateCache = response => {
  for (const name of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control']) assert.equal(response.headers.get(name), 'no-store');
  assert.equal(response.headers.get('x-radar-fetched-at'), null);
};
function fixture(fetchImpl, extras = {}) {
  const calls = []; const logs = [];
  const gateway = createMarketGateway({ now: () => time, logger: entry => logs.push(entry),
    fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); }, ...extras });
  return { gateway, calls, logs };
}

test('market gateway canonicalizes addresses and makes one fixed anonymous GET, preserving the raw array and source timestamp', async () => {
  const body = JSON.stringify([pair({ pairAddress: '0x' + 'd'.repeat(64), labels: ['v4'] })], null, 2);
  const f = fixture(() => new Response(body));
  const response = await f.gateway(request([B, A.toUpperCase().replace('0X', '0x'), A].join(',')));
  assert.equal(response.status, 200); assert.equal(await response.text(), body); assert.equal(f.calls.length, 1);
  const [url, init] = f.calls[0];
  assert.equal(url, `https://api.dexscreener.com/tokens/v1/robinhood/${A},${B}`);
  assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
  assert.deepEqual(init.headers, { accept: 'application/json' }); assert.ok(init.signal instanceof AbortSignal);
  assert.equal(response.headers.get('x-radar-fetched-at'), new Date(time).toISOString());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('cdn-cache-control'), 'public, max-age=30');
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'public, max-age=30');
  assert.deepEqual(f.logs, [{ event: 'MARKET_GATEWAY', status: 200, outcome: 'UPSTREAM_OK', durationMs: 0 }]);
});

test('market gateway rejects invalid input, extra parameters and methods without an upstream request', async () => {
  const f = fixture(() => { throw new Error('must not fetch'); });
  for (const query of ['', 'addresses=', 'addresses=' + ZERO, 'addresses=' + A + ',',
    'addresses=https://unexpected.invalid', 'addresses=' + A + '&chain=ethereum',
    'addresses=' + A + '&addresses=' + B, 'addresses=' + Array(21).fill(A).join(','),
    'addresses=' + A + '%2F..%2Fethereum', 'addresses=0x' + 'a'.repeat(39)]) {
    const response = await f.gateway(new Request('https://radar.example/api/market?' + query));
    assert.equal(response.status, 400); privateCache(response);
  }
  const wrongPath = await f.gateway(new Request('https://radar.example/api/elsewhere?addresses=' + A));
  assert.equal(wrongPath.status, 404);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await f.gateway(request(A, { method }));
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET'); privateCache(response);
  }
  assert.equal(f.calls.length, 0);
});

test('empty upstream markets are a valid empty array, not fabricated data', async () => {
  const f = fixture(() => Response.json([]));
  const response = await f.gateway(request());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), []);
});

test('the raw token endpoint may return a requested token on the quote side without inventing a reversed pair', async () => {
  const body = [pair({ baseToken: { address: B }, quoteToken: { address: A } })];
  const f = fixture(() => Response.json(body));
  const response = await f.gateway(request(A));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), body);
});

test('429 is forwarded once with Retry-After, safe JSON and no caching', async () => {
  for (const [header, expected] of [['120', 120], [new Date(time + 90000).toUTCString(), 90], ['invalid', 60]]) {
    const f = fixture(() => new Response('private upstream body', { status: 429, headers: { 'retry-after': header } }));
    const response = await f.gateway(request());
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), String(expected));
    assert.deepEqual(await response.json(), { error: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: expected });
    assert.equal(f.calls.length, 1); privateCache(response);
    assert.equal(JSON.stringify(f.logs).includes('private upstream body'), false);
  }
});

test('upstream redirects and unavailable responses are never followed or cached', async () => {
  for (const status of [301, 302, 403, 500, 503]) {
    const f = fixture(() => new Response('private', { status, headers: { location: 'https://unexpected.invalid' } }));
    const response = await f.gateway(request());
    assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'UPSTREAM_UNAVAILABLE' });
    assert.equal(f.calls.length, 1); privateCache(response);
    assert.equal(JSON.stringify(f.logs).includes('unexpected'), false);
  }
});

test('malformed JSON and mismatched chain, base token, quote or pool identities fail closed', async () => {
  for (const body of ['not JSON', '{}', JSON.stringify([null]), JSON.stringify([pair({ chainId: 'ethereum' })]),
    JSON.stringify([pair({ baseToken: { address: B } })]), JSON.stringify([pair({ pairAddress: ZERO })]),
    JSON.stringify([pair({ pairAddress: 'https://unexpected.invalid' })]),
    JSON.stringify([pair({ quoteToken: { address: 'ETH' } })])]) {
    const f = fixture(() => new Response(body));
    const response = await f.gateway(request());
    assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'UPSTREAM_INVALID_RESPONSE' });
    privateCache(response);
  }
});

test('declared and streamed response limits prevent returning an oversized body', async () => {
  for (const response of [new Response('[]', { headers: { 'content-length': '131073' } }), new Response(' '.repeat(131073))]) {
    const f = fixture(() => response);
    const result = await f.gateway(request());
    assert.equal(result.status, 502); assert.deepEqual(await result.json(), { error: 'UPSTREAM_RESPONSE_LIMIT' });
    assert.equal(f.calls.length, 1); privateCache(result);
  }
});

test('request timeout is bounded to three seconds even when transport ignores abort, without retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => new Promise(() => {}));
  const pending = f.gateway(request());
  t.mock.timers.tick(3000);
  const response = await pending;
  assert.equal(response.status, 504); assert.deepEqual(await response.json(), { error: 'UPSTREAM_TIMEOUT' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1].signal.aborted, true); privateCache(response);
});

test('body timeout is also bounded and cancels the reader without returning partial data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const f = fixture(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const pending = f.gateway(request());
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(3000);
  const response = await pending;
  assert.equal(response.status, 504); assert.equal(cancelled, true); privateCache(response);
});

test('network errors and invalid clocks disclose no URLs or credentials', async () => {
  const f = fixture(() => { throw new Error('https://private.invalid?key=secret'); });
  const response = await f.gateway(request());
  assert.equal(response.status, 502); assert.equal((await response.text()).includes('secret'), false);
  assert.equal(JSON.stringify(f.logs).includes('secret'), false); privateCache(response);
  const badClock = fixture(() => { throw new Error('must not fetch'); }, { now: () => NaN });
  const invalid = await badClock.gateway(request());
  assert.equal(invalid.status, 500); assert.equal(badClock.calls.length, 0); privateCache(invalid);
});

test('Vercel Node adapter returns validation errors as Node responses without starting an upstream request', async () => {
  const headers = {}; let body;
  const result = { setHeader(name, value) { headers[name] = value; }, end(value) { body = value; } };
  await nodeHandler({ url: '/api/market?addresses=invalid', method: 'GET' }, result);
  assert.equal(result.statusCode, 400); assert.equal(headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(body.toString()), { error: 'INVALID_ADDRESSES' });
});

test('Vercel Node adapter rejects restricted HTTP methods before constructing a Web Request', async () => {
  const headers = {}; let body;
  const result = { setHeader(name, value) { headers[name] = value; }, end(value) { body = value; } };
  await nodeHandler({ url: '/api/market?addresses=' + A, method: 'TRACE' }, result);
  assert.equal(result.statusCode, 405); assert.equal(headers.allow, 'GET');
  assert.deepEqual(JSON.parse(body.toString()), { error: 'METHOD_NOT_ALLOWED' });
});
