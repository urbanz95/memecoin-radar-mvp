import { estimatedFdvUsdCents } from './market-cap-gate.mjs';
import { SOL_MINT } from './protocols/pump.mjs';

// The observed token feed is deliberately an incomplete, bounded log projection.
// It does not infer holders, global volume, circulating market cap or safe exits.
const NATIVE_SOL = '11111111111111111111111111111111';
const BUY = new Set(['TOKEN_BOUGHT']);
const SELL = new Set(['TOKEN_SOLD']);
const STAGES = new Set(['TOKEN_CREATED', 'POOL_CREATED', 'TOKEN_MIGRATED', 'TOKEN_GRADUATED']);
const FIVE_MINUTES = 300_000;

function validTime(value) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
}
function isObservedLog(e) {
  return e?.dataMode === 'REAL_RPC_LOG_OBSERVATION' &&
    e?.evidenceStatus === 'VERIFIED_RPC_LOG_EVENT' &&
    e?.evidenceSource?.kind === 'rpc:logsSubscribe' &&
    typeof e?.tokenMint === 'string' && e.tokenMint.length > 0 &&
    typeof e?.transactionSignature === 'string' && e.transactionSignature.length > 0;
}
function verifiedSolQuote(e) {
  return e.protocol === 'pump_fun' &&
    (e.quoteMint === SOL_MINT ||
      (e.quoteMint == null && e.protocolQuoteMint === NATIVE_SOL));
}
function validOracle(quote, now) {
  return quote && Number.isSafeInteger(quote.usdCents) && quote.usdCents > 0 &&
    Number.isFinite(quote.at) && now - quote.at >= -15000 &&
    now - quote.at <= FIVE_MINUTES;
}
function emptyWindow() { return { events: 0, buys: 0, sells: 0, lifecycle: 0 }; }
function exposedToken(t, now, quote, minimumFdvUsd) {
  const windows = { '15s': emptyWindow(), '60s': emptyWindow(), '300s': emptyWindow() };
  for (const e of t.events) {
    const age = now - e.at;
    for (const [k, duration] of [['15s',15000],['60s',60000],['300s',300000]]) {
      if (age < 0 || age > duration) continue;
      windows[k].events++;
      if (BUY.has(e.type)) windows[k].buys++;
      if (SELL.has(e.type)) windows[k].sells++;
      if (STAGES.has(e.type)) windows[k].lifecycle++;
    }
  }
  const q = t.reserve;
  const fdv = validOracle(quote, now) && q && t.supply && q.at >= t.supply.at
    ? estimatedFdvUsdCents({
        virtualTokenRaw: q.virtualTokenRaw,
        virtualQuoteRaw: q.virtualQuoteRaw,
        totalSupplyRaw: t.supply.raw,
        solUsdCents: quote.usdCents,
      })
    : null;
  const numericFdv = fdv !== null && fdv <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(fdv) / 100 : null;
  let status = 'FDV_UNKNOWN';
  if (fdv !== null) {
    if (fdv >= BigInt(minimumFdvUsd) * 100n) status = 'ABOVE_FLOOR';
    else if (fdv * 100n >= BigInt(minimumFdvUsd) * 100n * 95n) status = 'NEAR_FLOOR';
    else status = 'BELOW_FLOOR';
  }
  return {
    mint: t.mint, protocols: [...t.protocols].sort(),
    firstObservedAt: new Date(t.first).toISOString(),
    lastObservedAt: new Date(t.last).toISOString(),
    lastEventType: t.lastType,
    lastTransactionSignature: t.lastSignature,
    observedEvents: t.events.length,
    distinctObservedTransactions: t.signatures.size,
    observedWalletsIdentified: t.wallets.size,
    unattributedBuySellEvents: t.unknownWalletTradeEvents,
    activity: windows,
    estimatedFdvUsd: numericFdv,
    fdvStatus: status,
    fdvEvidence: fdv === null ? null : {
      kind: 'PUMP_FUN_VIRTUAL_RESERVE_PROXY_NOT_CIRCULATING_MARKET_CAP',
      reserveTransactionSignature: q.signature,
      creationTransactionSignature: t.supply.signature,
      solUsdSource: quote.source ?? 'unknown',
      solUsdAt: new Date(quote.at).toISOString(),
    },
    context: 'PARTIAL_RPC_LOG_OBSERVATIONS',
    confidence: null,
    safetyConclusion: null,
  };
}

