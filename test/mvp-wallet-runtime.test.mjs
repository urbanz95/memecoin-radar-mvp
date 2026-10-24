import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { SWAPS } from '../src/onchain/abi.mjs';
import { projectObservedWallets } from '../src/mvp/wallet-runtime.mjs';
import { normalizeReceiptSettlement } from '../src/mvp/wallet-accounting.mjs';
import { prepareWalletProjection, prepareWalletLedger, readWalletProfile, getWalletLedgerStats } from '../src/mvp/wallet-ledger.mjs';
import { prepareWalletTemporalUpdates, attachWalletTemporalEvidence } from '../src/mvp/wallet-temporal.mjs';
import { scoreWalletProfile } from '../src/mvp/wallet-scoring.mjs';
import { setup, TOKEN, time } from './helpers/mvp-sqlite.mjs';
const schema = await readFile(new URL('../cloudflare/migrations/0004_mvp_wallets.sql', import.meta.url), 'utf8');
const hash = n => '0x' + n.toString(16).padStart(64, '0');

test('a transaction sender without settlement history remains tracked with unknown PnL and unknown lifetime trade count', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const input = [{ receipt: { from: TOKEN(10), logs: [], transactionHash: hash(4), status: '0x1',
    blockNumber: '0x64', blockHash: hash(100) }, block: { number: 100, hash: hash(100), timestamp: time / 1000 },
    tokenAddress: TOKEN(1), pool: null, events: [], source: 'canonical-readonly-receipt/v1' }];
  const projected = await projectObservedWallets(DB, input, { now: time });
  assert.equal(projected.profiles.length, 1);
  const value = projected.profiles[0];
  assert.equal(value.realizedTradeCount, null);
  assert.equal(value.netRealizedPnlUsd, null);
  assert.equal(value.eligible, false);
  assert.equal(value.historyComplete, false);
  assert.equal(value.attributionComplete, false);
  assert.equal(value.riskFlags, null);
  await DB.batch(prepareWalletProjection(DB, { runId: 'actual-unknown', observedAt: time, profiles: projected.profiles }).commands);
  assert.equal((await readWalletProfile(DB, TOKEN(10))).netRealizedPnlUsd, null);
  const stats = await getWalletLedgerStats(DB);
  assert.equal(stats.tracked, 1); assert.equal(stats.eligible, 0);
  const retry = await projectObservedWallets(DB, input, { now: time + 1 });
  assert.deepEqual(retry.profiles[0].observedCounts, value.observedCounts);
});

test('missing sender and invalid runtime input cannot invent a tracked smart wallet', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const result = await projectObservedWallets(DB, [{ receipt: { from: null } }], { now: time });
  assert.deepEqual(result.profiles, []);
  assert.deepEqual(result.diagnostics, ['WALLET_SENDER_UNAVAILABLE']);
  await assert.rejects(projectObservedWallets(DB, [], { now: NaN }), /RUNTIME_INPUT/);
});

