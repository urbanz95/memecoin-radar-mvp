import test from 'node:test';
import assert from 'node:assert/strict';
import { publicReport } from '../src/cloudflare/public-report.mjs';

const now = Date.parse('2026-10-23T09:00:00Z');
const address = '0x1111111111111111111111111111111111111111';
const expires = new Date(now + 30000).toISOString();
const fixture = () => ({ runId: 'test-run', completedAt: new Date(now).toISOString(),
  observedHead: { timestamp: now / 1000, number: 1 }, operationalStatus: 'PARTIAL',
  snapshots: [{ address, synthetic: false }], results: [], alerts: [],
  screening: { entries: [{ address, pipeline: 'new', status: 'REVIEW', risks: [],
    signal: { kind: 'MARKET_ALERT', status: 'MARKET_ALERT', tradeApproved: false,
      observedAt: new Date(now).toISOString(), expiresAt: expires } }] } });

test('market alert and strict trade approval are independent availability states', () => {
  const report = fixture();
  const output = publicReport(report, now);
  assert.equal(output.marketSignalsAvailable, true);
  assert.equal(output.currentSignalsAvailable, false);
  assert.equal(output.signals.marketAlerts.length, 1);
  assert.equal(output.signals.tradeCandidates.length, 0);
  assert.equal(output.signals.summary.counts.MARKET_ALERT, 1);
  assert.equal(output.screening.entries[0].signal.tradeApproved, false);
});

test('a real current strict candidate is published and expires on read without another collection', () => {
  const report = fixture();
  report.results = [{ address, status: 'CANDIDATE', chain: 'robinhood', chainId: 4663, environment: 'mainnet',
    score: 80, minScore: 75, evaluatedAt: new Date(now).toISOString(), evidenceExpiresAt: expires }];
  report.alerts = [{ id: 'event', type: 'candidate', address }];
  const current = publicReport(report, now);
  assert.equal(current.currentSignalsAvailable, true);
  assert.equal(current.signals.tradeCandidates.length, 1);
  assert.equal(current.alerts.length, 1);
  const expired = publicReport(report, now + 30001);
  assert.equal(expired.currentSignalsAvailable, false);
  assert.equal(expired.marketSignalsAvailable, false);
  assert.equal(expired.screening.entries[0].signal.status, 'STALE');
  assert.equal(expired.signals.summary.marketAlerts, 0);
  assert.equal(expired.recordedResults[0].status, 'CANDIDATE');
  assert.equal(report.screening.entries[0].signal.status, 'MARKET_ALERT', 'read does not mutate archived evidence');
});

test('synthetic input, wrong chain, blocked tokens and incomplete assessments cannot become trade signals', () => {
  for (const change of ['synthetic', 'chain', 'blocked', 'incomplete', 'score']) {
    const report = fixture();
    report.results = [{ address, status: 'CANDIDATE', chain: 'robinhood', chainId: 4663, environment: 'mainnet',
      score: 80, minScore: 75, evaluatedAt: new Date(now).toISOString(), evidenceExpiresAt: expires }];
    if (change === 'synthetic') report.snapshots[0].synthetic = true;
    if (change === 'chain') report.results[0].chainId = 1;
    if (change === 'blocked') report.screening.entries[0].status = 'BLOCKED';
    if (change === 'incomplete') report.results[0].status = 'INCOMPLETE';
    if (change === 'score') report.results[0].score = 74;
    const output = publicReport(report, now);
    assert.equal(output.currentSignalsAvailable, false, change);
    if (change === 'blocked') assert.equal(output.marketSignalsAvailable, false);
  }
});

test('a stale or invalid chain head suppresses every current signal despite future expiries', () => {
  for (const timestamp of [now / 1000 - 61, now / 1000 + 31, undefined]) {
    const report = fixture(); report.observedHead.timestamp = timestamp;
    const output = publicReport(report, now);
    assert.equal(output.dataStale, true);
    assert.equal(output.marketSignalsAvailable, false);
    assert.equal(output.signals.marketAlerts.length, 0);
    assert.equal(output.screening.entries[0].signal.status, 'STALE');
  }
});
