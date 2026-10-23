import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { ERC20 } from '../onchain/abi.mjs';
import { isEvmAddress } from '../network.mjs';
import { hash, hex, quantity } from './rpc.mjs';

const ZERO = '0x' + '0'.repeat(40);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const UINT256 = (1n << 256n) - 1n;
const whole = value => Number.isSafeInteger(value) && value >= 0;
const addressOf = value => isEvmAddress(value) ? value.toLowerCase() : null;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const HOLDER_PROBE_ABI = parseAbi(['function balances(address token, address[] accounts) view returns (uint256[] results)']);
// Runtime below is generated from this source, never deployed. It exists only
// inside an eth_call state override and cannot persist or move funds.
export const HOLDER_PROBE_SOURCE = 'pragma solidity 0.8.30; interface T {function balanceOf(address) external view returns(uint256);} contract HolderProbe {function balances(address token,address[] calldata accounts) external view returns(uint256[] memory results){results=new uint256[](accounts.length);for(uint256 i;i<accounts.length;i++){results[i]=T(token).balanceOf(accounts[i]);}}}';
export const HOLDER_PROBE_RUNTIME = "0x6080604052600436101561001257600080fd5b60003560e01c63d3e5ca871461002757600080fd5b346101cd5760403660031901126101cd576004356001600160a01b038116908190036101cd576024359067ffffffffffffffff82116101cd57366023830112156101cd5781600401359067ffffffffffffffff82116101cd573660248360051b850101116101cd576100988261020a565b6100a560405191826101d2565b8281526100b18361020a565b6020820190601f190136823760005b84811015610188576001600160a01b03600582901b878101602401359182169160009083900361018557604051926370a0823160e01b845260048401526020836024818a5afa928315610178578193610141575b50855184101561012d57508401602001526001016100c0565b634e487b7160e01b81526032600452602490fd5b9092506020813d8211610170575b8161015c602093836101d2565b8101031261016c57519138610114565b8280fd5b3d915061014f565b50604051903d90823e3d90fd5b80fd5b50906040519182916020830190602084525180915260408301919060005b8181106101b4575050500390f35b82518452859450602093840193909201916001016101a6565b600080fd5b90601f8019910116810190811067ffffffffffffffff8211176101f457604052565b634e487b7160e01b600052604160045260246000fd5b67ffffffffffffffff81116101f45760051b6020019056fea164736f6c634300081e000a";
const probeAddress = () => '0x' + [...crypto.getRandomValues(new Uint8Array(20))].map(value => value.toString(16).padStart(2, '0')).join('');
function raw(value, signed = false) {
  if (typeof value !== 'string' || !(signed ? /^-?(?:0|[1-9]\d{0,77})$/ : /^(?:0|[1-9]\d{0,77})$/).test(value)) return null;
  const n = BigInt(value); return n >= (signed ? -UINT256 : 0n) && n <= UINT256 ? n : null;
}
function header(value, expected, head) {
  try {
    const number = quantity(value?.number); const timestamp = quantity(value?.timestamp);
    if (number !== expected || number > head.number || timestamp > head.timestamp || !hash(value?.hash)
      || (number === head.number && !equal(value.hash, head.hash))) return null;
    return { number, hash: value.hash.toLowerCase(), timestamp };
  } catch { return null; }
}
function creationOf(value, head) {
  if (value?.kind !== 'direct-creation-receipt' || !whole(value.blockNumber) || value.blockNumber > head.number
    || !hash(value.blockHash) || !hash(value.transactionHash)) return null;
  return { kind: 'direct-creation-receipt', blockNumber: value.blockNumber, blockHash: value.blockHash.toLowerCase(), proven: true,
    transactionHash: value.transactionHash.toLowerCase(),
    ...(addressOf(value.deployer) && addressOf(value.deployer) !== ZERO ? { deployer: addressOf(value.deployer) } : {}) };
}
function fresh(address, origin, window) {
  return { version: 1, address, origin, nextBlock: origin.blockNumber, anchor: null,
    balances: [], netSupplyRaw: '0', transfers: 0, window };
}
function restore(value, address, head, maxAddresses, maxStateBytes) {
  if (!value || value.version !== 1 || value.address !== address || !whole(value.origin?.blockNumber)
    || value.origin.blockNumber > head.number || typeof value.origin.proven !== 'boolean'
    || (value.origin.blockHash !== null && !hash(value.origin.blockHash))
    || !['direct-creation-receipt', 'chain-genesis', 'partial-observation'].includes(value.origin.kind)
    || (value.origin.proven && !(value.origin.kind === 'chain-genesis' && value.origin.blockNumber === 0 && value.origin.genesisCodeAbsent === true)
      && !hash(value.origin.transactionHash)) || !whole(value.nextBlock)
    || value.nextBlock < value.origin.blockNumber || !whole(value.transfers) || !whole(value.window) || value.window < 1
    || !Array.isArray(value.balances) || value.balances.length > maxAddresses || raw(value.netSupplyRaw, true) === null
    || bytes(value) > maxStateBytes - 256) return null;
  if (value.anchor ? !whole(value.anchor.number) || !hash(value.anchor.hash) || !whole(value.anchor.timestamp)
    || value.anchor.number + 1 !== value.nextBlock || value.anchor.number < value.origin.blockNumber
    : value.nextBlock !== value.origin.blockNumber || value.balances.length || value.transfers || value.netSupplyRaw !== '0') return null;
  const seen = new Set(); let sum = 0n;
  for (const item of value.balances) {
    if (!Array.isArray(item) || item.length !== 2 || !addressOf(item[0]) || item[0] !== addressOf(item[0])
      || item[0] === ZERO || seen.has(item[0]) || raw(item[1], !value.origin.proven) === null || BigInt(item[1]) === 0n) return null;
    seen.add(item[0]); sum += BigInt(item[1]);
  }
  if (sum !== BigInt(value.netSupplyRaw) || (value.origin.proven && sum < 0n)) return null;
  // Copy typed fields only: persisted state cannot smuggle unbounded metadata.
  return { version: 1, address, origin: { kind: value.origin.kind, blockNumber: value.origin.blockNumber,
    blockHash: value.origin.blockHash?.toLowerCase() ?? null, proven: value.origin.proven,
    ...(value.origin.kind === 'direct-creation-receipt' ? { transactionHash: value.origin.transactionHash.toLowerCase() } : {}),
    ...(value.origin.kind === 'chain-genesis' ? { genesisCodeAbsent: value.origin.genesisCodeAbsent === true } : {}),
    ...(addressOf(value.origin.deployer) && value.origin.proven ? { deployer: addressOf(value.origin.deployer) } : {}) },
  nextBlock: value.nextBlock, anchor: value.anchor ? { number: value.anchor.number, hash: value.anchor.hash.toLowerCase(), timestamp: value.anchor.timestamp } : null,
  balances: value.balances.map(([a, n]) => [a, n]), netSupplyRaw: value.netSupplyRaw,
  transfers: value.transfers, window: value.window };
}
function transfers(logs, address, from, to, knownHeaders) {
  const entries = new Map(); const blocks = new Map(); const blockNumbers = new Map(); const transactions = new Map();
  for (const log of logs) {
    if (addressOf(log?.address) !== address || (log.removed !== undefined && log.removed !== false)
      || !hash(log.blockHash) || !hash(log.transactionHash) || !Array.isArray(log.topics) || log.topics.length !== 3
      || !equal(log.topics[0], TRANSFER) || log.topics.slice(1).some(t => typeof t !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(t))
      || typeof log.data !== 'string' || !/^0x[0-9a-f]{64}$/i.test(log.data)) throw new Error('HOLDER_INVALID_TRANSFER');
    const block = quantity(log.blockNumber); const index = quantity(log.logIndex);
    if (block < from || block > to) throw new Error('HOLDER_TRANSFER_OUTSIDE_RANGE');
    const blockHash = log.blockHash.toLowerCase(); const tx = log.transactionHash.toLowerCase();
    if ((blocks.has(block) && blocks.get(block) !== blockHash) || (blockNumbers.has(blockHash) && blockNumbers.get(blockHash) !== block)
      || (knownHeaders.has(block) && knownHeaders.get(block).hash !== blockHash)
      || (transactions.has(tx) && transactions.get(tx) !== `${block}:${blockHash}`)) throw new Error('HOLDER_INCONSISTENT_TRANSFER_BLOCK');
    blocks.set(block, blockHash); blockNumbers.set(blockHash, block); transactions.set(tx, `${block}:${blockHash}`);
    if (log.transactionIndex !== undefined) quantity(log.transactionIndex);
    const fromAddress = '0x' + log.topics[1].slice(-40).toLowerCase(); const toAddress = '0x' + log.topics[2].slice(-40).toLowerCase();
    const amount = BigInt(log.data); const id = `${blockHash}:${index}`;
    const fingerprint = `${tx}:${block}:${fromAddress}:${toAddress}:${amount}`;
    if (entries.has(id)) {
      if (entries.get(id).fingerprint !== fingerprint) throw new Error('HOLDER_CONFLICTING_TRANSFER');
      continue;
    }
    if (fromAddress === ZERO && toAddress === ZERO && amount !== 0n) throw new Error('HOLDER_INVALID_ZERO_TRANSFER');
    entries.set(id, { block, blockHash, index, tx, from: fromAddress, to: toAddress, amount, fingerprint });
  }
  return [...entries.values()].sort((a, b) => a.block - b.block || a.index - b.index);
}
function apply(state, logs) {
  const balances = new Map(state.balances.map(([a, n]) => [a, BigInt(n)]));
  let supply = BigInt(state.netSupplyRaw);
  const add = (a, n) => {
    if (a === ZERO) return;
    const value = (balances.get(a) ?? 0n) + n;
    if (value < -UINT256 || value > UINT256 || (state.origin.proven && value < 0n)) throw new Error('HOLDER_EVENT_BALANCE_UNDERFLOW');
    if (value) balances.set(a, value); else balances.delete(a);
  };
  for (const log of logs) {
    if (log.from === ZERO) supply += log.amount;
    else if (state.origin.proven && (balances.get(log.from) ?? 0n) < log.amount) throw new Error('HOLDER_EVENT_BALANCE_UNDERFLOW');
    if (log.to === ZERO) supply -= log.amount;
    add(log.from, -log.amount); add(log.to, log.amount);
    if (supply < -UINT256 || supply > UINT256 || (state.origin.proven && supply < 0n)) throw new Error('HOLDER_EVENT_SUPPLY_INVALID');
  }
  return { balances: [...balances].map(([a, n]) => [a, n.toString()]), netSupplyRaw: supply.toString(), transfers: state.transfers + logs.length };
}
function percent(value, supply, roundUp = false) {
  if (supply <= 0n) return null;
  return Number((value * 100000000n + (roundUp && value > 0n ? supply - 1n : 0n)) / supply) / 1000000;
}
const readUint = entry => {
  try { return typeof entry?.value === 'string' ? decodeFunctionResult({ abi: ERC20, functionName: 'totalSupply', data: entry.value }) : null; }
  catch { return null; }
};

