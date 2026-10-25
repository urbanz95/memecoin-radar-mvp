import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWalletClusters } from '../src/mvp/wallet-clusters.mjs';

const A = n => `0x${n.toString(16).padStart(40, '0')}`;
const H = n => `0x${n.toString(16).padStart(64, '0')}`;
const now = Date.parse('2026-10-25T12:00:00.000Z');
const proof = overrides => ({ chainId: 4663, canonical: true, source: 'canonical-test-index/v1',
  evidence: ['proof:canonical-fixture'], checkedAt: new Date(now).toISOString(),
  blockNumber: 100, blockHash: H(100), ...overrides });
const funding = (wallet, funder, overrides = {}) => proof({ walletAddress: A(wallet), funderAddress: A(funder),
  transactionHash: H(10000 + wallet), firstFunding: true, complete: true,
  funderClassification: 'non-hub', classificationProven: true, ...overrides });
const transfer = (from, to, overrides = {}) => proof({ fromAddress: A(from), toAddress: A(to),
  transactionHash: H(20000 + from * 10 + to), direct: true, amountRaw: '1', ...overrides });
const coverage = overrides => ({ ...proof(), complete: true, contiguous: true,
  fundingComplete: true, buysComplete: true, transfersComplete: true, fromBlock: 90,
  toBlock: 200, toBlockHash: H(200), ...overrides });
const run = overrides => buildWalletClusters({ wallets: [A(1), A(2)], now, ...overrides });

test('missing funding, coverage and risk facts remain explicitly unproven', () => {
  const result = run();
  assert.equal(result.clusters.length, 2);
  for (const wallet of result.wallets) {
    assert.equal(wallet.clusterProof.complete, false);
    assert.equal(wallet.clusterProof.canonical, false);
    assert.deepEqual(wallet.riskFlags, { insider: null, bundler: null, washTrading: null });
    assert.deepEqual(wallet.riskEvidence, []);
    assert.ok(wallet.gaps.includes('CLUSTER_FIRST_FUNDING_UNPROVEN'));
    assert.ok(wallet.gaps.includes('CLUSTER_WINDOW_COVERAGE_UNPROVEN'));
  }
});

test('common first funding forms a deterministic counting group without inventing malicious or clean flags', () => {
  const result = run({ fundingProofs: [funding(2, 9), funding(1, 9)] });
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].clusterId, `rhc:4663:wallet:${A(1)}`);
  assert.deepEqual(result.clusters[0].wallets, [A(1), A(2)]);
  assert.equal(result.clusters[0].relations[0].kind, 'common-first-funding');
  assert.equal(result.wallets[0].clusterProof.complete, false);
  assert.deepEqual(result.wallets[0].riskFlags, { insider: null, bundler: null, washTrading: null });
});

test('canonical first funding and complete declared window can prove separate groups while risk stays unknown', () => {
  const result = run({ coverage: coverage(), fundingProofs: [funding(1, 8), funding(2, 9)] });
  assert.equal(result.clusters.length, 2);
  assert.ok(result.wallets.every(wallet => wallet.clusterProof.complete));
  assert.ok(result.wallets.every(wallet => wallet.clusterProof.evidence.length > 0));
  assert.deepEqual(result.wallets[0].clusterProof.coverage, { fromBlock: 90, toBlock: 200, toBlockHash: H(200) });
  assert.equal(result.wallets[0].riskFlags.insider, null);
});

test('first funding may precede the declared trading window', () => {
  const result = run({ coverage: coverage(), fundingProofs: [funding(1, 8, { blockNumber: 1, blockHash: H(1) }),
    funding(2, 9, { blockNumber: 2, blockHash: H(2) })] });
  assert.ok(result.wallets.every(wallet => wallet.clusterProof.complete));
});

test('unknown common funding collapses the group but cannot prove independence', () => {
  const result = run({ coverage: coverage(), fundingProofs: [funding(1, 9, { classificationProven: false }),
    funding(2, 9, { classificationProven: false })] });
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].complete, false);
  assert.ok(result.wallets.every(wallet => wallet.gaps.includes('CLUSTER_FUNDER_CLASSIFICATION_UNPROVEN')));
});

