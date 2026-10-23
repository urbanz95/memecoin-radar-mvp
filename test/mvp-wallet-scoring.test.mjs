import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreWalletProfile, aggregateWalletSignal, scoreLaunchMomentum, scoreNewProfile } from '../src/mvp/wallet-scoring.mjs';
import profiles, { validateProfiles } from '../src/mvp/config.mjs';

const NOW = Date.parse('2026-10-23T15:00:00Z');
const addr = number => '0x' + BigInt(number).toString(16).padStart(40, '0');
const hash = number => '0x' + BigInt(number).toString(16).padStart(64, '0');
const iso = time => new Date(time).toISOString();
const TOKEN = addr(100);
function profile(wallet = addr(1), changes = {}) {
  return { chainId: 4663, walletAddress: wallet, checkedAt: iso(NOW), source: 'synthetic-fifo-proof', evidence: ['fixture:full-accounting'],
    historyComplete: true, costsComplete: true, feesComplete: true, attributionComplete: true, clusteringComplete: true,
    realizedTradeCount: 5, netRealizedPnlUsd: '1000', winRatePct: 70, avgHoldingSeconds: 300,
    earlyEntryPct: 70, maxDrawdownPct: 0, lastRealizedAt: iso(NOW),
    riskFlags: { insider: false, bundler: false, washTrading: false }, ...changes };
}
const score = value => scoreWalletProfile(value, { now: NOW });
function entry(wallet, cluster = 'group-a', changes = {}) {
  return { chainId: 4663, tokenAddress: TOKEN, walletAddress: wallet, observedAt: iso(NOW), source: 'synthetic-receipt-settlement',
    evidence: ['fixture:receipt-and-transfer'], attributionVerified: true, entryType: 'buy', firstEntryAt: iso(NOW - 60000),
    earlyEntry: true, clusterId: cluster, clusteringComplete: true, clusterEvidence: ['fixture:complete-cluster-analysis'], ...changes };
}
const aggregate = (scored, entries) => aggregateWalletSignal(scored, { tokenAddress: TOKEN, entries, now: NOW });
function observation(time, number, holders, liquidity, changes = {}) {
  return { chainId: 4663, address: TOKEN, observedAt: iso(time), source: 'synthetic-canonical-momentum',
    evidence: ['fixture:canonical-header', 'fixture:holders-proof', 'fixture:market-proof'], canonical: true,
    holdersCount: holders, liquidityUsd: liquidity, holdersComplete: true, holdersCheckedAt: iso(time), liquidityFetchedAt: iso(time),
    blockNumber: number, blockHash: hash(number), pairAddress: addr(200), ...changes };
}
const momentum = observations => scoreLaunchMomentum(observations, { now: NOW });

test('reliable FIFO profile with five realized trades receives a bounded manual score and preserves decimal PnL', () => {
  const result = score(profile());
  assert.equal(result.status, 'ELIGIBLE'); assert.equal(result.eligible, true); assert.equal(result.score, 100);
  assert.equal(result.walletAddress, addr(1)); assert.equal(result.realizedTradeCount, 5);
  assert.equal(result.features.netRealizedPnlUsd, '1000');
  assert.equal(result.evidenceExpiresAt, iso(NOW + 600000));
});

test('missing history, cost, fees, attribution, clustering or risk analysis never becomes score zero or eligibility', () => {
  for (const field of ['historyComplete', 'costsComplete', 'feesComplete', 'attributionComplete', 'clusteringComplete']) {
    const result = score(profile(addr(1), { [field]: false }));
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.score, null); assert.equal(result.eligible, false);
  }
  assert.equal(score(profile(addr(1), { riskFlags: null })).score, null);
  assert.equal(score(profile(addr(1), { riskFlags: [] })).score, null);
  assert.equal(score(profile(addr(1), { netRealizedPnlUsd: null })).score, null);
});

test('confirmed insiders, bundlers or wash traders are excluded even when other profile fields are missing', () => {
  for (const flag of ['insider', 'bundler', 'washTrading']) {
    const value = profile(addr(1), { historyComplete: false }); value.riskFlags[flag] = true;
    const result = score(value);
    assert.equal(result.status, 'EXCLUDED'); assert.equal(result.score, 0); assert.equal(result.eligible, false);
  }
});

