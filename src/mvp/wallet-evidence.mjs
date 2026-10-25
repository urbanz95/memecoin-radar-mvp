import { normalizeReceiptSettlement } from './wallet-accounting.mjs';
import { reconcileReceiptFees } from './wallet-native-settlement.mjs';

const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const raw = value => typeof value === 'string' && /^(?:0x[0-9a-f]{1,64}|\d{1,78})$/i.test(value)
  && BigInt(value) < 2n ** 256n ? BigInt(value) : null;
const key = value => `${value?.transactionHash?.toLowerCase()}:${value?.blockHash?.toLowerCase()}`;

/** Materialize observed facts from the receipts already captured by the scanner.
 * Execution gas is measurable without claiming full L1/additional fee coverage.
 * Historical USD prices, native traces and financial history need their own
 * typed providers. Missing providers remain explicit gaps, never clean flags.
 */
export function prepareReceiptEvidence(values, { now = Date.now(), supplied = [] } = {}) {
  if (!whole(now) || !Array.isArray(values) || values.length > 128 || !Array.isArray(supplied) || supplied.length > 512)
    throw Error('MVP_INVALID_RECEIPT_EVIDENCE_INPUT');
  const receiptEvidence = [...supplied]; const diagnostics = [];
  const counts = { receipts: 0, attributed: 0, executionFeeKnown: 0, totalFeesComplete: 0, valued: 0 };
  for (const value of values) {
    const { receipt, block } = value ?? {};
    if (!receipt || !block || !hash(receipt.transactionHash) || !hash(block.hash)
      || !whole(block.number) || !whole(block.timestamp) || block.timestamp * 1000 > now
      || receipt.blockHash?.toLowerCase() !== block.hash.toLowerCase()
      || raw(receipt.blockNumber) !== BigInt(block.number) || !address(receipt.from)) {
      diagnostics.push('WALLET_RECEIPT_IDENTITY_UNPROVEN'); continue;
    }
    counts.receipts++;
    const matches = supplied.filter(proof => key(proof) === key(receipt));
    if (matches.length) {
      // Existing adapters remain responsible for their typed proof validation.
      // Never replace or combine conflicting provider claims here.
      value.proofDiagnostics = matches.length === 1 ? [] : ['WALLET_DUPLICATE_RECEIPT_PROOF'];
      if (matches.length === 1) value.receiptEvidence = matches[0];
      continue;
    }
    const evidence = [`d1:mvp_wallet_receipts:${receipt.transactionHash.toLowerCase()}`];
    const gas = raw(receipt.gasUsed); const gasPrice = raw(receipt.effectiveGasPrice);
    const execution = gas !== null && gasPrice !== null && gas * gasPrice < 2n ** 256n ? gas * gasPrice : null;
    if (execution !== null) counts.executionFeeKnown++;
    const fees = reconcileReceiptFees(receipt, { proof: value.feeProof, block, walletAddress: receipt.from });
    const settlement = normalizeReceiptSettlement(receipt, value.events ?? [], {
      chainId: 4663, tokenAddress: value.tokenAddress, pool: value.pool, block,
      evidence, valuation: value.valuation, feeProof: value.feeProof,
      nativeSettlementProof: value.nativeSettlementProof,
      feeComponentsComplete: fees.complete,
    });
    if (settlement.attributionComplete) counts.attributed++;
    if (fees.complete) counts.totalFeesComplete++;
    if (settlement.trades.length && settlement.trades.every(trade => trade.costsComplete)) counts.valued++;
    const gaps = [...new Set([...fees.gaps, ...settlement.gaps,
      ...(!value.valuation ? ['WALLET_HISTORICAL_USD_PROVIDER_UNAVAILABLE'] : [])])];
    const proof = { schemaVersion: 1, chainId: 4663, walletAddress: receipt.from.toLowerCase(),
      transactionHash: receipt.transactionHash.toLowerCase(), blockNumber: block.number, blockHash: block.hash.toLowerCase(),
      canonical: true, checkedAt: new Date(now).toISOString(), source: 'canonical-receipt-evidence/v1', evidence,
      executionFeeNativeRaw: execution?.toString() ?? null,
      feeComponentsComplete: fees.complete, feeEvidence: fees.evidence,
      attributionComplete: settlement.attributionComplete,
      valuation: value.valuation ?? null, feeProof: value.feeProof ?? null,
      nativeSettlementProof: value.nativeSettlementProof ?? null, gaps };
    // The enclosing captured receipt is persisted by the existing ledger batch,
    // retaining these observations and unknown reasons for later replay.
    value.receiptEvidence = proof;
    receiptEvidence.push(proof); diagnostics.push(...gaps);
  }
  return { receiptEvidence, counts, diagnostics: [...new Set(diagnostics)] };
}
