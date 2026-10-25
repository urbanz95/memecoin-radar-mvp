import CONFIG from './wallet-evidence-config.mjs';

const ZERO = '0x' + '0'.repeat(40);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 64
  && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 240);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = value => value >= 0n && value < 2n ** 256n;
const incompleteTrace = value => ['truncated', 'timeout', 'timedOut']
  .some(field => Object.hasOwn(value, field) && value[field] !== false);
function raw(value) {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]{1,64}|\d{1,78})$/i.test(value)) return null;
  try { const result = BigInt(value); return bounded(result) ? result : null; } catch { return null; }
}
function integer(value) {
  if (whole(value)) return value;
  const result = raw(value);
  return result !== null && result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}
function identity(receipt, proof, block, wallet) {
  return object(proof) && proof.schemaVersion === 1 && proof.chainId === 4663
    && proof.complete === true && proof.canonical === true && wallet && wallet !== ZERO
    && address(proof.walletAddress) === wallet && address(receipt?.from) === wallet
    && hash(receipt?.transactionHash) && hash(proof.transactionHash)
    && proof.transactionHash.toLowerCase() === receipt.transactionHash.toLowerCase()
    && whole(block?.number) && hash(block?.hash) && proof.blockNumber === block.number
    && proof.blockHash?.toLowerCase() === block.hash.toLowerCase()
    && integer(receipt.blockNumber) === block.number && receipt.blockHash?.toLowerCase() === block.hash.toLowerCase()
    && integer(receipt.status) === 1 && typeof proof.source === 'string'
    && proof.source.length > 0 && proof.source.length <= 240 && refs(proof.evidence);
}
const feeUnknown = gap => ({ complete: false, feeNativeRaw: null, evidence: [], gaps: [gap] });

/** Validate a provider's full fee decomposition against the actual receipt.
 * L1 fees can already be inside gasUsed: adding them blindly would charge twice.
 * NOT_APPLICABLE is an explicit evidenced claim, never a missing-field default.
 */
export function reconcileReceiptFees(receipt, { proof, block, walletAddress } = {}) {
  try {
    const wallet = address(walletAddress ?? receipt?.from);
    if (!identity(receipt, proof, block, wallet) || proof.kind !== 'receipt-fees/v1'
      || proof.coverage !== 'all-transaction-fees') return feeUnknown('TOTAL_NATIVE_FEE_PROOF_REQUIRED');
    const gas = raw(receipt.gasUsed); const price = raw(receipt.effectiveGasPrice);
    if (gas === null || price === null) return feeUnknown('EXECUTION_NATIVE_FEE_UNKNOWN');
    const execution = gas * price;
    if (!bounded(execution) || raw(proof.executionNativeRaw) !== execution)
      return feeUnknown('EXECUTION_NATIVE_FEE_MISMATCH');
    const l1 = proof.l1; const l1Amount = raw(l1?.amountRaw);
    const receiptL1 = Object.hasOwn(receipt, 'l1Fee') ? raw(receipt.l1Fee)
      : Object.hasOwn(receipt, 'gasUsedForL1') && raw(receipt.gasUsedForL1) !== null
        ? raw(receipt.gasUsedForL1) * price : null;
    if (!object(l1) || l1Amount === null || !['NOT_APPLICABLE', 'INCLUDED_IN_EXECUTION', 'ADDITIONAL'].includes(l1.treatment))
      return feeUnknown('L1_NATIVE_FEE_TREATMENT_UNKNOWN');
    if (l1.treatment === 'NOT_APPLICABLE'
      ? l1Amount !== 0n || (Object.hasOwn(receipt, 'l1Fee') || Object.hasOwn(receipt, 'gasUsedForL1')) && receiptL1 !== 0n
      : receiptL1 === null || l1Amount !== receiptL1)
      return feeUnknown('L1_NATIVE_FEE_MISMATCH');
    let additional = l1.treatment === 'ADDITIONAL' ? l1Amount : 0n;
    let included = l1.treatment === 'INCLUDED_IN_EXECUTION' ? l1Amount : 0n;
    const components = proof.otherComponents;
    if (!Array.isArray(components) || components.length > CONFIG.native.maxFeeComponents)
      return feeUnknown('OTHER_NATIVE_FEE_COVERAGE_UNKNOWN');
    const seen = new Set(['l1Fee']);
    for (const component of components) {
      const field = component?.receiptField; const amount = raw(component?.amountRaw);
      if (typeof field !== 'string' || !/^[a-z][a-zA-Z0-9_]{0,63}Fee$/.test(field) || seen.has(field)
        || amount === null || !['INCLUDED_IN_EXECUTION', 'ADDITIONAL'].includes(component.treatment))
        return feeUnknown('INVALID_NATIVE_FEE_COMPONENT');
      seen.add(field);
      const observed = field === 'blobGasFee'
        ? raw(receipt.blobGasUsed) !== null && raw(receipt.blobGasPrice) !== null
          ? raw(receipt.blobGasUsed) * raw(receipt.blobGasPrice) : null
        : raw(receipt[field]);
      if (observed === null || amount !== observed) return feeUnknown('NATIVE_FEE_COMPONENT_MISMATCH');
      if (component.treatment === 'ADDITIONAL') additional += amount;
      else included += amount;
    }
    const uncovered = Object.keys(receipt).some(field => /Fee$/.test(field) && !seen.has(field));
    const uncoveredBlob = (Object.hasOwn(receipt, 'blobGasUsed') || Object.hasOwn(receipt, 'blobGasPrice')) && !seen.has('blobGasFee');
    const total = execution + additional;
    if (uncovered || uncoveredBlob) return feeUnknown('OTHER_NATIVE_FEE_COVERAGE_UNKNOWN');
    if (included > execution || !bounded(total) || raw(proof.totalNativeRaw) !== total)
      return feeUnknown('TOTAL_NATIVE_FEE_MISMATCH');
    return { complete: true, feeNativeRaw: total.toString(), evidence: [...proof.evidence], gaps: [] };
  } catch { return feeUnknown('INVALID_NATIVE_FEE_PROOF'); }
}

