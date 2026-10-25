import { reconcileNativeSettlement } from './wallet-native-settlement.mjs';

const ZERO = '0x' + '0'.repeat(40);
const raw = value => typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value) ? BigInt(value) : null;
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);

/** Nitro's receipt gasUsed includes the posting gas component gasUsedForL1.
 * Only receipts actually exposing that component use this model. Additional
 * fee fields must be reconciled separately; absence of the Nitro component is
 * not interpreted as a zero L1 fee.
 */
export function nitroReceiptFeeProof(value, now) {
  const { receipt, block } = value;
  const gas = raw(receipt.gasUsed), price = raw(receipt.effectiveGasPrice), posting = raw(receipt.gasUsedForL1);
  if (gas === null || price === null || posting === null || posting > gas || gas * price >= 2n ** 256n) return null;
  return { schemaVersion: 1, kind: 'receipt-fees/v1', coverage: 'all-transaction-fees', chainId: 4663,
    walletAddress: receipt.from.toLowerCase(), transactionHash: receipt.transactionHash.toLowerCase(),
    blockNumber: block.number, blockHash: block.hash, canonical: true, complete: true,
    checkedAt: new Date(now).toISOString(), source: 'nitro-receipt-fee-components/v1',
    executionNativeRaw: (gas * price).toString(), totalNativeRaw: (gas * price).toString(),
    l1: { treatment: 'INCLUDED_IN_EXECUTION', amountRaw: (posting * price).toString() }, otherComponents: [],
    evidence: [`d1:mvp_wallet_receipts:${receipt.transactionHash.toLowerCase()}`,
      'https://docs.arbitrum.io/build-decentralized-apps/how-to-estimate-gas'] };
}

/** One bounded provider batch for a native-v4 receipt already ingested. Failed
 * or unsupported tracing is a recorded unknown, never a settlement inference.
 */
export async function collectNativeReceiptProofs(rpc, values, { now = Date.now(), maxRequests = 30 } = {}) {
  const diagnostics = []; const counts = { attempted: 0, reconciled: 0 };
  const eligible = values.filter(value => value?.pool?.type === 'v4'
    && address(value.pool.quoteAddress) === ZERO && !value.nativeSettlementProof);
  for (const value of eligible.slice(0, 4)) {
    const { receipt, pool, block } = value;
    if (!Number.isSafeInteger(rpc.requests) || rpc.requests >= maxRequests) { diagnostics.push('NATIVE_RPC_BUDGET_DEFERRED'); break; }
    counts.attempted++;
    try {
      const feeProof = nitroReceiptFeeProof(value, now);
      const result = await rpc.batch([
        ['eth_getTransactionByHash', [receipt.transactionHash]],
        ['debug_traceTransaction', [receipt.transactionHash,
          { tracer: 'callTracer', timeout: '2s', tracerConfig: { onlyTopCall: false, withLog: false } }]],
      ]);
      const transaction = result[0]?.value, trace = result[1]?.value;
      if (!transaction || !trace) { diagnostics.push('NATIVE_TRANSACTION_TRACE_PROVIDER_UNAVAILABLE'); continue; }
      if (raw(transaction.chainId) !== 4663n || !hash(transaction.hash)
        || transaction.hash.toLowerCase() !== receipt.transactionHash.toLowerCase()
        || !address(transaction.from)) { diagnostics.push('NATIVE_PROVIDER_IDENTITY_UNPROVEN'); continue; }
      const proof = { schemaVersion: 1, kind: 'native-settlement/v1', chainId: 4663,
        walletAddress: receipt.from.toLowerCase(), transactionHash: receipt.transactionHash.toLowerCase(),
        blockNumber: block.number, blockHash: block.hash, complete: true, canonical: true,
        checkedAt: new Date(now).toISOString(), source: 'canonical-transaction-call-trace/v1',
        evidence: [`rpc:transaction:${receipt.transactionHash}`, `rpc:trace:${receipt.transactionHash}`],
        method: 'call-trace', transaction: { ...transaction, chainId: 4663 }, traceComplete: true, trace, fees: feeProof };
      const reconciled = reconcileNativeSettlement(receipt, { proof, block, walletAddress: receipt.from, pool });
      if (!reconciled.complete) { diagnostics.push(...reconciled.gaps); continue; }
      if (new TextEncoder().encode(JSON.stringify({ ...value, nativeSettlementProof: proof, feeProof })).length > 120000) {
        diagnostics.push('NATIVE_PROOF_EVIDENCE_LIMIT'); continue;
      }
      value.nativeSettlementProof = proof; value.feeProof = feeProof;
      counts.reconciled++;
    } catch { diagnostics.push('NATIVE_TRACE_PROVIDER_UNAVAILABLE'); }
  }
  return { diagnostics: [...new Set(diagnostics)], counts };
}
