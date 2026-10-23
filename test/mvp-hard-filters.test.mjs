import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHardFilters } from '../src/mvp/hard-filters.mjs';
import { fixture, DEMO_TIME } from '../examples/fixtures.mjs';
import { evaluate } from '../src/engine.mjs';
import policy from '../config/policies.json' with { type: 'json' };
import profiles from '../src/mvp/config.mjs';

const NOW = DEMO_TIME;
const deployer = '0x3333333333333333333333333333333333333333';
const blockHash = number => '0x' + BigInt(number + 1).toString(16).padStart(64, '0');
function safe() {
  const snapshot = fixture('new', NOW);
  const stamp = { schemaVersion: 1, chainId: 4663, address: snapshot.address,
    checkedAt: new Date(NOW).toISOString(), source: 'synthetic-hard-filter-proof',
    evidence: ['fixture:typed-history-and-launch-proof'], complete: true };
  return { snapshot, entry: { address: snapshot.address, observedAt: new Date(NOW).toISOString(),
    blockNumber: snapshot.chainState.blockNumber, status: 'REVIEW', risks: [],
    hardFilterEvidence: {
      deployerHistory: { ...stamp, deployerAddress: deployer, knownMaliciousDeployments: 0 },
      launchActivity: { ...stamp, bundledSupplyPct: 3, sniperManipulationConfirmed: false },
    } } };
}
const run = ({ snapshot, entry }, options = {}) => evaluateHardFilters(snapshot, entry, { now: NOW, ...options });
function boundsCase({ absentMinutes = 120, presentMinutes = 30 } = {}) {
  const value = safe(); delete value.snapshot.contractCreatedAt;
  const head = value.snapshot.chainState.blockNumber;
  value.entry.age = { basis: 'code-existence-bounds', lowerBoundMinutes: presentMinutes, upperBoundMinutes: absentMinutes,
    evidence: [
      { kind: 'historical-code-existence', blockNumber: head - absentMinutes * 4,
        blockHash: blockHash(head - absentMinutes * 4), timestamp: new Date(NOW - absentMinutes * 60000).toISOString(), hasBytecode: false },
      { kind: 'historical-code-existence', blockNumber: head - presentMinutes * 4,
        blockHash: blockHash(head - presentMinutes * 4), timestamp: new Date(NOW - presentMinutes * 60000).toISOString(), hasBytecode: true },
    ] };
  return value;
}

