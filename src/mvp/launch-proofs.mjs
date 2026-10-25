import { NETWORK, isEvmAddress } from '../network.mjs';
import { hash, quantity } from '../cloudflare/rpc.mjs';

const VERSION = 'canonical-launch-proofs/v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const address = value => isEvmAddress(value) ? value.toLowerCase() : null;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 240;
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(text);
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19)
  ? Date.parse(value) : NaN;
const unique = values => [...new Set(values)].slice(0, 32);
const uint = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,77})$/.test(value)
  && BigInt(value) <= (1n << 256n) - 1n ? BigInt(value) : null;
const number = value => typeof value === 'number' ? value : quantity(value);

function sourceFact(value, token, head, now) {
  return object(value) && value.schemaVersion === 1 && value.chainId === NETWORK.chainId
    && same(value.address, token) && value.canonical === true && text(value.source) && refs(value.evidence)
    && Number.isFinite(time(value.checkedAt)) && time(value.checkedAt) <= now
    && time(value.checkedAt) >= head.timestamp * 1000
    && now - time(value.checkedAt) <= 600000 && value.blockNumber === head.number
    && same(value.blockHash, head.hash) && typeof value.complete === 'boolean';
}
function coverage(value, scope, head, from) {
  return object(value) && value.scope === scope && value.complete === true && value.contiguous === true
    && value.canonical === true && whole(value.fromBlock) && value.fromBlock <= from
    && value.toBlock === head.number && same(value.toBlockHash, head.hash) && refs(value.evidence);
}
function creationCandidate(value, token, head) {
  if (!object(value)) return null;
  const fromAge = value.basis === 'direct-creation-receipt' && Array.isArray(value.evidence)
    && value.evidence.length <= 8;
  if (fromAge && value.reasons !== undefined && (!Array.isArray(value.reasons) || value.reasons.length > 32
    || value.reasons.some(reason => ['AGE_CANONICAL_PROOF_UNAVAILABLE', 'AGE_CODE_CONTINUITY_UNPROVEN',
      'AGE_MULTIPLE_DEPLOYMENTS', 'AGE_INPUT_INVALID', 'AGE_EVIDENCE_UNAVAILABLE'].includes(reason)))) return null;
  const proofs = fromAge ? value.evidence.filter(item => item?.kind === 'direct-creation-receipt') : [value];
  if (proofs.length !== 1) return null;
  const proof = proofs[0];
  if (proof?.kind !== 'direct-creation-receipt' || proof.canonical === false || value.canonical === false
    || value.chainId !== undefined && value.chainId !== NETWORK.chainId
    || proof.chainId !== undefined && proof.chainId !== NETWORK.chainId
    || value.address !== undefined && !same(value.address, token)
    || proof.address !== undefined && !same(proof.address, token)
    || !whole(proof.blockNumber) || proof.blockNumber > head.number
    || !hash(proof.blockHash) || !hash(proof.transactionHash)
    || proof.blockNumber === head.number && !same(proof.blockHash, head.hash)) return null;
  const timestamp = value.contractCreatedAt ?? value.timestamp ?? proof.timestamp ?? null;
  if (timestamp !== null && (!Number.isFinite(time(timestamp)) || time(timestamp) > head.timestamp * 1000)) return null;
  const deployer = address(value.deployer ?? value.deployerAddress ?? proof.deployer ?? proof.deployerAddress);
  return { kind: 'direct-creation-receipt', chainId: NETWORK.chainId, address: token,
    blockNumber: proof.blockNumber, blockHash: proof.blockHash.toLowerCase(),
    transactionHash: proof.transactionHash.toLowerCase(), deployer, timestamp,
    canonical: true, source: VERSION,
    evidence: [`rpc:receipt:${proof.transactionHash.toLowerCase()}`, `rpc:block:${proof.blockHash.toLowerCase()}`] };
}

/** Produces facts only from identified canonical evidence. Standard Ethereum
 * JSON-RPC cannot enumerate an account's deployment or funding history. Receipt
 * verification is optional and uses at most one request; no absence is inferred
 * from a missing provider, an empty observation window, or transaction counts.
 *
 * Optional provider summaries must be schemaVersion:1 facts at the pinned head,
 * canonical:true, with source/evidence/checkedAt. Complete history requires a
 * deployer-lifetime coverage proof, previousContracts, knownRugs, and a separately
 * evidenced fundingOrigin. Launch coverage uses scope:token-launch; bundles need
 * attributed membership plus a proven positive totalSupplyRaw denominator.
 */
