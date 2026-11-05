import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, summarizeSamples } from '../scripts/pump-focused-smoke.mjs';

function sample(at) {
  return {
    chain: 'solana', mode: 'READ_ONLY', status: 'OBSERVING',
    startedAt: '2026-11-05T12:00:00Z',
    programs: [{ protocol: 'pump_fun' }, { protocol: 'pump_swap' }],
    metrics: {
      startedAt: '2026-11-05T12:00:00Z', measuredAt: at,
      counters: {
        notificationsReceived: 100, logObservationsPersisted: 80,
        rpc_requests: 10, transactionsProcessed: 5, contextEnrichmentSkipped: 30,
      },
      gauges: {
        websocket_connected: true, durableBacklog: 2, coverageOverloaded: false,
      },
      histograms: {
        logObservationLatencyMs: {
          count: 40, retainedSamples: 40, p50: 120, p95: 300, p99: 500,
        },
      },
    },
    storage: {
      pending: 2, deferred: 1, events: 3,
      event_observations: 80, gaps: 0, storageBytes: 1000,
    },
  };
}

test('local-only arguments reject remote, credentialed and non-health URLs', () => {
  assert.equal(parseArgs([]).seconds, 180);
  assert.equal(parseArgs(['--seconds', '45', '--interval', '5']).interval, 5);
  for (const url of [
    'https://127.0.0.1:8791/health',
    'http://evil.example/health',
    'http://user:pass@localhost:8791/health',
    'http://localhost:8791/events',
    'http://localhost:8791/health?secret=1',
  ]) {
    assert.throws(() => parseArgs(['--url', url]), /HEALTH_URL_MUST_BE_LOOPBACK/);
  }
  assert.throws(() => parseArgs(['--seconds', '15']), /INVALID_SECONDS/);
  assert.throws(() => parseArgs(['--interval', '61']), /INVALID_INTERVAL/);
  assert.throws(() => parseArgs(['--unexpected']), /UNKNOWN_ARGUMENT/);
});

test('window counter deltas remain distinct from retained rows and process histograms', () => {
  const first = sample('2026-11-05T12:00:00Z');
  const last = sample('2026-11-05T12:01:00Z');
  last.metrics.counters = {
    ...last.metrics.counters,
    notificationsReceived: 700, logObservationsPersisted: 330,
    rpc_requests: 22, transactionsProcessed: 11, contextEnrichmentSkipped: 200,
  };
  last.metrics.histograms.logObservationLatencyMs.count = 500;
  last.storage.event_observations = 50; // retention may prune previously held rows
  const report = summarizeSamples([first, last]);
  assert.equal(report.elapsedSeconds, 60);
  assert.equal(report.counterDeltas.notificationsReceived, 600);
  assert.equal(report.windowRates.notificationsPerSecond, 10);
  assert.equal(report.windowRates.enrichedTransactionsPerMinute, 6);
  assert.equal(report.windowRates.rpcRequestsPerEnrichedTransaction, 2);
  assert.equal(report.lastStorage.logObservationsRetained, 50);
  assert.equal(report.latencyAtEnd.logObservationLatencyMs.p95Ms, 300);
  assert.match(report.latencyAtEnd.logObservationLatencyMs.scope, /NOT a per-window/);
  assert.equal(report.reliability.degradedSamples, 0);
  assert.equal(report.reliability.overloadedSamples, 0);
  assert.equal(report.reliability.disconnectedSamples, 0);
  assert.equal(report.reliability.recoveryGapDelta, 0);
  assert.equal(report.reliability.decoderFailureDelta, 0);
});

test('restarts, counter resets and missing samples cannot yield a misleading report', () => {
  const first = sample('2026-11-05T12:00:00Z');
  const last = sample('2026-11-05T12:00:30Z');
  assert.throws(() => summarizeSamples([first]), /INSUFFICIENT/);
  assert.throws(() => summarizeSamples([
    first, { ...last, startedAt: '2026-11-05T12:00:15Z' },
  ]), /SCANNER_RESTARTED/);
  last.metrics.counters.notificationsReceived = 80;
  assert.throws(() => summarizeSamples([first, last]), /COUNTER_RESET/);
});

test('no enriched transactions produces null rather than infinite cost ratio', () => {
  const first = sample('2026-11-05T12:00:00Z');
  const last = sample('2026-11-05T12:00:45Z');
  last.metrics.counters.rpc_requests = 12;
  assert.equal(
    summarizeSamples([first, last]).windowRates.rpcRequestsPerEnrichedTransaction,
    null,
  );
});