const W = TOKEN(10); const QUOTE = TOKEN(2); const POOL = TOKEN(3); const ZERO = TOKEN(0);
const iso = at => new Date(at).toISOString();
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const indexed = address => '0x' + '0'.repeat(24) + address.slice(2);
function receiptValue(side = 'BUY', number = 100) {
  const block = { number, hash: hash(number), timestamp: time / 1000 + (number - 100) * 60 };
  const transactionHash = hash(number + 10000); const pool = { type: 'v2', address: POOL,
    token0: QUOTE, token1: TOKEN(1), quoteAddress: QUOTE, tokenDecimals: 18, quoteDecimals: 6 };
  const base = { blockNumber: '0x' + number.toString(16), blockHash: block.hash, transactionHash, removed: false };
  const transfer = (asset, from, to, quantity, logIndex) => ({ ...base, address: asset, logIndex: '0x' + logIndex.toString(16),
    topics: [transferTopic, indexed(from), indexed(to)], data: '0x' + BigInt(quantity).toString(16).padStart(64, '0') });
  const quoteRaw = side === 'BUY' ? 100000000n : 120000000n;
  const swap = { ...base, address: POOL, logIndex: '0x2',
    topics: encodeEventTopics({ abi: [SWAPS.v2], eventName: 'Swap', args: { sender: POOL, to: W } }),
    data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), side === 'BUY'
      ? [quoteRaw, 0n, 0n, 10n ** 19n] : [0n, 10n ** 19n, quoteRaw, 0n]) };
  const receipt = { ...base, status: '0x1', from: W, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [
    transfer(TOKEN(1), side === 'BUY' ? POOL : W, side === 'BUY' ? W : POOL, 10n ** 19n, 0),
    transfer(QUOTE, side === 'BUY' ? W : POOL, side === 'BUY' ? POOL : W, quoteRaw, 1), swap] };
  const events = [{ ...base, kind: 'SWAP', chainId: 4663, blockNumber: number, logIndex: 2, tokenAddress: TOKEN(1), address: POOL, pool }];
  return { receipt, events, block, pool, tokenAddress: TOKEN(1), source: 'fixture:canonical-receipt' };
}
function receiptProof(value, now) {
  const { block, receipt } = value;
  const price = (assetAddress, value) => ({ chainId: 4663, assetAddress, value, observedAt: iso(block.timestamp * 1000),
    blockNumber: block.number, blockHash: block.hash, source: 'fixture:historical-price', evidence: ['fixture:price'] });
  return { chainId: 4663, transactionHash: receipt.transactionHash, blockNumber: block.number, blockHash: block.hash,
    canonical: true, checkedAt: iso(now), source: 'fixture:receipt-evidence', evidence: ['fixture:receipt-evidence'],
    feeComponentsComplete: true, feeEvidence: ['fixture:complete-fee-components'],
    valuation: { quoteUsd: price(QUOTE, '1'), feeAssetUsd: price(ZERO, '2000') },
    deployment: { chainId: 4663, kind: 'direct-creation-receipt', address: TOKEN(1), canonical: true,
      blockNumber: 90, blockHash: hash(90), transactionHash: hash(9000), timestamp: iso(time - 180000),
      source: 'fixture:canonical-deployment', evidence: ['fixture:deployment'] } };
}
function walletProof(value, now) {
  return { chainId: 4663, walletAddress: W, blockNumber: value.block.number, blockHash: value.block.hash,
    canonical: true, checkedAt: iso(now), source: 'fixture:wallet-lifetime-provider', evidence: ['fixture:wallet-coverage'],
    historyProof: { scope: 'wallet-lifetime', fromBlock: 0, toBlock: value.block.number, toBlockHash: value.block.hash,
      complete: true, contiguous: true, canonical: true, openingBalanceKnown: true, evidence: ['fixture:complete-wallet-history'] },
    feesComplete: true, attributionComplete: true,
    riskFlags: { insider: false, bundler: false, washTrading: false }, riskEvidence: ['fixture:risk-screening'],
    clusterProof: { chainId: 4663, walletAddress: W, complete: true, clusterId: 'fixture:independent-wallet-10', evidence: ['fixture:funding-analysis'] },
    openingEquityProof: { chainId: 4663, walletAddress: W, value: '1000', canonical: true,
      timestamp: iso(time - 60000), blockNumber: 99, blockHash: hash(99), source: 'fixture:opening-equity', evidence: ['fixture:opening-equity'] } };
}
function optionsFor(values, now = time + 3600000) {
  return { now, receiptEvidence: values.map(value => receiptProof(value, now)), walletEvidence: [walletProof(values.at(-1), now)] };
}
function replayFor(values, options) {
  const proof = options.walletEvidence[0];
  return { chainId: 4663, walletAddress: W, blockNumber: proof.blockNumber, blockHash: proof.blockHash, canonical: true,
    checkedAt: iso(options.now), source: 'fixture:full-replay', evidence: ['fixture:full-replay'], complete: true,
    trades: values.flatMap((value, index) => normalizeReceiptSettlement(value.receipt, value.events,
      { ...value, ...options.receiptEvidence[index], chainId: 4663,
        evidence: [`d1:mvp_wallet_receipts:${value.receipt.transactionHash}`] }).trades) };
}
async function persist(DB, profiles, at, runId = 'fixture:projection') {
  await DB.batch(prepareWalletProjection(DB, { runId, observedAt: at, profiles }).commands);
}

