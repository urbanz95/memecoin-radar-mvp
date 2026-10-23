import { isEvmAddress } from '../network.mjs';
import { readWalletProfile } from './wallet-ledger.mjs';
import { normalizeReceiptSettlement, computeRealizedWalletMetrics } from './wallet-accounting.mjs';

/** Track observed senders, but only settlement evidence can identify a trade.
 * The bounded collector does not establish a complete wallet lifetime, a USD
 * cost basis, fees or funding clusters. Those facts remain explicitly unknown. */
export async function projectObservedWallets(DB, receiptValues, { now = Date.now(), reorgDetected = false } = {}) {
  if (!Number.isSafeInteger(now) || !Array.isArray(receiptValues)) throw new Error('MVP_WALLET_RUNTIME_INPUT');
  const grouped = new Map(); const diagnostics = [];
  for (const value of receiptValues) {
    const walletAddress = value.receipt?.from?.toLowerCase();
    if (!isEvmAddress(walletAddress) || /^0x0+$/.test(walletAddress)) {
      diagnostics.push('WALLET_SENDER_UNAVAILABLE'); continue;
    }
    const settlement = normalizeReceiptSettlement(value.receipt, value.events ?? [], {
      chainId: 4663, tokenAddress: value.tokenAddress, pool: value.pool, block: value.block,
      source: value.source, evidence: [`d1:mvp_wallet_receipts:${value.receipt.transactionHash}`] });
    const item = grouped.get(walletAddress) ?? { trades: [], evidence: [], gaps: [], entries: [] };
    item.trades.push(...settlement.trades);
    for (const trade of settlement.trades) if (trade.side === 'BUY') item.entries.push({
      chainId: 4663, tokenAddress: value.tokenAddress, walletAddress,
      observedAt: new Date(now).toISOString(), source: 'canonical-receipt-net-flows/v1',
      evidence: [`d1:mvp_wallet_receipts:${value.receipt.transactionHash}`],
      attributionVerified: settlement.attributionComplete === true, entryType: 'buy', firstEntryAt: trade.timestamp,
      earlyEntry: null, clusterId: null, clusteringComplete: false, clusterEvidence: [] });
    item.evidence.push(`d1:mvp_wallet_receipts:${value.receipt.transactionHash}`);
    item.gaps.push(...settlement.gaps);
    grouped.set(walletAddress, item);
  }
  const profiles = [];
  for (const [walletAddress, item] of grouped) {
    const previous = reorgDetected ? null : await readWalletProfile(DB, walletAddress);
    const profile = computeRealizedWalletMetrics(item.trades, { walletAddress, chainId: 4663, now,
      previousState: previous?.accountingState ?? previous?.state,
      source: 'observed-receipt-settlement/v1', evidence: [...new Set(item.evidence)],
      historyComplete: false, historyProof: { complete: false, scope: 'bounded-observed-transactions',
        reason: 'Amostras de pools e transfers não comprovam todo o histórico da carteira.' },
      feesComplete: false, attributionComplete: false, clusteringComplete: false, riskFlags: null });
    const { state, accountingState, ...metrics } = profile;
    profiles.push({ ...metrics, chainId: 4663, walletAddress, checkedAt: new Date(now).toISOString(),
      source: 'observed-receipt-settlement/v1', evidence: [...new Set(item.evidence)],
      historyComplete: false, feesComplete: false, attributionComplete: false, clusteringComplete: false,
      riskFlags: null, eligible: false, accountingState: accountingState ?? state,
      collectionGaps: [...new Set(item.gaps.map(gap => typeof gap === 'string' ? gap : gap.code ?? gap.message))],
      tokenEntries: [...new Map([...(previous?.tokenEntries ?? []), ...item.entries].map(entry =>
        [entry.tokenAddress, entry])).values()].slice(-32) });
  }
  return { profiles, diagnostics };
}
