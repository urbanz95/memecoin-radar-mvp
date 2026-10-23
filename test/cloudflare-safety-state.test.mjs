import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeSafetyFocus, nextSafetyFocus, findSafetyState, saveSafetyState, mergeSafetySnapshots, pendingSafetyPool } from '../src/cloudflare/safety-state.mjs';

const now = Date.parse('2026-10-22T18:00:00Z');
const address = n => '0x' + n.toString(16).padStart(40, '0');
const pool = { id: 'v2:' + address(3), type: 'v2', token0: address(1), token1: address(2), createdBlock: 10 };
test('security phases finish after three observations, expired focus cannot monopolize selection', () => {
  const first = nextSafetyFocus(pool, 0, null, now);
  assert.equal(resumeSafetyFocus(first, now + 60000).phase, 1);
  const second = nextSafetyFocus(pool, 1, first.startedAt, now + 60000);
  assert.equal(second.phase, 2);
  assert.equal(nextSafetyFocus(pool, 2, first.startedAt, now + 120000), null);
  assert.equal(resumeSafetyFocus(second, now + 7 * 3600000), null);
  assert.equal(resumeSafetyFocus({ ...first, pool: { ...pool, token0: 'bad' } }, now), null);
});

test('unfinished holder scans receive automatic retries while one in three focus groups remains open to new tokens', () => {
  const pending = { pool, holderState: { nextBlock: 1 }, updatedAt: new Date(now).toISOString(),
    assessments: { holders: { coverage: { distributionComplete: false } } } };
  const complete = { ...pending, pool: { ...pool, id: 'complete' },
    assessments: { holders: { coverage: { distributionComplete: true } } } };
  assert.equal(pendingSafetyPool([complete, pending], 1, now), null);
  assert.deepEqual(pendingSafetyPool([complete, pending], 4, now), pool);
  assert.deepEqual(pendingSafetyPool([complete, pending], 7, now), pool);
  assert.equal(pendingSafetyPool([complete, pending], 10, now), null);
  assert.equal(pendingSafetyPool([complete], 4, now), null);
  assert.equal(pendingSafetyPool([pending], 4, now + 7 * 3600000), null);
});

test('native ETH v4 focus resumes across security phases without allowing zero token contracts elsewhere', () => {
  const native = { ...pool, type: 'v4', token0: '0x' + '0'.repeat(40) };
  assert.equal(resumeSafetyFocus(nextSafetyFocus(native, 0, null, now), now + 60000).phase, 1);
  assert.equal(resumeSafetyFocus(nextSafetyFocus({ ...native, type: 'v3' }, 0, null, now), now), null);
  assert.equal(resumeSafetyFocus(nextSafetyFocus({ ...native, token1: native.token0 }, 0, null, now), now), null);
});

test('proven risk measurements persist across phases with their original timestamps and expire at policy ages', () => {
  const checkedAt = new Date(now).toISOString();
  const previous = { holders: { checkedAt, top1Pct: 80 }, security: { checkedAt, source: 'sim', buyTaxPct: 2,
    honeypotDetected: false, canMint: false } };
  const reused = mergeSafetySnapshots(previous, {}, now + 120000);
  assert.equal(reused.holders.checkedAt, checkedAt);
  assert.equal(reused.holders.top1Pct, 80);
  assert.equal(reused.security.buyTaxPct, 2);
  assert.equal(reused.security.honeypotDetected, undefined);
  assert.equal(reused.security.canMint, undefined);
  assert.equal(mergeSafetySnapshots(previous, {}, now + 301000).holders, undefined);
  assert.equal(mergeSafetySnapshots(previous, {}, now + 601000).security, undefined);
  assert.equal(mergeSafetySnapshots(previous, {}, now - 1000).holders, undefined);
});
test('holder progress is reused only for the same runtime and pool and is bounded independently', () => {
  const entry = n => ({ address: address(n), poolId: pool.id, codeHash: 'hash1', updatedAt: new Date(now).toISOString(), holderState: { data: 'x'.repeat(15000) } });
  let states = [];
  for (let n = 1; n <= 20; n++) states = saveSafetyState(states, entry(n), now);
  assert.ok(Buffer.byteLength(JSON.stringify(states)) <= 524288);
  assert.ok(states.length <= 12);
  assert.ok(findSafetyState(states, address(20), pool.id, 'hash1', now));
  assert.equal(findSafetyState(states, address(20), pool.id, 'different-runtime', now), null);
  assert.equal(findSafetyState(states, address(20), 'different-pool', 'hash1', now), null);
  assert.equal(findSafetyState(states, address(20), pool.id, 'hash1', now + 7 * 3600000), null);
  states = saveSafetyState(states, { ...entry(20), holderState: { data: 'x'.repeat(200000) } }, now);
  assert.equal(states.some(value => value.address === address(20)), false);
});
