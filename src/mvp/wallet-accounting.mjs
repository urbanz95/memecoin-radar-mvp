import { createHash } from 'node:crypto';
import { SWAPS, topic } from '../onchain/abi.mjs';

const VERSION = 'fifo-receipt-net-usd/v1';
const ZERO = '0x' + '0'.repeat(40);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SWAP_TOPICS = new Set(Object.values(SWAPS).map(event => topic(event).toLowerCase()));
const MAX_STATE_BYTES = 16384;
const whole = value => Number.isSafeInteger(value) && value >= 0;
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const time = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 64
  && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 240);
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) { const next = a % b; a = b; b = next; } return a || 1n; };
function frac(n = 0n, d = 1n) { if (d <= 0n) throw Error('INVALID_DENOMINATOR'); const g = gcd(n, d); return { n: n / g, d: d / g }; }
const add = (a, b) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => frac(a.n * b.n, a.d * b.d);
const compare = (a, b) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const packed = value => ({ n: value.n.toString(), d: value.d.toString() });
function unpack(value) {
  if (!value || typeof value.n !== 'string' || !/^-?\d{1,180}$/.test(value.n)
    || typeof value.d !== 'string' || !/^[1-9]\d{0,180}$/.test(value.d)) throw Error('INVALID_FRACTION');
  return frac(BigInt(value.n), BigInt(value.d));
}
function decimal(value) {
  if (typeof value !== 'string' || !/^-?\d{1,78}(?:\.\d{1,36})?$/.test(value)) return null;
  const [integer, fraction = ''] = value.split('.');
  return frac(BigInt(integer + fraction), 10n ** BigInt(fraction.length));
}
const numeric = value => Number(value.n * 1000000000n / value.d) / 1000000000;
function money(value) {
  const scale = 10n ** 18n;
  let n = value.n * scale / value.d;
  // Serialize conservatively; comparisons and FIFO allocations use exact
  // rationals before this final conversion, never rounded display profit.
  if (value.n < 0n && value.n * scale % value.d) n--;
  const sign = n < 0n ? '-' : ''; const raw = (n < 0n ? -n : n).toString().padStart(19, '0');
  const tail = raw.slice(-18).replace(/0+$/, '');
  return sign + raw.slice(0, -18) + (tail ? '.' + tail : '');
}
function raw(value) {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]{1,64}|\d{1,78})$/i.test(value)) return null;
  try { const n = BigInt(value); return n >= 0n && n < 2n ** 256n ? n : null; } catch { return null; }
}
function integer(value) {
  if (whole(value)) return value;
  const parsed = raw(value); return parsed !== null && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
}
function priceProof(value, asset, block) {
  const at = time(value?.observedAt); const price = decimal(value?.value);
  if (!asset || value?.chainId !== 4663 || address(value?.assetAddress) !== asset || !price || price.n <= 0n
    || !Number.isFinite(at) || at > block.timestamp * 1000 || block.timestamp * 1000 - at > 120000
    || !whole(value.blockNumber) || value.blockNumber > block.number || !hash(value.blockHash)
    || value.blockNumber === block.number && value.blockHash.toLowerCase() !== block.hash.toLowerCase()
    || typeof value.source !== 'string' || !value.source || !refs(value.evidence)) return null;
  return { chainId: 4663, assetAddress: asset, value: value.value, observedAt: new Date(at).toISOString(),
    blockNumber: value.blockNumber, blockHash: value.blockHash.toLowerCase(), source: value.source, evidence: [...value.evidence] };
}
function valued(amount, decimals, proof) {
  return amount !== null && whole(decimals) && decimals <= 36 && proof ? mul(frac(amount, 10n ** BigInt(decimals)), decimal(proof.value)) : null;
}
function deploymentAt(proof, token, block) {
  const at = time(proof?.timestamp ?? proof?.contractCreatedAt);
  return proof?.kind === 'direct-creation-receipt' && address(proof.address ?? proof.contractAddress) === token
    && whole(proof.blockNumber) && proof.blockNumber <= block.number && hash(proof.blockHash) && hash(proof.transactionHash)
    && refs(proof.evidence) && Number.isFinite(at) && at <= block.timestamp * 1000 ? new Date(at).toISOString() : null;
}