export async function collectLaunchProofs({ rpc, tokenAddress, pool, head, now = Date.now(), creation,
  deployerHistory, launchActivity } = {}) {
  if (typeof now === 'function') now = now();
  if (!whole(now) || now > 8640000000000000) throw new Error('LAUNCH_PROOFS_CLOCK_INVALID');
  const token = address(tokenAddress);
  const checkedAt = new Date(now).toISOString();
  const stamp = { schemaVersion: 1, chainId: NETWORK.chainId, address: token,
    source: VERSION, checkedAt, evidence: ['capability:ethereum-json-rpc:read-only'], complete: false };
  const history = { ...stamp, deployerAddress: null, previousContracts: null, previousContractsCount: null,
    knownMaliciousDeployments: null, knownRugs: null, fundingOrigin: null, gaps: [] };
  const activity = { ...stamp, bundledSupplyPct: null, sniperManipulationConfirmed: null, gaps: [] };
  const diagnostics = { source: VERSION, checkedAt, rpcRequests: 0, creation: null, gaps: [] };
  const gap = (fact, code) => { if (!fact.gaps.includes(code)) fact.gaps.push(code); };
  const result = () => ({ hardFilterEvidence: { deployerHistory: history, launchActivity: activity }, diagnostics });
  if (!token || !whole(head?.number) || !whole(head?.timestamp) || !hash(head?.hash)
    || head.timestamp * 1000 > now + 30000 || now - head.timestamp * 1000 > 600000) {
    gap(history, 'LAUNCH_INPUT_INVALID'); gap(activity, 'LAUNCH_INPUT_INVALID'); gap(diagnostics, 'LAUNCH_INPUT_INVALID'); return result();
  }
  let created = creationCandidate(creation, token, head);
  if (creation && !created) gap(diagnostics, 'DEPLOYMENT_PROOF_INVALID');
  if (created && !created.deployer) {
    if (typeof rpc?.request !== 'function' || whole(rpc.requests) && rpc.requests >= 30) gap(diagnostics, 'DEPLOYMENT_RECEIPT_UNAVAILABLE');
    else {
      diagnostics.rpcRequests++;
      try {
        const receipt = await rpc.request('eth_getTransactionReceipt', [created.transactionHash]);
        if (!object(receipt) || number(receipt.status) !== 1 || !same(receipt.transactionHash, created.transactionHash)
          || number(receipt.blockNumber) !== created.blockNumber || !same(receipt.blockHash, created.blockHash)
          || !same(receipt.contractAddress, token) || receipt.to !== undefined && receipt.to !== null || !address(receipt.from))
          throw new Error('DEPLOYMENT_RECEIPT_MISMATCH');
        created.deployer = address(receipt.from);
      } catch { created = null; gap(diagnostics, 'DEPLOYMENT_RECEIPT_UNPROVEN'); }
    }
  }
  diagnostics.creation = created;
  if (created?.deployer) {
    history.deployerAddress = created.deployer;
    history.evidence = unique([...history.evidence, ...created.evidence]);
  } else gap(history, 'DEPLOYER_IDENTITY_UNPROVEN');

  const suppliedHistory = sourceFact(deployerHistory, token, head, now)
    && history.deployerAddress && same(deployerHistory.deployerAddress, history.deployerAddress);
  if (deployerHistory && !suppliedHistory) gap(history, 'DEPLOYER_HISTORY_SOURCE_INVALID');
  let contractsProven = false; let rugsProven = false; let fundsProven = false; let historyCoverage = false;
  if (suppliedHistory) {
    history.checkedAt = deployerHistory.checkedAt;
    history.evidence = unique([...history.evidence, ...deployerHistory.evidence]);
    historyCoverage = coverage(deployerHistory.coverage, 'deployer-lifetime', head, 0);
    const contracts = deployerHistory.previousContracts;
    if (Array.isArray(contracts) && contracts.length <= 128 && contracts.every(item => object(item)
      && address(item.address) && item.chainId === NETWORK.chainId && item.canonical === true
      && whole(item.blockNumber) && item.blockNumber < created.blockNumber && hash(item.blockHash)
      && hash(item.transactionHash) && same(item.deployerAddress, history.deployerAddress) && refs(item.evidence)
      && (item.blockNumber !== head.number || same(item.blockHash, head.hash)))) {
      const identities = new Set(contracts.map(item => address(item.address)));
      if (identities.size === contracts.length && !identities.has(token) && (contracts.length || historyCoverage)) {
        history.previousContracts = contracts.map(item => ({ chainId: NETWORK.chainId, address: address(item.address),
          deployerAddress: history.deployerAddress, blockNumber: item.blockNumber, blockHash: item.blockHash.toLowerCase(),
          transactionHash: item.transactionHash.toLowerCase(), canonical: true, evidence: [...item.evidence] }));
        // An empty/partial list is an observation, never a zero lifetime count.
        if (historyCoverage) { history.previousContractsCount = contracts.length; contractsProven = true; }
      }
    }
    const rugs = deployerHistory.knownRugs;
    if (Array.isArray(rugs) && rugs.length <= 128 && rugs.every(item => object(item) && item.chainId === NETWORK.chainId
      && address(item.address) && item.confirmed === true && text(item.source) && refs(item.evidence)
      && history.previousContracts?.some(contract => same(contract.address, item.address)))) {
      const identities = new Set(rugs.map(item => address(item.address)));
      if (identities.size === rugs.length && (rugs.length || historyCoverage && deployerHistory.rugAssessmentComplete === true)) {
        history.knownRugs = rugs.map(item => ({ chainId: NETWORK.chainId, address: address(item.address),
          confirmed: true, source: item.source, evidence: [...item.evidence] }));
        if (rugs.length || historyCoverage && deployerHistory.rugAssessmentComplete === true) {
          history.knownMaliciousDeployments = rugs.length;
          rugsProven = historyCoverage && deployerHistory.rugAssessmentComplete === true;
        }
      }
    }
    const funding = deployerHistory.fundingOrigin;
    if (object(funding) && funding.chainId === NETWORK.chainId && funding.canonical === true
      && same(funding.walletAddress, history.deployerAddress) && address(funding.sourceAddress)
      && funding.firstFunding === true && funding.complete === true && hash(funding.transactionHash)
      && whole(funding.blockNumber) && funding.blockNumber <= created.blockNumber && hash(funding.blockHash)
      && (funding.blockNumber !== head.number || same(funding.blockHash, head.hash))
      && text(funding.source) && refs(funding.evidence)) {
      history.fundingOrigin = { chainId: NETWORK.chainId, walletAddress: history.deployerAddress,
        sourceAddress: address(funding.sourceAddress), firstFunding: true, canonical: true, complete: true,
        transactionHash: funding.transactionHash.toLowerCase(), blockNumber: funding.blockNumber,
        blockHash: funding.blockHash.toLowerCase(), source: funding.source, evidence: [...funding.evidence] };
      fundsProven = true;
    }
    history.complete = deployerHistory.complete && historyCoverage && contractsProven && rugsProven && fundsProven;
  }
  if (!historyCoverage) gap(history, 'DEPLOYER_LIFETIME_HISTORY_NOT_INDEXED');
  if (!contractsProven) gap(history, 'DEPLOYER_PREVIOUS_CONTRACTS_UNPROVEN');
  if (!rugsProven) gap(history, 'DEPLOYER_RUG_HISTORY_UNPROVEN');
  if (!fundsProven) gap(history, 'DEPLOYER_FUNDING_ORIGIN_UNPROVEN');

  const suppliedActivity = sourceFact(launchActivity, token, head, now);
  if (launchActivity && !suppliedActivity) gap(activity, 'LAUNCH_ACTIVITY_SOURCE_INVALID');
  let launchCoverage = false; let bundlesProven = false; let sniperProven = false;
  if (suppliedActivity) {
    activity.checkedAt = launchActivity.checkedAt;
    activity.evidence = unique([...activity.evidence, ...launchActivity.evidence]);
    launchCoverage = whole(pool?.createdBlock) && hash(pool?.createdBlockHash)
      && pool.createdBlock <= head.number && (pool.createdBlock !== head.number || same(pool.createdBlockHash, head.hash))
      && coverage(launchActivity.coverage, 'token-launch', head, pool.createdBlock);
    const bundles = launchActivity.bundles;
    const numerator = uint(bundles?.bundledSupplyRaw); const denominator = uint(bundles?.totalSupplyRaw);
    if (object(bundles) && bundles.complete === true && bundles.membershipProven === true
      && bundles.supplyProven === true && refs(bundles.evidence) && numerator !== null && denominator !== null
      && denominator > 0n && numerator <= denominator && (numerator > 0n || launchCoverage)) {
      activity.bundledSupplyPct = Number((numerator * 100000000n + (numerator > 0n ? denominator - 1n : 0n)) / denominator) / 1000000;
      activity.evidence = unique([...activity.evidence, ...bundles.evidence]); bundlesProven = true;
    }
    const sniper = launchActivity.sniperManipulation;
    if (object(sniper) && typeof sniper.confirmed === 'boolean' && sniper.complete === true && refs(sniper.evidence)
      && (sniper.confirmed || launchCoverage)) {
      activity.sniperManipulationConfirmed = sniper.confirmed;
      activity.evidence = unique([...activity.evidence, ...sniper.evidence]); sniperProven = true;
    }
    activity.complete = launchActivity.complete && launchCoverage && bundlesProven && sniperProven;
  }
  if (!launchCoverage) gap(activity, 'LAUNCH_HISTORY_COVERAGE_UNPROVEN');
  if (!bundlesProven) gap(activity, 'BUNDLED_SUPPLY_UNPROVEN');
  if (!sniperProven) gap(activity, 'SNIPER_MANIPULATION_UNPROVEN');
  return result();
}
