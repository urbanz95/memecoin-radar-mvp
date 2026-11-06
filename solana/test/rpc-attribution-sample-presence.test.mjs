import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSamples } from '../scripts/pump-focused-smoke.mjs';

const buckets = [
  'enrichment_p0', 'enrichment_p1', 'enrichment_p2', 'enrichment_p3',
  'enrichment_unclassified', 'recovery', 'finality', 'security', 'other',
];

function snapshot(second) {
  const counters = { rpc_requests: 0 };
  for (const bucket of buckets) counters[`rpc_budget_${bucket}`] = 0;
  return {
    chain: 'solana', mode: 'READ_ONLY', status: 'OBSERVING',
    startedAt: '2026-11-06T00:00:00Z', programs: [{ protocol: 'pump_fun' }],
    metrics: {
      startedAt: '2026-11-06T00:00:00Z',
      measuredAt: new Date(Date.UTC(2026, 10, 6, 0, 0, second)).toISOString(),
      counters, gauges: {}, histograms: {},
    },
    storage: {},
  };
}

test('RPC accounting requires bucket presence in every sampled snapshot', () => {
  const samples = [snapshot(0), snapshot(10), snapshot(20)];
  assert.equal(summarizeSamples(samples).rpcAttribution.accountingComplete, true);
  delete samples[1].metrics.counters.rpc_budget_recovery;
  const report = summarizeSamples(samples);
  assert.equal(report.rpcAttribution.attempts, 0);
  assert.equal(report.rpcAttribution.attributedAttempts, 0);
  assert.equal(report.rpcAttribution.accountingComplete, false);
});

test('RPC accounting does not infer complete instrumentation from missing middle total', () => {
  const samples = [snapshot(0), snapshot(10), snapshot(20)];
  delete samples[1].metrics.counters.rpc_requests;
  assert.equal(summarizeSamples(samples).rpcAttribution.accountingComplete, false);
});
