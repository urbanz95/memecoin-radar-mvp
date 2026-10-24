import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { SWAPS, topic } from '../src/onchain/abi.mjs';
import { normalizeReceiptSettlement, computeRealizedWalletMetrics } from '../src/mvp/wallet-accounting.mjs';

const W = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const QUOTE = '0x3333333333333333333333333333333333333333';
const POOL = '0x4444444444444444444444444444444444444444';
const ROUTER = '0x5555555555555555555555555555555555555555';
const ZERO = '0x' + '0'.repeat(40);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const t0 = Date.parse('2026-10-23T14:00:00Z');
const iso = time => new Date(time).toISOString();
const indexed = address => '0x' + '0'.repeat(24) + address.slice(2);
const proof = (assetAddress, block, value) => ({ chainId: 4663, assetAddress, value,
  observedAt: iso(block.timestamp * 1000), blockNumber: block.number, blockHash: block.hash,
  source: 'fixture-historical-price', evidence: ['fixture:historical-price'] });
function fixture(side = 'BUY', number = 100, quoteRaw = side === 'BUY' ? '100000000' : '120000000') {
  const block = { number, hash: hash(number), timestamp: Math.floor(t0 / 1000) + (number - 100) * 60 };
  const tx = hash(number + 10000);
  const base = { blockNumber: '0x' + number.toString(16), blockHash: block.hash, transactionHash: tx, transactionIndex: '0x0', removed: false };
  const transfer = (asset, from, to, amount, index) => ({ ...base, address: asset, logIndex: '0x' + index.toString(16),
    topics: [TRANSFER, indexed(from), indexed(to)], data: '0x' + BigInt(amount).toString(16).padStart(64, '0') });
  const swap = { ...base, address: POOL, logIndex: '0x2', topics: encodeEventTopics({ abi: [SWAPS.v2], eventName: 'Swap', args: { sender: ROUTER, to: W } }),
    data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), side === 'BUY' ? [BigInt(quoteRaw), 0n, 0n, 10n ** 19n] : [0n, 10n ** 19n, BigInt(quoteRaw), 0n]) };
  const receipt = { status: '0x1', from: W, to: ROUTER, transactionHash: tx, blockNumber: base.blockNumber,
    blockHash: block.hash, transactionIndex: '0x0', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [
      transfer(TOKEN, side === 'BUY' ? POOL : W, side === 'BUY' ? W : POOL, '10000000000000000000', 0),
      transfer(QUOTE, side === 'BUY' ? W : POOL, side === 'BUY' ? POOL : W, quoteRaw, 1), swap,
    ] };
  const event = { kind: 'SWAP', chainId: 4663, transactionHash: tx, blockNumber: number, blockHash: block.hash, logIndex: 2,
    address: POOL, tokenAddress: TOKEN, pool: { type: 'v2', address: POOL, token0: QUOTE, token1: TOKEN,
      quoteAddress: QUOTE, tokenDecimals: 18, quoteDecimals: 6 } };
  const context = { chainId: 4663, block, pool: event.pool, tokenAddress: TOKEN, now: block.timestamp * 1000,
    feeComponentsComplete: true, evidence: ['fixture:receipt:' + tx],
    valuation: { quoteUsd: proof(QUOTE, block, '1'), feeAssetUsd: proof(ZERO, block, '2000') },
    deployment: { kind: 'direct-creation-receipt', address: TOKEN, blockNumber: 90, blockHash: hash(90), transactionHash: hash(9000),
      timestamp: iso(t0 - 180000), evidence: ['fixture:creation'] } };
  return { receipt, events: [event], context };
}
const normalize = f => normalizeReceiptSettlement(f.receipt, f.events, f.context);
const complete = overrides => ({ walletAddress: W, chainId: 4663, now: t0 + 3600000,
  historyComplete: true, historyProof: { complete: true, contiguous: true, canonical: true, openingBalanceKnown: true, evidence: ['fixture:full-history'] },
  feesComplete: true, attributionComplete: true, clusteringComplete: true,
  initialEquityUsd: '1000', riskFlags: { insider: false, bundler: false, washTrading: false }, riskEvidence: ['fixture:risk-assessment'], ...overrides });

test('receipt settlement attributes one swap only from opposing wallet net transfers and accounts gas once', () => {
  const result = normalize(fixture());
  assert.equal(result.status, 'SETTLED'); assert.equal(result.attributionComplete, true); assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.walletAddress, W); assert.equal(trade.side, 'BUY');
  assert.equal(trade.quantityRaw, '10000000000000000000'); assert.equal(trade.quoteAmountRaw, '100000000');
  assert.equal(trade.quoteUsdValue, '100'); assert.equal(trade.feeNativeRaw, '21000000000000');
  assert.equal(trade.feeUsdValue, '0.042'); assert.equal(trade.feesComplete, true);
});

