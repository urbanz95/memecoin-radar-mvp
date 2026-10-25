import test from 'node:test';
import assert from 'node:assert/strict';
import { attachObservedWalletClusters } from '../src/mvp/wallet-cluster-runtime.mjs';
const W = n => '0x' + n.toString(16).padStart(40, '0');
const H = n => '0x' + n.toString(16).padStart(64, '0');
const now = Date.parse('2026-10-25T12:00:00Z');
const profiles = () => [1, 2].map(n => ({ walletAddress: W(n), clusteringComplete: true,
  riskFlags: { insider: false, bundler: false, washTrading: false },
  tokenEntries: [{ tokenAddress: W(20), clusterId: `fixture:independent-${n}`, clusteringComplete: true }] }));
const transfer = amount => ({ kind: 'TRANSFER', chainId: 4663, args: { from: W(1), to: W(2), value: amount },
  blockNumber: 100, blockHash: H(100), transactionHash: H(10), logIndex: 1 });

test('observed direct coordination collapses groups and cannot preserve a contradictory independence claim', () => {
  const result = attachObservedWalletClusters(profiles(), { now, events: [transfer('10')] });
  assert.equal(result.counts.coordinatedGroups, 1);
  assert.equal(result.profiles[0].tokenEntries[0].clusterId, result.profiles[1].tokenEntries[0].clusterId);
  assert.ok(result.profiles.every(profile => !profile.clusteringComplete));
  assert.ok(result.profiles.every(profile => profile.riskFlags.insider === false), 'coordination alone does not assert insider fraud');
});

test('zero-value dust cannot overwrite existing valid cluster interfaces', () => {
  const input = profiles();
  const result = attachObservedWalletClusters(input, { now, events: [transfer('0')] });
  assert.equal(result.counts.coordinatedGroups, 0);
  assert.deepEqual(result.profiles.map(profile => profile.tokenEntries), input.map(profile => profile.tokenEntries));
  assert.ok(result.profiles.every(profile => profile.clusteringComplete));
});

test('an unknown graph cannot turn unknown risks into clean flags or remove positive risks', () => {
  const input = profiles(); input[0].riskFlags = null; input[1].riskFlags.insider = true;
  const result = attachObservedWalletClusters(input, { now });
  assert.deepEqual(result.profiles[0].riskFlags, { insider: null, bundler: null, washTrading: null });
  assert.equal(result.profiles[1].riskFlags.insider, true);
});
