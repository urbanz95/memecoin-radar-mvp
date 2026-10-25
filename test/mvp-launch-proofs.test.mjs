import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLaunchProofs } from '../src/mvp/launch-proofs.mjs';

const token = '0x' + 'a'.repeat(40);
const deployer = '0x' + 'b'.repeat(40);
const previous = '0x' + 'c'.repeat(40);
const funder = '0x' + 'd'.repeat(40);
const h = n => '0x' + n.toString(16).padStart(64, '0');
const now = Date.parse('2026-10-25T12:00:00.000Z');
const head = { number: 200, hash: h(200), timestamp: now / 1000 };
const pool = { createdBlock: 110, createdBlockHash: h(110) };
const creation = { kind: 'direct-creation-receipt', chainId: 4663, address: token,
  blockNumber: 100, blockHash: h(100), transactionHash: h(1000), deployer,
  timestamp: '2026-10-25T11:00:00.000Z' };
const base = () => ({ schemaVersion: 1, chainId: 4663, address: token, canonical: true,
  source: 'verified-indexer/v1', checkedAt: new Date(now).toISOString(), evidence: ['indexer:head:200'],
  blockNumber: head.number, blockHash: head.hash, complete: true });
const window = (scope, fromBlock = 0) => ({ scope, fromBlock, toBlock: head.number, toBlockHash: head.hash,
  complete: true, contiguous: true, canonical: true, evidence: ['indexer:coverage:200'] });
function proven() {
  return { tokenAddress: token, head, now, pool, creation,
    deployerHistory: { ...base(), deployerAddress: deployer, coverage: window('deployer-lifetime'),
      previousContracts: [{ address: previous, chainId: 4663, canonical: true, deployerAddress: deployer,
        blockNumber: 20, blockHash: h(20), transactionHash: h(2000), evidence: ['receipt:previous'] }],
      knownRugs: [], rugAssessmentComplete: true,
      fundingOrigin: { chainId: 4663, canonical: true, walletAddress: deployer, sourceAddress: funder,
        firstFunding: true, complete: true, transactionHash: h(3000), blockNumber: 10,
        blockHash: h(10), source: 'canonical-funding/v1', evidence: ['funding:first'] } },
    launchActivity: { ...base(), coverage: window('token-launch', 110),
      bundles: { complete: true, membershipProven: true, supplyProven: true,
        bundledSupplyRaw: '3', totalSupplyRaw: '100', evidence: ['bundle:membership', 'rpc:totalSupply'] },
      sniperManipulation: { confirmed: false, complete: true, evidence: ['launch:investigation'] } } };
}

test('launch facts preserve unknown history and activity without inventing safe values or making RPC calls', async () => {
  let calls = 0;
  const result = await collectLaunchProofs({ tokenAddress: token, head, now, pool,
    rpc: { async request() { calls++; throw new Error('unexpected'); } } });
  assert.equal(calls, 0);
  const history = result.hardFilterEvidence.deployerHistory;
  assert.equal(history.complete, false);
  assert.equal(history.deployerAddress, null);
  assert.equal(history.previousContractsCount, null);
  assert.equal(history.knownMaliciousDeployments, null);
  assert.equal(history.fundingOrigin, null);
  assert.ok(history.gaps.includes('DEPLOYER_LIFETIME_HISTORY_NOT_INDEXED'));
  assert.ok(history.gaps.includes('DEPLOYER_FUNDING_ORIGIN_UNPROVEN'));
  const activity = result.hardFilterEvidence.launchActivity;
  assert.equal(activity.bundledSupplyPct, null);
  assert.equal(activity.sniperManipulationConfirmed, null);
  assert.equal(activity.complete, false);
  for (const fact of [history, activity]) {
    assert.equal(fact.schemaVersion, 1);
    assert.equal(fact.chainId, 4663);
    assert.equal(fact.address, token);
    assert.equal(fact.checkedAt, new Date(now).toISOString());
    assert.ok(fact.evidence.length > 0);
  }
});

test('existing canonical age creation proof supplies deployer without a redundant RPC call', async () => {
  const age = { basis: 'direct-creation-receipt', deployer, contractCreatedAt: creation.timestamp,
    evidence: [{ kind: creation.kind, blockNumber: creation.blockNumber, blockHash: creation.blockHash,
      transactionHash: creation.transactionHash }] };
  const result = await collectLaunchProofs({ tokenAddress: token.toUpperCase().replace('0X', '0x'), head, now, pool,
    creation: age, rpc: { async request() { assert.fail('must reuse canonical age evidence'); } } });
  assert.equal(result.hardFilterEvidence.deployerHistory.deployerAddress, deployer);
  assert.equal(result.diagnostics.creation.blockHash, creation.blockHash);
  assert.equal(result.diagnostics.rpcRequests, 0);
  assert.equal(result.hardFilterEvidence.deployerHistory.knownMaliciousDeployments, null);
});

