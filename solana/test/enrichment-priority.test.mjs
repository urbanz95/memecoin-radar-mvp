import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Scanner } from '../src/scanner.mjs';
import { loadConfig } from '../src/config.mjs';
import { classifyContextPriority, PriorityScheduler } from '../src/enrichment-priority.mjs';

const verified = (eventType, extra = {}) => ({
  evidenceStatus: 'VERIFIED_RPC_LOG_EVENT',
  evidenceSource: { kind: 'rpc:logsSubscribe' },
  tokenMint: 'verified-mint',
  protocol: 'pump_fun',
  eventType,
  ...extra,
});
const observed = (signature, contextPriority) => ({
  signature, slot: 1, receivedAt: new Date(1793900000000).toISOString(),
  ...(contextPriority === undefined ? {} : { contextPriority }),
});

test('only evidence-backed lifecycle events reach P0; unknown cannot be upgraded', () => {
  for (const event of ['TOKEN_CREATED', 'POOL_CREATED', 'TOKEN_MIGRATED', 'TOKEN_GRADUATED'])
    assert.equal(classifyContextPriority([verified(event)]), 0);
  assert.equal(classifyContextPriority([verified('TOKEN_CREATED', { tokenMint: null })]), 3);
  assert.equal(classifyContextPriority([verified('TOKEN_CREATED', { evidenceStatus: null })]), 3);
  assert.equal(classifyContextPriority([verified('TOKEN_CREATED', { evidenceSource: { kind: 'manual' } })]), 3);
  assert.equal(classifyContextPriority([], { action: 'ENRICH' }), 3);
  assert.equal(classifyContextPriority([verified('TOKEN_BOUGHT')], { action: 'ENRICH' }), 1);
  assert.equal(classifyContextPriority([verified('TOKEN_BOUGHT')], { action: 'UNKNOWN' }), 2);
  assert.equal(classifyContextPriority([verified('TOKEN_SOLD', { protocol: 'pump_swap' })], { action: 'ENRICH' }), 2);
  assert.equal(classifyContextPriority([verified('SOMETHING_UNKNOWN')]), 3);
});

test('durable SQLite inbox sorts P0–P3 without an on-disk schema migration', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.receiveBatch([
      observed('p3-old'), observed('p2', 2),
      observed('p0a', 0), observed('p1', 1), observed('p0b', 0), observed('p3', 3),
    ]), 6);
    assert.deepEqual(store.pendingByPriority(0).map(x => x.signature), ['p0a', 'p0b']);
    assert.deepEqual(store.pendingByPriority(1).map(x => x.signature), ['p1']);
    assert.deepEqual(store.pendingByPriority(2).map(x => x.signature), ['p2']);
    assert.deepEqual(store.pendingByPriority(3).map(x => x.signature), ['p3', 'p3-old']);
    assert.equal(store.pending(10).length, 6);
    assert.throws(() => store.receiveBatch([observed('bad', 9)]), /INVALID_CONTEXT_PRIORITY/);
    assert.equal(store.stats().inbox, 6);
    assert.throws(() => store.pendingByPriority(9), /INVALID_CONTEXT_PRIORITY_QUERY/);
  } finally { store.close(); }
});

test('scheduler gives every continuously backlogged rank a quota without duplicate work', () => {
  const s = new PriorityScheduler();
  const buckets = [0, 1, 2, 3].map(p => Array.from({ length: 15 },
    (_, i) => ({ signature: `P${p}-${i}`, contextPriority: p })));
  const chosen = s.select(buckets, 16);
  assert.equal(chosen.length, 16);
  assert.equal(new Set(chosen.map(x => x.signature)).size, 16);
  assert.deepEqual([0, 1, 2, 3].map(p => chosen.filter(x => x.contextPriority === p).length),
    [8, 4, 2, 2]);
});

