import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNewToken, MVP_SCORE_VERSION } from '../src/mvp/pipeline.mjs';
import { fixture, DEMO_TIME } from '../examples/fixtures.mjs';

test('MVP reuses existing security evidence: observed mint risk rejects even without wallet history', () => {
  const snapshot = fixture(); snapshot.security.canMint = true;
  const result = evaluateNewToken(snapshot, {}, { now: DEMO_TIME });
  assert.equal(result.profile, 'profile_new');
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.security.status, 'REJECTED');
  assert.equal(result.score, null);
  assert.equal(result.alertEligible, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.synthetic, true);
  assert.equal(result.scoreVersion, MVP_SCORE_VERSION);
});

test('MVP missing provenance is incomplete rather than an assumed safe wallet or a fabricated PnL', () => {
  const snapshot = fixture();
  delete snapshot.holders; delete snapshot.quote;
  const result = evaluateNewToken(snapshot, {}, { now: DEMO_TIME });
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.securityComplete, false);
  assert.equal(result.walletsComplete, false);
  assert.equal(result.scoreComplete, false);
  assert.equal(result.score, null);
  assert.equal(result.wallets.score, null);
  assert.equal(result.wallets.realizedPnlUsd, null);
  assert.ok(result.gaps.some(gap => gap.code === 'WALLET_HISTORY_UNAVAILABLE'));
  assert.equal(result.alertEligible, false);
});

test('MVP leaves legacy snapshot and entry interfaces untouched', () => {
  const snapshot = fixture(); const entry = { symbol: 'Demo', age: { contractCreatedAt: snapshot.contractCreatedAt } };
  const before = structuredClone({ snapshot, entry });
  evaluateNewToken(snapshot, entry, { now: DEMO_TIME });
  assert.deepEqual({ snapshot, entry }, before);
});

test('Mode A excludes exact 24h boundary while preserving the recorded decision', () => {
  const snapshot = fixture(); snapshot.contractCreatedAt = new Date(DEMO_TIME - 86400000).toISOString();
  const result = evaluateNewToken(snapshot, {}, { now: DEMO_TIME });
  assert.equal(result.status, 'OUT_OF_SCOPE');
  assert.equal(result.alertEligible, false);
});

test('chart links use an exact external pair or parsed legacy pool identity, never an opaque path', () => {
  const pair = '0x' + '12'.repeat(20); const id = '0x' + 'ab'.repeat(32);
  assert.equal(evaluateNewToken(fixture(), { poolId: `v2:${pair}` }, { now: DEMO_TIME }).chartUrl,
    `https://dexscreener.com/robinhood/${pair}`);
  assert.equal(evaluateNewToken(fixture(), { poolId: `v4:${id}` }, { now: DEMO_TIME }).chartUrl,
    `https://dexscreener.com/robinhood/${id}`);
  assert.equal(evaluateNewToken(fixture(), { poolId: '../evil?key=secret' }, { now: DEMO_TIME }).chartUrl, null);
});
