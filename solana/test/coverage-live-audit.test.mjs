import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeHealth, summarizeRadar, analyzeSnapshots
} from '../scripts/coverage-live-audit.mjs';

const at = '2026-11-09T01:18:00.000Z';
const makeHealth = (overrides = {}) => ({
  chain: 'solana',
  mode: 'READ_ONLY',
  coverage: 'PARTIAL',
  status: 'OBSERVING',
  startedAt: at,
  metrics: {
    uptimeMs: 120000,
    gauges: { websocket_connected: true },
    counters: { websocket_disconnects: 0 }
  },
  backup: { enabled: true, operational: true, successes: 1, attempts: 1,
    lastSuccessfulAt: at, lastErrorCode: null },
  storage: { pending: 3 },
  logStream: { noRecentLogs: false, lastObservedAt: at },
  coverageDiagnostics: {
    status: 'PARTIAL_UNQUANTIFIED',
    networkWideCompletenessPercent: null,
    totalNotificationsSeen: 20,
    decodedLogEvents: 10,
    persistedLogEvents: 9,
    decoderFailures: 0,
    contextEnrichmentSkipped: 18,
    rpcRateLimitErrors: 0,
    recoveryGapsReported: 1,
    persistenceFailures: 0,
    pendingContextTransactions: 3,
    programs: [
      { protocol: 'pump_fun', logNotificationsSeen: 19, logEventsDecoded: 9,
        decoderAlerts: 0, lastLogAt: at, secondsSinceLastLog: 3,
        checkpointPresent: true, checkpointContinuity: 'PARTIAL',
        recoveryCursorPending: true, lastRecovery: {
          complete: false, gap: 'HISTORY_RECOVERY_PENDING', pagesRequested: 1
        } },
      { protocol: 'pump_swap', logNotificationsSeen: 1, logEventsDecoded: 1,
        decoderAlerts: 0, lastLogAt: at, secondsSinceLastLog: 50,
        checkpointPresent: false, checkpointContinuity: null,
        recoveryCursorPending: false, lastRecovery: null },
    ],
  },
  sensitiveNewField: { secret: 'NEVER_LEAK_SECRET' },
  ...overrides,
});
const radar = {
  kind: 'SOLANA_PUMP_RADAR_MVP', coverage: 'PARTIAL',
  sample: { timeWindowSeconds: 300, rowsInspected: 44,
    verifiedUniqueEvents: 23, possibleTruncation: false },
  totals: { observedDistinctMints: 6 },
  candidates: [{ mint: 'PRIVATE_MINT_IN_TEST' }],
};

test('live audit accepts expected health while omitting all private/transaction fields', () => {
  const h = summarizeHealth(makeHealth(), at);
  assert.equal(h.coverage, 'PARTIAL_UNQUANTIFIED');
  assert.equal(h.notifications, 20);
  assert.equal(h.programs[0].checkpointContinuity, 'PARTIAL');
  assert.equal(h.backup.successes, 1);
  assert.equal(h.programs[1].notifications, 1);
  assert.ok(!JSON.stringify(h).includes('NEVER_LEAK_SECRET'));
  assert.ok(!JSON.stringify(h).includes('sensitiveNewField'));
});

test('invalid coverage status and false percentage fail closed', () => {
  assert.throws(() => summarizeHealth(makeHealth({ coverage: 'FULL' })),
    /INVALID_COVERAGE_HEALTH_SCHEMA/);
  assert.throws(() => summarizeHealth(makeHealth({
    coverageDiagnostics: {
      ...makeHealth().coverageDiagnostics,
      networkWideCompletenessPercent: 100,
    },
  })), /INVALID_COVERAGE_HEALTH_SCHEMA/);
  assert.throws(() => summarizeHealth(makeHealth({
    coverageDiagnostics: {
      ...makeHealth().coverageDiagnostics,
      programs: [{ protocol: 'pump_fun' }],
    },
  })), /EXPECTED_PROTOCOL_MISSING/);
});

test('radar summary preserves truncation and excludes candidate mint identities', () => {
  const result = summarizeRadar(radar);
  assert.equal(result.rowsInspected, 44);
  assert.equal(result.verifiedUniqueEvents, 23);
  assert.equal(result.possibleTruncation, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_MINT_IN_TEST'));
});

test('two samples calculate process-local deltas, never claim network-wide coverage', () => {
  const a = summarizeHealth(makeHealth());
  const b = summarizeHealth(makeHealth({
    coverageDiagnostics: {
      ...makeHealth().coverageDiagnostics,
      totalNotificationsSeen: 25, decodedLogEvents: 14, persistedLogEvents: 12,
      programs: [
        { ...makeHealth().coverageDiagnostics.programs[0],
          logNotificationsSeen: 24, logEventsDecoded: 13 },
        makeHealth().coverageDiagnostics.programs[1]
      ],
    },
  }));
  const result = analyzeSnapshots(a, b, summarizeRadar(radar), summarizeRadar(radar));
  assert.equal(result.sameProcess, true);
  assert.equal(result.delta.notifications, 5);
  assert.equal(result.delta.decodedEvents, 4);
  assert.equal(result.delta.persistedEvents, 3);
  assert.equal(result.delta.programs[0].notifications, 5);
  assert.equal(result.delta.programs[1].notifications, 0);
  assert.equal(result.observedCoveragePercent, null);
  assert.equal(result.independentExpectedEventCount, null);
  assert.equal(result.observationsGrowing, true);
});

test('cross-restart counts are not subtracted and stale/no activity is marked', () => {
  const a = summarizeHealth(makeHealth());
  const b = summarizeHealth(makeHealth({
    startedAt: '2026-11-09T01:19:00.000Z',
    metrics: { uptimeMs: 4000,
      gauges: { websocket_connected: false }, counters: {} },
    logStream: { noRecentLogs: true, lastObservedAt: null },
  }));
  const summary = analyzeSnapshots(a, b, summarizeRadar(radar),
    summarizeRadar({ ...radar, sample: {
      ...radar.sample, possibleTruncation: true } }));
  assert.equal(summary.sameProcess, false);
  assert.equal(summary.delta, null);
  assert.ok(summary.warnings.includes('SCANNER_RESTART_BETWEEN_SAMPLES'));
  assert.ok(summary.warnings.includes('WEBSOCKET_NOT_CONFIRMED'));
  assert.ok(summary.warnings.includes('NO_RECENT_LOGS'));
  assert.ok(summary.warnings.includes('RADAR_WINDOW_MAY_BE_TRUNCATED'));
  assert.equal(summary.observedCoveragePercent, null);
});