test('scheduler rotates fairly even with single-item dispatch and respects blocked signatures', () => {
  const s = new PriorityScheduler();
  const buckets = [0, 1, 2, 3].map(p => Array.from({ length: 50 },
    (_, i) => ({ signature: `P${p}-${i}`, contextPriority: p })));
  const blocked = new Set(['P0-0']);
  const selected = [];
  for (let i = 0; i < 16; i++) {
    const [x] = s.select(buckets, 1, blocked);
    assert.ok(x);
    selected.push(x);
    blocked.add(x.signature);
  }
  assert.ok(!selected.some(x => x.signature === 'P0-0'));
  assert.deepEqual([0, 1, 2, 3].map(p => selected.filter(x => x.contextPriority === p).length),
    [8, 4, 2, 2]);
});

test('focused priority config is opt-in and strictly validated', () => {
  assert.equal(loadConfig({ SOLANA_PROGRAMS: 'pump_fun' }).contextPrioritiesEnabled, false);
  assert.equal(loadConfig({
    SOLANA_PROGRAMS: 'pump_fun',
    SOLANA_CONTEXT_PRIORITIES_ENABLED: 'true',
    SOLANA_PRIORITY_RESERVED_P0_SLOTS: '8',
  }).priorityP0ReservedSlots, 8);
  assert.throws(() => loadConfig({ SOLANA_CONTEXT_PRIORITIES_ENABLED: 'yes' }),
    /INVALID_SOLANA_CONTEXT_PRIORITIES_ENABLED/);
  assert.throws(() => loadConfig({ SOLANA_PRIORITY_RESERVED_P0_SLOTS: '-1' }),
    /INVALID_CONFIG_SOLANA_PRIORITY_RESERVED_P0_SLOTS/);
});

test('when non-P0 reservation is exhausted, verified P0 still admitted and logs retained', async () => {
  const createTx = JSON.parse(readFileSync(
    new URL('../fixtures/pump-create-v2-mainnet.json', import.meta.url))).result;
  const buyTx = JSON.parse(readFileSync(
    new URL('../fixtures/pump-buy-v3-mainnet.json', import.meta.url))).result;
  const store = new Store(':memory:');
  const scanner = new Scanner({
    ...loadConfig({ SOLANA_PROGRAMS: 'pump_fun', SOLANA_CONTEXT_PRIORITIES_ENABLED: 'true' }),
    fdvMinimumUsd: 0,
    maxDurableBacklog: 9,
    priorityP0ReservedSlots: 2,
  }, {store, rpc:{ close: async () => {} }});
  const event = tx => ({
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    logs: tx.meta.logMessages,
    err: tx.meta.err,
    receivedAt: new Date().toISOString(),
    confirmationStatus: 'confirmed',
  });
  try {
    scanner.contextBacklog = 7;  // explicit backpressure fixture; no live calls
    scanner.receive(event(buyTx));
    scanner.flush();
    assert.equal(scanner.metrics.snapshot().counters.contextPriorityReservedAdmissionSkip, 1);
    assert.equal(scanner.metrics.snapshot().counters.contextPrioritySkippedP2, 1);
    assert.equal(store.stats().inbox, 0);
    assert.ok(store.observations({ signature: buyTx.transaction.signatures[0] }).length > 0);
    scanner.receive(event(createTx));
    scanner.flush();
    const p0 = store.pendingByPriority(0);
    assert.equal(p0.length, 1);
    assert.equal(p0[0].signature, createTx.transaction.signatures[0]);
    assert.equal(scanner.health().metrics.counters.contextPriorityAdmittedP0, 1);
    assert.ok(store.observations({ signature: createTx.transaction.signatures[0] }).length > 0);
  } finally { await scanner.stop(); }
});

test('durable priority survives SQLite restart and remains queryable by rank', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'solana-priority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'inbox.sqlite');
  const first = new Store(path);
  first.receiveBatch([observed('priority-p0', 0), observed('priority-p3')]);
  first.close();
  const reopened = new Store(path);
  try {
    assert.equal(reopened.pendingByPriority(0)[0].signature, 'priority-p0');
    assert.equal(reopened.pendingByPriority(3)[0].signature, 'priority-p3');
    assert.equal(reopened.stats().pending, 2);
  } finally { reopened.close(); }
});