test('hard-filter adapter preserves legacy engine behavior and does not mutate either input', () => {
  const value = safe(); const before = structuredClone(value); const policyBefore = structuredClone(policy);
  assert.equal(evaluate(value.snapshot, 'new', policy, { now: NOW }).status, 'CONFIRMING');
  const result = run(value);
  assert.equal(result.status, 'PASS'); assert.equal(result.score, 100); assert.equal(result.securityComplete, true);
  assert.ok(result.checks.length > 20); assert.deepEqual(result.gaps, []);
  assert.match(result.policyHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(value, before); assert.deepEqual(policy, policyBefore);
});

test('activity and momentum eligibility are separate from hard security evidence', () => {
  const value = safe(); value.snapshot.activity = {};
  for (const name of ['liquidityUsd', 'fdvUsd', 'oldestPoolCreatedAt', 'priceChange5mPct', 'priceChange1hPct']) delete value.snapshot.market[name];
  delete value.snapshot.holders.count;
  assert.equal(run(value).status, 'PASS');
  assert.equal(run(value).checks.some(check => check.category === 'eligibility'), false);
});

test('mode A accepts exact creation at zero age and rejects the exclusive 24-hour boundary', () => {
  const fresh = safe(); fresh.snapshot.contractCreatedAt = new Date(NOW).toISOString();
  fresh.snapshot.market.oldestPoolCreatedAt = new Date(NOW).toISOString();
  assert.equal(run(fresh).status, 'PASS');
  const boundary = safe(); boundary.snapshot.contractCreatedAt = new Date(NOW - 24 * 3600000).toISOString();
  assert.equal(run(boundary).status, 'OUT_OF_SCOPE'); assert.equal(run(boundary).score, null);
  boundary.snapshot.contractCreatedAt = new Date(NOW - 25 * 3600000).toISOString();
  assert.equal(run(boundary).status, 'OUT_OF_SCOPE');
});

test('canonical bytecode bounds prove an age window without inventing an exact creation date', () => {
  const value = boundsCase();
  const result = run(value);
  assert.equal(result.status, 'PASS'); assert.equal(result.securityComplete, true);
  assert.equal(Object.hasOwn(value.snapshot, 'contractCreatedAt'), false);
  assert.equal(result.checks.some(check => check.metric === 'contractAge' && check.passed === true), true);
  const tooOld = boundsCase({ absentMinutes: 47 * 60 });
  assert.notEqual(run(tooOld).status, 'PASS');
  tooOld.entry.age.upperBoundMinutes = 20;
  assert.notEqual(run(tooOld).status, 'PASS', 'numeric bounds cannot override the historical absence proof');
});

test('an older absence observation does not expire a stronger recent bound prematurely', () => {
  const value = boundsCase();
  const head = value.snapshot.chainState.blockNumber;
  value.entry.age.evidence.unshift({ kind: 'historical-code-existence', blockNumber: head - 47 * 60 * 4,
    blockHash: blockHash(head - 47 * 60 * 4), timestamp: new Date(NOW - 47 * 3600000).toISOString(), hasBytecode: false });
  const result = run(value);
  assert.equal(result.status, 'PASS');
  assert.equal(result.age.upperBoundMinutes, 120);
  assert.equal(result.evidenceExpiresAt, new Date(NOW + 60000).toISOString());
});

test('age numbers, a pool creation time, invalid hashes and contradictory code do not prove token age', () => {
  const values = [
    value => { value.entry.age = { lowerBoundMinutes: 10, upperBoundMinutes: 100 }; },
    value => { value.entry.age.evidence[0].blockHash = '0x123'; },
    value => { value.entry.age.evidence[0].timestamp = new Date(NOW + 60000).toISOString(); },
    value => { value.entry.age.evidence[0].hasBytecode = true; },
    value => { value.entry.age.evidence[1].timestamp = new Date(NOW - 180 * 60000).toISOString(); },
    value => { value.entry.address = deployer; },
    value => { value.entry.age.reasons = ['AGE_CANONICAL_PROOF_UNAVAILABLE']; },
    value => { value.entry.age.reasons = 'untyped-result'; },
  ];
  for (const mutate of values) { const value = boundsCase(); mutate(value); assert.equal(run(value).status, 'INCOMPLETE'); }
  const poolOnly = safe(); delete poolOnly.snapshot.contractCreatedAt;
  poolOnly.snapshot.collection = { selectedPoolCreatedAt: new Date(NOW - 60000).toISOString() };
  assert.equal(run(poolOnly).status, 'INCOMPLETE');
});

for (const [section, field, risk] of [
  ['security', 'canMint', true], ['security', 'canPause', true], ['security', 'canBlacklist', true],
  ['security', 'canChangeFees', true], ['security', 'buyTaxPct', 0.1], ['security', 'sellTaxPct', 1],
  ['security', 'proxyUpgradeable', true], ['security', 'hiddenPrivileges', true],
  ['security', 'honeypotDetected', true], ['security', 'liquidityRemovableByCreator', true],
  ['liquidityProtection', 'coveragePct', 94], ['holders', 'top1Pct', 6],
  ['holders', 'top10Pct', 26], ['holders', 'deployerPct', 3], ['holders', 'bundledSupplyPct', 11],
]) test(`existing risk rejects immediately despite unrelated missing data: ${section}.${field}`, () => {
  const value = safe(); value.snapshot[section][field] = risk;
  delete value.snapshot.contractCreatedAt; value.entry.hardFilterEvidence = {};
  delete value.snapshot.security.contractVerified;
  const result = run(value);
  assert.equal(result.status, 'REJECTED'); assert.equal(result.score, 0); assert.equal(result.securityComplete, false);
  assert.ok(result.checks.some(check => check.metric === `${section}.${field}` && check.passed === false));
  assert.ok(result.gaps.length > 0);
});

test('unknown owner powers, renounced ownership and unrelated Solana authorities never imply EVM safety or malice', () => {
  for (const owner of [deployer, '0x' + '0'.repeat(40)]) {
    const value = safe(); value.snapshot.security.owner = owner;
    delete value.snapshot.security.canMint;
    value.snapshot.security.mintAuthority = null; value.snapshot.security.freezeAuthority = null;
    const result = run(value);
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.score, null);
    assert.ok(result.gaps.some(gap => gap.path === 'security.canMint'));
  }
});

