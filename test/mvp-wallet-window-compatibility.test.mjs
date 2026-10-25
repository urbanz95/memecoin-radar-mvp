import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRealizedWalletMetrics } from '../src/mvp/wallet-accounting.mjs';

const wallet = '0x' + '1'.repeat(40);
const token = '0x' + '2'.repeat(40);
const quote = '0x' + '3'.repeat(40);
const zero = '0x' + '0'.repeat(40);
const hash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const at = Date.parse('2026-10-25T12:00:00Z');
const iso = value => new Date(value).toISOString();
function trade(number, side, address = token) {
  const timestamp = at - 3600000 + number * 1000;
  const price = assetAddress => ({ chainId: 4663, assetAddress, value: '1',
    observedAt: iso(timestamp), blockNumber: number, blockHash: hash(number), source: 'fixture:price', evidence: ['fixture:price'] });
  return { schemaVersion: 1, kind: 'TRADE', id: `fixture:${number}`, chainId: 4663, walletAddress: wallet,
    tokenAddress: address, quoteAddress: quote, tokenDecimals: 0, quoteDecimals: 0,
    side, quantityRaw: '1', quoteAmountRaw: side === 'BUY' ? '10' : '20', feeNativeRaw: '0',
    quoteUsdProof: price(quote), feeAssetUsdProof: price(zero), timestamp: iso(timestamp),
    blockNumber: number, blockHash: hash(number), transactionHash: hash(number + 10000), logIndex: 0,
    attributionComplete: true, feesComplete: true, deploymentAt: iso(timestamp - 1000),
    source: 'fixture:trade', evidence: ['fixture:trade'] };
}
function options(extra = {}) {
  return { walletAddress: wallet, chainId: 4663, now: at, historyComplete: true,
    historyProof: { complete: true, contiguous: true, canonical: true, openingBalanceKnown: true, evidence: ['fixture:lifetime'] },
    feesComplete: true, attributionComplete: true, clusteringComplete: true, initialEquityUsd: '1000',
    openingEquityProof: { chainId: 4663, walletAddress: wallet, value: '1000', canonical: true,
      timestamp: iso(at - 86400000), blockNumber: 9, blockHash: hash(9), source: 'fixture:equity', evidence: ['fixture:equity'] },
    ...extra };
}

test('existing lifetime FIFO remains exact and cannot accept an unmatched sale as zero-cost profit', () => {
  const matched = computeRealizedWalletMetrics([trade(100, 'BUY'), trade(110, 'SELL')], options());
  assert.equal(matched.netRealizedPnlUsd, '10');
  assert.equal(matched.realizedTradeCount, 1);
  const missing = computeRealizedWalletMetrics([trade(110, 'SELL')], options());
  assert.equal(missing.netRealizedPnlUsd, null);
  assert.equal(missing.costsComplete, false);
});

test('an existing incomplete lifetime checkpoint needs replay before later proof can complete it', () => {
  const first = computeRealizedWalletMetrics([trade(100, 'BUY')], options({ historyComplete: false }));
  const later = computeRealizedWalletMetrics([trade(110, 'SELL')], options({ previousState: first.state }));
  assert.equal(later.historyComplete, false);
  assert.equal(later.netRealizedPnlUsd, null);
});