test('fewer than five realized trades, non-positive net PnL or low decayed score cannot qualify', () => {
  assert.equal(score(profile(addr(1), { realizedTradeCount: 4 })).status, 'INELIGIBLE');
  for (const pnl of ['0', '-0.000000000000000001', '-100']) assert.equal(score(profile(addr(1), { netRealizedPnlUsd: pnl })).status, 'INELIGIBLE');
  const old = score(profile(addr(1), { lastRealizedAt: iso(NOW - 30 * 86400000) }));
  assert.equal(old.score, 50); assert.equal(old.status, 'INELIGIBLE');
  const recentRefresh = score(profile(addr(1), { checkedAt: iso(NOW), lastRealizedAt: iso(NOW - 30 * 86400000) }));
  assert.equal(recentRefresh.score, old.score, 'refreshing a profile cannot reset its trading recency');
});

test('PnL accepts fixed decimal strings only and caps before finite numeric conversion', () => {
  for (const pnl of [1000, NaN, '1e3', '', 'Infinity', '--1']) assert.equal(score(profile(addr(1), { netRealizedPnlUsd: pnl })).status, 'INCOMPLETE');
  const huge = score(profile(addr(1), { netRealizedPnlUsd: '9'.repeat(78) }));
  assert.equal(huge.score, 100); assert.equal(huge.features.netRealizedPnlUsd, '9'.repeat(78));
});

test('wrong identities, future timestamps and stale profiles cannot contribute a wallet score', () => {
  for (const changes of [{ chainId: 46630 }, { walletAddress: '0x123' }, { source: '' }, { evidence: [] },
    { checkedAt: iso(NOW - 601000) }, { checkedAt: iso(NOW + 31000) }, { lastRealizedAt: iso(NOW + 1000) }]) {
    const result = score(profile(addr(1), changes)); assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.score, null);
  }
});

test('coordinated wallets count as one group and duplicate trades cannot increase independent evidence', () => {
  const scored = [addr(1), addr(2), addr(3)].map(wallet => score(profile(wallet)));
  const entries = [entry(addr(1)), entry(addr(1)), entry(addr(2)), entry(addr(3), 'group-b')];
  const result = aggregate(scored, entries);
  assert.equal(result.status, 'READY'); assert.equal(result.independentGroups, 2); assert.equal(result.eligibleWallets, 3);
  assert.equal(result.score, 100); assert.equal(result.wallets.length, 3);
  assert.equal(aggregate(scored, entries.filter(value => value.walletAddress !== addr(3))).status, 'INCOMPLETE');
  assert.equal(aggregate(scored, entries.filter(value => value.walletAddress !== addr(3))).score, null);
});

test('overlapping explicit clusters merge transitively instead of double counting one wallet', () => {
  const scored = [addr(1), addr(2), addr(3)].map(wallet => score(profile(wallet)));
  const result = aggregate(scored, [entry(addr(1), 'group-a'), entry(addr(2), 'group-a'), entry(addr(2), 'group-b'), entry(addr(3), 'group-b')]);
  assert.equal(result.independentGroups, 1); assert.equal(result.status, 'INCOMPLETE');
});

test('unknown clusters, router-only attribution, stale entries and unrelated tokens do not prove independent buyers', () => {
  const scored = [score(profile(addr(1))), score(profile(addr(2)))];
  for (const changes of [{ clusteringComplete: false }, { clusterEvidence: [] }, { clusterId: null },
    { attributionVerified: false }, { observedAt: iso(NOW - 601000) }, { tokenAddress: addr(999) }]) {
    const result = aggregate(scored, [entry(addr(1), 'group-a', changes), entry(addr(2), 'group-b', changes)]);
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.score, null);
  }
});

test('excluded or unknown wallets do not gain weight, while two separately proved eligible groups can qualify', () => {
  const excluded = profile(addr(3)); excluded.riskFlags.insider = true;
  const scored = [score(profile(addr(1))), score(profile(addr(2))), score(excluded), score(profile(addr(4), { netRealizedPnlUsd: null }))];
  const result = aggregate(scored, [entry(addr(1), 'a'), entry(addr(2), 'b'), entry(addr(3), 'c'), entry(addr(4), 'd')]);
  assert.equal(result.status, 'READY'); assert.equal(result.independentGroups, 2); assert.equal(result.excludedWallets, 1);
  assert.equal(result.wallets.some(wallet => wallet.address === addr(3) || wallet.address === addr(4)), false);
});

