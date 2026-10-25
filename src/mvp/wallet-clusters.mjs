import { NETWORK, isEvmAddress } from '../network.mjs';

const VERSION = 'canonical-wallet-clusters/v1';
const whole = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const address = value => isEvmAddress(value) ? value.toLowerCase() : null;
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 240;
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(label);
const unique = values => [...new Set(values)].sort();
const clusterId = wallet => `rhc:${NETWORK.chainId}:wallet:${wallet}`;
const FLAGS = ['insider', 'bundler', 'washTrading'];
const CLASSES = ['eoa', 'non-hub', 'exchange', 'router', 'unknown'];
const MAX_UINT256 = (1n << 256n) - 1n;
function positiveRaw(proof) {
  const value = proof.amountRaw ?? proof.valueRaw;
  if (proof.amountRaw !== undefined && proof.valueRaw !== undefined && proof.amountRaw !== proof.valueRaw) return false;
  return typeof value === 'string' && /^[1-9]\d{0,77}$/.test(value) && BigInt(value) <= MAX_UINT256;
}

function fresh(proof, now) {
  const at = typeof proof?.checkedAt === 'string' ? Date.parse(proof.checkedAt) : NaN;
  return object(proof) && proof.chainId === NETWORK.chainId && proof.canonical === true
    && label(proof.source) && refs(proof.evidence) && whole(at) && at <= now && now - at <= 600000;
}
const canonical = (proof, now) => fresh(proof, now) && whole(proof.blockNumber) && hash(proof.blockHash);
function coverageValid(value, now) {
  return fresh(value, now) && value.complete === true && value.contiguous === true
    && ['fundingComplete', 'buysComplete', 'transfersComplete'].every(key => value[key] === true)
    && whole(value.fromBlock) && whole(value.toBlock) && value.fromBlock <= value.toBlock && hash(value.toBlockHash);
}
const poolIdentity = proof => address(proof?.poolAddress) ?? (hash(proof?.poolId) ? proof.poolId.toLowerCase() : null);

/**
 * Evidence adapter; it never fetches history or assumes that missing links prove
 * independence. Funding proofs assert a first funding source only when both
 * firstFunding and complete are true. Coverage declares the observed block
 * window, and must explicitly cover funding, buys and direct transfers.
 *
 * Relations are conservative counting groups, not findings of insider activity,
 * bundling or wash trading. Direct transfer proofs require a positive uint256
 * amountRaw (or valueRaw) decimal string. An EOA classification alone does not
 * establish that a funder is independent of an exchange or router; completeness
 * requires an explicit, proven non-hub classification.
 * Those flags require separate canonical riskProofs
 * with complete:true and riskFlags containing explicit booleans or nulls.
 */