/** Consume an already-ingested Swap and its complete canonical receipt. No RPC or other I/O. */
export function normalizeReceiptSettlement(receipt, swapEvents, context = {}) {
  const result = { status: 'INVALID', trades: [], attributionComplete: false, gaps: [], evidence: [] };
  const stop = (status, gap) => ({ ...result, status, gaps: [gap] });
  try {
    const events = Array.isArray(swapEvents) ? swapEvents.filter(event => event?.kind === 'SWAP') : [];
    const pool = context.pool ?? events[0]?.pool; const block = context.block;
    const wallet = address(receipt?.from); const token = address(context.tokenAddress ?? events[0]?.tokenAddress);
    const quote = address(context.quoteAddress ?? pool?.quoteAddress);
    if ((context.chainId ?? 4663) !== 4663 || !wallet || wallet === ZERO || !token || token === ZERO
      || !block || !whole(block.number) || !whole(block.timestamp) || !hash(block.hash)
      || !hash(receipt?.transactionHash) || integer(receipt.blockNumber) !== block.number
      || receipt.blockHash?.toLowerCase() !== block.hash.toLowerCase()) return stop('INVALID', 'INVALID_RECEIPT_IDENTITY');
    if (integer(receipt.status) !== 1) return stop('NOT_TRADE', 'TRANSACTION_NOT_SUCCESSFUL');
    if (!quote || quote === ZERO) return stop('AMBIGUOUS', 'NATIVE_OR_UNKNOWN_QUOTE_SETTLEMENT');
    if (token === quote || !pool || !['v2', 'v3', 'v4'].includes(pool.type) || !address(pool.address) || !Array.isArray(receipt.logs) || receipt.logs.length > 512)
      return stop('INVALID', 'INVALID_RECEIPT_LOGS');
    const swaps = receipt.logs.filter(log => SWAP_TOPICS.has(log?.topics?.[0]?.toLowerCase()));
    if (events.length !== 1 || swaps.length !== 1) return stop('AMBIGUOUS', 'MULTISWAP_OR_UNINGESTED_ROUTE');
    const event = events[0]; const swap = swaps[0]; const index = integer(swap.logIndex);
    if ((event.chainId ?? 4663) !== 4663 || event.transactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase()
      || integer(event.blockNumber) !== block.number || event.blockHash?.toLowerCase() !== block.hash.toLowerCase()
      || integer(event.logIndex) !== index || address(swap.address) !== address(pool.address) || index === null
      || swap.topics[0].toLowerCase() !== topic(SWAPS[pool.type]).toLowerCase()
      || pool.type === 'v4' && swap.topics[1]?.toLowerCase() !== pool.poolId?.toLowerCase()
      || event.data !== undefined && event.data !== swap.data
      || event.topics !== undefined && JSON.stringify(event.topics.map(value => value.toLowerCase())) !== JSON.stringify(swap.topics.map(value => value.toLowerCase())))
      return stop('INVALID', 'SWAP_RECEIPT_MISMATCH');
    const net = new Map([[token, 0n], [quote, 0n]]); const positions = new Map();
    for (const log of receipt.logs) {
      if (log?.removed || !hash(log?.blockHash) || log.blockHash.toLowerCase() !== block.hash.toLowerCase()
        || log.transactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase() || integer(log.blockNumber) !== block.number
        || integer(log.logIndex) === null || !Array.isArray(log.topics) || !address(log.address))
        return stop('INVALID', 'INVALID_RECEIPT_LOG');
      const fingerprint = JSON.stringify([log.address, log.topics, log.data]);
      const previous = positions.get(integer(log.logIndex));
      if (previous && previous !== fingerprint) return stop('INVALID', 'CONFLICTING_RECEIPT_LOG');
      if (previous) continue; positions.set(integer(log.logIndex), fingerprint);
      if (log.topics[0]?.toLowerCase() !== TRANSFER) continue;
      if (log.topics.length !== 3 || log.topics.slice(1).some(value => !/^0x0{24}[0-9a-f]{40}$/i.test(value))
        || typeof log.data !== 'string' || !/^0x[0-9a-f]{64}$/i.test(log.data)) return stop('INVALID', 'INVALID_TRANSFER_LOG');
      const from = '0x' + log.topics[1].slice(-40).toLowerCase(); const to = '0x' + log.topics[2].slice(-40).toLowerCase();
      if (from !== wallet && to !== wallet) continue;
      const asset = address(log.address);
      if (!net.has(asset)) return stop('AMBIGUOUS', 'ADDITIONAL_WALLET_ASSET_FLOW');
      const amount = BigInt(log.data);
      net.set(asset, net.get(asset) + (to === wallet ? amount : 0n) - (from === wallet ? amount : 0n));
    }
    const targetDelta = net.get(token); const quoteDelta = net.get(quote);
    if (!targetDelta || !quoteDelta || (targetDelta > 0n) === (quoteDelta > 0n)) return stop('AMBIGUOUS', 'OPPOSING_WALLET_NET_FLOWS_NOT_PROVEN');
    const tokenDecimals = integer(context.tokenDecimals ?? pool.tokenDecimals);
    const quoteDecimals = integer(context.quoteDecimals ?? pool.quoteDecimals);
    const quoteUsdProof = priceProof(context.quoteUsd ?? context.valuation?.quoteUsd, quote, block);
    const feeAssetUsdProof = priceProof(context.feeAssetUsd ?? context.valuation?.feeAssetUsd, ZERO, block);
    const gas = raw(receipt.gasUsed); const gasPrice = raw(receipt.effectiveGasPrice);
    const feeNative = gas !== null && gasPrice !== null ? gas * gasPrice : null;
    const quoteAmount = quoteDelta < 0n ? -quoteDelta : quoteDelta;
    const quoteUsd = valued(quoteAmount, quoteDecimals, quoteUsdProof);
    const feeUsd = context.feeComponentsComplete === true ? valued(feeNative, 18, feeAssetUsdProof) : null;
    const evidence = refs(context.evidence) ? [...context.evidence] : [`receipt:${receipt.transactionHash.toLowerCase()}:${block.hash.toLowerCase()}`];
    const trade = { schemaVersion: 1, kind: 'TRADE',
      id: `4663:${block.hash.toLowerCase()}:${receipt.transactionHash.toLowerCase()}:${index}:${wallet}`,
      chainId: 4663, walletAddress: wallet, tokenAddress: token, quoteAddress: quote,
      tokenDecimals: tokenDecimals !== null && tokenDecimals <= 36 ? tokenDecimals : null,
      quoteDecimals: quoteDecimals !== null && quoteDecimals <= 36 ? quoteDecimals : null,
      side: targetDelta > 0n ? 'BUY' : 'SELL', quantityRaw: (targetDelta < 0n ? -targetDelta : targetDelta).toString(),
      quoteAmountRaw: quoteAmount.toString(), feeNativeRaw: feeNative?.toString() ?? null,
      quoteUsdValue: quoteUsd ? money(quoteUsd) : null, feeUsdValue: feeUsd ? money(feeUsd) : null,
      quoteUsdProof, feeAssetUsdProof, timestamp: new Date(block.timestamp * 1000).toISOString(),
      blockNumber: block.number, blockHash: block.hash.toLowerCase(), transactionHash: receipt.transactionHash.toLowerCase(),
      logIndex: index, attributionComplete: true, feesComplete: feeUsd !== null,
      costsComplete: quoteUsd !== null && feeUsd !== null, deploymentAt: deploymentAt(context.deployment, token, block),
      source: 'receipt-transfer-net/v1', evidence };
    return { status: 'SETTLED', trades: [trade], attributionComplete: true,
      gaps: [...(!quoteUsd ? ['HISTORICAL_QUOTE_USD_UNKNOWN'] : []), ...(!feeUsd ? ['HISTORICAL_TOTAL_FEES_USD_UNKNOWN'] : [])], evidence };
  } catch { return stop('INVALID', 'INVALID_SETTLEMENT_INPUT'); }
}

