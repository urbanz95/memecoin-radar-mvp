import { createHash } from 'node:crypto';
import { decodeEventLog, parseAbiItem } from 'viem';
import { SWAPS, topic } from '../onchain/abi.mjs';
import { hash, hex, quantity } from '../cloudflare/rpc.mjs';
import { recordLabel, recordTime } from './records.mjs';
import { normalizeHistoryWindow } from './wallet-history-window.mjs';

const DAYS = 30;
const SECONDS = DAYS * 86400;
const SOURCE = 'canonical-erc20-wallet-backfill/v1';
const MAX_EVIDENCE_BYTES = 131072;
const MAX_EVENT_BYTES = 16384;
// The collector appends receipt observations before its 128 KiB ledger check.
const MAX_CAPTURED_BYTES = 120000;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const TRANSFER_TOPIC = topic(TRANSFER).toLowerCase();
const SWAP_TYPES = new Map(Object.entries(SWAPS).map(([type, abi]) => [topic(abi).toLowerCase(), type]));
const ZERO = '0x' + '0'.repeat(40);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const wallet = value => address(value) && address(value) !== ZERO ? address(value) : null;
const lower = value => typeof value === 'string' ? value.toLowerCase() : null;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encoded = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const bytes = value => new TextEncoder().encode(encoded(value)).length;
const textBytes = value => new TextEncoder().encode(value).length;
const all = async statement => (await statement.all())?.results ?? [];
const fail = reason => { throw new Error('MVP_WALLET_BACKFILL_' + reason); };
const validLimit = (value, maximum, minimum = 1) => whole(value) && value >= minimum && value <= maximum;
const retryAt = (at, attempts) => at + Math.min(86400000, 60000 * 2 ** Math.min(attempts, 10));
const proofRef = block => `onchain:block:4663:${block.number}:${block.hash}`;
const logFingerprint = event => digest([event.blockHash, event.logIndex, event.transactionHash,
  event.blockNumber, event.address, event.topics, event.data]);

function blockOf(raw, expected, anchor, at) {
  if (!raw || !hash(raw.hash)) fail('INVALID_BLOCK');
  const block = { number: quantity(raw.number), hash: lower(raw.hash), timestamp: quantity(raw.timestamp) };
  if (block.number !== expected || block.timestamp * 1000 > at
    || block.number > anchor.number || block.number !== anchor.number && block.timestamp > anchor.timestamp) fail('INVALID_BLOCK');
  return block;
}
function rawEvent(log, kind, tokenAddress, range, anchor) {
  if (!log || log.removed === true || !wallet(log.address) || !hash(log.blockHash) || !hash(log.transactionHash)
    || !Array.isArray(log.topics) || log.topics.length > 4
    || log.topics.some(value => !/^0x[0-9a-f]{64}$/i.test(value))
    || typeof log.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data)) fail('INVALID_LOG');
  const blockNumber = quantity(log.blockNumber); const logIndex = quantity(log.logIndex);
  if (blockNumber < range.from || blockNumber > range.to || blockNumber > anchor.number
    || blockNumber === anchor.number && lower(log.blockHash) !== anchor.hash) fail('LOG_RANGE_MISMATCH');
  return { chainId: 4663, kind, tokenAddress, address: address(log.address), blockNumber,
    blockHash: lower(log.blockHash), transactionHash: lower(log.transactionHash), logIndex,
    topics: log.topics.map(lower), data: lower(log.data) };
}
function transferOf(log, range, job) {
  const event = rawEvent(log, 'TRANSFER', wallet(log.address), range, job.anchor);
  if (event.topics[0] !== TRANSFER_TOPIC) fail('TRANSFER_FILTER_MISMATCH');
  // ERC721 shares the selector but has a fourth indexed topic and no uint data.
  if (event.topics.length === 4 && event.data === '0x') return null;
  const { args } = decodeEventLog({ abi: [TRANSFER], topics: event.topics, data: event.data, strict: true });
  event.args = { from: address(args.from), to: address(args.to), value: args.value.toString() };
  const matched = range.direction === 0 ? event.args.from : event.args.to;
  if (matched !== job.walletAddress) fail('TRANSFER_FILTER_MISMATCH');
  if (bytes(event) > MAX_EVENT_BYTES) fail('EVENT_EVIDENCE_LIMIT');
  return event;
}
function history(job, at, canonical) {
  const normalized = normalizeHistoryWindow({ schemaVersion: 1, scope: 'declared-window', chainId: 4663,
    walletAddress: job.walletAddress, days: DAYS,
    startAt: new Date(job.startAt).toISOString(), endAt: new Date(job.endAt).toISOString(),
    fromBlock: job.fromBlock?.number ?? null, fromBlockHash: job.fromBlock?.hash ?? null,
    toBlock: job.anchor.number, toBlockHash: job.anchor.hash,
    complete: false, contiguous: false, canonical, openingBalanceKnown: false,
    source: SOURCE, evidence: [proofRef(job.anchor), ...(job.fromBlock ? [proofRef(job.fromBlock)] : []),
      `d1:mvp_wallet_backfill_jobs:${job.jobId}`] }, { now: at, walletAddress: job.walletAddress, anchor: job.anchor });
  return { ...normalized, scanComplete: Boolean(job.scanComplete) && canonical,
    scanCoverage: { scope: 'erc20-transfer-from-to', complete: Boolean(job.scanComplete) && canonical },
    financialCoverage: { complete: false, nativeHistoryComplete: false, internalHistoryComplete: false,
      openingEquityKnown: false, feesComplete: false } };
}