test('repeated buys preserve the earliest observed entry across persisted incremental updates', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const first = await projectObservedWallets(DB, [receiptValue()], { now: time + 1000 });
  await persist(DB, first.profiles, time + 1000);
  const next = await projectObservedWallets(DB, [receiptValue('BUY', 101)], { now: time + 61000 });
  assert.equal(next.profiles[0].tokenEntries[0].firstEntryAt, iso(time));
  assert.equal(next.profiles[0].tokenEntries[0].observedAt, iso(time + 61000));
  assert.equal(next.profiles[0].netRealizedPnlUsd, null);
  assert.equal(next.profiles[0].tokenEntries[0].lastEntryAt, iso(time + 60000));
  await persist(DB, next.profiles, time + 61000, 'fixture:second-buy');
  const oldReceipt = await projectObservedWallets(DB, [receiptValue()], { now: time + 900000 });
  assert.deepEqual(oldReceipt.profiles[0].tokenEntries, next.profiles[0].tokenEntries,
    'ingesting the old receipt again cannot renew the actual entry or its observation');
});

test('canonical typed evidence forwards real financial, risk and cluster proofs without inventing eligibility', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const values = [receiptValue(), receiptValue('SELL', 110)]; const options = optionsFor(values);
  const result = await projectObservedWallets(DB, values, options); const profile = result.profiles[0];
  assert.equal(profile.netRealizedPnlUsd, '19.916'); assert.equal(profile.realizedTradeCount, 1);
  assert.equal(profile.historyComplete, true); assert.equal(profile.temporalMetricsComplete, true);
  assert.deepEqual(profile.riskFlags, { insider: false, bundler: false, washTrading: false });
  assert.equal(profile.tokenEntries[0].clusterId, 'fixture:independent-wallet-10');
  assert.equal(profile.tokenEntries[0].earlyEntry, true);
  assert.equal(profile.eligible, false, 'the independent scoring module still decides minimum trades and thresholds');
  assert.equal(result.realizedEvents.length, 1); assert.equal('realizedEvents' in profile, false);
  await persist(DB, result.profiles, options.now);
  const retry = await projectObservedWallets(DB, values, { ...options, now: options.now + 1 });
  assert.deepEqual(retry.realizedEvents, []); assert.equal(retry.profiles[0].realizedTradeCount, 1);
});

test('cross-wallet, cross-block, stale and future evidence cannot upgrade incomplete observed samples', async t => {
  const DB = setup(t); DB.sqlite.exec(schema); const values = [receiptValue(), receiptValue('SELL', 110)];
  for (const mutate of [
    o => { o.walletEvidence[0].walletAddress = TOKEN(99); },
    o => { o.walletEvidence[0].blockHash = hash(999); },
    o => { o.walletEvidence[0].checkedAt = iso(o.now + 1); },
    o => { o.walletEvidence[0].checkedAt = iso(o.now - 600001); },
    o => { o.walletEvidence[0].historyProof.scope = 'bounded-pool-sample'; },
    o => { o.receiptEvidence[0].blockHash = hash(999); },
    o => { o.receiptEvidence[1].transactionHash = hash(999); },
    o => { o.receiptEvidence[0].walletAddress = TOKEN(99); },
    o => { o.receiptEvidence[0].transactionHash = 4; },
    o => { o.walletEvidence[0].blockHash = 4; },
  ]) {
    const options = optionsFor(values); mutate(options);
    const result = await projectObservedWallets(DB, values, options);
    assert.equal(result.profiles[0].netRealizedPnlUsd, null); assert.deepEqual(result.realizedEvents, []);
    assert.equal(result.profiles[0].eligible, false);
  }
});

test('incomplete initial state upgrades only through an atomic verified full replay', async t => {
  const DB = setup(t); DB.sqlite.exec(schema); const values = [receiptValue(), receiptValue('SELL', 110)];
  const first = await projectObservedWallets(DB, [values[0]], { now: time + 1000 });
  await persist(DB, first.profiles, time + 1000);
  const options = optionsFor(values);
  const noReplay = await projectObservedWallets(DB, values, options);
  assert.equal(noReplay.profiles[0].netRealizedPnlUsd, null);
  assert.deepEqual(noReplay.profiles[0].accountingState, first.profiles[0].accountingState);
  assert.ok(noReplay.profiles[0].gaps.includes('WALLET_VERIFIED_REPLAY_REQUIRED'));
  const replay = replayFor(values, options);
  const invalid = structuredClone(replay); invalid.trades[1].quantityRaw = '0';
  const failed = await projectObservedWallets(DB, values, { ...options, replayEvidence: [invalid] });
  assert.deepEqual(failed.realizedEvents, []);
  assert.deepEqual(failed.profiles[0].accountingState, first.profiles[0].accountingState);
  assert.deepEqual(failed.profiles[0].tokenEntries, first.profiles[0].tokenEntries,
    'rejected replay cannot renew entry observation, risk or funding proof');
  const valid = await projectObservedWallets(DB, values, { ...options, replayEvidence: [replay] });
  assert.equal(valid.profiles[0].netRealizedPnlUsd, '19.916'); assert.equal(valid.profiles[0].requiresReplay, false);
  assert.equal(valid.realizedEvents.length, 1);
});