test('missing deployer uses at most one receipt and checks canonical contract identity', async () => {
  const calls = [];
  const candidate = { ...creation }; delete candidate.deployer;
  const rpc = { requests: 20, async request(method, params) {
    calls.push([method, params]);
    return { status: '0x1', transactionHash: creation.transactionHash, blockHash: creation.blockHash,
      blockNumber: '0x64', contractAddress: token, from: deployer, to: null };
  } };
  const result = await collectLaunchProofs({ tokenAddress: token, head, now, pool, creation: candidate, rpc });
  assert.deepEqual(calls, [['eth_getTransactionReceipt', [creation.transactionHash]]]);
  assert.equal(result.diagnostics.rpcRequests, 1);
  assert.equal(result.hardFilterEvidence.deployerHistory.deployerAddress, deployer);
  rpc.request = async () => ({ status: '0x1', transactionHash: creation.transactionHash, blockHash: h(999),
    blockNumber: '0x64', contractAddress: token, from: deployer, to: null });
  const wrong = await collectLaunchProofs({ tokenAddress: token, head, now, pool, creation: candidate, rpc });
  assert.equal(wrong.hardFilterEvidence.deployerHistory.deployerAddress, null);
  assert.ok(wrong.diagnostics.gaps.includes('DEPLOYMENT_RECEIPT_UNPROVEN'));
});

test('receipt verification preserves the collector head recheck budget', async () => {
  const candidate = { ...creation }; delete candidate.deployer;
  const result = await collectLaunchProofs({ tokenAddress: token, head, now, creation: candidate,
    rpc: { requests: 30, async request() { assert.fail('head verification budget'); } } });
  assert.equal(result.diagnostics.rpcRequests, 0);
  assert.equal(result.hardFilterEvidence.deployerHistory.deployerAddress, null);
  assert.ok(result.diagnostics.gaps.includes('DEPLOYMENT_RECEIPT_UNAVAILABLE'));
});

test('complete provider evidence produces identified history and launch facts', async () => {
  const result = await collectLaunchProofs(proven());
  const { deployerHistory: history, launchActivity: activity } = result.hardFilterEvidence;
  assert.equal(history.complete, true);
  assert.equal(history.previousContractsCount, 1);
  assert.equal(history.knownMaliciousDeployments, 0);
  assert.equal(history.fundingOrigin.sourceAddress, funder);
  assert.deepEqual(history.gaps, []);
  assert.equal(activity.complete, true);
  assert.equal(activity.bundledSupplyPct, 3);
  assert.equal(activity.sniperManipulationConfirmed, false);
  assert.deepEqual(activity.gaps, []);
  assert.equal(result.diagnostics.rpcRequests, 0);
});

test('positive rug and sniper evidence remain visible with partial global coverage', async () => {
  const input = proven();
  input.deployerHistory.coverage.complete = false;
  input.deployerHistory.knownRugs = [{ chainId: 4663, address: previous, confirmed: true,
    source: 'verified-rug-adjudication/v1', evidence: ['rug:previous'] }];
  input.launchActivity.coverage.complete = false;
  input.launchActivity.sniperManipulation.confirmed = true;
  const { hardFilterEvidence: { deployerHistory: history, launchActivity: activity } } = await collectLaunchProofs(input);
  assert.equal(history.knownMaliciousDeployments, 1);
  assert.equal(history.previousContractsCount, null);
  assert.equal(history.complete, false);
  assert.equal(activity.sniperManipulationConfirmed, true);
  assert.equal(activity.bundledSupplyPct, 3);
  assert.equal(activity.complete, false);
});

test('empty lists cannot prove absence without lifetime coverage', async () => {
  const input = proven();
  input.deployerHistory.coverage = null;
  input.deployerHistory.previousContracts = [];
  const history = (await collectLaunchProofs(input)).hardFilterEvidence.deployerHistory;
  assert.equal(history.previousContracts, null);
  assert.equal(history.knownRugs, null);
  assert.equal(history.previousContractsCount, null);
  assert.equal(history.knownMaliciousDeployments, null);
  assert.equal(history.complete, false);
});