function transactionMatches(receipt, transaction, block, wallet) {
  return object(transaction) && transaction.chainId === 4663
    && transaction.hash?.toLowerCase() === receipt.transactionHash.toLowerCase()
    && address(transaction.from) === wallet && address(transaction.to) !== null
    && address(transaction.to) === address(receipt.to) && raw(transaction.value) !== null
    && integer(transaction.blockNumber) === block.number
    && transaction.blockHash?.toLowerCase() === block.hash.toLowerCase();
}

function traceDelta(proof, transaction, wallet) {
  const root = proof.trace;
  if (proof.traceComplete !== true || !object(root) || root.type !== 'CALL' || root.error || root.revertReason
    || incompleteTrace(root)
    || address(root.from) !== wallet || address(root.to) !== address(transaction.to)
    || raw(root.value) !== raw(transaction.value)) return null;
  let net = 0n; let count = 0;
  const pending = [root];
  while (pending.length) {
    const call = pending.pop();
    if (++count > CONFIG.native.maxTraceTransfers || !object(call)
      || incompleteTrace(call)
      || !['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(call.type)
      || !address(call.from) || !address(call.to) || call.calls !== undefined && !Array.isArray(call.calls)) return null;
    // A reverted subtree has no effective value transfers, including descendants.
    if (call.error || call.revertReason) continue;
    if (!['STATICCALL', 'DELEGATECALL', 'CALLCODE'].includes(call.type)) {
      const value = raw(call.value);
      if (value === null) return null;
      if (address(call.to) === wallet) net += value;
      if (address(call.from) === wallet) net -= value;
      if (net <= -(2n ** 256n) || net >= 2n ** 256n) return null;
    }
    if (call.calls) pending.push(...call.calls);
    if (pending.length > CONFIG.native.maxTraceTransfers) return null;
  }
  return net;
}

/** Read-only reconciliation of native ETH in one v4 transaction. Block-wide
 * balance differences, receipt.from and tx.value alone never establish its net
 * settlement. Producers must retain the canonical transaction and trace/diff.
 */
export function reconcileNativeSettlement(receipt, { proof, block, walletAddress, pool } = {}) {
  const result = { complete: false, netNativeRaw: null, feeNativeRaw: null,
    feeComponentsComplete: false, evidence: [], gaps: [] };
  const stop = gap => ({ ...result, gaps: [gap] });
  try {
    const wallet = address(walletAddress ?? receipt?.from);
    if (!CONFIG.native.enabled) return stop('NATIVE_SETTLEMENT_DISABLED');
    if (pool?.type !== 'v4' || !identity(receipt, proof, block, wallet) || proof.kind !== 'native-settlement/v1'
      || !transactionMatches(receipt, proof.transaction, block, wallet)) return stop('NATIVE_TRANSACTION_PROOF_REQUIRED');
    const fees = reconcileReceiptFees(receipt, { proof: proof.fees, block, walletAddress: wallet });
    if (!fees.complete) return { ...result, gaps: fees.gaps };
    result.feeNativeRaw = fees.feeNativeRaw; result.feeComponentsComplete = true;
    let net;
    if (proof.method === 'transaction-balance-diff') {
      const diff = proof.balanceDiff; const before = raw(diff?.beforeRaw); const after = raw(diff?.afterRaw);
      if (diff?.scope !== 'transaction' || diff.complete !== true || before === null || after === null)
        return stop('NATIVE_TRANSACTION_BALANCE_PROOF_REQUIRED');
      net = after - before + BigInt(fees.feeNativeRaw);
    } else if (proof.method === 'call-trace') {
      net = traceDelta(proof, proof.transaction, wallet);
      if (net === null) return stop('NATIVE_COMPLETE_CALL_TRACE_REQUIRED');
    } else return stop('NATIVE_TRANSACTION_PROOF_REQUIRED');
    if (net <= -(2n ** 256n) || net >= 2n ** 256n) return stop('INVALID_NATIVE_SETTLEMENT_AMOUNT');
    return { complete: true, netNativeRaw: net.toString(), feeNativeRaw: fees.feeNativeRaw,
      feeComponentsComplete: true, evidence: [...new Set([...proof.evidence, ...fees.evidence])], gaps: [] };
  } catch { return stop('INVALID_NATIVE_SETTLEMENT_PROOF'); }
}
