import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeEventTopics } from 'viem';
import { SWAPS } from '../src/onchain/abi.mjs';
import { normalizeReceiptSettlement, computeRealizedWalletMetrics } from '../src/mvp/wallet-accounting.mjs';
import { projectObservedWallets } from '../src/mvp/wallet-runtime.mjs';
import { prepareWalletProjection } from '../src/mvp/wallet-ledger.mjs';
import { setup, TOKEN, time } from './helpers/mvp-sqlite.mjs';

const schema = await readFile(new URL('../cloudflare/migrations/0004_mvp_wallets.sql', import.meta.url), 'utf8');
const wallet = TOKEN(10); const token = TOKEN(1); const router = TOKEN(20); const manager = TOKEN(30); const zero = TOKEN(0);
const hash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const iso = at => new Date(at).toISOString();
const indexed = address => '0x' + '0'.repeat(24) + address.slice(2);
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const fee = 21000000000000n;

function nativeReceipt(side, number) {
  const block = { number, hash: hash(number), timestamp: time / 1000 + (number - 100) * 60 };
  const transactionHash = hash(number + 10000);
  const pool = { type: 'v4', address: manager, poolId: hash(900), quoteAddress: zero, tokenDecimals: 18, quoteDecimals: 18 };
  const base = { transactionHash, blockHash: block.hash, blockNumber: '0x' + number.toString(16), removed: false };
  const receipt = { ...base, status: '0x1', from: wallet, to: router,
    gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [
      { ...base, address: token, logIndex: '0x0', topics: [transferTopic,
        indexed(side === 'BUY' ? manager : wallet), indexed(side === 'BUY' ? wallet : manager)],
      data: '0x' + (10n ** 18n).toString(16).padStart(64, '0') },
      { ...base, address: manager, logIndex: '0x1', data: '0x',
        topics: encodeEventTopics({ abi: [SWAPS.v4], eventName: 'Swap', args: { id: pool.poolId, sender: router } }) },
    ] };
  const events = [{ kind: 'SWAP', chainId: 4663, transactionHash, blockNumber: number, blockHash: block.hash,
    logIndex: 1, tokenAddress: token, pool }];
  const identity = { schemaVersion: 1, chainId: 4663, walletAddress: wallet, transactionHash,
    blockNumber: number, blockHash: block.hash, canonical: true, complete: true,
    source: 'fixture:canonical-proof', evidence: ['fixture:transaction-proof'] };
  const feeProof = { ...identity, kind: 'receipt-fees/v1', coverage: 'all-transaction-fees',
    executionNativeRaw: fee.toString(), totalNativeRaw: fee.toString(),
    l1: { treatment: 'NOT_APPLICABLE', amountRaw: '0' }, otherComponents: [] };
  const net = side === 'BUY' ? -(10n ** 18n) : 12n * 10n ** 17n;
  const nativeSettlementProof = { ...identity, kind: 'native-settlement/v1', method: 'transaction-balance-diff', fees: feeProof,
    transaction: { chainId: 4663, hash: transactionHash, from: wallet, to: router,
      value: net < 0n ? (-net).toString() : '0', blockNumber: base.blockNumber, blockHash: block.hash },
    balanceDiff: { scope: 'transaction', complete: true, beforeRaw: '10000000000000000000',
      afterRaw: (10000000000000000000n + net - fee).toString() } };
  const price = { chainId: 4663, assetAddress: zero, value: '2000', observedAt: iso(block.timestamp * 1000),
    blockNumber: number, blockHash: block.hash, source: 'fixture:price', evidence: ['fixture:price'] };
  const evidence = { ...identity, checkedAt: iso(time + 3600000), nativeSettlementProof, feeProof,
    valuation: { quoteUsd: price, feeAssetUsd: price }, deployment: {
      chainId: 4663, canonical: true, kind: 'direct-creation-receipt', address: token,
      blockNumber: 90, blockHash: hash(90), transactionHash: hash(9090), timestamp: iso(time - 1000),
      source: 'fixture:deployment', evidence: ['fixture:deployment'] } };
  return { receipt, events, pool, block, tokenAddress: token, source: 'fixture:receipt', evidence };
}

function windowFor(value) {
  const end = value.block.timestamp * 1000;
  return { schemaVersion: 1, scope: 'declared-window', chainId: 4663, walletAddress: wallet, days: 30,
    startAt: iso(end - 30 * 86400000), endAt: iso(end), fromBlock: 10, fromBlockHash: hash(10),
    toBlock: value.block.number, toBlockHash: value.block.hash, complete: true, contiguous: true,
    canonical: true, openingBalanceKnown: true, source: 'fixture:window', evidence: ['fixture:window'],
    openingBalanceProof: { schemaVersion: 1, scope: 'opening-balances', chainId: 4663, walletAddress: wallet,
      blockNumber: 9, blockHash: hash(9), canonical: true, complete: true, nativeRaw: '10000000000000000000',
      assets: [], source: 'fixture:opening', evidence: ['fixture:opening'] } };
}

