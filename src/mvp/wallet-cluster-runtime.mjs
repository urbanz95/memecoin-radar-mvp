import { buildWalletClusters } from './wallet-clusters.mjs';
import { normalizeReceiptSettlement } from './wallet-accounting.mjs';

/** Reuse validated scanner logs and reconciled receipts. Observed relations can
 * reduce independence; only complete typed coverage can establish it. No new
 * RPC scanner, inferred funder identity, or clean insider flag is introduced.
 */
export function attachObservedWalletClusters(profiles, { events = [], receipts = [], pool = null,
  now = Date.now(), proofs = {} } = {}) {
  const stamp = { chainId: 4663, canonical: true, checkedAt: new Date(now).toISOString(),
    source: 'canonical-wallet-ledger-coordination/v1' };
  const transfers = events.filter(event => event.kind === 'TRANSFER').map(event => ({ ...stamp,
    fromAddress: event.args?.from, toAddress: event.args?.to, amountRaw: event.args?.value,
    direct: true, blockNumber: event.blockNumber, blockHash: event.blockHash,
    transactionHash: event.transactionHash, evidence: [`wallet-ledger:${event.blockHash}:${event.logIndex}`] }));
  const buys = receipts.flatMap(value => normalizeReceiptSettlement(value.receipt, value.events, {
    ...value, chainId: 4663, valuation: value.receiptEvidence?.valuation,
    nativeSettlementProof: value.receiptEvidence?.nativeSettlementProof,
    feeProof: value.receiptEvidence?.feeProof,
  }).trades.filter(trade => trade.side === 'BUY').map(trade => ({ ...stamp,
    walletAddress: trade.walletAddress, side: 'BUY', attributionComplete: trade.attributionComplete,
    poolAddress: value.pool?.type === 'v4' ? undefined : value.pool?.address,
    poolId: value.pool?.type === 'v4' ? value.pool.poolId : undefined,
    blockNumber: trade.blockNumber, blockHash: trade.blockHash, transactionHash: trade.transactionHash,
    evidence: trade.evidence })));
  const launch = pool ? { ...stamp, blockNumber: pool.createdBlock, blockHash: pool.createdBlockHash,
    transactionHash: pool.creationTransactionHash,
    poolAddress: pool.type === 'v4' ? undefined : pool.address,
    poolId: pool.type === 'v4' ? pool.poolId : undefined,
    evidence: [`onchain:pool-created:${pool.id}:${pool.createdBlockHash}`] } : null;
  const result = buildWalletClusters({ wallets: profiles.map(profile => ({ walletAddress: profile.walletAddress,
    clusterId: profile.clusterProof?.clusterId })), transfers, buys, launch, now, ...proofs });
  const linked = new Set(result.clusters.filter(cluster => cluster.wallets.length > 1).flatMap(cluster => cluster.wallets));
  const updated = profiles.map(profile => {
    const item = result.wallets.find(value => value.walletAddress === profile.walletAddress);
    if (!item) return profile;
    const complete = item.clusterProof.complete && item.clusterProof.evidence.length <= 8;
    const observation = { ...item.clusterProof, complete, evidence: item.clusterProof.evidence.slice(0, 8),
      aliases: item.clusterProof.aliases.slice(0, 8) };
    const apply = complete || linked.has(profile.walletAddress);
    const flags = Object.fromEntries(['insider', 'bundler', 'washTrading'].map(flag => [flag,
      profile.riskFlags?.[flag] === true || item.riskFlags[flag] === true ? true
        : item.riskFlags[flag] === false ? false : profile.riskFlags?.[flag] ?? null]));
    return { ...profile, clusterObservation: observation,
      ...(apply ? { clusteringComplete: complete, clusterProof: observation,
        tokenEntries: (profile.tokenEntries ?? []).map(entry => ({ ...entry,
          clusterId: observation.clusterId, clusteringComplete: complete, clusterEvidence: observation.evidence })) } : {}),
      riskFlags: flags, clusterGaps: item.gaps.slice(0, 16) };
  });
  return { profiles: updated, diagnostics: result.diagnostics,
    counts: { wallets: result.wallets.length, observedGroups: result.clusters.length,
      coordinatedGroups: result.clusters.filter(cluster => cluster.wallets.length > 1).length,
      completeGroups: result.clusters.filter(cluster => cluster.complete).length } };
}