test('a full replay larger than the realization delta budget preserves the previous committed state', async t => {
  const DB = setup(t); DB.sqlite.exec(schema); const firstValue = receiptValue();
  const first = await projectObservedWallets(DB, [firstValue], { now: time + 1000 });
  await persist(DB, first.profiles, time + 1000);
  const values = Array.from({ length: 258 }, (_, index) => receiptValue(index % 2 ? 'SELL' : 'BUY', 100 + index));
  const options = optionsFor(values, time + 86400000);
  const result = await projectObservedWallets(DB, [values.at(-1)], { ...options, replayEvidence: [replayFor(values, options)] });
  assert.equal(result.profiles[0].requiresReplay, true); assert.deepEqual(result.realizedEvents, []);
  assert.deepEqual(result.profiles[0].accountingState, first.profiles[0].accountingState);
  assert.ok(result.profiles[0].gaps.includes('ACCOUNTING_REALIZATION_CAPACITY_REQUIRES_REPLAY'));
});

test('five canonical receipt settlements persist exact incremental PnL and temporal proof and rescore after restart', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  DB.sqlite.exec(await readFile(new URL('../cloudflare/migrations/0008_mvp_wallet_realizations.sql', import.meta.url), 'utf8'));
  let finalValues; let finalOptions;
  for (let index = 0; index < 5; index++) {
    const values = [receiptValue('BUY', 100 + index * 2), receiptValue('SELL', 101 + index * 2)];
    const options = optionsFor(values, time + 3600000 + index * 1000);
    const projected = await projectObservedWallets(DB, values, options);
    assert.equal(projected.realizedEvents.length, 1);
    assert.equal(projected.realizedEvents[0].disposalIndex, index + 1);
    const runId = 'fixture:incremental-cash-flow-' + index;
    const temporal = await prepareWalletTemporalUpdates(DB, { runId, observedAt: options.now,
      profiles: projected.profiles, realizedEvents: projected.realizedEvents });
    assert.equal(temporal.profiles[0].realizationHistory.complete, true);
    const ledger = prepareWalletLedger(DB, { runId, observedAt: options.now, receipts: values,
      profiles: temporal.profiles, realizedEvents: projected.realizedEvents, realizationUpdates: temporal.realizationUpdates });
    await DB.batch(ledger.commands);
    finalValues = values; finalOptions = options;
  }
  const saved = await readWalletProfile(DB, W);
  assert.equal(saved.realizedTradeCount, 5); assert.equal(saved.netRealizedPnlUsd, '99.58');
  assert.deepEqual(saved.netRealizedPnlUsdExact, { numerator: '4979', denominator: '50' });
  const [restored] = await attachWalletTemporalEvidence(DB, [saved], { now: finalOptions.now });
  assert.equal(restored.realizationHistory.complete, true);
  const scored = scoreWalletProfile(restored, { now: finalOptions.now });
  assert.ok(Number.isFinite(scored.score)); assert.ok(scored.score >= 0 && scored.score <= 100);
  assert.notEqual(scored.status, 'INCOMPLETE');
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_realizations').get().n, 5);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_receipts').get().n, 10);
  const retry = await projectObservedWallets(DB, finalValues, { ...finalOptions, now: finalOptions.now + 1 });
  assert.deepEqual(retry.realizedEvents, []);
  const temporal = await prepareWalletTemporalUpdates(DB, { runId: 'fixture:replayed-receipts', observedAt: finalOptions.now + 1,
    profiles: retry.profiles, realizedEvents: retry.realizedEvents });
  await DB.batch(prepareWalletLedger(DB, { runId: 'fixture:replayed-receipts', observedAt: finalOptions.now + 1,
    receipts: finalValues, profiles: temporal.profiles, realizedEvents: retry.realizedEvents,
    realizationUpdates: temporal.realizationUpdates }).commands);
  assert.equal((await readWalletProfile(DB, W)).netRealizedPnlUsd, '99.58');
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_realizations').get().n, 5);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM mvp_wallet_receipts').get().n, 10);
});
