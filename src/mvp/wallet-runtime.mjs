import { isEvmAddress } from '../network.mjs';
import { readWalletProfile } from './wallet-ledger.mjs';
import { normalizeReceiptSettlement, computeRealizedWalletMetrics } from './wallet-accounting.mjs';
import { normalizeHistoryWindow, historyWindowComplete, historyWindowKey } from './wallet-history-window.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const address = value => isEvmAddress(value) && !/^0x0{40}$/i.test(value) ? value.toLowerCase() : null;
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 64
  && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 240);
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const lower = value => typeof value === 'string' ? value.toLowerCase() : null;
const source = value => typeof value === 'string' && value.length > 0 && value.length <= 240;
const fresh = (proof, now) => object(proof) && proof.chainId === 4663 && proof.canonical === true
  && source(proof.source) && refs(proof.evidence) && Number.isSafeInteger(stamp(proof.checkedAt))
  && stamp(proof.checkedAt) <= now && now - stamp(proof.checkedAt) <= 600000;
const unique = values => [...new Set(values)];
const one = (values, matches) => { const found = values.filter(matches); return found.length === 1 ? found[0] : null; };
const stateReady = state => state?.historyFromStart === true
  && ['costsKnown', 'feesKnown', 'attributionKnown'].every(key => state[key] === true);

