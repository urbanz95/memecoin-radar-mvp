import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverageDiagnostics } from '../src/coverage-diagnostics.mjs';
import { Scanner } from '../src/scanner.mjs';
import { Store } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { PROGRAMS } from '../src/protocols/index.mjs';

const programs = PROGRAMS.filter(p =>
  ['pump_fun', 'pump_swap'].includes(p.protocol));

test('coverage evidence has no fake percentage, no signatures, and stable protocol counters', () => {
  const store = new Store(':memory:');
  try {
    const streams = new Map([
      ['pump_fun', { notifications: 8, decodedEvents: 12, decoderAlerts: 3,
        firstLogAt: '2026-11-09T00:00:00.000Z',
        lastLogAt: '2026-11-09T00:01:00.000Z', lastSlot: 123 }],
    ]);
    const metrics = {
      counters: { notificationsReceived: 8, logObservationsDecoded: 12,
        logObservationsPersisted: 9, recoveryGaps: 2 },
      gauges: { 'recovery.pump_fun': { complete: false, pages: 1,
        selected: 2, gap: 'HISTORY_RECOVERY_PENDING', continuation: true } },
      histograms: { logObservationLatencyMs: { p95: 25 } },
    };
    store.advanceCheckpoint(programs[0].programId, {
      signature: 'signature-must-not-be-exposed', slot: 100,
      continuity: 'PARTIAL',
    });
    store.saveRecoveryState(programs[0].programId, {
      before: 'secret-cursor', head: { signature: 'secret-head', slot: 123 },
    });
    const result = buildCoverageDiagnostics({
      programs, streams, metrics, store, storage: { pending: 4 },
      config: { requestsPerMinute: 12, contextMaxPriority: 0 },
      now: Date.parse('2026-11-09T00:02:00.000Z'),
    });
    assert.equal(result.status, 'PARTIAL_UNQUANTIFIED');
    assert.equal(result.networkWideCompletenessPercent, null);
    assert.equal(result.independentExpectedEventCount, null);
    assert.equal(result.rpcRequestsPerMinuteBudget, 12);
    assert.equal(result.pendingContextTransactions, 4);
    assert.equal(result.persistedLogEvents, 9);
    assert.equal(result.programs[0].logNotificationsSeen, 8);
    assert.equal(result.programs[0].secondsSinceLastLog, 60);
    assert.equal(result.programs[0].lastRecovery.gap, 'HISTORY_RECOVERY_PENDING');
    assert.equal(result.programs[0].recoveryCursorPending, true);
    assert.equal(result.programs[1].logNotificationsSeen, 0);
    assert.equal(result.programs[1].secondsSinceLastLog, null);
    assert.ok(!JSON.stringify(result).includes('signature-must-not-be-exposed'));
    assert.ok(!JSON.stringify(result).includes('secret-cursor'));
    assert.ok(!JSON.stringify(result).includes('secret-head'));
  } finally { store.close(); }
});

test('recovery errors are bounded diagnostics, not claims of lost transactions', () => {
  const result = buildCoverageDiagnostics({
    programs: [programs[0]], streams: new Map(),
    metrics: { counters: { recoveryGaps: 17, rate_limit_errors: 4 },
      gauges: { 'recovery.pump_fun': {
        gap: 'sensitive/raw_error/never_expose', pages: 0,
      } } },
    store: { checkpoint: () => null, recoveryState: () => null },
    config: { requestsPerMinute: 12 },
  });
  assert.equal(result.programs[0].lastRecovery.gap, null);
  assert.equal(result.recoveryGapsReported, 17);
  assert.equal(result.rpcRateLimitErrors, 4);
  assert.equal(result.networkWideCompletenessPercent, null);
});

test('scanner accepts each valid protocol log into bounded per-program coverage diagnostics', async t => {
  const store = new Store(':memory:');
  const config = loadConfig({ SOLANA_PROGRAMS: 'pump_fun,pump_swap' });
  const rpc = { request: async () => [], close: async () => {} };
  const scanner = new Scanner(config, { rpc, store });
  t.after(async () => scanner.stop());
  scanner.receive({
    signature: 'example-no-real-trade', slot: 12345,
    programId: programs[0].programId,
    receivedAt: '2026-11-09T00:00:00.000Z', logs: [],
  });
  const health = scanner.health();
  assert.equal(health.coverage, 'PARTIAL');
  assert.equal(health.coverageDiagnostics.networkWideCompletenessPercent, null);
  assert.equal(health.coverageDiagnostics.programs[0].logNotificationsSeen, 1);
  assert.equal(health.coverageDiagnostics.programs[1].logNotificationsSeen, 0);
  assert.equal(health.coverageDiagnostics.programs[0].lastObservedSlot, 12345);
  assert.equal(health.coverageDiagnostics.totalNotificationsSeen, 1);
});

test('recoveries alternate Pump.fun and PumpSwap first without increasing page budgets', async t => {
  const store = new Store(':memory:');
  const config = loadConfig({
    SOLANA_PROGRAMS: 'pump_fun,pump_swap',
    SOLANA_RECOVERY_PAGE_SIZE: '2',
    SOLANA_RECOVERY_MAX_PAGES: '1',
  });
  const calls = [];
  const rpc = {
    request: async (method, params) => {
      assert.equal(method, 'getSignaturesForAddress');
      assert.equal(params[1].limit, 2);
      calls.push(params[0]);
      return [];
    },
    close: async () => {},
  };
  const scanner = new Scanner(config, { rpc, store });
  t.after(async () => scanner.stop());
  scanner.recoveryPending = true;
  await scanner.tickRecovery();
  scanner.recoveryPending = true;
  await scanner.tickRecovery();
  assert.deepEqual(calls, [
    programs[0].programId, programs[1].programId,
    programs[1].programId, programs[0].programId,
  ]);
  assert.equal(scanner.health().metrics.gauges.recoveryFirstProtocol, 'pump_swap');
  assert.equal(scanner.health().coverageDiagnostics.rpcRequestsPerMinuteBudget, 60);
});