test('an EOA funder can belong to an exchange and does not establish non-hub independence', () => {
  const result = run({ coverage: coverage(), fundingProofs: [funding(1, 9, { funderClassification: 'eoa' }),
    funding(2, 9, { funderClassification: 'eoa' })] });
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].complete, false);
  assert.ok(result.wallets.every(wallet => wallet.gaps.includes('CLUSTER_FUNDER_CLASSIFICATION_UNPROVEN')));
});

for (const hub of ['exchange', 'router']) test(`${hub} common sources do not merge their customers or prove independence`, () => {
  const result = run({ coverage: coverage(), fundingProofs: [funding(1, 9, { funderClassification: hub }),
    funding(2, 9, { funderClassification: hub })] });
  assert.equal(result.clusters.length, 2);
  assert.ok(result.wallets.every(wallet => !wallet.clusterProof.complete));
  assert.ok(result.wallets.every(wallet => wallet.gaps.includes('CLUSTER_FIRST_FUNDING_HUB_SOURCE')));
});

test('direct transfers merge partial groups without requiring unavailable funding history', () => {
  const result = run({ transfers: [transfer(1, 2)] });
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].relations[0].kind, 'direct-wallet-transfer');
  assert.equal(result.wallets[0].clusterProof.complete, false);
  assert.equal(result.wallets[0].riskFlags.washTrading, null);
});

test('zero, missing, noncanonical, negative and overflowing transfer amounts cannot link wallets', () => {
  for (const amountRaw of [undefined, null, '0', '00', '01', '-1', '1.0', 1, (1n << 256n).toString()]) {
    const result = run({ transfers: [transfer(1, 2, { amountRaw })] });
    assert.equal(result.clusters.length, 2, `invalid amount ${String(amountRaw)}`);
    assert.ok(result.wallets.every(wallet => wallet.gaps.includes('CLUSTER_DIRECT_TRANSFER_UNPROVEN')));
  }
  const alias = run({ transfers: [transfer(1, 2, { amountRaw: undefined, valueRaw: '1' })] });
  assert.equal(alias.clusters.length, 1);
  const conflicting = run({ transfers: [transfer(1, 2, { amountRaw: '1', valueRaw: '2' })] });
  assert.equal(conflicting.clusters.length, 2);
  const maximum = run({ transfers: [transfer(1, 2, { amountRaw: ((1n << 256n) - 1n).toString() })] });
  assert.equal(maximum.clusters.length, 1);
});

test('buys merge only for an attributed buy in the exact creation block of the same pool', () => {
  const launch = proof({ poolAddress: A(90) });
  const buy = (wallet, overrides = {}) => proof({ walletAddress: A(wallet), poolAddress: A(90),
    transactionHash: H(30000 + wallet), side: 'BUY', attributionComplete: true, ...overrides });
  const result = buildWalletClusters({ wallets: [A(1), A(2), A(3), A(4)], now, launch,
    buys: [buy(1), buy(2), buy(3, { poolAddress: A(91) }), buy(4, { attributionComplete: false })] });
  assert.equal(result.clusters.length, 3);
  assert.deepEqual(result.clusters[0].wallets, [A(1), A(2)]);
  assert.equal(result.clusters[0].relations[0].kind, 'pool-creation-block-buys');
  assert.equal(result.wallets[0].riskFlags.bundler, null);
});

test('cluster identity and merge aliases survive input ordering and retain previous identifiers', () => {
  const wallets = [{ walletAddress: A(3), clusterId: 'previous:third' }, A(2), A(1)];
  const edges = [transfer(2, 3), transfer(1, 2)];
  const result = buildWalletClusters({ wallets, transfers: edges, now });
  const reordered = buildWalletClusters({ wallets: wallets.toReversed(), transfers: edges.toReversed(), now });
  assert.deepEqual(result.wallets.map(value => value.clusterProof.clusterId), reordered.wallets.map(value => value.clusterProof.clusterId));
  assert.deepEqual(result.aliases, reordered.aliases);
  assert.deepEqual(result.aliases, [
    { alias: 'previous:third', clusterId: `rhc:4663:wallet:${A(1)}` },
    { alias: `rhc:4663:wallet:${A(2)}`, clusterId: `rhc:4663:wallet:${A(1)}` },
    { alias: `rhc:4663:wallet:${A(3)}`, clusterId: `rhc:4663:wallet:${A(1)}` },
  ]);
});