test('receipt.from, router recipients and a swap log alone never prove wallet settlement', () => {
  const f = fixture();
  f.receipt.logs = f.receipt.logs.filter(log => log.address !== QUOTE);
  const result = normalize(f);
  assert.equal(result.attributionComplete, false); assert.equal(result.trades.length, 0);
});

test('multiple swaps, native quotes, failed receipts and mismatched canonical identities fail closed', () => {
  for (const mutate of [
    f => f.receipt.logs.push({ ...f.receipt.logs[2], logIndex: '0x3' }),
    f => { f.context.pool.quoteAddress = ZERO; },
    f => { f.receipt.status = '0x0'; },
    f => { f.receipt.blockHash = hash(999); },
    f => { f.receipt.logs[0].transactionHash = hash(999); },
  ]) {
    const f = fixture(); mutate(f); const result = normalize(f);
    assert.equal(result.attributionComplete, false); assert.equal(result.trades.length, 0);
  }
});

test('unknown or future USD prices and incomplete fee components remain null, never assumed one dollar or free gas', () => {
  for (const mutate of [
    f => { f.context.valuation = {}; },
    f => { f.context.valuation.quoteUsd.observedAt = iso(t0 + 1000); },
    f => { f.context.valuation.quoteUsd.assetAddress = TOKEN; },
  ]) {
    const f = fixture(); mutate(f); const trade = normalize(f).trades[0];
    assert.equal(trade.quoteUsdValue, null); assert.equal(trade.costsComplete, false);
  }
  const f = fixture(); f.context.feeComponentsComplete = false;
  const trade = normalize(f).trades[0];
  assert.equal(trade.feeUsdValue, null); assert.equal(trade.feesComplete, false);
});

test('FIFO net realized PnL includes buy and sell fees once with actual holding and entry proof', () => {
  const buy = normalize(fixture()).trades[0];
  const sell = normalize(fixture('SELL', 110)).trades[0];
  const profile = computeRealizedWalletMetrics([buy, sell], complete());
  assert.equal(profile.realizedTradeCount, 1); assert.equal(profile.netRealizedPnlUsd, '19.916');
  assert.equal(profile.winRatePct, 100); assert.equal(profile.avgHoldingSeconds, 600);
  assert.equal(profile.earlyEntryPct, 100); assert.equal(profile.maxDrawdownPct, 0);
  assert.equal(profile.lastRealizedAt, sell.timestamp); assert.equal(profile.historyComplete, true);
});

test('partial disposals allocate FIFO cost basis exactly without rounding fractional profit before summing', () => {
  const buy = normalize(fixture()).trades[0];
  buy.quantityRaw = '3'; buy.tokenDecimals = 0; buy.quoteAmountRaw = '1000000';
  buy.quoteUsdValue = '1'; buy.feeNativeRaw = '0'; buy.feeUsdValue = '0';
  const sells = [110, 111, 112].map(number => {
    const trade = normalize(fixture('SELL', number, '1000000')).trades[0];
    return { ...trade, quantityRaw: '1', tokenDecimals: 0, feeNativeRaw: '0', feeUsdValue: '0' };
  });
  const profile = computeRealizedWalletMetrics([buy, ...sells], complete());
  assert.equal(profile.realizedTradeCount, 3); assert.equal(profile.netRealizedPnlUsd, '2');
  assert.equal(profile.state.lots.length, 0);
});

test('incomplete history, unknown basis, fees or attribution never become zero or scored complete metrics', () => {
  const trades = [normalize(fixture()).trades[0], normalize(fixture('SELL', 110)).trades[0]];
  for (const options of [complete({ historyComplete: false }), complete({ feesComplete: false }), complete({ attributionComplete: false })]) {
    const profile = computeRealizedWalletMetrics(trades, options);
    assert.equal(profile.netRealizedPnlUsd, null); assert.equal(profile.winRatePct, null);
  }
  const unknown = computeRealizedWalletMetrics([trades[1]], complete());
  assert.equal(unknown.netRealizedPnlUsd, null); assert.equal(unknown.costsComplete, false);
  const raw = computeRealizedWalletMetrics(trades, { walletAddress: W, now: t0 + 3600000 });
  assert.equal(raw.riskFlags, null); assert.equal(raw.clusteringComplete, false);
});

test('foreign transfers have unknown basis and are not counted as realized trades', () => {
  const sell = normalize(fixture('SELL', 110)).trades[0];
  const transfer = { ...normalize(fixture()).trades[0], kind: 'TRANSFER', direction: 'IN' };
  const profile = computeRealizedWalletMetrics([transfer, sell], complete());
  assert.equal(profile.netRealizedPnlUsd, null); assert.equal(profile.costsComplete, false);
  assert.equal(profile.observedCounts.transfers, 1); assert.equal(profile.observedCounts.buys, 0);
});

