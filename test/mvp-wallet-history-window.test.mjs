import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistoryWindow, historyWindowComplete, historyWindowKey } from '../src/mvp/wallet-history-window.mjs';
import { computeRealizedWalletMetrics } from '../src/mvp/wallet-accounting.mjs';

const wallet = '0x' + '1'.repeat(40);
const token = '0x' + '2'.repeat(40);
const quote = '0x' + '3'.repeat(40);
const otherToken = '0x' + '4'.repeat(40);
const zero = '0x' + '0'.repeat(40);
const hash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const now = Date.parse('2026-10-25T12:00:00Z');
const iso = value => new Date(value).toISOString();
const start = now - 30 * 86400000;
const anchor = { number: 1000, hash: hash(1000), timestamp: now / 1000 };

function windowProof(extra = {}) {
  return { schemaVersion: 1, scope: 'declared-window', chainId: 4663, walletAddress: wallet,
    days: 30, startAt: iso(start), endAt: iso(now), fromBlock: 100, fromBlockHash: hash(100),
    toBlock: anchor.number, toBlockHash: anchor.hash, complete: true, contiguous: true,
    canonical: true, openingBalanceKnown: true, source: 'fixture:canonical-window',
    evidence: ['fixture:window-coverage'], openingBalanceProof: {
      schemaVersion: 1, scope: 'opening-balances', chainId: 4663, walletAddress: wallet,
      blockNumber: 99, blockHash: hash(99), canonical: true, complete: true,
      nativeRaw: '1000000000000000000', assets: [], source: 'fixture:opening-balances',
      evidence: ['fixture:opening-balances'] }, ...extra };
}

function trade(number, side, tokenAddress = token) {
  const timestamp = now - 3600000 + number * 1000;
  const price = assetAddress => ({ chainId: 4663, assetAddress, value: '1',
    observedAt: iso(timestamp), blockNumber: number, blockHash: hash(number),
    source: 'fixture:price', evidence: ['fixture:price'] });
  return { schemaVersion: 1, kind: 'TRADE', id: `fixture:${number}`, chainId: 4663, walletAddress: wallet,
    tokenAddress, quoteAddress: quote, tokenDecimals: 0, quoteDecimals: 0,
    side, quantityRaw: '1', quoteAmountRaw: side === 'BUY' ? '10' : '20', feeNativeRaw: '0',
    quoteUsdProof: price(quote), feeAssetUsdProof: price(zero), timestamp: iso(timestamp),
    blockNumber: number, blockHash: hash(number), transactionHash: hash(number + 10000), logIndex: 0,
    attributionComplete: true, feesComplete: true, deploymentAt: iso(timestamp - 1000),
    source: 'fixture:trade', evidence: ['fixture:trade'] };
}

function options(extra = {}) {
  return { walletAddress: wallet, chainId: 4663, now, historyComplete: true,
    historyWindow: windowProof(), feesComplete: true, attributionComplete: true,
    clusteringComplete: true, initialEquityUsd: '1000', openingEquityProof: {
      chainId: 4663, walletAddress: wallet, value: '1000', canonical: true,
      timestamp: iso(start), blockNumber: 99, blockHash: hash(99),
      source: 'fixture:equity', evidence: ['fixture:equity'] }, ...extra };
}

test('a declared thirty-day window binds its canonical end anchor and opening balances', () => {
  const normalized = normalizeHistoryWindow(windowProof(), { walletAddress: wallet, now, anchor });
  assert.equal(historyWindowComplete(normalized), true);
  assert.equal(normalized.boundaryResolved, true);
  assert.equal(normalized.openingBalanceProof.blockNumber, 99);
  assert.equal(historyWindowKey(normalized), historyWindowKey(windowProof()));
  assert.equal(normalizeHistoryWindow(windowProof(), { walletAddress: wallet, now,
    anchor: { ...anchor, hash: hash(1001) } }), null);
  assert.equal(normalizeHistoryWindow(windowProof({ days: 29 }), { walletAddress: wallet, now }), null);
  assert.equal(normalizeHistoryWindow(windowProof({ startAt: iso(start + 1000) }), { walletAddress: wallet, now }), null);
});

test('coverage flags alone cannot replace a canonical opening-balance proof', () => {
  for (const change of [
    value => { delete value.openingBalanceProof; },
    value => { value.openingBalanceProof.complete = false; },
    value => { value.openingBalanceProof.canonical = false; },
    value => { value.openingBalanceProof.walletAddress = otherToken; },
    value => { value.openingBalanceProof.blockNumber = 100; },
    value => { value.openingBalanceProof.assets = [{ assetAddress: token, quantityRaw: '-1' }]; },
    value => { value.openingBalanceProof.assets = [
      { assetAddress: token, quantityRaw: '1' }, { assetAddress: token.toUpperCase().replace('0X', '0x'), quantityRaw: '1' }]; },
    value => { value.contiguous = false; },
    value => { value.canonical = false; },
  ]) {
    const value = windowProof(); change(value);
    const normalized = normalizeHistoryWindow(value, { walletAddress: wallet, now });
    assert.ok(normalized, 'a valid range retains its incomplete evidence metadata');
    assert.equal(historyWindowComplete(normalized), false);
    assert.equal(normalized.complete, false);
  }
});