test('processed transaction increments its actual priority counter, not only scheduled', async () => {
  const tx = JSON.parse(readFileSync(
    new URL('../fixtures/pump-create-v2-mainnet.json', import.meta.url))).result;
  const observation = {
    ...observed(tx.transaction.signatures[0], 0),
    slot: tx.slot,
    receivedAt: new Date().toISOString(),
    evidenceSource: 'rpc:logsSubscribe',
    confirmationStatus: 'confirmed',
  };
  const store = new Store(':memory:');
  let count = 0;
  const scanner = new Scanner({
    ...loadConfig({ SOLANA_PROGRAMS: 'pump_fun', SOLANA_CONTEXT_PRIORITIES_ENABLED: 'true' }),
    fdvMinimumUsd: 0,
  }, { store, rpc: {
    async request(method) {
      assert.equal(method, 'getTransaction');
      count++;
      return tx;
    },
    async close() {},
  }});
  try {
    store.receiveBatch([observation]);
    assert.equal(await scanner.processObservation(observation), true);
    assert.equal(count, 1);
    assert.equal(scanner.health().metrics.counters.contextPriorityFetchStartedP0, 1);
    assert.equal(scanner.health().metrics.counters.contextPriorityTransactionsProcessedP0, 1);
    assert.ok(scanner.health().metrics.histograms.contextPriorityLiveLatencyP0Ms);
  } finally { await scanner.stop(); }
});

test('tiered reservation retains admission slots for P1 and P2 under abundant P3 logs', async () => {
  const createTx = JSON.parse(readFileSync(new URL('../fixtures/pump-create-v2-mainnet.json', import.meta.url))).result;
  const buyTx = JSON.parse(readFileSync(new URL('../fixtures/pump-buy-v3-mainnet.json', import.meta.url))).result;
  const store = new Store(':memory:');
  const scanner = new Scanner({
    ...loadConfig({ SOLANA_PROGRAMS: 'pump_fun', SOLANA_CONTEXT_PRIORITIES_ENABLED: 'true' }),
    fdvMinimumUsd: 5000,
    maxDurableBacklog: 32,
    priorityP0ReservedSlots: 4,
    priorityP1ReservedSlots: 4,
    priorityP2ReservedSlots: 4,
  }, {
    store,
    rpc: { async close() {} },
    oracle: { snapshot: () => null },
  });
  const data = (tx, suffix = '') => ({
    signature: tx.transaction.signatures[0] + suffix, slot: tx.slot,
    logs: tx.meta.logMessages, err: tx.meta.err,
    receivedAt: new Date().toISOString(),
    confirmationStatus: 'confirmed',
  });
  try {
    // Isolate priority scheduling from FDV arithmetic (covered by FDV tests).
    scanner.fdvGate.evaluate = () => ({ action: 'UNKNOWN' });
    scanner.contextBacklog = 20;
    scanner.receive({ signature: 'unidentified', slot: 1, logs: [], receivedAt: new Date().toISOString() });
    assert.equal(scanner.metrics.snapshot().counters.contextPrioritySkippedP3, 1);
    scanner.receive(data(buyTx));
    assert.equal(scanner.metrics.snapshot().counters.contextPriorityAdmittedP2, 1);
    scanner.flush();
    scanner.contextBacklog = 24;
    scanner.receive(data(buyTx, '-second'));
    assert.equal(scanner.metrics.snapshot().counters.contextPrioritySkippedP2, 1);
    scanner.fdvGate.evaluate = () => ({ action: 'ENRICH' });
    scanner.receive(data(buyTx, '-eligible'));
    assert.equal(scanner.metrics.snapshot().counters.contextPriorityAdmittedP1, 1);
    scanner.flush();
    scanner.contextBacklog = 28;
    scanner.receive(data(buyTx, '-eligible-blocked'));
    assert.equal(scanner.metrics.snapshot().counters.contextPrioritySkippedP1, 1);
    scanner.receive(data(createTx));
    assert.equal(scanner.metrics.snapshot().counters.contextPriorityAdmittedP0, 1);
    scanner.flush();
    assert.equal(store.pendingByPriority(0).length, 1);
    assert.equal(store.pendingByPriority(1).length, 1);
    assert.equal(store.pendingByPriority(2).length, 1);
    assert.ok(scanner.health().contextPriorityScheduler.reservedP1Slots >= 4);
  } finally { await scanner.stop(); }
});