function optionsFor(values) {
  const last = values.at(-1); const historyWindow = windowFor(last);
  return { now: time + 3600000, receiptEvidence: values.map(value => value.evidence), walletEvidence: [{
    chainId: 4663, walletAddress: wallet, blockNumber: last.block.number, blockHash: last.block.hash,
    canonical: true, checkedAt: iso(time + 3600000), source: 'fixture:wallet', evidence: ['fixture:wallet'],
    historyWindow, feesComplete: true, attributionComplete: true,
    openingEquityProof: { chainId: 4663, walletAddress: wallet, value: '20000', canonical: true,
      timestamp: historyWindow.startAt, blockNumber: 9, blockHash: hash(9), source: 'fixture:equity', evidence: ['fixture:equity'] },
  }] };
}
const normalize = value => normalizeReceiptSettlement(value.receipt, value.events, { ...value, ...value.evidence });

test('native v4 normalization requires transaction-specific evidence and charges the proved fee once', () => {
  const value = nativeReceipt('BUY', 100); const complete = normalize(value);
  assert.equal(complete.status, 'SETTLED');
  assert.equal(complete.trades[0].quoteAddress, zero);
  assert.equal(complete.trades[0].quoteDecimals, 18);
  assert.equal(complete.trades[0].quoteUsdValue, '2000');
  assert.equal(complete.trades[0].feeUsdValue, '0.042');
  const missing = normalizeReceiptSettlement(value.receipt, value.events, value);
  assert.equal(missing.status, 'INCOMPLETE'); assert.deepEqual(missing.trades, []);
  value.evidence.nativeSettlementProof.balanceDiff.scope = 'block';
  assert.equal(normalize(value).status, 'INCOMPLETE');
});

test('runtime forwards native proof into exact declared-window accounting and persists it across restart', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const values = [nativeReceipt('BUY', 100), nativeReceipt('SELL', 110)]; const options = optionsFor(values);
  const result = await projectObservedWallets(DB, values, options); const profile = result.profiles[0];
  assert.equal(profile.historyWindow.complete, true); assert.equal(profile.historyComplete, true);
  assert.equal(profile.realizedTradeCount, 1); assert.equal(profile.netRealizedPnlUsd, '399.916');
  assert.equal(result.realizedEvents.length, 1);
  await DB.batch(prepareWalletProjection(DB, { runId: 'native-window', observedAt: options.now, profiles: result.profiles }).commands);
  const restart = await projectObservedWallets(DB, values, { ...options, now: options.now + 1 });
  assert.equal(restart.profiles[0].netRealizedPnlUsd, '399.916');
  assert.deepEqual(restart.profiles[0].accountingState, profile.accountingState);
  assert.deepEqual(restart.realizedEvents, []);
});

test('runtime keeps partial window metadata without treating asserted range flags as coverage', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const values = [nativeReceipt('BUY', 100)]; const options = optionsFor(values);
  options.walletEvidence[0].historyWindow.fromBlock = null;
  options.walletEvidence[0].historyWindow.fromBlockHash = null;
  const result = await projectObservedWallets(DB, values, options); const profile = result.profiles[0];
  assert.equal(profile.historyWindow.boundaryResolved, false);
  assert.equal(profile.historyComplete, false); assert.equal(profile.netRealizedPnlUsd, null);
  assert.ok(profile.collectionGaps.includes('WALLET_DECLARED_WINDOW_INCOMPLETE'));
});

test('backfill descriptors remain visible before the fixed end receipt and cannot establish financial coverage', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const value = nativeReceipt('BUY', 100); const descriptor = windowFor(nativeReceipt('SELL', 110));
  descriptor.scanComplete = true;
  descriptor.scanCoverage = { scope: 'erc20-transfer-from-to', complete: true };
  descriptor.financialCoverage = { complete: false, nativeHistoryComplete: false };
  const options = { now: time + 3600000, receiptEvidence: [value.evidence], historyWindows: [descriptor] };
  const result = await projectObservedWallets(DB, [value], options); const profile = result.profiles[0];
  assert.equal(profile.historyWindow.toBlock, 110);
  assert.equal(profile.historyWindow.scanCoverage.complete, true);
  assert.equal(profile.historyWindow.complete, false);
  assert.equal(profile.historyComplete, false); assert.equal(profile.netRealizedPnlUsd, null);
  assert.equal((await projectObservedWallets(DB, [], options)).profiles.length, 0);
});