export function buildWalletClusters({ wallets = [], fundingProofs = [], buys = [], transfers = [],
  launch = null, coverage = null, now = Date.now(), riskProofs = [] } = {}) {
  if (!whole(now) || now > 8640000000000000 || !Array.isArray(wallets) || wallets.length > 128
    || !Array.isArray(fundingProofs) || fundingProofs.length > 512
    || !Array.isArray(buys) || buys.length > 1024 || !Array.isArray(transfers) || transfers.length > 1024
    || !Array.isArray(riskProofs) || riskProofs.length > 512) throw new Error('MVP_WALLET_CLUSTER_INPUT');
  const diagnostics = []; const diagnose = code => { if (!diagnostics.includes(code)) diagnostics.push(code); };
  const previousIds = new Map(); const walletGaps = new Map();
  for (const input of wallets) {
    const wallet = address(typeof input === 'string' ? input : input?.walletAddress);
    if (!wallet) { diagnose('CLUSTER_WALLET_INVALID'); continue; }
    if (object(input) && input.chainId !== undefined && input.chainId !== NETWORK.chainId) {
      diagnose('CLUSTER_WALLET_CHAIN_MISMATCH'); continue;
    }
    if (!previousIds.has(wallet)) { previousIds.set(wallet, new Set()); walletGaps.set(wallet, new Set()); }
    if (object(input) && typeof input.clusterId === 'string' && input.clusterId.length > 0 && input.clusterId.length <= 160)
      previousIds.get(wallet).add(input.clusterId);
  }
  const selected = [...previousIds.keys()].sort(); const parent = new Map(selected.map(wallet => [wallet, wallet]));
  const gap = (wallet, code) => { if (walletGaps.has(wallet)) walletGaps.get(wallet).add(code); };
  const allGap = code => selected.forEach(wallet => gap(wallet, code));
  const find = wallet => { let root = wallet; while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(wallet) !== wallet) { const next = parent.get(wallet); parent.set(wallet, root); wallet = next; } return root; };
  const union = (left, right) => { const a = find(left); const b = find(right); if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); };
  const edges = []; const proofRefs = new Map(selected.map(wallet => [wallet, new Set()]));
  const addRefs = (wallet, values) => values.forEach(value => proofRefs.get(wallet)?.add(value));
  const link = (left, right, kind, evidence) => {
    if (left === right || !parent.has(left) || !parent.has(right)) return;
    union(left, right); edges.push({ wallets: [left, right].sort(), kind, evidence: unique(evidence) });
    addRefs(left, evidence); addRefs(right, evidence);
  };

  // Caller supplied canonical assertions must also agree with each other. No
  // relation from a conflicting block is used, even if every item says canonical.
  const blocks = new Map(); const hashBlocks = new Map(); const transactionBlocks = new Map(); const conflicts = new Set();
  const candidates = [...fundingProofs, ...buys, ...transfers, ...riskProofs, ...(launch ? [launch] : [])];
  if (fresh(coverage, now) && whole(coverage.toBlock) && hash(coverage.toBlockHash)) {
    blocks.set(coverage.toBlock, coverage.toBlockHash.toLowerCase());
    hashBlocks.set(coverage.toBlockHash.toLowerCase(), coverage.toBlock);
  }
  for (const proof of candidates) if (canonical(proof, now)) {
    const value = proof.blockHash.toLowerCase();
    if (blocks.has(proof.blockNumber) && blocks.get(proof.blockNumber) !== value) conflicts.add(proof.blockNumber);
    else blocks.set(proof.blockNumber, value);
    if (hashBlocks.has(value) && hashBlocks.get(value) !== proof.blockNumber) {
      conflicts.add(proof.blockNumber); conflicts.add(hashBlocks.get(value));
    } else hashBlocks.set(value, proof.blockNumber);
    if (hash(proof.transactionHash)) {
      const tx = proof.transactionHash.toLowerCase(); const previous = transactionBlocks.get(tx);
      if (previous && (previous.number !== proof.blockNumber || previous.hash !== value)) {
        conflicts.add(proof.blockNumber); conflicts.add(previous.number);
      } else transactionBlocks.set(tx, { number: proof.blockNumber, hash: value });
    }
  }
  if (conflicts.size) { diagnose('CLUSTER_CANONICAL_CONFLICT'); allGap('CLUSTER_CANONICAL_CONFLICT'); }
  const valid = (proof, withinWindow = true) => canonical(proof, now) && !conflicts.has(proof.blockNumber)
    && (!coverageValid(coverage, now) || (!withinWindow || proof.blockNumber >= coverage.fromBlock) && proof.blockNumber <= coverage.toBlock);
  const fullCoverage = coverageValid(coverage, now) && !conflicts.size;
  if (!fullCoverage) allGap('CLUSTER_WINDOW_COVERAGE_UNPROVEN');

  const byWallet = new Map();
  for (const proof of fundingProofs) {
    const wallet = address(proof?.walletAddress);
    if (!parent.has(wallet)) { diagnose('CLUSTER_FUNDING_WALLET_UNKNOWN'); continue; }
    const funder = address(proof.funderAddress);
    if (!valid(proof, false) || !funder || proof.firstFunding !== true || proof.complete !== true || !hash(proof.transactionHash)) {
      gap(wallet, 'CLUSTER_FIRST_FUNDING_UNPROVEN'); continue;
    }
    const classification = proof.classificationProven === true && CLASSES.includes(proof.funderClassification)
      ? proof.funderClassification : 'unknown';
    const item = { wallet, funder, classification, evidence: [...proof.evidence],
      identity: `${funder}:${proof.blockNumber}:${proof.blockHash.toLowerCase()}:${proof.transactionHash.toLowerCase()}` };
    const old = byWallet.get(wallet);
    if (old && (old.identity !== item.identity || old.classification !== item.classification)) {
      byWallet.set(wallet, null); gap(wallet, 'CLUSTER_FIRST_FUNDING_CONFLICT');
    } else if (old !== null) byWallet.set(wallet, item);
  }
  const funders = new Map();
  for (const wallet of selected) {
    const proof = byWallet.get(wallet);
    if (!proof) { gap(wallet, 'CLUSTER_FIRST_FUNDING_UNPROVEN'); continue; }
    addRefs(wallet, proof.evidence);
    if (['unknown', 'eoa'].includes(proof.classification)) gap(wallet, 'CLUSTER_FUNDER_CLASSIFICATION_UNPROVEN');
    if (['exchange', 'router'].includes(proof.classification)) {
      gap(wallet, 'CLUSTER_FIRST_FUNDING_HUB_SOURCE'); continue;
    }
    // An unknown funder may still establish a common observed funding relation,
    // but its cluster can never establish complete independence.
    const members = funders.get(proof.funder) ?? [];
    members.push(proof); funders.set(proof.funder, members);
  }
  for (const members of funders.values()) for (const item of members.slice(1))
    link(members[0].wallet, item.wallet, 'common-first-funding', [...members[0].evidence, ...item.evidence]);

  const launchValid = valid(launch, false) && poolIdentity(launch);
  if (buys.length && !launchValid) { diagnose('CLUSTER_POOL_CREATION_UNPROVEN'); allGap('CLUSTER_POOL_CREATION_UNPROVEN'); }
  const launchBuys = [];
  for (const proof of buys) {
    const wallet = address(proof?.walletAddress);
    if (!parent.has(wallet)) { diagnose('CLUSTER_BUY_WALLET_UNKNOWN'); continue; }
    if (!valid(proof) || proof.side !== 'BUY' || proof.attributionComplete !== true || !hash(proof.transactionHash)) {
      gap(wallet, 'CLUSTER_BUY_PROOF_INVALID'); continue;
    }
    if (launchValid && proof.blockNumber === launch.blockNumber
      && proof.blockHash.toLowerCase() === launch.blockHash.toLowerCase() && poolIdentity(proof) === poolIdentity(launch))
      launchBuys.push(proof);
  }
  launchBuys.sort((a, b) => address(a.walletAddress).localeCompare(address(b.walletAddress)));
  for (const proof of launchBuys.slice(1)) link(address(launchBuys[0].walletAddress), address(proof.walletAddress),
    'pool-creation-block-buys', [...launch.evidence, ...launchBuys[0].evidence, ...proof.evidence]);

  for (const proof of transfers) {
    const from = address(proof?.fromAddress); const to = address(proof?.toAddress);
    if (!parent.has(from) || !parent.has(to)) { diagnose('CLUSTER_TRANSFER_WALLET_UNKNOWN'); continue; }
    if (!valid(proof) || proof.direct !== true || !hash(proof.transactionHash) || !positiveRaw(proof)) {
      gap(from, 'CLUSTER_DIRECT_TRANSFER_UNPROVEN'); gap(to, 'CLUSTER_DIRECT_TRANSFER_UNPROVEN'); continue;
    }
    link(from, to, 'direct-wallet-transfer', proof.evidence);
  }

  const riskByWallet = new Map(selected.map(wallet => [wallet, []]));
  for (const proof of riskProofs) {
    const wallet = address(proof?.walletAddress);
    if (!parent.has(wallet)) { diagnose('CLUSTER_RISK_WALLET_UNKNOWN'); continue; }
    if (!valid(proof) || proof.complete !== true || !object(proof.riskFlags)
      || !FLAGS.every(flag => [true, false, null].includes(proof.riskFlags[flag]))) {
      gap(wallet, 'CLUSTER_RISK_PROOF_INVALID'); continue;
    }
    riskByWallet.get(wallet).push(proof);
  }

  const grouped = new Map();
  for (const wallet of selected) { const root = find(wallet); const members = grouped.get(root) ?? [];
    members.push(wallet); grouped.set(root, members); }
  const aliasTargets = new Map();
  for (const [root, members] of grouped) for (const wallet of members)
    for (const alias of [clusterId(wallet), ...previousIds.get(wallet)]) {
      const targets = aliasTargets.get(alias) ?? new Set(); targets.add(clusterId(root)); aliasTargets.set(alias, targets);
    }
  for (const [alias, targets] of aliasTargets) if (targets.size > 1) {
    diagnose('CLUSTER_ALIAS_CONFLICT');
    for (const [root, members] of grouped) if (targets.has(clusterId(root))) members.forEach(wallet => gap(wallet, 'CLUSTER_ALIAS_CONFLICT'));
    aliasTargets.delete(alias);
  }
  const aliases = [...aliasTargets].filter(([alias, targets]) => alias !== [...targets][0])
    .map(([alias, targets]) => ({ alias, clusterId: [...targets][0] })).sort((a, b) => a.alias.localeCompare(b.alias));
  const clusters = []; const output = [];
  for (const [root, members] of grouped) {
    const evidence = unique(members.flatMap(wallet => [...proofRefs.get(wallet)]).concat(fullCoverage ? coverage.evidence : []));
    if (evidence.length > 64) members.forEach(wallet => gap(wallet, 'CLUSTER_EVIDENCE_CAPACITY'));
    const gaps = unique(members.flatMap(wallet => [...walletGaps.get(wallet)]));
    const complete = fullCoverage && !gaps.length && evidence.length > 0;
    const id = clusterId(root); const clusterAliases = aliases.filter(value => value.clusterId === id).map(value => value.alias);
    clusters.push({ clusterId: id, wallets: members, aliases: clusterAliases, complete,
      evidence: evidence.slice(0, 64), gaps, relations: edges.filter(edge => find(edge.wallets[0]) === root)
        .map(edge => ({ wallets: edge.wallets, kind: edge.kind, evidence: edge.evidence.slice(0, 64) })) });
    for (const wallet of members) {
      const proofs = riskByWallet.get(wallet); const flags = {}; const riskGaps = [];
      for (const flag of FLAGS) {
        const values = unique(proofs.map(proof => proof.riskFlags[flag]).filter(value => value !== null));
        flags[flag] = values.includes(true) ? true : values.length === 1 ? values[0] : null;
        if (values.length > 1) riskGaps.push(`CLUSTER_RISK_${flag.toUpperCase()}_CONFLICT`);
        else if (!values.length) riskGaps.push(`CLUSTER_RISK_${flag.toUpperCase()}_UNPROVEN`);
      }
      const riskEvidence = unique(proofs.flatMap(proof => proof.evidence));
      if (riskEvidence.length > 64) { FLAGS.forEach(flag => { flags[flag] = null; }); riskGaps.push('CLUSTER_RISK_EVIDENCE_CAPACITY'); }
      output.push({ walletAddress: wallet, clusterProof: { schemaVersion: 1, chainId: NETWORK.chainId,
        walletAddress: wallet, clusterId: id, aliases: clusterAliases, source: VERSION,
        canonical: evidence.length > 0 && !conflicts.size,
        checkedAt: new Date(now).toISOString(), evidence: evidence.slice(0, 64), complete,
        coverage: fullCoverage ? { fromBlock: coverage.fromBlock, toBlock: coverage.toBlock,
          toBlockHash: coverage.toBlockHash.toLowerCase() } : null },
      riskFlags: flags, riskEvidence: riskEvidence.slice(0, 64), gaps: unique([...gaps, ...riskGaps]) });
    }
  }
  return { wallets: output.sort((a, b) => a.walletAddress.localeCompare(b.walletAddress)), clusters, aliases,
    diagnostics: unique(diagnostics) };
}