test('an unresolved start boundary stays visible and incomplete despite asserted coverage', () => {
  const partial = windowProof({ fromBlock: null, fromBlockHash: null });
  const normalized = normalizeHistoryWindow(partial, { walletAddress: wallet, now, anchor });
  assert.equal(normalized.fromBlock, null);
  assert.equal(normalized.boundaryResolved, false);
  assert.equal(normalized.openingBalanceKnown, false);
  assert.equal(normalized.complete, false);
  const profile = computeRealizedWalletMetrics([trade(110, 'BUY'), trade(120, 'SELL')], options({ historyWindow: partial }));
  assert.equal(profile.historyWindow.fromBlock, null);
  assert.equal(profile.historyWindow.complete, false);
  assert.equal(profile.state.historyWindow.fromBlock, null);
  assert.equal(profile.historyComplete, false);
  assert.equal(profile.netRealizedPnlUsd, null);
});

test('complete window accounting counts matched FIFO sales without requiring a lifetime proof', () => {
  const profile = computeRealizedWalletMetrics([trade(110, 'BUY'), trade(120, 'SELL')], options());
  assert.equal(profile.historyComplete, true);
  assert.equal(profile.historyWindow.complete, true);
  assert.equal(profile.state.historyWindow.complete, true);
  assert.equal(profile.realizedTradeCount, 1);
  assert.equal(profile.netRealizedPnlUsd, '10');
  assert.equal(profile.observedCounts.excludedSells, 0);
});

test('the lifetime interface omits window-only metadata and counters', () => {
  const lifetime = options(); delete lifetime.historyWindow;
  lifetime.historyProof = { complete: true, contiguous: true, canonical: true,
    openingBalanceKnown: true, evidence: ['fixture:lifetime-coverage'] };
  const profile = computeRealizedWalletMetrics([trade(110, 'BUY'), trade(120, 'SELL')], lifetime);
  assert.equal(profile.netRealizedPnlUsd, '10');
  assert.equal(profile.realizedTradeCount, 1);
  assert.equal(Object.hasOwn(profile, 'historyWindow'), false);
  assert.equal(Object.hasOwn(profile.state, 'historyWindow'), false);
  assert.equal(Object.hasOwn(profile.observedCounts, 'excludedSells'), false);
});

test('a sale with no in-window acquisition is reported and excluded from realized PnL and count', () => {
  const profile = computeRealizedWalletMetrics([
    trade(105, 'SELL'), trade(110, 'BUY', otherToken), trade(120, 'SELL', otherToken),
  ], options());
  assert.equal(profile.realizedTradeCount, 1);
  assert.equal(profile.netRealizedPnlUsd, '10');
  assert.equal(profile.observedCounts.sells, 2);
  assert.equal(profile.observedCounts.disposals, 1);
  assert.equal(profile.observedCounts.excludedSells, 1);
  assert.ok(profile.gaps.includes('WALLET_WINDOW_SALE_WITHOUT_KNOWN_COST'));
});

test('an incoming transfer with unknown acquisition cost cannot qualify a window sale', () => {
  const incoming = { ...trade(110, 'BUY'), kind: 'TRANSFER', direction: 'IN' };
  delete incoming.side;
  const profile = computeRealizedWalletMetrics([incoming, trade(120, 'SELL')], options());
  assert.equal(profile.observedCounts.disposals, 0);
  assert.equal(profile.observedCounts.excludedSells, 1);
  assert.equal(profile.netRealizedPnlUsd, null);
  assert.ok(profile.gaps.includes('WALLET_WINDOW_SALE_WITHOUT_KNOWN_COST'));
});

test('a changed declared window cannot extend a prior FIFO checkpoint without replay', () => {
  const first = computeRealizedWalletMetrics([trade(110, 'BUY')], options());
  const shifted = windowProof({ startAt: iso(start + 1000), endAt: iso(now + 1000),
    toBlock: 1001, toBlockHash: hash(1001) });
  const next = computeRealizedWalletMetrics([trade(120, 'SELL')], options({
    now: now + 1000, historyWindow: shifted, previousState: first.state,
  }));
  assert.equal(next.requiresReplay, true);
  assert.deepEqual(next.state, first.state);
  assert.equal(next.realizedTradeCount, null);
  assert.equal(next.netRealizedPnlUsd, null);
});

test('opening inventory stays unknown-cost FIFO inventory and cannot borrow a later purchase basis', () => {
  const window = windowProof();
  window.openingBalanceProof.assets = [{ assetAddress: token, quantityRaw: '1' }];
  const profile = computeRealizedWalletMetrics([
    trade(110, 'BUY'), trade(120, 'SELL'), trade(130, 'SELL'),
  ], options({ historyWindow: window }));
  assert.equal(profile.observedCounts.excludedSells, 1);
  assert.equal(profile.realizedTradeCount, 1);
  assert.equal(profile.netRealizedPnlUsd, '10');
});

test('an acquisition outside the declared range cannot qualify a window sale', () => {
  const outside = trade(90, 'BUY');
  const profile = computeRealizedWalletMetrics([outside, trade(120, 'SELL')], options());
  assert.equal(profile.observedCounts.buys, 0);
  assert.equal(profile.realizedTradeCount, 0);
  assert.equal(profile.netRealizedPnlUsd, null);
  assert.equal(profile.observedCounts.excludedSells, 1);
});

test('a conflicting canonical range boundary preserves the prior checkpoint for replay', () => {
  const first = computeRealizedWalletMetrics([trade(110, 'BUY')], options());
  const conflicting = { ...trade(1000, 'SELL'), blockHash: hash(1001) };
  const result = computeRealizedWalletMetrics([conflicting], options({ previousState: first.state }));
  assert.equal(result.requiresReplay, true);
  assert.ok(result.gaps.includes('ACCOUNTING_WINDOW_BLOCK_MISMATCH'));
  assert.deepEqual(result.state, first.state);
});