test('incremental FIFO state survives restart and duplicate events are idempotent', () => {
  const buy = normalize(fixture()).trades[0]; const sell = normalize(fixture('SELL', 110)).trades[0];
  const first = computeRealizedWalletMetrics([buy], complete());
  const second = computeRealizedWalletMetrics([buy, sell], complete({ previousState: JSON.parse(JSON.stringify(first.state)) }));
  assert.equal(second.netRealizedPnlUsd, '19.916'); assert.equal(second.realizedTradeCount, 1);
  assert.equal(second.observedCounts.buys, 1); assert.equal(second.observedCounts.sells, 1);
  assert.doesNotThrow(() => JSON.stringify(second));
});

test('conflicting duplicate, out-of-order events, a reorg or an explicit capacity overflow require replay', () => {
  const buy = normalize(fixture()).trades[0]; const sell = normalize(fixture('SELL', 110)).trades[0];
  const first = computeRealizedWalletMetrics([buy, sell], complete());
  for (const [trades, extra] of [
    [[{ ...sell, quantityRaw: '1' }], {}],
    [[{ ...buy, id: 'previously-unseen-old-event' }], {}],
    [[], { reorgDetected: true }],
    [[...Array(513)].map(() => buy), {}],
  ]) {
    const result = computeRealizedWalletMetrics(trades, complete({ previousState: first.state, ...extra }));
    assert.equal(result.requiresReplay, true); assert.equal(result.netRealizedPnlUsd, null);
    assert.deepEqual(result.state, first.state, 'a replay request preserves the last committed cursor, lots and counts');
  }
});

test('an incomplete initial history cannot become complete merely by supplying a later flag', () => {
  const buy = normalize(fixture()).trades[0]; const sell = normalize(fixture('SELL', 110)).trades[0];
  const first = computeRealizedWalletMetrics([buy], complete({ historyProof: undefined }));
  const second = computeRealizedWalletMetrics([sell], complete({ previousState: first.state }));
  assert.equal(second.historyComplete, false); assert.equal(second.netRealizedPnlUsd, null);
});

test('invalid persisted fractions fail closed and do not create a positive PnL', () => {
  const buy = normalize(fixture()).trades[0]; const state = computeRealizedWalletMetrics([buy], complete()).state;
  state.lots[0].cost = { n: '-100', d: '1' };
  const result = computeRealizedWalletMetrics([normalize(fixture('SELL', 110)).trades[0]], complete({ previousState: state }));
  assert.equal(result.requiresReplay, true); assert.equal(result.netRealizedPnlUsd, null);
});

test('bounded FIFO capacity requests replay without truncating open lots or advancing committed counts', () => {
  const first = computeRealizedWalletMetrics(normalize(fixture()).trades, complete());
  const trades = Array.from({ length: 200 }, (_, index) => normalize(fixture('BUY', index + 101)).trades[0]);
  const result = computeRealizedWalletMetrics(trades, complete({ previousState: first.state, now: t0 + 86400000 }));
  assert.equal(result.requiresReplay, true); assert.ok(result.gaps.includes('ACCOUNTING_CAPACITY_REQUIRES_REPLAY'));
  assert.deepEqual(result.state, first.state); assert.equal(result.observedCounts.buys, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result.state)) <= 16384);
});

test('holding age and drawdown remain unknown without real creation or opening equity evidence', () => {
  const buy = normalize(fixture()).trades[0]; delete buy.deploymentAt;
  const sell = normalize(fixture('SELL', 110)).trades[0];
  const result = computeRealizedWalletMetrics([buy, sell], complete({ initialEquityUsd: null }));
  assert.equal(result.earlyEntryPct, null); assert.equal(result.maxDrawdownPct, null);
  assert.equal(result.avgHoldingSeconds, 600);
});

test('drawdown is measured against opening equity plus cumulative net realized PnL, not unrealized token prices', () => {
  const buy = normalize(fixture()).trades[0];
  const sell = normalize(fixture('SELL', 110, '90000000')).trades[0];
  const result = computeRealizedWalletMetrics([buy, sell], complete({ initialEquityUsd: '100' }));
  assert.equal(result.netRealizedPnlUsd, '-10.084'); assert.equal(result.winRatePct, 0);
  assert.equal(result.maxDrawdownPct, 10.084);
});

const openingProof = (value = '1000') => ({ chainId: 4663, walletAddress: W, value,
  timestamp: iso(t0 - 60000), blockNumber: 99, blockHash: hash(99), canonical: true,
  source: 'fixture:verified-opening-equity', evidence: ['fixture:opening-balances-and-prices'] });