/**
 * Two read-only HTTP batches at most. maxRequests is an absolute FreeRpc ceiling
 * (30 leaves the collector's two final canonical-head calls). creation is an
 * already verified direct-creation-receipt proof from ageEvidence. Otherwise a
 * genesis-to-head scan plus absence of bytecode at genesis can establish the
 * start. historyMode:'partial' uses observedFromBlock without proving a start.
 * State is JSON-safe and <=128KiB. Up to 1024 balances may be independently read
 * at one pinned block using a transient view aggregator; five direct calls
 * cross-check that an unusual caller has not changed those balances.
 * Transfer history is not an audit of token accounting or insider funding.
 */
export async function analyseHolders(rpc, address, head, token = {}, options = {}) {
  const assessment = { status: 'INCOMPLETE', scope: 'token-distribution-at-block', checkedAt: null,
    blockNumber: null, blockHash: null, risks: [], gaps: [], metrics: {}, lowerBounds: {},
    linkedInsidersPct: null, bundledSupplyPct: null };
  const evidence = { method: 'erc20-transfer-ledger-and-balanceOf/v1', ranges: [], balances: [],
    accountingAssumption: 'ERC20 totalSupply/balanceOf invariants; events alone never establish distribution.',
    linkedInsiders: 'Funding relationships not indexed.', bundles: 'Transaction co-occurrence does not prove a bundle.' };
  const output = { state: null, assessment, evidence, snapshot: {} };
  const gap = code => { if (!assessment.gaps.includes(code) && assessment.gaps.length < 16) assessment.gaps.push(code); };
  const risk = (code, reason) => assessment.risks.push({ code, reason });
  try {
    address = addressOf(address);
    const maxRequests = Math.min(30, options.maxRequests ?? 30);
    const maxHttpRequests = Math.min(2, options.maxHttpRequests ?? 2);
    const maxBlocks = Math.min(1000000000, options.maxBlocks ?? (whole(head?.number) ? head.number + 1 : 0));
    const maxLogs = Math.min(512, options.maxLogs ?? 256);
    const maxAddresses = Math.min(1024, options.maxAddresses ?? 1024);
    const maxStateBytes = Math.min(131072, options.maxStateBytes ?? 131072);
    if (!address || address === ZERO || !whole(head?.number) || !whole(head?.timestamp) || !hash(head?.hash)
      || ![maxRequests, maxHttpRequests, maxBlocks, maxLogs, maxAddresses, maxStateBytes].every(whole)
      || !maxBlocks || !maxLogs || !maxAddresses || maxStateBytes < 1024) { gap('HOLDER_INVALID_INPUT'); return output; }
    const creation = creationOf(options.creation, head);
    const start = whole(options.observedFromBlock) && options.observedFromBlock <= head.number ? options.observedFromBlock : head.number;
    const origin = creation ?? (options.historyMode === 'partial'
      ? { kind: 'partial-observation', blockNumber: start, blockHash: null, proven: false }
      : { kind: 'chain-genesis', blockNumber: 0, blockHash: null, proven: false, genesisCodeAbsent: false });
    let state = restore(options.state, address, head, maxAddresses, maxStateBytes);
    if (options.state && !state) gap('HOLDER_SAVED_STATE_REJECTED');
    if (state && creation && (!state.origin.proven || state.origin.blockNumber !== creation.blockNumber
      || state.origin.blockHash !== creation.blockHash || state.origin.transactionHash !== creation.transactionHash)) {
      state = null; gap('HOLDER_CREATION_PROOF_CHANGED_RESTARTED');
    }
    if (!state) state = fresh(address, origin, maxBlocks);
    state.window = Math.min(state.window, maxBlocks);
    if (creation?.deployer) state.origin.deployer = creation.deployer;
    if (state.nextBlock > head.number + 1) { state = fresh(address, state.origin, state.window); gap('HOLDER_HEAD_REGRESSION_RESTARTED'); }
    output.state = state;
    const coverage = () => {
      assessment.coverage = { fromBlock: output.state.origin.blockNumber, fromBlockProven: output.state.origin.proven,
        indexedThroughBlock: output.state.anchor?.number ?? null, nextBlock: output.state.nextBlock,
        headBlock: head.number, remainingBlocks: Math.max(0, head.number - output.state.nextBlock + 1),
        transferHistoryComplete: output.state.origin.proven && output.state.nextBlock === head.number + 1,
        distributionComplete: false, maxAddresses, maxStateBytes, windowBlocks: output.state.window };
    };
    coverage();
    gap('LINKED_INSIDERS_NOT_INDEXED'); gap('BUNDLES_NOT_PROVEN');
    let localRequests = 0;
    const initial = whole(rpc?.requests) ? rpc.requests : 0;
    const available = () => Math.min(maxHttpRequests - localRequests,
      maxRequests - Math.max(whole(rpc?.requests) ? rpc.requests : 0, initial + localRequests));
    const batch = async calls => {
      if (available() < 1) { gap('HOLDER_RPC_BUDGET_DEFERRED'); return null; }
      localRequests++;
      try { const values = await rpc.batch(calls); return Array.isArray(values) && values.length === calls.length ? values : null; }
      catch { return null; }
    };
    if (available() < 2) { gap('HOLDER_RPC_BUDGET_DEFERRED'); return output; }
    const temporary = addressOf(options.probeAddress ?? probeAddress());
    if (!temporary || temporary === ZERO || temporary === address) { gap('HOLDER_INVALID_PROBE_ADDRESS'); return output; }
    const hasRange = state.nextBlock <= head.number;
    const end = hasRange ? Math.min(head.number, state.nextBlock + state.window - 1) : head.number;
    const numbers = [...new Set([state.anchor?.number ?? state.origin.blockNumber, end])];
    const calls = numbers.map(number => ['eth_getBlockByNumber', [hex(number), false]]);
    const genesisCodeIndex = state.origin.kind === 'chain-genesis' && !state.origin.genesisCodeAbsent
      ? calls.push(['eth_getCode', [address, '0x0']]) - 1 : null;
    const probeCodeIndex = calls.push(['eth_getCode', [temporary, hex(head.number)]]) - 1;
    if (hasRange) calls.push(['eth_getLogs', [{ address, topics: [TRANSFER], fromBlock: hex(state.nextBlock), toBlock: hex(end) }]]);
    const first = await batch(calls);
    if (!first) {
      output.state.window = Math.max(1, Math.floor(state.window / 2)); gap('HOLDER_RANGE_UNAVAILABLE'); coverage(); return output;
    }
    const headers = new Map(numbers.map((number, i) => [number, header(first[i]?.value, number, head)]));
    if ([...headers.values()].some(value => !value)) { gap('HOLDER_CANONICAL_HEADER_UNAVAILABLE'); return output; }
    const prior = headers.get(state.anchor?.number ?? state.origin.blockNumber);
    if ((state.anchor && !equal(prior.hash, state.anchor.hash))
      || (!state.anchor && state.origin.blockHash && !equal(prior.hash, state.origin.blockHash))) {
      output.state = fresh(address, state.origin, state.window); gap('HOLDER_REORG_RESTARTED'); coverage(); return output;
    }
    const nextOrigin = { ...state.origin, blockHash: state.origin.blockHash ?? prior.hash };
    if (genesisCodeIndex !== null) {
      if (first[genesisCodeIndex]?.value === '0x') { nextOrigin.proven = true; nextOrigin.genesisCodeAbsent = true; }
      else gap('HOLDER_GENESIS_INITIAL_BALANCES_UNKNOWN');
    }
    if (!nextOrigin.proven) gap('HOLDER_DEPLOYMENT_START_UNPROVEN');
    state.origin = nextOrigin;
    const logs = hasRange ? first.at(-1)?.value : [];
    let proposed = state; let observedBalances = state.balances; let validatedTransfers = null;
    if (!Array.isArray(logs) || logs.length > maxLogs) {
      output.state.window = Math.max(1, Math.floor(state.window / 2));
      gap(state.window === 1 ? 'HOLDER_SINGLE_BLOCK_TOO_DENSE' : 'HOLDER_RANGE_SHRUNK');
    } else {
      try {
        const parsed = transfers(logs, address, state.nextBlock, end, headers);
        const changes = apply(state, parsed); observedBalances = changes.balances;
        proposed = { ...state, origin: nextOrigin, ...changes, nextBlock: end + 1, anchor: headers.get(end),
          window: Math.min(maxBlocks, logs.length < maxLogs / 4 ? state.window * 2 : state.window) };
        if (hasRange) evidence.ranges.push({ fromBlock: state.nextBlock, toBlock: end, endpointHash: proposed.anchor.hash,
          returnedLogs: logs.length, uniqueTransfers: parsed.length });
        if (proposed.balances.length > maxAddresses || bytes(proposed) > maxStateBytes - 256) {
          proposed = state; gap('HOLDER_LEDGER_CAPACITY_REACHED');
        } else validatedTransfers = parsed;
      } catch (error) { gap(/^HOLDER_/.test(error.message) ? error.message : 'HOLDER_INVALID_TRANSFER'); }
    }
    const sampleBlock = proposed !== state || !hasRange ? end : head.number;
    const expectedHeader = sampleBlock === end ? headers.get(end) : head;
    const positives = observedBalances.filter(([, n]) => BigInt(n) > 0n)
      .sort((a, b) => BigInt(a[1]) === BigInt(b[1]) ? a[0].localeCompare(b[0]) : BigInt(a[1]) > BigInt(b[1]) ? -1 : 1);
    const deployer = addressOf(state.origin.deployer);
    const selected = [];
    const aggregate = positives.length > 6 || (options.forceAggregate === true && positives.length > 0);
    const add = value => { const a = addressOf(value); if (a && a !== ZERO && !selected.includes(a) && selected.length < (aggregate ? maxAddresses : 6)) selected.push(a); };
    if (state.origin.proven && positives.length <= 6) positives.forEach(([a]) => add(a));
    else { positives.slice(0, deployer ? 5 : 6).forEach(([a]) => add(a)); }
    add(deployer);
    positives.forEach(([a]) => add(a));
    (Array.isArray(options.candidateAddresses) ? options.candidateAddresses.slice(0, 128) : []).forEach(add);
    const direct = aggregate ? selected.slice(0, 5) : selected;
    const aggregateReady = aggregate && first[probeCodeIndex]?.value === '0x';
    if (aggregate && !aggregateReady) gap('HOLDER_AGGREGATOR_ADDRESS_NOT_EMPTY');
    const secondCalls = [['eth_getBlockByNumber', [hex(sampleBlock), false]],
      ['eth_call', [{ to: address, data: encodeFunctionData({ abi: ERC20, functionName: 'totalSupply' }) }, hex(sampleBlock)]],
      ...direct.map(holder => ['eth_call', [{ to: address,
        data: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [holder] }) }, hex(sampleBlock)]])];
    const aggregateIndex = aggregateReady ? secondCalls.push(['eth_call', [{ to: temporary,
      data: encodeFunctionData({ abi: HOLDER_PROBE_ABI, functionName: 'balances', args: [address, selected] }),
      gas: '0x989680', gasPrice: '0x0' }, hex(sampleBlock), { [temporary]: { code: HOLDER_PROBE_RUNTIME } }]]) - 1 : null;
    const second = await batch(secondCalls);
    const confirmed = second && header(second[0]?.value, sampleBlock, head);
    if (!confirmed || !equal(confirmed.hash, expectedHeader.hash)) {
      if (confirmed) { output.state = fresh(address, state.origin, state.window); gap('HOLDER_REORG_RESTARTED'); }
      else gap('HOLDER_RANGE_CONFIRMATION_UNAVAILABLE');
      coverage(); return output;
    }
    output.state = proposed; coverage();
    if (hasRange && validatedTransfers && proposed !== state && typeof options.onValidatedEvents === 'function') {
      const originals = new Map(logs.map(log => [`${log.blockHash.toLowerCase()}:${quantity(log.logIndex)}`, log]));
      const events = validatedTransfers.map(log => {
        const original = originals.get(`${log.blockHash}:${log.index}`);
        return { chainId: 4663, kind: 'TRANSFER', tokenAddress: address, address, blockNumber: log.block,
          blockHash: original.blockHash.toLowerCase(), transactionHash: log.tx, logIndex: log.index,
          topics: original.topics.map(value => value.toLowerCase()), data: original.data.toLowerCase(),
          args: { from: log.from, to: log.to, value: log.amount.toString() } };
      });
      try { options.onValidatedEvents({ kind: 'TRANSFER', tokenAddress: address,
        range: { kind: 'TRANSFER', tokenAddress: address, address, fromBlock: state.nextBlock, toBlock: end,
          headBlock: head.number, headHash: head.hash, endpointHash: confirmed.hash, source: 'validated-holder-transfers/v1',
          historyComplete: false, tokenHistoryComplete: assessment.coverage.transferHistoryComplete,
          origin: nextOrigin, nextBlock: proposed.nextBlock }, events }); }
      catch { gap('WALLET_EVENT_SINK_FAILED'); }
    }
    const supplied = sampleBlock === head.number ? raw(token?.totalSupplyRaw) : null;
    const supply = readUint(second[1]) ?? supplied;
    evidence.blockNumber = sampleBlock; evidence.blockHash = confirmed.hash;
    evidence.checkedAt = new Date(confirmed.timestamp * 1000).toISOString();
    assessment.blockNumber = sampleBlock; assessment.blockHash = confirmed.hash;
    assessment.checkedAt = evidence.checkedAt;
    evidence.totalSupplyRaw = supply === null ? null : supply.toString();
    evidence.totalSupplySource = readUint(second[1]) === null ? 'caller-pinned-head' : 'eth_call';
    const verified = new Map();
    direct.forEach((a, i) => {
      const value = readUint(second[i + 2]);
      if (value !== null) { verified.set(a, value); evidence.balances.push({ address: a, raw: value.toString() }); }
    });
    if (aggregateIndex !== null) {
      try {
        const data = second[aggregateIndex]?.value;
        const values = decodeFunctionResult({ abi: HOLDER_PROBE_ABI, functionName: 'balances', data });
        if (!Array.isArray(values) || values.length !== selected.length || values.some(value => typeof value !== 'bigint' || value < 0n || value > UINT256)) throw new Error('INVALID_AGGREGATE_BALANCES');
        const missingCrosscheck = direct.some((a, i) => readUint(second[i + 2]) === null);
        const inconsistentCaller = direct.some(a => verified.has(a) && values[selected.indexOf(a)] !== verified.get(a));
        if (missingCrosscheck || inconsistentCaller) {
          if (inconsistentCaller) risk('HOLDER_BALANCE_CALLER_INCONSISTENT', 'As leituras diretas de balanceOf divergem da leitura agregada no mesmo bloco.');
          gap('HOLDER_AGGREGATE_CROSSCHECK_FAILED');
        } else {
          selected.forEach((a, i) => verified.set(a, values[i]));
          evidence.aggregateBalanceVerification = { method: 'eth_call/stateOverrides', readOnly: true, rawRetained: false,
            accountCount: selected.length, directCrosschecks: direct.length, responseHash: keccak256(data),
            runtimeCodeHash: keccak256(HOLDER_PROBE_RUNTIME), compiler: 'solc-0.8.30;viaIR;optimizer200;evm-paris;metadata-none', probeAddress: temporary };
        }
      } catch { gap('HOLDER_AGGREGATE_BALANCES_UNAVAILABLE'); }
    }
    if (verified.size < selected.length) gap('HOLDER_BALANCE_READ_UNAVAILABLE');
    evidence.balanceReadCount = verified.size;
    const excluded = new Set((Array.isArray(options.verifiedPoolAddresses) ? options.verifiedPoolAddresses.slice(0, 16) : [])
      .map(addressOf).filter(Boolean));
    evidence.excludedVerifiedPools = [...excluded];
    const measured = [...verified].filter(([a, n]) => !excluded.has(a) && n > 0n)
      .sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1);
    assessment.lowerBounds.count = measured.length;
    const sumMeasured = [...verified.values()].reduce((sum, n) => sum + n, 0n);
    const supplyConsistent = supply !== null && sumMeasured <= supply;
    if (supply !== null && !supplyConsistent) risk('BALANCE_SUPPLY_INCONSISTENT', 'A soma dos saldos confirmados excede totalSupply no mesmo bloco.');
    const tracked = new Map(output.state.balances.map(([a, n]) => [a, BigInt(n)]));
    const ledgerAtSample = output.state.anchor?.number === sampleBlock;
    const reconciled = ledgerAtSample && output.state.origin.proven && supply !== null
      && BigInt(output.state.netSupplyRaw) === supply && [...tracked.values()].reduce((sum, n) => sum + n, 0n) === supply;
    assessment.supplyReconciled = reconciled;
    const allBalancesVerified = reconciled && [...tracked].every(([a, n]) => n >= 0n && verified.get(a) === n)
      && [...verified].every(([a, n]) => (tracked.get(a) ?? 0n) === n);
    if (ledgerAtSample && output.state.origin.proven && !reconciled) gap('HOLDER_SUPPLY_NOT_RECONCILED');
    if (reconciled && !allBalancesVerified) gap('HOLDER_ALL_BALANCES_NOT_VERIFIED');
    if (supplyConsistent && supply > 0n) {
      const largest = measured[0]?.[1] ?? 0n;
      const topTen = measured.slice(0, 10).reduce((sum, [, n]) => sum + n, 0n);
      assessment.lowerBounds.top1Pct = percent(largest, supply);
      assessment.lowerBounds.top10Pct = percent(topTen, supply);
      const thresholds = options.pipeline === 'new' ? { top1Pct: 5, top10Pct: 25, deployerPct: 2 }
        : { top1Pct: 8, top10Pct: 35, deployerPct: 3 };
      for (const [name, amount] of [['top1Pct', largest], ['top10Pct', topTen]]) if (amount * 100n > supply * BigInt(thresholds[name]))
        risk(`HOLDER_${name === 'top1Pct' ? 'TOP1' : 'TOP10'}_CONCENTRATION`, `Saldos on-chain comprovam concentração superior a ${thresholds[name]}% (${name}) no bloco ${sampleBlock}.`);
      if (deployer && verified.has(deployer)) {
        assessment.metrics.deployerPct = percent(verified.get(deployer), supply, true);
        if (verified.get(deployer) * 100n > supply * BigInt(thresholds.deployerPct))
          risk('HOLDER_DEPLOYER_CONCENTRATION', `O deployer comprovado detém mais de ${thresholds.deployerPct}% do totalSupply no bloco ${sampleBlock}.`);
      }
    } else gap(supply === 0n ? 'HOLDER_ZERO_TOTAL_SUPPLY' : 'HOLDER_TOTAL_SUPPLY_UNAVAILABLE_OR_INCONSISTENT');
    if (allBalancesVerified && assessment.coverage.transferHistoryComplete) {
      const ranked = [...tracked].filter(([a, n]) => !excluded.has(a) && n > 0n)
        .sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1);
      Object.assign(assessment.metrics, { count: ranked.length,
        ...(supply > 0n ? { top1Pct: percent(ranked[0]?.[1] ?? 0n, supply, true),
          top10Pct: percent(ranked.slice(0, 10).reduce((sum, [, n]) => sum + n, 0n), supply, true),
          ...(deployer ? { deployerPct: percent(tracked.get(deployer) ?? 0n, supply, true) } : {}) } : {}) });
      assessment.coverage.distributionComplete = true; assessment.status = 'RECONCILED_AT_HEAD';
    } else if (output.state.nextBlock <= head.number) assessment.status = 'INDEXING';
    if (Object.keys(assessment.metrics).length) output.snapshot.holders = { ...assessment.metrics,
      checkedAt: evidence.checkedAt, source: 'cloudflare-erc20-transfer-ledger/v1',
      evidence: [`onchain:erc20:${address}:${sampleBlock}:${confirmed.hash}`] };
    return output;
  } catch { gap('HOLDER_ANALYSIS_UNAVAILABLE'); return output; }
}