test('bundle supply and sniper negatives require denominator and coverage proofs', async () => {
  for (const mutate of [
    input => { input.launchActivity.bundles.totalSupplyRaw = '0'; },
    input => { input.launchActivity.bundles.totalSupplyRaw = undefined; },
    input => { input.launchActivity.bundles.bundledSupplyRaw = '101'; },
    input => { input.launchActivity.bundles.membershipProven = false; },
  ]) {
    const input = proven(); mutate(input);
    const activity = (await collectLaunchProofs(input)).hardFilterEvidence.launchActivity;
    assert.equal(activity.bundledSupplyPct, null);
    assert.equal(activity.complete, false);
  }
  const input = proven();
  input.launchActivity.coverage.complete = false;
  input.launchActivity.bundles.bundledSupplyRaw = '0';
  const activity = (await collectLaunchProofs(input)).hardFilterEvidence.launchActivity;
  assert.equal(activity.bundledSupplyPct, null);
  assert.equal(activity.sniperManipulationConfirmed, null);
});

test('bundle percentage rounds conservatively above a security threshold', async () => {
  const input = proven();
  input.launchActivity.bundles.bundledSupplyRaw = '100000000000000000000001';
  input.launchActivity.bundles.totalSupplyRaw = '1000000000000000000000000';
  assert.equal((await collectLaunchProofs(input)).hardFilterEvidence.launchActivity.bundledSupplyPct, 10.000001);
});

test('provider identity, freshness, head and bounded evidence cannot be laundered into new stamps', async () => {
  for (const mutate of [
    fact => { fact.chainId = 1; }, fact => { fact.address = previous; },
    fact => { fact.canonical = false; }, fact => { fact.blockHash = h(999); },
    fact => { fact.checkedAt = '2026-10-25T11:00:00.000Z'; },
    fact => { fact.checkedAt = '2026-10-25T12:01:00.000Z'; },
    fact => { fact.evidence = Array(33).fill('proof'); },
  ]) {
    const input = proven(); mutate(input.deployerHistory); mutate(input.launchActivity);
    const { hardFilterEvidence } = await collectLaunchProofs(input);
    assert.equal(hardFilterEvidence.deployerHistory.complete, false);
    assert.equal(hardFilterEvidence.deployerHistory.knownMaliciousDeployments, null);
    assert.equal(hardFilterEvidence.launchActivity.bundledSupplyPct, null);
  }
});

test('provider observation time is preserved instead of refreshing older source evidence', async () => {
  const input = proven();
  input.head = { ...head, timestamp: head.timestamp - 30 };
  input.deployerHistory.checkedAt = new Date(now - 20000).toISOString();
  input.launchActivity.checkedAt = new Date(now - 10000).toISOString();
  const { hardFilterEvidence } = await collectLaunchProofs(input);
  assert.equal(hardFilterEvidence.deployerHistory.checkedAt, input.deployerHistory.checkedAt);
  assert.equal(hardFilterEvidence.launchActivity.checkedAt, input.launchActivity.checkedAt);
  input.launchActivity.checkedAt = new Date(now - 40000).toISOString();
  assert.equal((await collectLaunchProofs(input)).hardFilterEvidence.launchActivity.complete, false);
});

test('contradictory creation and history identities are rejected', async () => {
  for (const mutate of [
    value => { value.chainId = 1; }, value => { value.address = previous; },
    value => { value.blockNumber = head.number; value.blockHash = h(999); },
    value => { value.timestamp = '2026-10-25T12:01:00.000Z'; },
  ]) {
    const input = proven(); input.creation = { ...creation }; mutate(input.creation);
    const result = await collectLaunchProofs(input);
    assert.equal(result.diagnostics.creation, null);
    assert.equal(result.hardFilterEvidence.deployerHistory.deployerAddress, null);
    assert.equal(result.hardFilterEvidence.deployerHistory.complete, false);
  }
  const input = proven(); input.deployerHistory.deployerAddress = previous;
  assert.equal((await collectLaunchProofs(input)).hardFilterEvidence.deployerHistory.knownMaliciousDeployments, null);
});

test('malformed and oversized optional provider structures stay incomplete', async () => {
  const input = proven();
  input.deployerHistory.previousContracts = Array(129).fill(input.deployerHistory.previousContracts[0]);
  input.launchActivity.bundles.totalSupplyRaw = '9'.repeat(10000);
  const result = await collectLaunchProofs(input);
  assert.equal(result.hardFilterEvidence.deployerHistory.complete, false);
  assert.equal(result.hardFilterEvidence.launchActivity.bundledSupplyPct, null);
  assert.equal(JSON.stringify(result).length < 10000, true);
  await assert.rejects(collectLaunchProofs({ now: Infinity }), /LAUNCH_PROOFS_CLOCK_INVALID/);
});