test('smoke report counts overload and degraded evidence without claiming full coverage', () => {
  const first = sample('2026-11-05T12:00:00Z');
  const middle = sample('2026-11-05T12:00:10Z');
  const last = sample('2026-11-05T12:00:20Z');
  middle.status = 'DEGRADED';
  middle.metrics.gauges.coverageOverloaded = true;
  middle.metrics.gauges.websocket_connected = false;
  last.status = 'DEGRADED';
  last.metrics.gauges.coverageOverloaded = true;
  middle.metrics.counters.recoveryGaps = 1;
  last.metrics.counters.recoveryGaps = 2;
  middle.metrics.counters.logDecoderFailures = 1;
  last.metrics.counters.logDecoderFailures = 3;
  const report = summarizeSamples([first, middle, last]);
  assert.equal(report.reliability.degradedSamples, 2);
  assert.equal(report.reliability.overloadedSamples, 2);
  assert.equal(report.reliability.disconnectedSamples, 1);
  assert.equal(report.reliability.recoveryGapDelta, 2);
  assert.equal(report.reliability.decoderFailureDelta, 3);
  assert.equal(report.coverage, 'PARTIAL');
});

test('smoke rejects changes in subscribed protocols and non-monotonic health snapshots', () => {
  const first = sample('2026-11-05T12:00:00Z');
  const middle = sample('2026-11-05T12:00:10Z');
  const last = sample('2026-11-05T12:00:20Z');
  middle.programs = [{ protocol: 'pump_fun' }];
  assert.throws(
    () => summarizeSamples([first, middle, last]),
    /PROGRAM_SCOPE_CHANGED_DURING_SMOKE/,
  );
  middle.programs = [...first.programs].reverse();
  assert.doesNotThrow(() => summarizeSamples([first, middle, last]));
  middle.metrics.measuredAt = first.metrics.measuredAt;
  assert.throws(
    () => summarizeSamples([first, middle, last]),
    /NON_MONOTONIC_HEALTH_TIMESTAMPS/,
  );
  middle.metrics.measuredAt = '2026-11-05T12:00:30Z';
  assert.throws(
    () => summarizeSamples([first, middle, last]),
    /NON_MONOTONIC_HEALTH_TIMESTAMPS/,
  );
});

test('context admission reports observed skip causes without inventing uninstrumented data', () => {
  const first = sample('2026-11-05T12:00:00Z');
  const last = sample('2026-11-05T12:01:00Z');
  first.metrics.counters.contextSkippedDurableBacklog = 10;
  first.metrics.counters.contextSkippedIngressBuffer = 20;
  last.metrics.counters.contextEnrichmentSkipped = 50;
  last.metrics.counters.contextSkippedDurableBacklog = 22;
  last.metrics.counters.contextSkippedIngressBuffer = 38;
  const complete = summarizeSamples([first, last]).contextAdmission;
  assert.equal(complete.skippedTotal, 20);
  assert.equal(complete.skippedDurableBacklog, 12);
  assert.equal(complete.skippedIngressBuffer, 18);
  assert.equal(complete.unattributedSkips, 0);
  assert.equal(complete.causeAccountingComplete, false); // causes exceed aggregate
  last.metrics.counters.contextEnrichmentSkipped = 60;
  assert.equal(summarizeSamples([first, last]).contextAdmission.causeAccountingComplete, true);
  delete first.metrics.counters.contextSkippedDurableBacklog;
  delete first.metrics.counters.contextSkippedIngressBuffer;
  assert.equal(summarizeSamples([first, last]).contextAdmission.causeAccountingComplete, false);
});

test('priority reservation skips are a distinct complete admission cause', () => {
  const first = sample('2026-11-05T12:00:00Z');
  const last = sample('2026-11-05T12:01:00Z');
  for (const s of [first, last]) {
    s.metrics.counters.contextSkippedDurableBacklog = 0;
    s.metrics.counters.contextSkippedIngressBuffer = 0;
    s.metrics.counters.contextSkippedPriorityReservation = 10;
  }
  last.metrics.counters.contextEnrichmentSkipped = 70;
  last.metrics.counters.contextSkippedPriorityReservation = 50;
  const report = summarizeSamples([first, last]).contextAdmission;
  assert.equal(report.skippedTotal, 40);
  assert.equal(report.skippedPriorityReservation, 40);
  assert.equal(report.skippedIngressBuffer, 0);
  assert.equal(report.skippedDurableBacklog, 0);
  assert.equal(report.unattributedSkips, 0);
  assert.equal(report.causeAccountingComplete, true);
  delete first.metrics.counters.contextSkippedPriorityReservation;
  assert.equal(summarizeSamples([first, last]).contextAdmission.causeAccountingComplete, false);
});