/** Pure deterministic projection from retained, verified, deduplicated RPC logs. */
export function buildRadarSnapshot(observations, {
  now = Date.now(), minimumFdvUsd = 5000, limit = 50, quote = null, sampleLimit = 10000,
  includeAllEvidence = false,
} = {}) {
  if (!Array.isArray(observations) || !Number.isFinite(now) ||
      !Number.isSafeInteger(minimumFdvUsd) || minimumFdvUsd < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(sampleLimit) || sampleLimit < 1)
    throw Error('INVALID_RADAR_ARGUMENTS');
  const seen = new Set(), tokens = new Map();
  let accepted = 0;
  let oldest = null;
  for (const e of observations) {
    if (!isObservedLog(e)) continue;
    const at = validTime(e.receivedAt);
    if (at === null || at < now - FIVE_MINUTES || at > now + 15000) continue;
    // Event IDs are verified during SQLite insertion; the fallback remains
    // explicit and unique by source hash, signature, ordinal and event type.
    const identity = e.id ?? JSON.stringify([
      e.transactionSignature, e.evidenceSource.sourceMessageSha256,
      e.eventOrdinal, e.eventType,
    ]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    accepted++;
    oldest = oldest === null ? at : Math.min(oldest, at);
    let t = tokens.get(e.tokenMint);
    if (!t) {
      t = {
        mint: e.tokenMint, protocols: new Set(), events: [], wallets: new Set(),
        signatures: new Set(), unknownWalletTradeEvents: 0, first: at, last: at,
        lastType: e.eventType, lastSignature: e.transactionSignature,
        supply: null, reserve: null,
      };
      tokens.set(e.tokenMint, t);
    }
    t.protocols.add(e.protocol);
    t.events.push({ at, type: e.eventType });
    t.signatures.add(e.transactionSignature);
    t.first = Math.min(t.first, at);
    if (at >= t.last) {
      t.last = at; t.lastType = e.eventType;
      t.lastSignature = e.transactionSignature;
    }
    if (BUY.has(e.eventType) || SELL.has(e.eventType)) {
      if (typeof e.wallet === 'string' && e.wallet) t.wallets.add(e.wallet);
      else t.unknownWalletTradeEvents++;
    }
    if (e.protocol === 'pump_fun' && e.eventType === 'TOKEN_CREATED' &&
        typeof e.totalSupplyRaw === 'string' && /^\d+$/.test(e.totalSupplyRaw) &&
        BigInt(e.totalSupplyRaw) > 0n &&
        (!t.supply || at >= t.supply.at)) {
      t.supply = { raw: e.totalSupplyRaw, at, signature: e.transactionSignature };
    }
    if (verifiedSolQuote(e) && e.reserves &&
        typeof e.reserves.virtualTokenRaw === 'string' &&
        typeof e.reserves.virtualQuoteRaw === 'string' &&
        (!t.reserve || at >= t.reserve.at)) {
      t.reserve = {
        at, signature: e.transactionSignature,
        virtualTokenRaw: e.reserves.virtualTokenRaw,
        virtualQuoteRaw: e.reserves.virtualQuoteRaw,
      };
    }
  }
  const all = [...tokens.values()].map(t => exposedToken(t, now, quote, minimumFdvUsd));
  const order = { ABOVE_FLOOR: 0, NEAR_FLOOR: 1, FDV_UNKNOWN: 2, BELOW_FLOOR: 3 };
  all.sort((a,b) => (order[a.fdvStatus] - order[b.fdvStatus]) ||
    (b.activity['60s'].events - a.activity['60s'].events) ||
    b.lastObservedAt.localeCompare(a.lastObservedAt) || a.mint.localeCompare(b.mint));
  const candidates = all.filter(x => x.fdvStatus !== 'BELOW_FLOOR');
  const possibleTruncation = observations.length >= sampleLimit;
  // Earliest retained *verified* event is only an evidence bound, never proof
  // that all events up to this age arrived from the network.
  const sampledLookbackSeconds = oldest === null ? null
    : Math.min(300, Math.max(0, Math.floor((now - oldest) / 1000)));
  return {
    schemaVersion: 1,
    kind: 'SOLANA_PUMP_RADAR_MVP',
    generatedAt: new Date(now).toISOString(),
    mode: 'READ_ONLY',
    coverage: 'PARTIAL',
    protocols: ['pump_fun', 'pump_swap'],
    minimumFdvUsd,
    fdvIsCirculatingMarketCap: false,
    quote: validOracle(quote, now)
      ? { source: quote.source, at: new Date(quote.at).toISOString(), usdCents: quote.usdCents }
      : null,
    sample: {
      rowsInspected: observations.length,
      verifiedUniqueEvents: accepted,
      oldestRetainedObservationInWindow: oldest === null ? null : new Date(oldest).toISOString(),
      maxRowsRead: sampleLimit,
      possibleTruncation,
      sampledLookbackSeconds,
      window60sPotentiallyTruncated: possibleTruncation &&
        (sampledLookbackSeconds === null || sampledLookbackSeconds < 60),
      window300sPotentiallyTruncated: possibleTruncation &&
        (sampledLookbackSeconds === null || sampledLookbackSeconds < 300),
      timeWindowSeconds: 300,
    },
    totals: {
      observedDistinctMints: all.length,
      eligibleOrUnknown: candidates.length,
      aboveFloor: all.filter(x=>x.fdvStatus === 'ABOVE_FLOOR').length,
      nearFloor: all.filter(x=>x.fdvStatus === 'NEAR_FLOOR').length,
      unknownFdv: all.filter(x=>x.fdvStatus === 'FDV_UNKNOWN').length,
      belowFloorNotDisplayed: all.length - candidates.length,
    },
    candidates: candidates.slice(0, limit),
    warnings: [
      'Only bounded retained RPC log observations are included; missing events and historical completeness are unknown.',
      ...(possibleTruncation ? ['The radar hit its row cap; activity windows can contain substantially less than the nominal 60 or 300 seconds.'] : []),
      'Event windows use local receivedAt, not authoritative on-chain execution time.',
      'Observed wallet counts and volumes are partial; no inference of global buyers, holders or profitability.',
      'FDV is a reserve-based proxy when evidenced, not circulating market cap, liquidity or sellable proceeds.',
      'The candidate list is NOT a recommendation to buy or a token safety determination.',
    ],
    // Internal-only transient FDV/threshold evidence. Scanner.radar() removes
    // this before sending a response. Unlike candidates, it includes BELOW_FLOOR.
    ...(includeAllEvidence ? { internalRawTokenEvidence: all } : {}),
  };
}
