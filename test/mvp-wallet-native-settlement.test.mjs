import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileNativeSettlement, reconcileReceiptFees } from '../src/mvp/wallet-native-settlement.mjs';

const wallet = '0x' + '1'.repeat(40);
const router = '0x' + '2'.repeat(40);
const thirdParty = '0x' + '3'.repeat(40);
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const block = { number: 100, hash: hash(100), timestamp: 1792750000 };
const receipt = () => ({ status: '0x1', from: wallet, to: router, transactionHash: hash(1000),
  blockNumber: '0x64', blockHash: block.hash, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' });
const executionFee = 21000000000000n;
const identity = () => ({ schemaVersion: 1, chainId: 4663, walletAddress: wallet,
  transactionHash: hash(1000), blockNumber: 100, blockHash: block.hash,
  canonical: true, complete: true, source: 'fixture:canonical-transaction-proof', evidence: ['fixture:transaction-proof'] });
const fees = () => ({ ...identity(), kind: 'receipt-fees/v1', coverage: 'all-transaction-fees',
  executionNativeRaw: executionFee.toString(),
  l1: { treatment: 'NOT_APPLICABLE', amountRaw: '0' }, otherComponents: [],
  totalNativeRaw: executionFee.toString() });
const proof = (delta = -1000000000000000000n) => ({ ...identity(), kind: 'native-settlement/v1',
  method: 'transaction-balance-diff', fees: fees(),
  transaction: { chainId: 4663, hash: hash(1000), from: wallet, to: router, value: delta < 0n ? (-delta).toString() : '0',
    blockNumber: '0x64', blockHash: block.hash },
  balanceDiff: { scope: 'transaction', complete: true, beforeRaw: '10000000000000000000',
    afterRaw: (10000000000000000000n + delta - executionFee).toString() } });
const context = proof => ({ proof, block, walletAddress: wallet, pool: { type: 'v4' } });

test('native buy and sell use the transaction balance difference with the actual fee added back once', () => {
  for (const delta of [-1000000000000000000n, 1200000000000000000n]) {
    const result = reconcileNativeSettlement(receipt(), context(proof(delta)));
    assert.equal(result.complete, true);
    assert.equal(result.netNativeRaw, delta.toString());
    assert.equal(result.feeNativeRaw, executionFee.toString());
    assert.equal(result.feeComponentsComplete, true);
  }
});

test('absence of native proof and block-wide balances never prove a transaction settlement', () => {
  assert.equal(reconcileNativeSettlement(receipt(), context(undefined)).netNativeRaw, null);
  const value = proof(); value.balanceDiff.scope = 'block';
  const result = reconcileNativeSettlement(receipt(), context(value));
  assert.equal(result.complete, false); assert.equal(result.netNativeRaw, null);
  assert.ok(result.gaps.includes('NATIVE_TRANSACTION_BALANCE_PROOF_REQUIRED'));
});

test('native proof is bound to wallet, transaction, block, chain and supported pool type', () => {
  for (const mutate of [
    value => { value.walletAddress = thirdParty; },
    value => { value.transactionHash = hash(999); },
    value => { value.blockHash = hash(999); },
    value => { value.chainId = 1; },
    value => { value.canonical = false; },
    value => { value.transaction.hash = hash(999); },
    value => { value.transaction.from = thirdParty; },
    value => { value.transaction.blockHash = hash(999); },
  ]) {
    const value = proof(); mutate(value);
    assert.equal(reconcileNativeSettlement(receipt(), context(value)).complete, false);
  }
  assert.equal(reconcileNativeSettlement(receipt(), { ...context(proof()), pool: { type: 'v2' } }).complete, false);
});

test('L1 fees are included exactly once according to an explicit proved treatment', () => {
  const r = receipt(); r.l1Fee = '0x64';
  const additional = fees(); additional.l1 = { treatment: 'ADDITIONAL', amountRaw: '100' };
  additional.totalNativeRaw = (executionFee + 100n).toString();
  assert.equal(reconcileReceiptFees(r, { proof: additional, block, walletAddress: wallet }).feeNativeRaw,
    (executionFee + 100n).toString());
  const included = fees(); included.l1 = { treatment: 'INCLUDED_IN_EXECUTION', amountRaw: '100' };
  assert.equal(reconcileReceiptFees(r, { proof: included, block, walletAddress: wallet }).feeNativeRaw,
    executionFee.toString());
  const native = proof(); native.fees = additional;
  native.balanceDiff.afterRaw = (BigInt(native.balanceDiff.afterRaw) - 100n).toString();
  const settled = reconcileNativeSettlement(r, context(native));
  assert.equal(settled.complete, true); assert.equal(settled.netNativeRaw, '-1000000000000000000');
});

test('missing or contradictory fee coverage cannot become free gas or a native settlement', () => {
  for (const mutate of [
    value => { delete value.fees; },
    value => { value.fees.complete = false; },
    value => { delete value.fees.l1; },
    value => { value.fees.coverage = 'execution-only'; },
    value => { value.fees.executionNativeRaw = '0'; },
    value => { value.fees.totalNativeRaw = '0'; },
    value => { value.fees.transactionHash = hash(999); },
  ]) {
    const value = proof(); mutate(value);
    const result = reconcileNativeSettlement(receipt(), context(value));
    assert.equal(result.complete, false); assert.equal(result.netNativeRaw, null);
    assert.equal(result.feeNativeRaw, null); assert.equal(result.feeComponentsComplete, false);
  }
  const r = receipt(); r.l1Fee = '1';
  assert.equal(reconcileReceiptFees(r, { proof: fees(), block, walletAddress: wallet }).complete, false);
  const value = fees(); value.l1 = { treatment: 'ADDITIONAL', amountRaw: '1' };
  value.totalNativeRaw = (executionFee + 1n).toString();
  assert.equal(reconcileReceiptFees(receipt(), { proof: value, block, walletAddress: wallet }).complete, false,
    'an attested amount without an actual receipt component is not an observed fee');
});

test('other receipt fees require explicit complete coverage and never reuse a fee field twice', () => {
  const r = receipt(); r.operatorFee = '25';
  const value = fees();
  assert.equal(reconcileReceiptFees(r, { proof: value, block, walletAddress: wallet }).complete, false);
  value.otherComponents = [{ receiptField: 'operatorFee', amountRaw: '25', treatment: 'ADDITIONAL' }];
  value.totalNativeRaw = (executionFee + 25n).toString();
  assert.equal(reconcileReceiptFees(r, { proof: value, block, walletAddress: wallet }).complete, true);
  value.otherComponents.push({ ...value.otherComponents[0] });
  assert.equal(reconcileReceiptFees(r, { proof: value, block, walletAddress: wallet }).complete, false);
});

test('complete call traces reconcile native transfers, refunds and reverts without counting delegatecall value', () => {
  const value = proof(); value.method = 'call-trace'; delete value.balanceDiff;
  value.traceComplete = true;
  value.trace = { type: 'CALL', from: wallet, to: router, value: '1000000000000000000', calls: [
    { type: 'CALL', from: router, to: wallet, value: '100000000000000000' },
    { type: 'DELEGATECALL', from: router, to: wallet, value: '1000000000000000000' },
    { type: 'CALL', from: router, to: thirdParty, value: '0', error: 'reverted', calls: [
      { type: 'CALL', from: thirdParty, to: wallet, value: '999999999999999999' },
    ] },
  ] };
  assert.equal(reconcileNativeSettlement(receipt(), context(value)).netNativeRaw, '-900000000000000000');
  value.traceComplete = false;
  assert.equal(reconcileNativeSettlement(receipt(), context(value)).complete, false);
});

test('explicit root or nested truncation and timeout flags leave native settlement unknown', () => {
  for (const field of ['truncated', 'timeout', 'timedOut']) {
    for (const nested of [false, true]) {
      const value = proof(); value.method = 'call-trace'; value.traceComplete = true;
      value.trace = { type: 'CALL', from: wallet, to: router, value: value.transaction.value, calls: [
        { type: 'CALL', from: router, to: wallet, value: '100' },
      ] };
      const call = nested ? value.trace.calls[0] : value.trace;
      call[field] = false;
      assert.equal(reconcileNativeSettlement(receipt(), context(value)).complete, true);
      call[field] = true;
      const result = reconcileNativeSettlement(receipt(), context(value));
      assert.equal(result.complete, false);
      assert.equal(result.netNativeRaw, null);
      assert.ok(result.gaps.includes('NATIVE_COMPLETE_CALL_TRACE_REQUIRED'));
    }
  }
});

test('a failed receipt, unknown gas, malformed balances and mismatched root trace stay unknown', () => {
  const failed = receipt(); failed.status = '0x0';
  assert.equal(reconcileNativeSettlement(failed, context(proof())).complete, false);
  const unknown = receipt(); delete unknown.gasUsed;
  assert.equal(reconcileNativeSettlement(unknown, context(proof())).feeNativeRaw, null);
  const malformed = proof(); malformed.balanceDiff.beforeRaw = '-1';
  assert.equal(reconcileNativeSettlement(receipt(), context(malformed)).complete, false);
  const trace = proof(); trace.method = 'call-trace'; trace.traceComplete = true;
  trace.trace = { type: 'CALL', from: thirdParty, to: router, value: '1000000000000000000' };
  assert.equal(reconcileNativeSettlement(receipt(), context(trace)).complete, false);
});
