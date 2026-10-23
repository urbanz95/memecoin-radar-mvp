import test from 'node:test';
import assert from 'node:assert/strict';
import policy from '../config/policies.json' with { type: 'json' };
import { fixture, DEMO_TIME } from '../examples/fixtures.mjs';
import { runScan } from '../src/runner.mjs';
import { publicReport } from '../src/cloudflare/public-report.mjs';

test('legacy scanner keeps candidate event format and full-batch empty-input semantics', () => {
  let state = {}; let report;
  for (const seconds of [0, 60, 120]) {
    const now = DEMO_TIME + seconds * 1000;
    report = runScan([fixture('new', now)], policy, { now, state, pipelines: ['new'] });
    state = report.state;
  }
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.results[0].status, 'CANDIDATE');
  assert.equal(report.alerts[0].type, 'candidate');
  assert.equal(report.alerts[0].pipeline, 'new');
  assert.equal(report.alerts[0].dataMode, 'synthetic');
  assert.equal(report.alerts[0].address, fixture().address);
  assert.match(report.alerts[0].id, /^[a-f0-9]{64}:/);
  const empty = runScan([], policy, { now: DEMO_TIME + 180000, state });
  assert.deepEqual(empty.state, {});
  assert.deepEqual(empty.alerts, []);
});

test('legacy public report preserves observations, results and safety failures without MVP metadata', () => {
  const snapshot = fixture(); snapshot.security.canBlacklist = true;
  const scan = runScan([snapshot], policy, { now: DEMO_TIME });
  const report = { runId: 'legacy', completedAt: new Date(DEMO_TIME).toISOString(),
    observedHead: { number: snapshot.chainState.blockNumber, timestamp: DEMO_TIME / 1000 },
    operationalStatus: 'PARTIAL', snapshots: [snapshot], results: scan.results, errors: [] };
  const output = publicReport(report, DEMO_TIME);
  assert.equal(output.runId, report.runId);
  assert.deepEqual(output.observations, report.snapshots);
  assert.deepEqual(output.recordedResults, scan.results);
  assert.deepEqual(Object.fromEntries(output.recordedResults.map(value => [value.pipeline, value.status])),
    { new: 'BLOCKED', established: 'OUT_OF_SCOPE' });
  assert.equal(output.currentSignalsAvailable, false);
  assert.equal(output.mvp, undefined);
});