function receiptProofFor(value, proofs, now) {
  const proof = one(proofs, item => item?.chainId === 4663
    && lower(item.transactionHash) === lower(value.receipt.transactionHash));
  return fresh(proof, now) && whole(value.block?.number) && hash(value.block?.hash)
    && (proof.walletAddress === undefined || address(proof.walletAddress) === address(value.receipt.from))
    && proof.blockNumber === value.block.number && lower(proof.blockHash) === lower(value.block.hash)
    ? proof : null;
}
function walletProofFor(wallet, values, proofs, now) {
  const anchor = values.map(value => value.block).filter(value => whole(value?.number) && hash(value?.hash))
    .sort((a, b) => b.number - a.number)[0];
  const proof = one(proofs, item => address(item?.walletAddress) === wallet);
  if (!anchor || !fresh(proof, now) || proof.blockNumber !== anchor.number
    || lower(proof.blockHash) !== lower(anchor.hash)) return null;
  if (values.some(value => !whole(value.block?.number) || value.block.number > anchor.number
    || value.block.number === anchor.number && lower(value.block.hash) !== lower(anchor.hash))) return null;
  if (proof.historyWindow !== undefined) {
    const historyWindow = normalizeHistoryWindow(proof.historyWindow, { walletAddress: wallet, now, anchor });
    return historyWindow ? { ...proof, historyWindow } : null;
  }
  const history = proof.historyProof;
  if (!object(history) || history.scope !== 'wallet-lifetime' || history.fromBlock !== 0
    || history.toBlock !== anchor.number || lower(history.toBlockHash) !== lower(anchor.hash)
    || !['complete', 'contiguous', 'canonical', 'openingBalanceKnown'].every(key => history[key] === true)
    || !refs(history.evidence) || values.some(value => !whole(value.block?.number)
      || value.block.number > anchor.number || value.block.number === anchor.number
      && lower(value.block.hash) !== lower(anchor.hash))) return null;
  return proof;
}
function deploymentProof(proof, token, block) {
  return proof?.chainId === 4663 && proof.canonical === true && proof.kind === 'direct-creation-receipt'
    && address(proof.address ?? proof.contractAddress) === token && whole(proof.blockNumber)
    && proof.blockNumber <= block.number && hash(proof.blockHash) && hash(proof.transactionHash)
    && source(proof.source) && refs(proof.evidence) && Number.isSafeInteger(stamp(proof.timestamp))
    && stamp(proof.timestamp) <= block.timestamp * 1000 ? proof : undefined;
}
function clusterProof(proof, wallet) {
  const cluster = proof?.clusterProof;
  return cluster?.chainId === 4663 && address(cluster.walletAddress) === wallet && cluster.complete === true
    && typeof cluster.clusterId === 'string' && cluster.clusterId.length > 0 && cluster.clusterId.length <= 160
    && refs(cluster.evidence) ? cluster : null;
}
function replayFor(wallet, values, proofs, walletProof, now) {
  const proof = one(proofs, item => address(item?.walletAddress) === wallet);
  if (!walletProof || !fresh(proof, now) || proof.complete !== true
    || proof.blockNumber !== walletProof.blockNumber || lower(proof.blockHash) !== lower(walletProof.blockHash)
    || !Array.isArray(proof.trades) || proof.trades.length > 512 || !proof.trades.length
    || proof.trades.some(trade => trade?.chainId !== 4663 || address(trade.walletAddress) !== wallet
      || !whole(trade.blockNumber) || trade.blockNumber > proof.blockNumber || !hash(trade.blockHash)
      || trade.blockNumber === proof.blockNumber && lower(trade.blockHash) !== lower(proof.blockHash)
      || !Number.isSafeInteger(stamp(trade.timestamp)) || stamp(trade.timestamp) > now
      || !source(trade.source) || !refs(trade.evidence))) return null;
  if (walletProof.historyWindow) {
    const window = normalizeHistoryWindow(proof.historyWindow, { walletAddress: wallet, now });
    if (!historyWindowComplete(window) || historyWindowKey(window) !== historyWindowKey(walletProof.historyWindow)) return null;
  }
  // A replay must include the selected canonical transaction instead of an
  // unrelated favourable wallet history.
  if (values.some(value => !proof.trades.some(trade => lower(trade.transactionHash)
    === lower(value.receipt.transactionHash) && lower(trade.blockHash) === lower(value.block.hash)))) return null;
  return proof;
}
function mergeEntries(previous, entries, cluster) {
  const result = new Map();
  for (const entry of [...previous, ...entries]) {
    const old = result.get(entry.tokenAddress);
    if (!old) { result.set(entry.tokenAddress, { ...entry }); continue; }
    const first = stamp(old.firstEntryAt) <= stamp(entry.firstEntryAt) ? old : entry;
    const oldAt = stamp(old.lastEntryAt ?? old.firstEntryAt); const newAt = stamp(entry.lastEntryAt ?? entry.firstEntryAt);
    const latest = oldAt > newAt || old.entryEventId && old.entryEventId === entry.entryEventId ? old : entry;
    result.set(entry.tokenAddress, { ...latest, firstEntryAt: first.firstEntryAt,
      earlyEntry: first.earlyEntry, attributionVerified: old.attributionVerified === true && entry.attributionVerified === true });
  }
  return [...result.values()].slice(-32).map(entry => cluster ? { ...entry, clusterId: cluster.clusterId,
    clusteringComplete: true, clusterEvidence: [...cluster.evidence] } : { ...entry, clusterId: null,
    clusteringComplete: false, clusterEvidence: [] });
}

/** Optional verified evidence is an internal adapter contract, not a provider
 * assumption. Missing lifetime, prices, fees or funding proofs remain unknown. */