test('unknown deployer history and launch manipulation remain incomplete, never safe by default', () => {
  const value = safe(); delete value.entry.hardFilterEvidence;
  const result = run(value);
  assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.score, null); assert.equal(result.securityComplete, false);
  assert.ok(result.gaps.some(gap => gap.path.includes('deployerHistory')));
  assert.ok(result.gaps.some(gap => gap.path.includes('launchActivity')));
});

test('typed, fresh positive deployer or sniper manipulation evidence maps to the existing malicious-activity gate', () => {
  for (const feature of ['deployer', 'sniper']) {
    const value = safe();
    if (feature === 'deployer') value.entry.hardFilterEvidence.deployerHistory.knownMaliciousDeployments = 1;
    else value.entry.hardFilterEvidence.launchActivity.sniperManipulationConfirmed = true;
    const result = run(value);
    assert.equal(result.status, 'REJECTED'); assert.equal(result.score, 0);
    assert.ok(result.checks.some(check => check.metric === 'security.knownMalicious' && check.passed === false));
  }
});

test('typed bundle supply uses the existing holder threshold and cannot clear a stronger known concentration', () => {
  const value = safe(); value.entry.hardFilterEvidence.launchActivity.bundledSupplyPct = 11;
  assert.equal(run(value).status, 'REJECTED');
  value.entry.hardFilterEvidence.launchActivity.bundledSupplyPct = 0;
  value.snapshot.holders.bundledSupplyPct = 12;
  assert.equal(run(value).status, 'REJECTED');
});

test('new history facts require typed identity, provenance and freshness; common funding is not insider proof', () => {
  const mutations = [
    fact => { fact.chainId = 46630; }, fact => { fact.address = deployer; },
    fact => { fact.source = ''; }, fact => { fact.evidence = []; },
    fact => { fact.checkedAt = new Date(NOW - 601000).toISOString(); },
    fact => { fact.checkedAt = new Date(NOW + 31000).toISOString(); },
    fact => { fact.knownMaliciousDeployments = '1'; }, fact => { fact.complete = false; },
  ];
  for (const mutate of mutations) {
    const value = safe(); mutate(value.entry.hardFilterEvidence.deployerHistory);
    const result = run(value);
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.score, null);
  }
  const value = safe(); delete value.snapshot.holders.linkedInsidersPct;
  value.entry.commonFunding = [deployer, value.snapshot.address];
  value.entry.sameBlockBuyers = 20;
  const result = run(value);
  assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.checks.some(check => check.metric === 'holders.linkedInsidersPct' && check.passed === false), false);
});

test('100 USD round-trip, hard-section provenance and freshness are mandatory, despite a positive market score', () => {
  for (const mutate of [
    value => { value.snapshot.quote.amountUsd = 0.001; },
    value => { value.snapshot.quote.checkedAt = new Date(NOW - 61000).toISOString(); },
    value => { value.snapshot.holders.evidence = []; },
    value => { value.snapshot.market.checkedAt = new Date(NOW - 121000).toISOString(); },
  ]) {
    const value = safe(); mutate(value); value.entry.priorityScore = 100;
    const result = run(value);
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.score, null); assert.equal(result.securityComplete, false);
  }
});

test('disabled existing profile and unsupported future modes cannot be activated by this adapter', () => {
  const value = safe();
  assert.equal(run(value, { profile: profiles.profiles.profile_existing }).status, 'OUT_OF_SCOPE');
  assert.equal(run(value, { profile: { ...profiles.profiles.profile_existing, enabled: true } }).status, 'INCOMPLETE');
});

test('identity and malformed input failures stay fail-closed with safe structured gaps', () => {
  const value = safe(); value.snapshot.chainId = 46630;
  assert.equal(run(value).status, 'INCOMPLETE');
  assert.equal(evaluateHardFilters(null, {}, { now: NOW }).status, 'INCOMPLETE');
  assert.throws(() => evaluateHardFilters(value.snapshot, {}, { now: NaN }), /HARD_FILTER_CLOCK_INVALID/);
});