function newState(wallet, chainId, options) {
  const opening = decimal(options.initialEquityUsd);
  return { schemaVersion: 1, accountingVersion: VERSION, chainId, walletAddress: wallet, lots: [], seen: [], lastApplied: null,
    counts: { buys: 0, sells: 0, transfers: 0 }, disposals: 0, wins: 0, pnl: packed(frac()), holding: packed(frac()), early: packed(frac()),
    costsKnown: true, feesKnown: true, attributionKnown: true, holdingKnown: true, earlyKnown: true,
    historyFromStart: completeHistory(options, { historyFromStart: true }), lastDisposalAt: null,
    opening: opening && opening.n > 0n ? packed(opening) : null, peak: opening && opening.n > 0n ? packed(opening) : null,
    drawdown: packed(frac()), equityKnown: true };
}
function restore(value, wallet, chainId) {
  if (!value || bytes(value) > MAX_STATE_BYTES || value.schemaVersion !== 1 || value.accountingVersion !== VERSION
    || value.walletAddress !== wallet || value.chainId !== chainId || !Array.isArray(value.lots) || value.lots.length > 128
    || !Array.isArray(value.seen) || value.seen.length > 32 || !value.counts
    || !['buys', 'sells', 'transfers'].every(key => whole(value.counts[key]))
    || !whole(value.disposals) || !whole(value.wins) || value.wins > value.disposals
    || !['costsKnown', 'feesKnown', 'attributionKnown', 'holdingKnown', 'earlyKnown', 'historyFromStart', 'equityKnown'].every(key => typeof value[key] === 'boolean'))
    throw Error('INVALID_ACCOUNTING_STATE');
  for (const key of ['pnl', 'holding', 'early', 'drawdown']) unpack(value[key]);
  if (value.opening) unpack(value.opening); if (value.peak) unpack(value.peak);
  if (value.lastApplied && (!whole(value.lastApplied.blockNumber) || !whole(value.lastApplied.logIndex)
    || !hash(value.lastApplied.blockHash) || !hash(value.lastApplied.transactionHash))) throw Error('INVALID_ACCOUNTING_CURSOR');
  for (const lot of value.lots) {
    if (!address(lot.tokenAddress) || raw(lot.quantityRaw) === null || raw(lot.quantityRaw) === 0n
      || lot.acquiredAt !== null && !whole(lot.acquiredAt) || ![true, false, null].includes(lot.early)) throw Error('INVALID_ACCOUNTING_LOT');
    if (lot.cost && unpack(lot.cost).n < 0n) throw Error('INVALID_ACCOUNTING_COST');
  }
  if (value.seen.some(item => typeof item.id !== 'string' || item.id.length > 300 || !/^[0-9a-f]{64}$/.test(item.fingerprint)))
    throw Error('INVALID_ACCOUNTING_DEDUP');
  return structuredClone(value);
}
function completeHistory(options, state) {
  const proof = options.historyProof;
  return state.historyFromStart && options.historyComplete === true && proof?.complete === true && proof.contiguous === true
    && proof.canonical === true && proof.openingBalanceKnown === true && refs(proof.evidence);
}
function profile(state, options, gaps = [], requiresReplay = false) {
  const checked = time(options.now ?? Date.now());
  const historyComplete = !requiresReplay && completeHistory(options, state);
  const attributionComplete = !requiresReplay && options.attributionComplete === true && state.attributionKnown;
  const feesComplete = !requiresReplay && options.feesComplete === true && state.feesKnown;
  const costsComplete = !requiresReplay && historyComplete && state.costsKnown;
  const ready = historyComplete && attributionComplete && feesComplete && costsComplete;
  const pnl = unpack(state.pnl); const count = state.disposals;
  const bounded = bytes(state) <= MAX_STATE_BYTES;
  const risk = options.riskFlags;
  const riskFlags = refs(options.riskEvidence) && risk && !Array.isArray(risk) && typeof risk === 'object'
    && ['insider', 'bundler', 'washTrading'].every(key => [true, false, null].includes(risk[key]))
    ? Object.fromEntries(['insider', 'bundler', 'washTrading'].map(key => [key, risk[key]])) : null;
  const evidence = [...new Set([...(refs(options.historyProof?.evidence) ? options.historyProof.evidence : []),
    ...(refs(options.evidence) ? options.evidence : []), ...(state.lastApplied ? [`wallet-ledger:${state.lastApplied.blockHash}:${state.lastApplied.logIndex}`] : [])])];
  const result = { schemaVersion: 1, chainId: state.chainId, walletAddress: state.walletAddress,
    checkedAt: Number.isFinite(checked) ? new Date(checked).toISOString() : null,
    source: VERSION, evidence, historyComplete, costsComplete, feesComplete, attributionComplete,
    clusteringComplete: !requiresReplay && options.clusteringComplete === true, riskFlags,
    realizedTradeCount: ready ? count : null, netRealizedPnlUsd: ready && count ? money(pnl) : null,
    netRealizedPnlUsdExact: ready && count ? { numerator: pnl.n.toString(), denominator: pnl.d.toString() } : null,
    winRatePct: ready && count ? state.wins / count * 100 : null,
    avgHoldingSeconds: ready && count && state.holdingKnown ? numeric(mul(unpack(state.holding), frac(1n, BigInt(count)))) : null,
    earlyEntryPct: ready && count && state.earlyKnown ? numeric(mul(unpack(state.early), frac(100n, BigInt(count)))) : null,
    maxDrawdownPct: ready && count && state.opening && state.equityKnown ? numeric(mul(unpack(state.drawdown), frac(100n))) : null,
    lastRealizedAt: ready && count ? state.lastDisposalAt : null,
    observedCounts: { ...state.counts, disposals: count }, observedLastDisposalAt: state.lastDisposalAt,
    accountingMethod: { version: VERSION, costBasis: 'FIFO', realizedTrade: 'one attributed sell transaction and token',
      holding: 'mean of FIFO quantity-weighted holding seconds per disposal', earlyEntrySeconds: options.earlyEntrySeconds ?? 300,
      drawdown: 'verified opening equity plus cumulative net realized PnL; excludes unrealized token prices', moneyDecimals: 18 },
    requiresReplay, gaps: [...new Set(gaps)], state: bounded ? state : null, accountingState: bounded ? state : null };
  return result;
}

