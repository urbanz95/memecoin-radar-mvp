import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Collector } from '../src/cloudflare/worker.mjs';
import { collectFree } from '../src/cloudflare/collector.mjs';
import { OPERATIONS_CONFIG } from '../src/cloudflare/operations.mjs';
import { prepareDecisionRecords, prepareDecisionCanonicality, readDecisionCanonicality } from '../src/mvp/records.mjs';
import { setup, decision } from './helpers/mvp-sqlite.mjs';

const memory = () => { const values = new Map(); return {
  async get(key) { return structuredClone(values.get(key)); },
  async put(key, value) { values.set(key, structuredClone(value)); },
}; };
const post = path => new Request(`https://collector.internal/${path}`, { method: 'POST' });
const hash = number => '0x' + Number(number).toString(16).padStart(64, '0');

test('the real managed Durable Object captures a D1 quota failure during initial lease acquisition and skips further D1 calls', async () => {
  let statements = 0;
  const env = { OPERATIONS_ENABLED: '1', DB: { prepare() { statements++; return { bind() { return this; },
    async first() { throw Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. https://private/secret"); },
  }; } } };
  const object = new Collector({ storage: memory() }, env);
  const result = await (await object.fetch(post('collect'))).json();
  assert.equal(result.status, 'ERROR'); assert.equal(result.reason, 'D1_DAILY_WRITE_LIMIT');
  const skipped = await (await object.fetch(post('collect'))).json();
  assert.equal(skipped.status, 'SKIPPED'); assert.equal(skipped.reason, 'D1_QUOTA_COOLDOWN');
  assert.equal(statements, 1, 'the initial lease is outside collectFree try/catch, but the DO wrapper protects it');
  const state = await (await object.fetch(new Request('https://collector.internal/operations'))).json();
  assert.equal(state.lastError.code, 'D1_DAILY_WRITE_LIMIT'); assert.equal(state.lastError.module, 'd1');
  assert.equal(state.lastSuccessAt, null); assert.equal(state.stability.qualified, false);
  assert.equal(state.budget.estimatedRowsWritten, OPERATIONS_CONFIG.collector.unfinishedCycleWriteReservation);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('scheduled jobs route weekly work to its own actor and heartbeat to the collector journal without invoking D1 in the caller', async t => {
  const calls = [];
  t.mock.method(console, 'log', () => {});
  const env = { OPERATIONS_ENABLED: '1', COLLECTOR_INSTANCE: 'phase3b',
    COLLECTOR: {
      idFromName(name) { return name; }, get(name) { return { async fetch(url, init) {
        calls.push({ name, path: new URL(url).pathname, method: init.method }); return Response.json({ status: 'COMPLETE' });
      } }; },
    }, DB: new Proxy({}, { get() { throw Error('unexpected-D1-in-scheduler'); } }),
  };
  await worker.scheduled({ cron: OPERATIONS_CONFIG.weekly.cron }, env);
  await worker.scheduled({ cron: OPERATIONS_CONFIG.heartbeat.cron }, env);
  await worker.scheduled({ cron: '* * * * *' }, env);
  assert.deepEqual(calls, [
    { name: 'phase3b-weekly', path: '/weekly', method: 'POST' },
    { name: 'phase3b', path: '/heartbeat', method: 'POST' },
    { name: 'phase3b', path: '/collect', method: 'POST' },
  ]);
});

test('an unavailable old baseline header remains quarantined without interrupting ingestion', async t => {
  const DB = setup(t); const now = Date.now();
  await DB.batch(prepareDecisionRecords(DB, { runId: 'old-baseline', observedAt: now - 60000,
    decisions: [decision()] }).commands);
  await DB.batch(prepareDecisionCanonicality(DB, { runId: 'old-fork', observedAt: now - 30000,
    reorgDetected: true }).commands);
  const head = { number: 200, hash: hash(200), timestamp: Math.floor(now / 1000) };
  DB.sqlite.prepare('UPDATE control SET state_json=?').run(JSON.stringify({ head }));
  const rpc = { audit: [], async request(method) {
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getLogs') return [];
    throw Error('unexpected-rpc');
  }, async block(number = 'latest') { return number === 'latest' || number === 200 ? head : null; } };
  t.mock.method(console, 'error', () => {});
  const result = await collectFree({ DB, MVP_RECORDING_ENABLED: '1', MVP_PHASE: '1' }, { now: () => now, rpc });
  assert.equal(result.status, 'COMPLETED');
  assert.equal((await readDecisionCanonicality(DB)).revalidationComplete, false);
  assert.equal(DB.sqlite.prepare('SELECT status FROM control WHERE id=1').get().status, 'COMPLETED');
  assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM runs').get().n, 1);
});