export async function projectObservedWallets(DB, receiptValues, { now = Date.now(), reorgDetected = false,
  receiptEvidence = [], walletEvidence = [], replayEvidence = [], historyWindows = [] } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || !Array.isArray(receiptValues) || receiptValues.length > 128
    || !Array.isArray(receiptEvidence) || receiptEvidence.length > 512 || !Array.isArray(walletEvidence)
    || walletEvidence.length > 128 || !Array.isArray(replayEvidence) || replayEvidence.length > 128
    || !Array.isArray(historyWindows) || historyWindows.length > 128)
    throw new Error('MVP_WALLET_RUNTIME_INPUT');
  const grouped = new Map(); const diagnostics = []; const profiles = []; const realizedEvents = [];
  for (const value of receiptValues) {
    const walletAddress = address(value?.receipt?.from);
    if (!walletAddress) { diagnostics.push('WALLET_SENDER_UNAVAILABLE'); continue; }
    const item = grouped.get(walletAddress) ?? { values: [], trades: [], evidence: [], gaps: [], entries: [], settled: true };
    const proof = receiptProofFor(value, receiptEvidence, now);
    const settlement = normalizeReceiptSettlement(value.receipt, value.events ?? [], {
      chainId: 4663, tokenAddress: value.tokenAddress, pool: value.pool, block: value.block, source: value.source,
      evidence: [`d1:mvp_wallet_receipts:${value.receipt.transactionHash}`],
      valuation: proof?.valuation, feeComponentsComplete: proof?.feeComponentsComplete === true && refs(proof.feeEvidence),
      nativeSettlementProof: proof?.nativeSettlementProof, feeProof: proof?.feeProof,
      deployment: proof && value.block ? deploymentProof(proof.deployment, address(value.tokenAddress), value.block) : undefined });
    item.values.push(value); item.trades.push(...settlement.trades);
    item.settled &&= settlement.status === 'SETTLED' && settlement.attributionComplete === true;
    if (!proof) item.gaps.push('WALLET_RECEIPT_EVIDENCE_UNAVAILABLE');
    for (const trade of settlement.trades) if (trade.side === 'BUY') item.entries.push({
      chainId: 4663, tokenAddress: value.tokenAddress, walletAddress, observedAt: new Date(now).toISOString(),
      source: 'canonical-receipt-net-flows/v1', evidence: [`d1:mvp_wallet_receipts:${value.receipt.transactionHash}`],
      attributionVerified: settlement.attributionComplete === true, entryType: 'buy', firstEntryAt: trade.timestamp,
      lastEntryAt: trade.timestamp, entryEventId: trade.id,
      earlyEntry: trade.deploymentAt ? stamp(trade.timestamp) - stamp(trade.deploymentAt) <= 300000 : null,
      clusterId: null, clusteringComplete: false, clusterEvidence: [] });
    item.evidence.push(`d1:mvp_wallet_receipts:${value.receipt.transactionHash}`); item.gaps.push(...settlement.gaps);
    grouped.set(walletAddress, item);
  }
  for (const [walletAddress, item] of grouped) {
    const previous = reorgDetected ? null : await readWalletProfile(DB, walletAddress);
    const previousState = previous?.accountingState ?? previous?.state;
    const proof = walletProofFor(walletAddress, item.values, walletEvidence, now);
    const descriptor = one(historyWindows, value => address(value?.walletAddress) === walletAddress);
    const normalizedDescriptor = descriptor ? normalizeHistoryWindow(descriptor, { walletAddress, now }) : null;
    // Backfill's ERC20 scan descriptor is useful even when its fixed head is
    // newer than the latest captured receipt. It never proves financial history.
    const partialWindow = normalizedDescriptor ? { ...normalizedDescriptor, complete: false,
      ...(object(descriptor.scanCoverage) ? { scanCoverage: descriptor.scanCoverage } : {}),
      ...(object(descriptor.financialCoverage) ? { financialCoverage: descriptor.financialCoverage } : {}),
      ...(typeof descriptor.scanComplete === 'boolean' ? { scanComplete: descriptor.scanComplete } : {}) } : null;
    const cluster = clusterProof(proof, walletAddress);
    const replay = replayFor(walletAddress, item.values, replayEvidence, proof, now);
    const complete = Boolean(proof && item.settled && (!proof.historyWindow || historyWindowComplete(proof.historyWindow)));
    const windowChanged = Boolean(proof && previousState
      && historyWindowKey(proof.historyWindow) !== historyWindowKey(previousState.historyWindow));
    const upgradeNeedsReplay = Boolean(previousState && (windowChanged || previous.requiresReplay === true
      || complete && !stateReady(previousState)));
    // A verified lifetime proof explicitly selects lifetime accounting. Only
    // an absent proof inherits the checkpoint's window while coverage is unknown.
    const accountingWindow = proof ? proof.historyWindow : previousState?.historyWindow;
    const options = { walletAddress, chainId: 4663, now, source: 'observed-receipt-settlement/v1',
      evidence: unique(item.evidence), historyComplete: complete, historyProof: proof?.historyProof ?? { complete: false },
      ...(accountingWindow ? { historyWindow: accountingWindow } : {}),
      feesComplete: complete && proof.feesComplete === true,
      attributionComplete: complete && proof.attributionComplete === true,
      clusteringComplete: Boolean(cluster), riskFlags: proof?.riskFlags ?? null, riskEvidence: proof?.riskEvidence,
      initialEquityUsd: proof?.openingEquityProof?.value, openingEquityProof: proof?.openingEquityProof,
      maxRealizedEvents: 128 - realizedEvents.length };
    let profile;
    if (upgradeNeedsReplay && !replay) {
      profile = computeRealizedWalletMetrics([], { ...options, previousState, historyComplete: false });
      profile.requiresReplay = true; profile.gaps.push('WALLET_VERIFIED_REPLAY_REQUIRED');
    } else {
      profile = computeRealizedWalletMetrics(replay ? replay.trades : item.trades,
        { ...options, previousState: replay ? undefined : previousState });
      // A failed replay must preserve the predecessor instead of returning its
      // empty replay starting state or leaking successfully processed deltas.
      if (replay && profile.requiresReplay && previousState) {
        const failureGaps = profile.gaps;
        profile = computeRealizedWalletMetrics([], { ...options, previousState, historyComplete: false });
        profile.requiresReplay = true; profile.gaps = unique([...profile.gaps, ...failureGaps]);
      }
    }
    // An unresolved receipt may leave FIFO unchanged. Keep the replay request
    // across persisted runs so later evidence cannot silently skip that receipt.
    if (!item.settled) {
      profile.requiresReplay = true;
      profile.gaps = unique([...profile.gaps, 'WALLET_VERIFIED_REPLAY_REQUIRED']);
    }
    const { state, accountingState, realizedEvents: deltas, ...metrics } = profile;
    realizedEvents.push(...deltas);
    const collectionGaps = unique([...item.gaps, ...(!proof ? ['WALLET_LIFETIME_PROOF_UNAVAILABLE'] : []),
      ...((proof?.historyWindow && !historyWindowComplete(proof.historyWindow) || partialWindow && !proof?.historyWindow)
        ? ['WALLET_DECLARED_WINDOW_INCOMPLETE'] : [])]);
    const replayAccepted = Boolean(replay && !profile.requiresReplay);
    const observedEntries = replayAccepted ? replay.trades.filter(trade => trade.side === 'BUY').map(trade => ({
      chainId: 4663, tokenAddress: trade.tokenAddress, walletAddress, observedAt: new Date(now).toISOString(),
      source: replay.source, evidence: [...replay.evidence], attributionVerified: trade.attributionComplete === true,
      entryType: 'buy', firstEntryAt: trade.timestamp,
      lastEntryAt: trade.timestamp, entryEventId: trade.id,
      earlyEntry: trade.deploymentAt ? stamp(trade.timestamp) - stamp(trade.deploymentAt) <= 300000 : null,
      clusterId: null, clusteringComplete: false, clusterEvidence: [] })) : item.entries;
    const entries = options.historyWindow ? observedEntries.filter(entry => stamp(entry.firstEntryAt) >= stamp(options.historyWindow.startAt)
      && stamp(entry.firstEntryAt) <= stamp(options.historyWindow.endAt)) : observedEntries;
    const tokenEntries = profile.requiresReplay ? previous?.tokenEntries ?? []
      : mergeEntries(replayAccepted ? [] : previous?.tokenEntries ?? [], entries, cluster);
    profiles.push({ ...metrics, checkedAt: new Date(now).toISOString(), source: 'observed-receipt-settlement/v1',
      ...(proof?.historyWindow ? { historyWindow: proof.historyWindow } : partialWindow ? { historyWindow: partialWindow } : {}),
      evidence: unique([...item.evidence, ...(proof?.evidence ?? [])]).slice(0, 64), eligible: false,
      accountingState: accountingState ?? state, collectionGaps,
      tokenEntries });
  }
  return { profiles, diagnostics, realizedEvents };
}