/** Incremental FIFO over normalized cash settlements. Never reads chain state or prices. */
export function computeRealizedWalletMetrics(trades, options = {}) {
  const wallet = address(options.walletAddress ?? trades?.[0]?.walletAddress); const chainId = options.chainId ?? 4663;
  let state = newState(wallet, chainId, options);
  let committed = structuredClone(state);
  try {
    if (!wallet || wallet === ZERO || chainId !== 4663) throw Error('INVALID_ACCOUNTING_IDENTITY');
    if (options.previousState) state = restore(options.previousState, wallet, chainId);
    committed = structuredClone(state);
    if (!Array.isArray(trades) || trades.length > 512 || options.reorgDetected) throw Error('ACCOUNTING_REPLAY_REQUIRED');
    const input = trades.filter(trade => address(trade?.walletAddress) === wallet).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    for (const trade of input) {
      const at = time(trade.timestamp); const quantity = raw(trade.quantityRaw); const token = address(trade.tokenAddress);
      if (trade.chainId !== chainId || typeof trade.id !== 'string' || trade.id.length > 300 || !trade.id
        || !token || token === ZERO || !quantity || !whole(trade.blockNumber) || !whole(trade.logIndex)
        || !hash(trade.blockHash) || !hash(trade.transactionHash) || !Number.isSafeInteger(at) || at < 0
        || at > time(options.now ?? Date.now())) throw Error('INVALID_ACCOUNTING_TRADE');
      const fingerprint = createHash('sha256').update(JSON.stringify(trade)).digest('hex');
      const prior = state.seen.find(item => item.id === trade.id);
      if (prior) { if (prior.fingerprint !== fingerprint) throw Error('CONFLICTING_ACCOUNTING_EVENT'); continue; }
      const cursor = state.lastApplied;
      if (cursor && (trade.blockNumber < cursor.blockNumber || trade.blockNumber === cursor.blockNumber
        && (trade.blockHash !== cursor.blockHash || trade.logIndex <= cursor.logIndex))) throw Error('ACCOUNTING_OUT_OF_ORDER');
      if (trade.kind !== 'TRANSFER' && trade.kind !== 'TRADE') throw Error('UNKNOWN_ACCOUNTING_EVENT');
      if (trade.kind === 'TRADE' && (!address(trade.quoteAddress) || address(trade.quoteAddress) === ZERO))
        throw Error('AMBIGUOUS_ACCOUNTING_QUOTE');
      const block = { number: trade.blockNumber, hash: trade.blockHash, timestamp: Math.floor(at / 1000) };
      const quote = priceProof(trade.quoteUsdProof, address(trade.quoteAddress), block);
      const feePrice = priceProof(trade.feeAssetUsdProof, ZERO, block);
      const gross = valued(raw(trade.quoteAmountRaw), trade.quoteDecimals, quote);
      const fee = trade.feesComplete === true ? valued(raw(trade.feeNativeRaw), 18, feePrice) : null;
      const incoming = trade.kind === 'TRANSFER' ? trade.direction === 'IN' : trade.side === 'BUY';
      if (trade.kind === 'TRANSFER' && !['IN', 'OUT'].includes(trade.direction)
        || trade.kind === 'TRADE' && !['BUY', 'SELL'].includes(trade.side)) throw Error('INVALID_ACCOUNTING_DIRECTION');
      state.attributionKnown &&= trade.attributionComplete === true;
      if (trade.kind === 'TRANSFER') { state.counts.transfers++; if (incoming) state.costsKnown = false; }
      else { state.counts[incoming ? 'buys' : 'sells']++; state.feesKnown &&= fee !== null; state.costsKnown &&= gross !== null; }
      if (incoming) {
        const deployment = time(trade.deploymentAt); const earlySeconds = options.earlyEntrySeconds ?? 300;
        const cost = trade.kind === 'TRADE' && gross && fee ? add(gross, fee) : null;
        state.lots.push({ tokenAddress: token, quantityRaw: quantity.toString(), cost: cost ? packed(cost) : null,
          acquiredAt: trade.kind === 'TRADE' ? at : null,
          early: trade.kind === 'TRADE' && Number.isFinite(deployment) && deployment <= at ? at - deployment <= earlySeconds * 1000 : null });
      } else {
        let remaining = quantity; let basis = frac(); let holding = frac(); let early = frac();
        let known = true; let holdingKnown = true; let earlyKnown = true;
        for (const lot of state.lots) {
          if (!remaining || lot.tokenAddress !== token) continue;
          const available = BigInt(lot.quantityRaw); const take = remaining < available ? remaining : available;
          if (lot.cost) {
            const allocated = mul(unpack(lot.cost), frac(take, available));
            basis = add(basis, allocated); lot.cost = packed(sub(unpack(lot.cost), allocated));
          } else known = false;
          if (lot.acquiredAt !== null && lot.acquiredAt <= at) holding = add(holding, frac(BigInt(at - lot.acquiredAt) * take, quantity * 1000n));
          else holdingKnown = false;
          if (lot.early === null) earlyKnown = false; else if (lot.early) early = add(early, frac(take, quantity));
          lot.quantityRaw = (available - take).toString(); remaining -= take;
        }
        state.lots = state.lots.filter(lot => lot.quantityRaw !== '0');
        if (remaining) { known = false; holdingKnown = false; earlyKnown = false; }
        if (trade.kind === 'TRADE') {
          state.disposals++; state.lastDisposalAt = new Date(at).toISOString();
          state.costsKnown &&= known; state.holdingKnown &&= holdingKnown; state.earlyKnown &&= earlyKnown;
          if (holdingKnown) state.holding = packed(add(unpack(state.holding), holding));
          if (earlyKnown) state.early = packed(add(unpack(state.early), early));
          if (known && gross && fee) {
            const net = sub(sub(gross, fee), basis); state.pnl = packed(add(unpack(state.pnl), net));
            if (net.n > 0n) state.wins++;
            if (state.opening && state.equityKnown) {
              const equity = add(unpack(state.opening), unpack(state.pnl));
              if (compare(equity, unpack(state.peak)) > 0) state.peak = packed(equity);
              const peak = unpack(state.peak); const drawdown = mul(sub(peak, equity), frac(peak.d, peak.n));
              if (compare(drawdown, unpack(state.drawdown)) > 0) state.drawdown = packed(drawdown);
            }
          } else state.equityKnown = false;
        } else if (!known) state.costsKnown = false;
      }
      state.lastApplied = { blockNumber: trade.blockNumber, blockHash: trade.blockHash, logIndex: trade.logIndex, transactionHash: trade.transactionHash };
      state.seen.push({ id: trade.id, fingerprint }); if (state.seen.length > 32) state.seen.shift();
      if (state.lots.length > 128 || bytes(state) > MAX_STATE_BYTES) throw Error('ACCOUNTING_CAPACITY_REQUIRES_REPLAY');
    }
    return profile(state, options, [
      ...(!completeHistory(options, state) ? ['WALLET_HISTORY_INCOMPLETE'] : []),
      ...(!state.costsKnown ? ['WALLET_COST_BASIS_UNKNOWN'] : []), ...(!state.feesKnown ? ['WALLET_FEES_UNKNOWN'] : []),
    ]);
  } catch (error) {
    // Return an explicit replay state instead of resetting FIFO or allowing an
    // accounting-capacity error to break the collector's unrelated ingestion.
    return profile(committed, options, [error.message], true);
  }
}