async function selectJob(DB, requestedWallet, generation, at) {
  if (requestedWallet) {
    const row = await DB.prepare(`SELECT * FROM mvp_wallet_backfill_jobs WHERE wallet_address=? AND generation=?
      AND state!='REORG' ORDER BY updated_at DESC,job_id LIMIT 1`).bind(requestedWallet, generation).first();
    return { row, walletAddress: requestedWallet };
  }
  const row = await DB.prepare(`SELECT j.* FROM mvp_wallet_backfill_jobs j WHERE j.generation=? AND j.state!='REORG'
    AND j.next_attempt_at<=? AND (j.state!='COMPLETE' OR EXISTS(SELECT 1 FROM mvp_wallet_backfill_receipt_queue q
      WHERE q.job_id=j.job_id AND q.state IN ('PENDING','RETRY','CAPTURED') AND q.next_attempt_at<=?))
    ORDER BY j.updated_at,j.job_id LIMIT 1`).bind(generation, at, at).first();
  if (row) return { row, walletAddress: row.wallet_address };
  const profile = await DB.prepare(`SELECT p.wallet_address FROM mvp_wallet_profiles p
    WHERE p.chain_id=4663 AND p.generation=? AND NOT EXISTS(SELECT 1 FROM mvp_wallet_backfill_jobs j
      WHERE j.wallet_address=p.wallet_address AND j.generation=? AND j.state!='REORG')
    ORDER BY p.checked_at DESC,p.wallet_address LIMIT 1`).bind(generation, generation).first();
  return { row: null, walletAddress: wallet(profile?.wallet_address) };
}

/** Prepare only. The caller MUST commit commands and returned ledger evidence
 * together inside its existing atomic lease-fenced D1 batch. No writes occur
 * here. maxRequests is an absolute rpc.requests ceiling; maxStepRequests also
 * bounds the number of singleton RPC operations in this invocation. */
