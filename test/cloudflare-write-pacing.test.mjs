import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS_CONFIG, runManagedCollection, readOperations, validateOperationsConfig } from '../src/cloudflare/operations.mjs';

const start = Date.parse('2026-10-25T07:00:00Z');
function fixture() {
  let at = start;
  const values = new Map();
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
  };
  return {
    storage, values,
    async cycle(writes) {
      const result = await runManagedCollection({ storage, now: () => at,
        collect: async () => ({ status: 'COMPLETED', d1RowsWritten: writes }) });
      const state = await readOperations(storage, { now: at });
      at = Math.max(at + 180000, state.nextEligibleAt);
      return { result, state };
    },
    setTime(value) { at = value; },
  };
}

test('an isolated measured burst is amortized over real charges, without discounting the write budget', async () => {
  const f = fixture();
  for (let n = 0; n < 7; n++) await f.cycle(130);
  const { state } = await f.cycle(354);
  assert.equal(state.lastCycleRowsWritten, 354);
  assert.equal(state.budget.estimatedRowsWritten, 1344);
  assert.deepEqual(state.writePacing.samples, [...Array(7).fill(140), 364]);
  assert.equal(state.writePacing.meanRowsPerCycle, 168);
  assert.equal(state.cadenceSeconds, 182);
  assert.equal(state.stability.qualified, false);
});

test('sustained high measured costs still slow the collector beyond the stability gap', async () => {
  const f = fixture();
  let state;
  for (let n = 0; n < 9; n++) ({ state } = await f.cycle(354));
  assert.equal(state.writePacing.samples.length, 8);
  assert.equal(state.writePacing.meanRowsPerCycle, 364);
  assert.equal(state.cadenceSeconds, 394);
  assert.equal(state.stability.stableSince, state.lastSuccessAt);
  assert.equal(state.stability.qualified, false);
});

test('unknown costs contribute the conservative reservation to pacing and budget', async () => {
  const f = fixture();
  for (let n = 0; n < 7; n++) await f.cycle(130);
  const { state } = await f.cycle(null);
  assert.equal(state.writePacing.samples.at(-1), 2048);
  assert.equal(state.budget.estimatedRowsWritten, 3028);
  assert.equal(state.cadenceSeconds, 409);
});

test('a legacy journal starts with its first observed charge; no past samples are invented', async () => {
  const f = fixture();
  f.values.set('operations.v1', { schemaVersion: 1, completedCycles: 85, lastSuccessAt: start - 180000,
    stableSince: start - 3600000, lastCycleRowsWritten: 354,
    budget: { dayUtc: '2026-10-25', estimatedRowsWritten: 12469 } });
  const { state } = await f.cycle(130);
  assert.deepEqual(state.writePacing.samples, [140]);
  assert.equal(state.budget.estimatedRowsWritten, 12609);
  assert.equal(state.completedCycles, 86);
});

test('pacing samples reset at UTC midnight and survive a journal reload', async () => {
  const f = fixture();
  await f.cycle(354);
  f.setTime(Date.parse('2026-10-26T00:00:00Z'));
  const { state } = await f.cycle(100);
  assert.equal(state.writePacing.dayUtc, '2026-10-26');
  assert.deepEqual(state.writePacing.samples, [110]);
  assert.equal(state.budget.estimatedRowsWritten, 110);
  const reloaded = await readOperations(f.storage, { now: Date.parse('2026-10-26T00:00:01Z') });
  assert.deepEqual(reloaded.writePacing, state.writePacing);
});

test('a low rolling cost cannot bypass the hard daily preflight reservation', async () => {
  const f = fixture();
  for (let n = 0; n < 8; n++) await f.cycle(0);
  const journal = f.values.get('operations.v1');
  journal.budget.estimatedRowsWritten = 80000 - 2048 + 1;
  let calls = 0;
  const result = await runManagedCollection({ storage: f.storage, now: () => journal.nextEligibleAt,
    collect: async () => { calls++; return { status: 'COMPLETED', d1RowsWritten: 0 }; } });
  assert.equal(result.reason, 'D1_DAILY_WRITE_BUDGET');
  assert.equal(calls, 0);
  assert.equal((await readOperations(f.storage, { now: journal.nextEligibleAt })).stability.qualified, false);
});

test('the measured cost window is centrally configured and bounded', () => {
  assert.equal(OPERATIONS_CONFIG.collector.cadenceCostWindow, 8);
  for (const value of [0, -1, 65, 1.5, '8', null]) {
    const config = structuredClone(OPERATIONS_CONFIG);
    config.collector.cadenceCostWindow = value;
    assert.throws(() => validateOperationsConfig(config), /INVALID_OPERATIONS_CONFIG/);
  }
});
