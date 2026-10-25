import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNativeReceiptProofs, nitroReceiptFeeProof } from '../src/mvp/wallet-native-provider.mjs';

const wallet = '0x' + '1'.repeat(40);
const router = '0x' + '2'.repeat(40);
const zero = '0x' + '0'.repeat(40);
const hash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const now = Date.parse('2026-10-25T12:00:00Z');

function fixture() {
  const block = { number: 100, hash: hash(100), timestamp: now / 1000 - 60 };
  const receipt = { status: '0x1', from: wallet, to: router, transactionHash: hash(1000),
    blockNumber: '0x64', blockHash: block.hash, gasUsed: '0x5208',
    effectiveGasPrice: '0x3b9aca00', gasUsedForL1: '0x64', logs: [] };
  const transaction = { chainId: '0x1237', hash: receipt.transactionHash, from: wallet, to: router,
    value: '0xde0b6b3a7640000', blockNumber: receipt.blockNumber, blockHash: block.hash };
  const trace = { type: 'CALL', from: wallet, to: router, value: transaction.value, calls: [
    { type: 'CALL', from: router, to: wallet, value: '0x64' },
    { type: 'CALL', from: router, to: wallet, value: '0x3e8', error: 'execution reverted', calls: [
      { type: 'CALL', from: wallet, to: router, value: '0x3e8' },
    ] },
  ] };
  const value = { receipt, block, pool: { type: 'v4', quoteAddress: zero } };
  const rpc = { requests: 0, calls: [], async batch(calls) {
    this.requests++; this.calls.push(calls);
    return [{ value: transaction }, { value: trace }];
  } };
  return { value, transaction, trace, rpc };
}

test('native provider retains the canonical transaction and full trace with evidenced Nitro fees', async () => {
  const { value, rpc } = fixture();
  const result = await collectNativeReceiptProofs(rpc, [value], { now });
  assert.deepEqual(result, { diagnostics: [], counts: { attempted: 1, reconciled: 1 } });
  assert.deepEqual(rpc.calls[0].map(call => call[0]), ['eth_getTransactionByHash', 'debug_traceTransaction']);
  assert.equal(value.nativeSettlementProof.trace.calls.length, 2);
  assert.equal(value.nativeSettlementProof.transaction.chainId, 4663);
  assert.equal(value.feeProof.totalNativeRaw, '21000000000000');
  assert.deepEqual(value.feeProof.l1, { treatment: 'INCLUDED_IN_EXECUTION', amountRaw: '100000000000' });
});

test('missing Nitro L1 coverage cannot be turned into a zero L1 fee', async () => {
  const { value, rpc } = fixture(); delete value.receipt.gasUsedForL1;
  assert.equal(nitroReceiptFeeProof(value, now), null);
  const result = await collectNativeReceiptProofs(rpc, [value], { now });
  assert.equal(result.counts.reconciled, 0);
  assert.ok(result.diagnostics.includes('TOTAL_NATIVE_FEE_PROOF_REQUIRED'));
  assert.equal(value.nativeSettlementProof, undefined);
});

test('remote tracing errors remain unknown and do not attach a native proof', async () => {
  const { value, rpc } = fixture();
  rpc.batch = async () => [{ value: fixture().transaction }, { error: -32601 }];
  const result = await collectNativeReceiptProofs(rpc, [value], { now });
  assert.equal(result.counts.reconciled, 0);
  assert.ok(result.diagnostics.includes('NATIVE_TRANSACTION_TRACE_PROVIDER_UNAVAILABLE'));
  assert.equal(value.nativeSettlementProof, undefined);
});

test('root and nested truncation or timeout flags cannot establish a complete call trace', async () => {
  for (const field of ['truncated', 'timeout', 'timedOut']) {
    for (const nested of [false, true]) {
      const { value, trace, rpc } = fixture();
      (nested ? trace.calls[0] : trace)[field] = true;
      const result = await collectNativeReceiptProofs(rpc, [value], { now });
      assert.equal(result.counts.reconciled, 0, `${field} at ${nested ? 'nested' : 'root'} call`);
      assert.ok(result.diagnostics.includes('NATIVE_COMPLETE_CALL_TRACE_REQUIRED'));
      assert.equal(value.nativeSettlementProof, undefined);
    }
  }
});

test('a fetched transaction must agree with the captured transaction, wallet, chain and block', async () => {
  for (const mutate of [
    tx => { tx.hash = hash(2000); },
    tx => { tx.from = router; },
    tx => { tx.chainId = '0x1'; },
    tx => { tx.blockHash = hash(200); },
  ]) {
    const { value, transaction, rpc } = fixture(); mutate(transaction);
    const result = await collectNativeReceiptProofs(rpc, [value], { now });
    assert.equal(result.counts.reconciled, 0);
    assert.equal(value.nativeSettlementProof, undefined);
    assert.ok(result.diagnostics.length > 0);
  }
});

test('an uncovered additional receipt fee prevents complete native settlement', async () => {
  const { value, rpc } = fixture(); value.receipt.operatorFee = '0x64';
  const result = await collectNativeReceiptProofs(rpc, [value], { now });
  assert.equal(result.counts.reconciled, 0);
  assert.ok(result.diagnostics.includes('OTHER_NATIVE_FEE_COVERAGE_UNKNOWN'));
  assert.equal(value.nativeSettlementProof, undefined);
});

test('the native provider preserves the shared request budget', async () => {
  const { value, rpc } = fixture(); rpc.requests = 28;
  const result = await collectNativeReceiptProofs(rpc, [value], { now, maxRequests: 28 });
  assert.deepEqual(result.counts, { attempted: 0, reconciled: 0 });
  assert.ok(result.diagnostics.includes('NATIVE_RPC_BUDGET_DEFERRED'));
  assert.equal(rpc.calls.length, 0);
});

test('ordinary receipts before a native receipt do not consume the eligible receipt limit', async () => {
  const { value, rpc } = fixture();
  const ordinary = Array.from({ length: 4 }, () => ({ pool: { type: 'v2' } }));
  const result = await collectNativeReceiptProofs(rpc, [...ordinary, value], { now });
  assert.equal(result.counts.attempted, 1);
  assert.equal(result.counts.reconciled, 1);
  assert.ok(value.nativeSettlementProof);
});