export async function prepareWalletBackfillStep(DB, rpc, { runId, observedAt, head, walletAddress,
  maxStepRequests = 4, maxRequests = 30, chunkBlocks = 2048, maxLogs = 32,
  maxEvents = 16, maxReceipts = 1, targetForPool } = {}) {
  recordLabel(runId, 'RUN_ID'); const at = recordTime(observedAt);
  if (!whole(head?.number) || !hash(head?.hash) || !whole(head?.timestamp)
    || head.timestamp < SECONDS
    || walletAddress !== undefined && !wallet(walletAddress)
    || !validLimit(maxStepRequests, 4) || !validLimit(maxRequests, 30, 0)
    || !validLimit(chunkBlocks, 2048) || !validLimit(maxLogs, 32)
    || !validLimit(maxEvents, 16) || !validLimit(maxReceipts, 1)
    || targetForPool !== undefined && typeof targetForPool !== 'function') fail('INVALID_OPTIONS');
  const result = { commands: [], events: [], receipts: [], historyWindows: [], diagnostics: [],
    counts: { requests: 0, events: 0, receipts: 0, pages: 0, scanComplete: false, financialComplete: false } };
  if (head.timestamp * 1000 > at) {
    result.diagnostics.push('WALLET_BACKFILL_FUTURE_HEAD_DEFERRED'); return result;
  }
  const initialRequests = whole(rpc?.requests) ? rpc.requests : 0;
  const available = () => result.counts.requests < maxStepRequests
    && Math.max(initialRequests + result.counts.requests, whole(rpc?.requests) ? rpc.requests : 0) < maxRequests;
  if (!available()) { result.diagnostics.push('WALLET_BACKFILL_RPC_BUDGET_DEFERRED'); return result; }
  const epoch = await DB.prepare('SELECT generation FROM mvp_wallet_epoch WHERE id=1').first();
  const generation = epoch?.generation ?? 0;
  const selected = await selectJob(DB, wallet(walletAddress), generation, at);
  if (!selected.walletAddress) return result;
  const prior = selected.row;
  if (prior && prior.next_attempt_at > at) {
    result.historyWindows.push(history(JSON.parse(prior.job_json), at, false));
    result.diagnostics.push('WALLET_BACKFILL_RETRY_DEFERRED'); return result;
  }
  const anchor = { number: head.number, hash: lower(head.hash), timestamp: head.timestamp };
  const job = prior ? JSON.parse(prior.job_json) : {
    schemaVersion: 1, jobId: digest([4663, selected.walletAddress, generation, anchor.hash]),
    walletAddress: selected.walletAddress, generation, anchor,
    startAt: (anchor.timestamp - SECONDS) * 1000, endAt: anchor.timestamp * 1000,
    boundary: { low: 0, high: anchor.number, candidate: anchor, predecessor: null },
    fromBlock: null, scan: null, scanComplete: false, endpointProof: null,
  };
  let state = prior?.state === 'RETRY' ? (job.fromBlock ? 'SCANNING' : 'BOUNDARY') : prior?.state ?? 'BOUNDARY';
  let nextAttemptAt = at; let attempts = prior?.attempts ?? 0; let lastReason = null;
  const mutations = []; const mutationEvidence = [];
  const append = (sql, values) => { mutations.push(DB.prepare(sql).bind(...values)); mutationEvidence.push([sql, values]); };
  const request = async (method, params) => {
    if (!available()) throw new Error('BACKFILL_BUDGET_DEFERRED');
    result.counts.requests++;
    if (typeof rpc.request === 'function') return rpc.request(method, params);
    const [value] = await rpc.batch([[method, params]]);
    if (value?.error !== undefined) throw Object.assign(new Error('RPC_REMOTE_ERROR'), { code: value.error });
    return value?.value;
  };
  const headers = new Map();
  const getBlock = async number => {
    if (headers.has(number)) return headers.get(number);
    const block = blockOf(await request('eth_getBlockByNumber', [hex(number), false]), number, job.anchor, at);
    headers.set(number, block); return block;
  };
  const canonicalLog = async event => {
    const block = await getBlock(event.blockNumber);
    if (block.hash !== event.blockHash) throw new Error('BACKFILL_REORG');
    return block;
  };
  const emitted = new Map();
  const emit = async event => {
    const key = `${event.blockHash}:${event.logIndex}`; const fingerprint = logFingerprint(event);
    const known = emitted.get(key) ?? (await DB.prepare(`SELECT fingerprint FROM mvp_wallet_backfill_seen
      WHERE job_id=? AND block_hash=? AND log_index=?`).bind(job.jobId, event.blockHash, event.logIndex).first())?.fingerprint;
    if (known && known !== fingerprint) fail('EVENT_CONFLICT');
    if (known) return true;
    if (result.events.length >= maxEvents) return false;
    await canonicalLog(event);
    emitted.set(key, fingerprint); result.events.push(event);
    append('INSERT OR IGNORE INTO mvp_wallet_backfill_seen(job_id,block_hash,log_index,fingerprint) VALUES(?,?,?,?)',
      [job.jobId, event.blockHash, event.logIndex, fingerprint]);
    return true;
  };
  const queueTransfer = event => append(`INSERT OR IGNORE INTO mvp_wallet_backfill_receipt_queue
    (job_id,transaction_hash,block_hash,block_number,next_attempt_at) VALUES(?,?,?,?,?)`,
  [job.jobId, event.transactionHash, event.blockHash, event.blockNumber, at]);
  const archive = (item, reason, evidence) => {
    const raw = encoded(evidence); const jsonBytes = textBytes(raw);
    const fingerprint = createHash('sha256').update(raw).digest('hex');
    const retained = jsonBytes <= MAX_EVIDENCE_BYTES ? raw : encoded({ evidenceFormat: 'json-sha256-v1',
      rawRetained: false, sha256: fingerprint, jsonBytes,
      reason: 'WALLET_BACKFILL_RAW_EVIDENCE_LIMIT', source: SOURCE });
    append(`INSERT OR IGNORE INTO mvp_wallet_backfill_unresolved_receipts
      (job_id,transaction_hash,block_hash,observed_at,reason,evidence_hash,evidence_json) VALUES(?,?,?,?,?,?,?)`,
    [job.jobId, item.transaction_hash, item.block_hash, at, reason, fingerprint, retained]);
  };
  const unresolved = (item, reason, evidence) => {
    archive(item, reason, evidence);
    append(`UPDATE mvp_wallet_backfill_receipt_queue SET state='RETRY',attempts=?,next_attempt_at=?,last_reason=?
      WHERE job_id=? AND transaction_hash=? AND block_hash=?`,
    [(item.attempts ?? 0) + 1, retryAt(at, item.attempts ?? 0), reason, job.jobId, item.transaction_hash, item.block_hash]);
    result.diagnostics.push(reason);
  };

  try {
    const checkedAnchor = await getBlock(job.anchor.number);
    if (checkedAnchor.hash !== job.anchor.hash || checkedAnchor.timestamp !== job.anchor.timestamp) throw new Error('BACKFILL_REORG');
    if (job.fromBlock) {
      const checkedFrom = await getBlock(job.fromBlock.number);
      if (checkedFrom.hash !== job.fromBlock.hash || checkedFrom.timestamp !== job.fromBlock.timestamp) throw new Error('BACKFILL_REORG');
    }
    job.endpointProof = { checkedAt: new Date(at).toISOString(), canonical: true, source: SOURCE,
      evidence: [proofRef(checkedAnchor), ...(job.fromBlock ? [proofRef(job.fromBlock)] : [])] };

    // Lower-bound timestamp search is durable after every midpoint. The actual
    // preceding header is retained to prove the inclusive 30-day boundary.
    while (!job.fromBlock && available()) {
      const search = job.boundary;
      if (search.low < search.high) {
        const middle = Math.floor((search.low + search.high) / 2); const block = await getBlock(middle);
        if (block.timestamp >= job.startAt / 1000) { search.high = middle; search.candidate = block; }
        else { search.low = middle + 1; search.predecessor = block; }
      } else {
        const candidate = search.candidate.number === search.low ? search.candidate : await getBlock(search.low);
        const previous = search.low === 0 ? null : search.predecessor?.number === search.low - 1
          ? search.predecessor : await getBlock(search.low - 1);
        if (candidate.timestamp < job.startAt / 1000 || previous && previous.timestamp >= job.startAt / 1000)
          fail('BOUNDARY_PROOF_INVALID');
        job.fromBlock = candidate; job.boundary.predecessor = previous;
        job.scan = { nextBlock: candidate.number, pending: [] }; state = 'SCANNING';
      }
    }

    // Pending pages always drain before issuing another range query. A restart
    // resumes at the committed page cursor and never repeats consumed events.
    let page = job.fromBlock ? await DB.prepare(`SELECT * FROM mvp_wallet_backfill_pages
      WHERE job_id=? AND cursor<log_count ORDER BY from_block,direction,page_key LIMIT 1`).bind(job.jobId).first() : null;
    if (!page && job.fromBlock && !job.scanComplete && available()) {
      if (!job.scan.pending.length && job.scan.nextBlock <= job.anchor.number) {
        const from = job.scan.nextBlock; const to = Math.min(job.anchor.number, from + chunkBlocks - 1);
        job.scan.pending.push({ from, to, direction: 0 }, { from, to, direction: 1 }); job.scan.nextBlock = to + 1;
      }
      const range = job.scan.pending[0];
      if (range) {
        const topicWallet = '0x' + job.walletAddress.slice(2).padStart(64, '0');
        const topics = range.direction === 0 ? [TRANSFER_TOPIC, topicWallet] : [TRANSFER_TOPIC, null, topicWallet];
        let response; let split = false;
        try {
          response = await request('eth_getLogs', [{ fromBlock: hex(range.from), toBlock: hex(range.to), topics }]);
          if (!Array.isArray(response)) {
            // Nonstandard pagination is not proof of a full standard RPC range.
            if (response && (Array.isArray(response.logs) || response.hasMore || response.nextPage || response.continuationToken)) split = true;
            else fail('INVALID_LOG_RESPONSE');
          } else if (response.length >= maxLogs && range.from < range.to) split = true;
        } catch (error) {
          if (error.message === 'RPC_RESPONSE_LIMIT' || error.code === -32005) split = true;
          else throw error;
        }
        if (split) {
          if (range.from === range.to) throw new Error('BACKFILL_SINGLE_BLOCK_RESPONSE_UNRESOLVED');
          const middle = Math.floor((range.from + range.to) / 2);
          job.scan.pending.splice(0, 1, { ...range, to: middle }, { ...range, from: middle + 1 });
          result.diagnostics.push('WALLET_BACKFILL_LOG_RANGE_SPLIT');
        } else {
          const unique = new Map();
          for (const log of response) {
            const event = transferOf(log, range, job); if (!event) continue;
            const key = `${event.blockHash}:${event.logIndex}`;
            if (unique.has(key) && logFingerprint(unique.get(key)) !== logFingerprint(event)) fail('EVENT_CONFLICT');
            unique.set(key, event);
          }
          const logs = [...unique.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
          for (let offset = 0; offset < logs.length; offset += maxLogs) {
            const chunk = logs.slice(offset, offset + maxLogs);
            const pageKey = `${range.from}:${range.to}:${range.direction}:${offset}:${digest(chunk)}`;
            append(`INSERT OR IGNORE INTO mvp_wallet_backfill_pages
              (job_id,page_key,from_block,to_block,direction,logs_json,log_count) VALUES(?,?,?,?,?,?,?)`,
            [job.jobId, pageKey, range.from, range.to, range.direction, encoded(chunk), chunk.length]);
            result.counts.pages++;
            if (!page) page = { page_key: pageKey, logs_json: encoded(chunk), cursor: 0, log_count: chunk.length };
          }
          job.scan.pending.shift();
        }
      }
    }
    if (page) {
      const logs = JSON.parse(page.logs_json); let cursor = page.cursor;
      while (cursor < logs.length) {
        try { if (!await emit(logs[cursor])) break; }
        catch (error) { if (error.message === 'BACKFILL_BUDGET_DEFERRED') break; throw error; }
        queueTransfer(logs[cursor]); cursor++;
      }
      if (cursor !== page.cursor) append('UPDATE mvp_wallet_backfill_pages SET cursor=? WHERE job_id=? AND page_key=?',
        [cursor, job.jobId, page.page_key]);
      // Completion is deliberately checked on the next invocation, when all
      // inserted pages and their committed cursors are visible to the reader.
    }
    if (job.fromBlock && !page && !job.scan.pending.length && job.scan.nextBlock > job.anchor.number) {
      job.scanComplete = true; state = 'COMPLETE';
    }

    // Receipts get their own durable queue because a Transfer can belong to an
    // unknown router/pool. They are retained even when no catalog swap resolves.
    const item = job.fromBlock ? await DB.prepare(`SELECT * FROM mvp_wallet_backfill_receipt_queue
      WHERE job_id=? AND state IN ('PENDING','RETRY','CAPTURED') AND next_attempt_at<=?
      ORDER BY CASE state WHEN 'CAPTURED' THEN 0 ELSE 1 END,block_number,transaction_hash LIMIT 1`)
      .bind(job.jobId, at).first() : null;
    if (item && result.receipts.length < maxReceipts) {
      let captured = item.receipt_json ? JSON.parse(item.receipt_json) : null;
      let swapEvents = item.events_json ? JSON.parse(item.events_json) : [];
      if ((!captured || !captured.block) && available()) {
        let receipt = captured?.receipt ?? null;
        try {
          if (!receipt) receipt = await request('eth_getTransactionReceipt', [item.transaction_hash]);
          if (!receipt || !Array.isArray(receipt.logs)) throw new Error('WALLET_BACKFILL_RECEIPT_UNAVAILABLE');
          if (lower(receipt.transactionHash) !== item.transaction_hash || lower(receipt.blockHash) !== item.block_hash
            || quantity(receipt.blockNumber) !== item.block_number) throw new Error('BACKFILL_REORG');
          const block = await getBlock(item.block_number);
          if (block.hash !== item.block_hash) throw new Error('BACKFILL_REORG');
          let unknownSwap = false;
          for (const log of receipt.logs) {
            const type = SWAP_TYPES.get(lower(log?.topics?.[0])); if (!type) continue;
            const id = type === 'v4' ? `v4:${lower(log.topics[1])}` : `${type}:${lower(log.address)}`;
            const row = await DB.prepare('SELECT pool_json FROM pools WHERE id=?').bind(id).first();
            if (!row) { unknownSwap = true; continue; }
            const pool = JSON.parse(row.pool_json);
            if (pool.id !== id || pool.type !== type || address(pool.address) !== address(log.address)
              || type === 'v4' && lower(pool.poolId) !== lower(log.topics[1])) { unknownSwap = true; continue; }
            const target = targetForPool ? await targetForPool(pool) : null;
            const targetAddress = wallet(target?.targetAddress);
            const quoteAddress = address(target?.quoteAddress);
            if (!targetAddress || !quoteAddress || targetAddress === quoteAddress
              || ![address(pool.token0), address(pool.token1)].includes(targetAddress)
              || ![address(pool.token0), address(pool.token1)].includes(quoteAddress)
              || quoteAddress === ZERO && type !== 'v4') { unknownSwap = true; continue; }
            const event = rawEvent(log, 'SWAP', targetAddress, { from: item.block_number, to: item.block_number }, job.anchor);
            if (event.transactionHash !== item.transaction_hash || event.blockHash !== item.block_hash) throw new Error('BACKFILL_REORG');
            const { args } = decodeEventLog({ abi: [SWAPS[type]], topics: event.topics, data: event.data, strict: true });
            event.args = JSON.parse(encoded(args));
            event.pool = { ...pool, quoteAddress, quoteDecimals: whole(target.quoteDecimals) && target.quoteDecimals <= 36
              ? target.quoteDecimals : null };
            if (bytes(event) > MAX_EVENT_BYTES) throw new Error('WALLET_BACKFILL_EVENT_EVIDENCE_LIMIT');
            swapEvents.push(event);
          }
          captured = { receipt, block, pool: swapEvents[0]?.pool ?? null, tokenAddress: swapEvents[0]?.tokenAddress ?? null,
            events: swapEvents, source: SOURCE };
          if (bytes(captured) > MAX_CAPTURED_BYTES) throw new Error('WALLET_BACKFILL_RECEIPT_EVIDENCE_LIMIT');
          if (!swapEvents.length || unknownSwap) {
            archive(item, unknownSwap ? 'CATALOG_SWAP_UNRESOLVED' : 'NO_KNOWN_POOL_SWAP', captured);
          }
          append(`UPDATE mvp_wallet_backfill_receipt_queue SET state='CAPTURED',receipt_json=?,events_json=?,last_reason=NULL
            WHERE job_id=? AND transaction_hash=? AND block_hash=?`,
          [encoded(captured), encoded(swapEvents), job.jobId, item.transaction_hash, item.block_hash]);
        } catch (error) {
          if (error.message === 'BACKFILL_REORG') throw error;
          // Retain raw evidence now and resume its canonical-header lookup on
          // the next step instead of fetching the same receipt repeatedly.
          if (error.message === 'BACKFILL_BUDGET_DEFERRED') {
            if (receipt) {
              const deferred = { receipt, block: null, source: SOURCE };
              if (bytes(deferred) > MAX_EVIDENCE_BYTES) {
                unresolved(item, 'WALLET_BACKFILL_RECEIPT_EVIDENCE_LIMIT', { receipt, source: SOURCE });
              } else {
                append(`UPDATE mvp_wallet_backfill_receipt_queue SET state='CAPTURED',receipt_json=?,events_json=NULL
                  WHERE job_id=? AND transaction_hash=? AND block_hash=?`,
                [encoded(deferred), job.jobId, item.transaction_hash, item.block_hash]);
                archive(item, 'CANONICAL_RECEIPT_HEADER_DEFERRED', deferred);
              }
            }
            result.diagnostics.push('WALLET_BACKFILL_RECEIPT_BUDGET_DEFERRED');
          } else unresolved(item, error.message.startsWith('WALLET_BACKFILL_') ? error.message : 'WALLET_BACKFILL_RECEIPT_RPC_UNAVAILABLE',
            { receipt: receipt ?? null, source: SOURCE });
          captured = null;
        }
      }
      if (captured?.block) {
        let cursor = item.event_cursor;
        try {
          if (!headers.has(item.block_number)) await getBlock(item.block_number);
          if (headers.get(item.block_number).hash !== item.block_hash) throw new Error('BACKFILL_REORG');
          while (cursor < swapEvents.length && await emit(swapEvents[cursor])) cursor++;
          const done = cursor === swapEvents.length;
          append(`UPDATE mvp_wallet_backfill_receipt_queue SET state=?,event_cursor=?,last_reason=NULL
            WHERE job_id=? AND transaction_hash=? AND block_hash=?`,
          [done ? 'COMPLETE' : 'CAPTURED', cursor, job.jobId, item.transaction_hash, item.block_hash]);
          if (done) result.receipts.push(captured);
        } catch (error) { if (error.message !== 'BACKFILL_BUDGET_DEFERRED') throw error; }
      }
    }
  } catch (error) {
    if (error.message === 'BACKFILL_REORG') {
      state = 'REORG'; job.scanComplete = false;
      result.events = []; result.receipts = []; mutations.length = 0; mutationEvidence.length = 0;
      lastReason = 'WALLET_BACKFILL_REORG'; result.diagnostics.push(lastReason);
    } else if (error.message === 'BACKFILL_BUDGET_DEFERRED') {
      result.diagnostics.push('WALLET_BACKFILL_RPC_BUDGET_DEFERRED');
    } else {
      state = 'RETRY'; lastReason = error.message === 'BACKFILL_SINGLE_BLOCK_RESPONSE_UNRESOLVED'
        ? 'WALLET_BACKFILL_SINGLE_BLOCK_RESPONSE_UNRESOLVED' : 'WALLET_BACKFILL_RPC_RETRY';
      nextAttemptAt = retryAt(at, attempts); attempts++;
      result.diagnostics.push(lastReason);
    }
  }

  const version = (prior?.version ?? 0) + 1;
  const jobJson = encoded(job);
  const token = digest([runId, version, state, nextAttemptAt, attempts, lastReason, jobJson, mutationEvidence]);
  result.commands.push(DB.prepare(`INSERT OR REPLACE INTO mvp_wallet_backfill_guard(id,ok) VALUES(1,CASE WHEN
    ((?=0 AND NOT EXISTS(SELECT 1 FROM mvp_wallet_backfill_jobs WHERE job_id=?))
    OR EXISTS(SELECT 1 FROM mvp_wallet_backfill_jobs WHERE job_id=? AND version=?)
    OR EXISTS(SELECT 1 FROM mvp_wallet_backfill_jobs WHERE job_id=? AND version=? AND last_run_id=? AND last_token=?)
    ) AND (SELECT generation FROM mvp_wallet_epoch WHERE id=1)=?
    THEN 1 ELSE 0 END)`).bind(prior?.version ?? 0, job.jobId, job.jobId, prior?.version ?? 0,
  job.jobId, version, runId, token, generation));
  result.commands.push(DB.prepare(`INSERT INTO mvp_wallet_backfill_jobs
    (job_id,wallet_address,generation,version,state,next_attempt_at,attempts,last_reason,job_json,last_run_id,last_token,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET version=excluded.version,state=excluded.state,
    next_attempt_at=excluded.next_attempt_at,attempts=excluded.attempts,last_reason=excluded.last_reason,
    job_json=excluded.job_json,last_run_id=excluded.last_run_id,last_token=excluded.last_token,updated_at=excluded.updated_at`)
    .bind(job.jobId, job.walletAddress, generation, version, state, nextAttemptAt, attempts, lastReason, jobJson, runId, token, at));
  result.commands.push(...mutations);
  const canonical = state !== 'REORG' && job.endpointProof?.checkedAt === new Date(at).toISOString();
  result.historyWindows.push(history(job, at, canonical));
  result.counts.events = result.events.length; result.counts.receipts = result.receipts.length;
  result.counts.scanComplete = Boolean(job.scanComplete) && canonical;
  return result;
}
