import { NETWORK, isEvmAddress } from '../network.mjs';
import { hash, hex, quantity } from './rpc.mjs';

const MINUTE = 60;
const DAY = 86400;
const codePresent = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(value);
const codeValid = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function header(value, expected, head) {
  try {
    const number = typeof value?.number === 'number' ? value.number : quantity(value?.number);
    const timestamp = typeof value?.timestamp === 'number' ? value.timestamp : quantity(value?.timestamp);
    if (!integer(number) || number !== expected || number > head.number || !integer(timestamp)
      || timestamp > head.timestamp || !hash(value?.hash)) return null;
    return { number, timestamp, hash: value.hash.toLowerCase() };
  } catch { return null; }
}

async function sourceRecord(address, fetchImpl) {
  try {
    const response = await fetchImpl.call(globalThis,
      `https://sourcify.dev/server/v2/contract/${NETWORK.chainId}/${address}?fields=deployment,proxyResolution`,
      { redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) { await response.body?.cancel(); return { reason: response.status === 404 ? 'SOURCE_NOT_INDEXED' : 'SOURCE_UNAVAILABLE' }; }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 32768) { await reader.cancel(); return { reason: 'SOURCE_RESPONSE_LIMIT' }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (String(data?.chainId) !== String(NETWORK.chainId) || !same(data.address, address)) return { reason: 'SOURCE_IDENTITY_MISMATCH' };
    const sourceVerification = { provider: 'sourcify', runtimeMatch: ['match', 'exact_match'].includes(data.runtimeMatch) ? data.runtimeMatch : null,
      creationMatch: ['match', 'exact_match'].includes(data.creationMatch) ? data.creationMatch : null };
    if (typeof data.proxyResolution?.isProxy === 'boolean') sourceVerification.isProxy = data.proxyResolution.isProxy;
    let candidate;
    const deployment = data.deployment;
    if (hash(deployment?.transactionHash)) {
      const raw = deployment.blockNumber;
      const block = raw === null || raw === undefined ? null : typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)) ? Number(raw) : NaN;
      if (block === null || integer(block)) candidate = { transactionHash: deployment.transactionHash.toLowerCase(), blockNumber: block };
    }
    return { candidate, sourceVerification };
  } catch { return { reason: 'SOURCE_UNAVAILABLE' }; }
}