test('momentum uses two real canonical points and measured growth rather than inferred refreshed timestamps', () => {
  const result = momentum([observation(NOW - 300000, 100, 100, 100000), observation(NOW, 200, 110, 120000)]);
  assert.equal(result.status, 'READY'); assert.equal(result.score, 100);
  assert.equal(result.features.holderGrowthPct, 10); assert.equal(result.features.liquidityGrowthPct, 20);
  assert.equal(result.evidenceExpiresAt, iso(NOW + 120000));
  const zero = momentum([observation(NOW - 300000, 100, 100, 100000), observation(NOW, 200, 0, 0)]);
  assert.equal(zero.status, 'READY'); assert.equal(zero.score, 0);
});

test('cached holders or liquidity, missing coverage, changed pair and forged canonical metadata remain unknown momentum', () => {
  const before = observation(NOW - 300000, 100, 100, 100000);
  for (const changes of [{ holdersCheckedAt: before.holdersCheckedAt }, { liquidityFetchedAt: before.liquidityFetchedAt },
    { holdersComplete: false }, { holdersCount: null }, { liquidityUsd: null }, { canonical: false },
    { pairAddress: addr(201) }, { blockHash: before.blockHash }, { blockNumber: before.blockNumber },
    { liquidityFetchedAt: iso(NOW - 121000) }]) {
    const result = momentum([before, observation(NOW, 200, 110, 120000, changes)]);
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.score, null);
  }
  assert.equal(momentum([before]).score, null);
  assert.equal(momentum([observation(NOW - 300000, 100, 0, 0), observation(NOW, 200, 110, 120000)]).score, null);
});

test('manual new-profile score keeps 50/30/20 weights and never renormalizes missing components', () => {
  const security = { status: 'PASS', score: 100, securityComplete: true };
  const wallets = { status: 'READY', score: 80, independentGroups: 2 };
  const launch = { status: 'READY', score: 50 };
  const complete = scoreNewProfile({ security, wallets, momentum: launch });
  assert.equal(complete.score, 80); assert.equal(complete.status, 'READY'); assert.equal(complete.scoreComplete, true);
  const unknown = scoreNewProfile({ security, wallets: { status: 'INCOMPLETE', score: null }, momentum: launch });
  assert.equal(unknown.score, null); assert.equal(unknown.scoreComplete, false);
  assert.equal(scoreNewProfile({ security: { status: 'REJECTED', score: 0 }, wallets, momentum: launch }).status, 'REJECTED');
  assert.equal(scoreNewProfile({ security: { status: 'OUT_OF_SCOPE', score: null }, wallets, momentum: launch }).status, 'OUT_OF_SCOPE');
});

test('YAML caps, decay, eligibility floors and independent-group requirements are validated', () => {
  const config = structuredClone(profiles);
  assert.equal(config.profiles.profile_new.walletScoring.timeDecayHalfLifeDays, 30);
  assert.equal(config.profiles.profile_new.walletScoring.minScore, 70);
  assert.equal(config.profiles.profile_new.walletScoring.minIndependentGroups, 2);
  const tuned = structuredClone(config); tuned.profiles.profile_new.walletScoring.timeDecayHalfLifeDays = 45;
  assert.equal(validateProfiles(tuned).profiles.profile_new.walletScoring.timeDecayHalfLifeDays, 45);
  for (const mutate of [
    value => { value.profiles.profile_new.walletScoring.minRealizedTrades = 4; },
    value => { value.profiles.profile_new.walletScoring.minIndependentGroups = 1; },
    value => { value.profiles.profile_new.walletScoring.timeDecayHalfLifeDays = 0; },
    value => { value.profiles.profile_new.walletScoring.timeDecayHalfLifeDays = 366; },
    value => { value.profiles.profile_new.walletScoring.targets.netRealizedPnlUsd = Infinity; },
    value => { value.profiles.profile_new.momentum.maxLiquidityAgeSeconds = 600; },
  ]) { const candidate = structuredClone(config); mutate(candidate); assert.throws(() => validateProfiles(candidate), /PROFILE_CONFIG_INVALID/); }
});