test('runtime requires window-bound verified replay for a change and preserves the checkpoint on replay failure', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const firstValues = [nativeReceipt('BUY', 100)]; const firstOptions = optionsFor(firstValues);
  const first = await projectObservedWallets(DB, firstValues, firstOptions);
  await DB.batch(prepareWalletProjection(DB, { runId: 'before-window-shift', observedAt: firstOptions.now, profiles: first.profiles }).commands);
  const values = [firstValues[0], nativeReceipt('SELL', 110)]; const options = optionsFor(values);
  const replay = { ...options.walletEvidence[0], complete: true, trades: values.flatMap(value => normalize(value).trades) };
  for (const evidence of [[], [{ ...replay, historyWindow: undefined }],
    [{ ...replay, trades: [replay.trades[0], { ...replay.trades[1], quantityRaw: '0' }] }]]) {
    const result = await projectObservedWallets(DB, values, { ...options, replayEvidence: evidence });
    assert.equal(result.profiles[0].requiresReplay, true);
    assert.deepEqual(result.profiles[0].accountingState, first.profiles[0].accountingState);
    assert.deepEqual(result.realizedEvents, []);
  }
  const accepted = await projectObservedWallets(DB, values, { ...options, replayEvidence: [replay] });
  assert.equal(accepted.profiles[0].requiresReplay, false);
  assert.equal(accepted.profiles[0].netRealizedPnlUsd, '399.916');
  assert.equal(accepted.profiles[0].historyWindow.toBlock, 110);
});

test('a verified lifetime replay replaces the declared window and includes earlier lifetime trades', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const values = [nativeReceipt('BUY', 100), nativeReceipt('SELL', 110)]; const options = optionsFor(values);
  const first = await projectObservedWallets(DB, values, options);
  await DB.batch(prepareWalletProjection(DB, { runId: 'window-before-lifetime', observedAt: options.now, profiles: first.profiles }).commands);
  const lifetime = { ...options.walletEvidence[0], historyProof: {
    scope: 'wallet-lifetime', fromBlock: 0, toBlock: 110, toBlockHash: hash(110),
    complete: true, contiguous: true, canonical: true, openingBalanceKnown: true,
    evidence: ['fixture:lifetime-coverage'],
  }, openingEquityProof: { ...options.walletEvidence[0].openingEquityProof,
    blockNumber: 0, blockHash: hash(9000), timestamp: iso(time - 7200000) } };
  delete lifetime.historyWindow;
  const lifetimeTrades = [nativeReceipt('BUY', 1), nativeReceipt('SELL', 2), ...values]
    .flatMap(value => normalize(value).trades);
  const replay = { ...lifetime, complete: true, trades: lifetimeTrades };
  const result = await projectObservedWallets(DB, values, { ...options, walletEvidence: [lifetime], replayEvidence: [replay] });
  assert.equal(result.profiles[0].requiresReplay, false);
  assert.equal(result.profiles[0].historyComplete, true);
  assert.equal(result.profiles[0].realizedTradeCount, 2);
  assert.equal(result.profiles[0].netRealizedPnlUsd, '799.832');
  assert.equal(Object.hasOwn(result.profiles[0], 'historyWindow'), false);
  assert.equal(Object.hasOwn(result.profiles[0].accountingState, 'historyWindow'), false);
});

test('a missing or failed lifetime replay preserves the previous declared-window checkpoint', async t => {
  const DB = setup(t); DB.sqlite.exec(schema);
  const values = [nativeReceipt('BUY', 100), nativeReceipt('SELL', 110)]; const options = optionsFor(values);
  const first = await projectObservedWallets(DB, values, options);
  await DB.batch(prepareWalletProjection(DB, { runId: 'window-kept-on-lifetime-failure', observedAt: options.now, profiles: first.profiles }).commands);
  const lifetime = { ...options.walletEvidence[0], historyProof: {
    scope: 'wallet-lifetime', fromBlock: 0, toBlock: 110, toBlockHash: hash(110),
    complete: true, contiguous: true, canonical: true, openingBalanceKnown: true,
    evidence: ['fixture:lifetime-coverage'],
  } };
  delete lifetime.historyWindow;
  const replay = { ...lifetime, complete: true,
    trades: values.flatMap(value => normalize(value).trades).map((trade, index) => index ? { ...trade, quantityRaw: '0' } : trade) };
  for (const replayEvidence of [[], [replay]]) {
    const result = await projectObservedWallets(DB, values, { ...options, walletEvidence: [lifetime], replayEvidence });
    assert.equal(result.profiles[0].requiresReplay, true);
    assert.equal(result.profiles[0].historyComplete, false);
    assert.equal(result.profiles[0].netRealizedPnlUsd, null);
    assert.deepEqual(result.profiles[0].accountingState, first.profiles[0].accountingState);
    assert.deepEqual(result.realizedEvents, []);
  }
});

test('an unverified native quote cannot enter FIFO accounting through a legacy normalized trade', () => {
  const buy = normalize(nativeReceipt('BUY', 100)).trades[0];
  delete buy.nativeSettlementVerified;
  const profile = computeRealizedWalletMetrics([buy], { walletAddress: wallet, now: time + 3600000 });
  assert.equal(profile.requiresReplay, true);
  assert.ok(profile.gaps.includes('AMBIGUOUS_ACCOUNTING_QUOTE'));
});