// Code-existence bounds classify an observation window, never invent a deployment date.
// maxRequests is an absolute ceiling on rpc.requests, not an additional allowance.
export async function ageEvidence(rpc, address, pool, head, created,
  { fetchImpl = fetch, now = Date.now, maxRequests = Math.min(30, (rpc.requests ?? 0) + 4),
    include23HourBoundary = false } = {}) {
  const result = { classification: 'unclassified', basis: 'insufficient-evidence', evidence: [], reasons: [] };
  maxRequests = Math.min(maxRequests, 30);
  const initialRequests = Number.isSafeInteger(rpc.requests) ? rpc.requests : 0;
  let localRequests = 0;
  const reason = code => { if (!result.reasons.includes(code) && result.reasons.length < 8) result.reasons.push(code); };
  const batch = async calls => {
    if (!calls.length) return [];
    if (!Number.isSafeInteger(maxRequests) || Math.max(rpc.requests ?? 0, initialRequests + localRequests) >= maxRequests || localRequests >= 4) {
      reason('AGE_RPC_BUDGET_EXHAUSTED'); return null;
    }
    localRequests++;
    try {
      const data = await rpc.batch(calls);
      if (!Array.isArray(data) || data.length !== calls.length) { reason('AGE_RPC_UNAVAILABLE'); return null; }
      return data.map(entry => entry && entry.error === undefined ? entry.value : undefined);
    } catch { reason('AGE_RPC_UNAVAILABLE'); return null; }
  };
  try {
    if (typeof include23HourBoundary !== 'boolean' || !isEvmAddress(address) || !integer(head?.number) || !integer(head?.timestamp) || !hash(head?.hash)
      || !integer(pool?.createdBlock) || !hash(pool?.createdBlockHash)
      || !header(created, pool.createdBlock, head) || !same(created.hash, pool.createdBlockHash)
      || !Number.isFinite(now()) || head.timestamp * 1000 > now() + 30000 || now() - head.timestamp * 1000 > 60000) {
      reason('AGE_INPUT_INVALID'); return result;
    }
    address = address.toLowerCase();
    const source = await sourceRecord(address, fetchImpl);
    if (source.reason) reason(source.reason);
    if (source.sourceVerification) result.sourceVerification = source.sourceVerification;
    const candidates = [];
    if (hash(pool.creationTransactionHash)) candidates.push({ transactionHash: pool.creationTransactionHash.toLowerCase(), blockNumber: pool.createdBlock });
    if (source.candidate && !candidates.some(c => c.transactionHash === source.candidate.transactionHash)) candidates.push(source.candidate);
    const oldPool = head.timestamp - created.timestamp >= 7 * DAY;
    const anchorNumber = head.number >= 10000 ? head.number - 10000 : null;
    const firstCalls = candidates.map(c => ['eth_getTransactionReceipt', [c.transactionHash]]);
    const poolCodeIndex = firstCalls.push(['eth_getCode', [address, hex(created.number)]]) - 1;
    const anchorIndex = !oldPool && anchorNumber !== null ? firstCalls.push(['eth_getBlockByNumber', [hex(anchorNumber), false]]) - 1 : null;
    const first = await batch(firstCalls);
    if (!first) return result;
    const poolCode = first[poolCodeIndex];
    const receipts = candidates.flatMap((candidate, index) => {
      const receipt = first[index];
      try {
        const number = quantity(receipt?.blockNumber);
        if (quantity(receipt?.status) !== 1 || !same(receipt.contractAddress, address) || !same(receipt.transactionHash, candidate.transactionHash)
          || !isEvmAddress(receipt.from) || (receipt.to !== undefined && receipt.to !== null) || !hash(receipt.blockHash)
          || number > head.number || (candidate.blockNumber !== null && number !== candidate.blockNumber)) return [];
        return [{ receipt, number, transactionHash: candidate.transactionHash }];
      } catch { return []; }
    });
    const boundaryNumbers = [];
    if (!oldPool && anchorIndex !== null) {
      const anchor = header(first[anchorIndex], anchorNumber, head);
      const secondsPerBlock = anchor ? (head.timestamp - anchor.timestamp) / 10000 : 0;
      if (secondsPerBlock > 0 && Number.isFinite(secondsPerBlock)) {
        // An opt-in tighter upper bound supports the MVP's <24h window without
        // changing the legacy probes or adding another HTTP batch. The actual
        // block timestamp and its canonical hash remain the evidence.
        for (const seconds of [16 * MINUTE, ...(include23HourBoundary ? [23 * 3600] : []), 47 * 3600, 7 * DAY + 3600])
          boundaryNumbers.push(Math.max(0, head.number - Math.ceil(seconds / secondsPerBlock)));
      } else reason('AGE_BLOCK_TIMING_UNAVAILABLE');
    }
    const requested = [...new Set([...receipts.map(r => r.number), ...boundaryNumbers])];
    const second = await batch(requested.map(number => ['eth_getBlockByNumber', [hex(number), false]]));
    const headers = new Map([[created.number, header(created, created.number, head)]]);
    if (second) requested.forEach((number, index) => { const parsed = header(second[index], number, head); if (parsed) headers.set(number, parsed); });
    const validReceipts = receipts.filter(item => same(headers.get(item.number)?.hash, item.receipt.blockHash));
    const boundaries = [...new Set(boundaryNumbers)].map(number => headers.get(number)).filter(Boolean);
    const codes = boundaries.length ? await batch(boundaries.map(block => ['eth_getCode', [address, hex(block.number)]])) : [];
    // Recheck canonical hashes after the historical code reads. The caller also
    // checks its pinned head before committing the complete collection.
    const proofs = [...new Map([created, ...validReceipts.map(r => headers.get(r.number)), ...boundaries].map(b => [b.number, b])).values()];
    const checked = await batch(proofs.map(block => ['eth_getBlockByNumber', [hex(block.number), false]]));
    if (!checked || proofs.some((block, index) => !same(header(checked[index], block.number, head)?.hash, block.hash))) {
      reason('AGE_CANONICAL_PROOF_UNAVAILABLE'); return result;
    }
    if (new Set(validReceipts.map(item => item.number)).size > 1) { reason('AGE_MULTIPLE_DEPLOYMENTS'); return result; }
    for (const item of validReceipts) {
      const block = headers.get(item.number);
      result.contractCreatedAt = new Date(block.timestamp * 1000).toISOString();
      result.deployer = item.receipt.from.toLowerCase();
      result.basis = 'direct-creation-receipt';
      result.evidence.push({ kind: 'direct-creation-receipt', transactionHash: item.transactionHash, blockNumber: block.number, blockHash: block.hash });
      const minutes = (head.timestamp - block.timestamp) / MINUTE;
      result.lowerBoundMinutes = minutes; result.upperBoundMinutes = minutes;
      result.classification = minutes >= 7 * 1440 ? 'established' : minutes >= 15 && minutes <= 48 * 60 ? 'new' : 'unclassified';
      return result;
    }
    const observations = [{ block: headers.get(created.number), code: poolCode }, ...boundaries.map((block, index) => ({ block, code: codes?.[index] }))];
    const positive = []; const negative = [];
    for (const { block, code } of observations) {
      if (!codeValid(code)) continue;
      const minutes = (head.timestamp - block.timestamp) / MINUTE;
      result.evidence.push({ kind: 'historical-code-existence', blockNumber: block.number, blockHash: block.hash,
        timestamp: new Date(block.timestamp * 1000).toISOString(), hasBytecode: codePresent(code) });
      (codePresent(code) ? positive : negative).push(minutes);
    }
    if (positive.length) result.lowerBoundMinutes = Math.max(...positive);
    if (negative.length) result.upperBoundMinutes = Math.min(...negative);
    if (positive.length && negative.length && result.lowerBoundMinutes >= result.upperBoundMinutes) {
      result.basis = 'code-existence-bounds'; reason('AGE_CODE_CONTINUITY_UNPROVEN'); return result;
    }
    if (positive.some(minutes => minutes >= 7 * 1440)) result.classification = 'established';
    else if (positive.some(minutes => minutes >= 15) && negative.some(minutes => minutes <= 48 * 60)) result.classification = 'new';
    if (result.evidence.length) result.basis = 'code-existence-bounds';
    if (result.classification === 'unclassified') reason('AGE_WINDOW_NOT_PROVEN');
    return result;
  } catch { reason('AGE_EVIDENCE_UNAVAILABLE'); return result; }
}
