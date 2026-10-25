import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReceiptEvidence } from '../src/mvp/wallet-evidence.mjs';

const at = Date.parse('2026-10-25T12:00:00Z');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const wallet = '0x' + '1'.repeat(40);
const value = () => ({ tokenAddress: '0x' + '2'.repeat(40), pool: null, events: [],
  block: { number: 100, hash: hash(100), timestamp: at / 1000 },
  receipt: { transactionHash: hash(1), blockHash: hash(100), blockNumber: '0x64', from: wallet,
    status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [] } });

test('receipt producer measures execution fees but never invents total fees, historical USD or attribution', () => {
  const item = value();
  const result = prepareReceiptEvidence([item], { now: at });
  assert.equal(result.receiptEvidence[0].executionFeeNativeRaw, '21000000000000');
  assert.equal(result.receiptEvidence[0].feeComponentsComplete, false);
  assert.equal(result.receiptEvidence[0].attributionComplete, false);
  assert.equal(result.receiptEvidence[0].valuation, null);
  assert.ok(result.diagnostics.includes('WALLET_HISTORICAL_USD_PROVIDER_UNAVAILABLE'));
  assert.equal(item.receiptEvidence, result.receiptEvidence[0], 'ledger input retains evidence and unknown reasons');
  assert.deepEqual(result.counts, { receipts: 1, attributed: 0, executionFeeKnown: 1, totalFeesComplete: 0, valued: 0 });
});

test('missing gas is unknown while actually observed zero gas remains zero', () => {
  const missing = value(); delete missing.receipt.gasUsed;
  const zero = value(); zero.receipt.gasUsed = '0x0';
  assert.equal(prepareReceiptEvidence([missing], { now: at }).receiptEvidence[0].executionFeeNativeRaw, null);
  assert.equal(prepareReceiptEvidence([zero], { now: at }).receiptEvidence[0].executionFeeNativeRaw, '0');
});

test('contradictory receipt identity produces no canonical proof', () => {
  const item = value(); item.receipt.blockHash = hash(99);
  const result = prepareReceiptEvidence([item], { now: at });
  assert.deepEqual(result.receiptEvidence, []);
  assert.deepEqual(result.diagnostics, ['WALLET_RECEIPT_IDENTITY_UNPROVEN']);
});

test('supplied proof interfaces are preserved and duplicate claims are never merged', () => {
  const item = value(); const supplied = { ...item.receipt, source: 'fixture:provider' };
  const result = prepareReceiptEvidence([item], { now: at, supplied: [supplied] });
  assert.deepEqual(result.receiptEvidence, [supplied]);
  const duplicate = value();
  prepareReceiptEvidence([duplicate], { now: at, supplied: [supplied, { ...supplied }] });
  assert.equal(duplicate.receiptEvidence, undefined);
  assert.deepEqual(duplicate.proofDiagnostics, ['WALLET_DUPLICATE_RECEIPT_PROOF']);
});