test('verified disposals emit exact canonical realization deltas once, independently of the bounded FIFO state', () => {
  const buy = normalize(fixture()).trades[0]; const sell = normalize(fixture('SELL', 110)).trades[0];
  const options = complete({ openingEquityProof: openingProof() });
  const first = computeRealizedWalletMetrics([buy], options);
  const second = computeRealizedWalletMetrics([buy, sell], { ...options, previousState: first.state });
  assert.equal(second.temporalMetricsComplete, true);
  assert.equal(second.realizedEvents.length, 1);
  const event = second.realizedEvents[0];
  assert.equal(event.id, sell.id); assert.equal(event.disposalIndex, 1);
  assert.equal(event.netRealizedPnlUsd, '19.916');
  assert.deepEqual(event.netRealizedPnlUsdExact, { numerator: '4979', denominator: '250' });
  assert.equal(event.timestamp, sell.timestamp); assert.equal(event.transactionHash, sell.transactionHash);
  assert.equal(event.holdingSeconds, 600); assert.equal(event.earlyEntryPct, 100); assert.equal(event.drawdownPct, 0);
  assert.ok(event.evidence.includes('fixture:opening-balances-and-prices'));
  assert.equal('realizedEvents' in second.state, false);
  const retry = computeRealizedWalletMetrics([sell], { ...options, previousState: second.state });
  assert.deepEqual(retry.realizedEvents, []); assert.deepEqual(retry.state, second.state);
});

test('legacy lifetime PnL stays compatible, but missing or mismatched temporal proofs cannot publish immutable events', () => {
  const trades = [normalize(fixture()).trades[0], normalize(fixture('SELL', 110)).trades[0]];
  for (const openingEquityProof of [undefined, openingProof('999'), { ...openingProof(), walletAddress: TOKEN },
    { ...openingProof(), timestamp: iso(t0 + 1000) }, { ...openingProof(), canonical: false }]) {
    const result = computeRealizedWalletMetrics(trades, complete({ openingEquityProof }));
    assert.equal(result.netRealizedPnlUsd, '19.916');
    assert.equal(result.temporalMetricsComplete, false); assert.deepEqual(result.realizedEvents, []);
    assert.ok(result.gaps.includes('WALLET_TEMPORAL_METRICS_INCOMPLETE'));
  }
  const noCreation = structuredClone(trades); noCreation[0].deploymentAt = null;
  const result = computeRealizedWalletMetrics(noCreation, complete({ openingEquityProof: openingProof() }));
  assert.equal(result.netRealizedPnlUsd, '19.916'); assert.deepEqual(result.realizedEvents, []);
});

test('realization batches preserve committed state on overflow or a later invalid event', () => {
  const options = complete({ openingEquityProof: openingProof(), now: t0 + 86400000 });
  const buy = normalize(fixture()).trades[0];
  const first = computeRealizedWalletMetrics([buy], options);
  const sell = normalize(fixture('SELL', 110)).trades[0];
  for (const [trades, extra] of [
    [[sell], { maxRealizedEvents: 0 }],
    [[sell, { ...normalize(fixture('BUY', 111)).trades[0], quantityRaw: '0' }], {}],
  ]) {
    const result = computeRealizedWalletMetrics(trades, { ...options, previousState: first.state, ...extra });
    assert.equal(result.requiresReplay, true); assert.deepEqual(result.realizedEvents, []);
    assert.deepEqual(result.state, first.state);
  }
});

test('per-disposal drawdown records recovery instead of repeating lifetime maximum drawdown', () => {
  const trades = [normalize(fixture()).trades[0], normalize(fixture('SELL', 110, '90000000')).trades[0],
    normalize(fixture('BUY', 111)).trades[0], normalize(fixture('SELL', 120, '120000000')).trades[0]];
  const result = computeRealizedWalletMetrics(trades, complete({ initialEquityUsd: '100', openingEquityProof: openingProof('100') }));
  assert.equal(result.realizedEvents.length, 2);
  assert.equal(result.realizedEvents[0].drawdownPct, 10.084);
  assert.equal(result.realizedEvents[1].drawdownPct, 0);
  assert.equal(result.maxDrawdownPct, 10.084);
  assert.deepEqual(result.realizedEvents.map(event => event.disposalIndex), [1, 2]);
});

test('an unreconciled equity path cannot publish an out-of-range drawdown as complete temporal proof', () => {
  const trades = [normalize(fixture()).trades[0], normalize(fixture('SELL', 110, '1000000')).trades[0]];
  const result = computeRealizedWalletMetrics(trades, complete({ initialEquityUsd: '1', openingEquityProof: openingProof('1') }));
  assert.equal(result.netRealizedPnlUsd, '-99.084');
  assert.equal(result.maxDrawdownPct, null);
  assert.equal(result.temporalMetricsComplete, false);
  assert.deepEqual(result.realizedEvents, []);
  assert.ok(result.gaps.includes('WALLET_EQUITY_PATH_UNRECONCILED'));
});
