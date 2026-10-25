import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Collector } from '../src/cloudflare/worker.mjs';

const memory = () => { const values = new Map(); return {
  async get(key) { return structuredClone(values.get(key)); },
  async put(key, value) { values.set(key, structuredClone(value)); },
}; };

test('managed public read routes forward the DO response without D1 access or parsing its JSON in the stateless Worker', async t => {
  let parses = 0;
  const originalParse = JSON.parse;
  t.mock.method(JSON, 'parse', (...args) => { parses++; return originalParse(...args); });
  for (const path of ['/latest', '/health', '/weekly?page=2&scoreVersion=v3&profile=profile_new&quoteTier=T0']) {
    const calls = []; let jsonReads = 0;
    const expected = new Response('{"source":"durable-object","unparsed":true}', {
      status: path === '/health' ? 503 : 200, headers: { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-origin': 'do' },
    });
    expected.json = async () => { jsonReads++; throw Error('WORKER_JSON_PROCESSING'); };
    const env = { OPERATIONS_ENABLED: '1', COLLECTOR_INSTANCE: 'phase3b',
      get DB() { throw Error('WORKER_D1_ACCESS'); },
      COLLECTOR: { idFromName(name) { return name; }, get(name) { return { async fetch(url, init) {
        calls.push({ name, url: String(url), method: init.method }); return expected;
      } }; } },
    };
    const request = new Request('https://public.example' + path);
    const parsesBeforeRequest = parses;
    const response = await worker.fetch(request, env);
    assert.equal(response, expected);
    assert.equal(jsonReads, 0);
    assert.equal(parses, parsesBeforeRequest, 'the Worker does not parse report JSON');
    assert.deepEqual(calls, [{ name: 'phase3b', url: 'https://collector.internal/public' + path, method: 'GET' }]);
  }
});

test('the DO executes managed health reads using its own journal without a self request', async () => {
  const now = Date.now(); let reads = 0;
  const env = { OPERATIONS_ENABLED: '1', DB: { prepare() { return { async first() {
    reads++; return { status: 'COMPLETED', last_success: now, lease_until: 0, last_error: null, signals_json: '{}' };
  } }; } }, get COLLECTOR() { throw Error('RECURSIVE_DO_REQUEST'); } };
  const actor = new Collector({ storage: memory() }, env);
  const response = await actor.fetch(new Request('https://collector.internal/public/health'));
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(reads, 1); assert.equal(body.status, 'COMPLETED'); assert.equal(body.stale, false);
  assert.equal(body.lastSuccessAt, new Date(now).toISOString());
  assert.equal(body.operations.stability.qualified, false); assert.equal(body.heartbeat.telegramDelivery, false);
});

test('internal public routes remain GET-only and the public Worker cannot expose internal collector endpoints', async () => {
  const noReads = new Proxy({}, { get() { throw Error('UNEXPECTED_ENV_ACCESS'); } });
  for (const path of ['/public/health', '/operations', '/collect', '/heartbeat'])
    assert.equal((await worker.fetch(new Request('https://public.example' + path), noReads)).status, 404);
  assert.equal((await worker.fetch(new Request('https://public.example/latest', { method: 'POST' }), noReads)).status, 405);
  const actor = new Collector({ storage: memory() }, { OPERATIONS_ENABLED: '1' });
  assert.equal((await actor.fetch(new Request('https://collector.internal/public/latest', { method: 'POST' }))).status, 404);
  assert.equal((await actor.fetch(new Request('https://collector.internal/public/unknown'))).status, 405);
});

test('unmanaged public reads keep their direct legacy response and cache contract', async () => {
  let reads = 0;
  const env = { DB: { prepare() { return { async first() { reads++; return null; } }; } },
    get COLLECTOR() { throw Error('LEGACY_DO_ACCESS'); } };
  const response = await worker.fetch(new Request('https://public.example/latest'), env);
  assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'NOT_STARTED', currentSignalsAvailable: false });
  assert.equal(reads, 1);
});

test('a failed managed DO read preserves the existing sanitized 503 error response', async () => {
  const env = { OPERATIONS_ENABLED: '1', COLLECTOR: { idFromName(name) { return name; }, get() {
    return { async fetch() { throw Error('https://private/token-secret'); } };
  } } };
  const response = await worker.fetch(new Request('https://public.example/latest'), env);
  assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ERROR', currentSignalsAvailable: false, lastError: 'COLLECTION_FAILED' });
});