for (const [name, change] of [
  ['stale', { checkedAt: new Date(now - 600001).toISOString() }],
  ['future', { checkedAt: new Date(now + 1).toISOString() }],
  ['wrong-chain', { chainId: 1 }], ['noncanonical', { canonical: false }],
  ['unidentified', { blockHash: H(0) }], ['unsupported-directness', { direct: false }],
]) test(`${name} transfer evidence cannot merge wallets`, () => {
  const result = run({ transfers: [transfer(1, 2, change)] });
  assert.equal(result.clusters.length, 2);
  assert.ok(result.wallets.every(wallet => !wallet.clusterProof.complete));
});

test('conflicting block hashes invalidate all assertions at the conflicting number', () => {
  const result = run({ transfers: [transfer(1, 2)], fundingProofs: [funding(1, 9, { blockHash: H(101) })] });
  assert.equal(result.clusters.length, 2);
  assert.ok(result.diagnostics.includes('CLUSTER_CANONICAL_CONFLICT'));
});

test('the same hash at different heights and the same transaction in different blocks are rejected', () => {
  for (const overrides of [{ blockNumber: 101 }, { blockNumber: 101, blockHash: H(101), transactionHash: transfer(1, 2).transactionHash }]) {
    const result = run({ transfers: [transfer(1, 2)], fundingProofs: [funding(1, 9, overrides)] });
    assert.equal(result.clusters.length, 2);
    assert.ok(result.diagnostics.includes('CLUSTER_CANONICAL_CONFLICT'));
  }
});

test('conflicting first funding claims remain incomplete and do not select a convenient source', () => {
  const result = run({ coverage: coverage(), fundingProofs: [funding(1, 9), funding(1, 8), funding(2, 9)] });
  assert.equal(result.clusters.length, 2);
  assert.ok(result.wallets[0].gaps.includes('CLUSTER_FIRST_FUNDING_CONFLICT'));
  assert.equal(result.wallets[0].clusterProof.complete, false);
});

test('only separate complete canonical risk evidence sets flags, and positive findings survive conflicting clean claims', () => {
  const positive = proof({ walletAddress: A(1), complete: true,
    riskFlags: { insider: true, bundler: false, washTrading: null }, evidence: ['risk:verified-finding'] });
  const result = run({ transfers: [transfer(1, 2)], riskProofs: [positive] });
  assert.deepEqual(result.wallets[0].riskFlags, { insider: true, bundler: false, washTrading: null });
  assert.deepEqual(result.wallets[0].riskEvidence, ['risk:verified-finding']);
  assert.deepEqual(result.wallets[1].riskFlags, { insider: null, bundler: null, washTrading: null });
  const conflicting = run({ riskProofs: [positive, { ...positive,
    riskFlags: { insider: false, bundler: false, washTrading: false } }] });
  assert.equal(conflicting.wallets[0].riskFlags.insider, true);
  assert.ok(conflicting.wallets[0].gaps.includes('CLUSTER_RISK_INSIDER_CONFLICT'));
});

test('window coverage must explicitly cover every relation source and cannot cover future events', () => {
  const partial = run({ coverage: coverage({ transfersComplete: false }), fundingProofs: [funding(1, 8), funding(2, 9)] });
  assert.ok(partial.wallets.every(wallet => !wallet.clusterProof.complete));
  const outside = run({ coverage: coverage(), fundingProofs: [funding(1, 8), funding(2, 9)],
    transfers: [transfer(1, 2, { blockNumber: 201, blockHash: H(201) })] });
  assert.equal(outside.clusters.length, 2);
  assert.ok(outside.wallets.every(wallet => !wallet.clusterProof.complete));
});

test('oversized and invalid top-level inputs are rejected; malformed wallets are diagnosed', () => {
  for (const invalid of [{ now: NaN }, { now: 8640000000000001 }, { wallets: Array(129).fill(A(1)) },
    { transfers: Array(1025).fill({}) }, { riskProofs: {} }])
    assert.throws(() => run(invalid), /MVP_WALLET_CLUSTER_INPUT/);
  const result = run({ wallets: ['invalid', { walletAddress: A(1), chainId: 1 }, A(2)] });
  assert.equal(result.wallets.length, 1);
  assert.ok(result.diagnostics.includes('CLUSTER_WALLET_INVALID'));
  assert.ok(result.diagnostics.includes('CLUSTER_WALLET_CHAIN_MISMATCH'));
});
