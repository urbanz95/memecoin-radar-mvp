const WINDOWS = {
  "5s": 5000,
  "30s": 30000,
  "1m": 60000,
  "5m": 300000,
  "15m": 900000,
};
const BUY = "TOKEN_BOUGHT";
const SELL = "TOKEN_SOLD";
const raw = (value) =>
  typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
const time = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : null;
const gcd = (a, b) => {
  a = a < 0n ? -a : a;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};
function fraction(n, d) {
  if (d <= 0n) return null;
  const g = gcd(n, d);
  return { numerator: (n / g).toString(), denominator: (d / g).toString() };
}
function eventPrice(event) {
  const token = raw(event.amountTokenRaw);
  const quote = raw(event.amountQuoteRaw);
  if (token == null || quote == null || token === 0n) return null;
  const rawRatio = fraction(quote, token);
  const validDecimals = (value) =>
    Number.isInteger(value) && value >= 0 && value <= 255;
  const value =
    event.tokenMint &&
    event.quoteMint &&
    validDecimals(event.tokenDecimals) &&
    validDecimals(event.quoteDecimals)
      ? fraction(
          quote * 10n ** BigInt(event.tokenDecimals),
          token * 10n ** BigInt(event.quoteDecimals),
        )
      : null;
  return {
    quotePerToken: value,
    rawRatio,
    tokenDecimals: event.tokenDecimals ?? null,
    quoteDecimals: event.quoteDecimals ?? null,
    semantics: event.financialSemantics ?? "PROTOCOL_REPORTED_AMOUNTS",
    transactionSignature: event.transactionSignature,
    eventTimestamp: event.eventTimestamp,
  };
}
function priceChange(first, last) {
  if (
    !first?.quotePerToken ||
    !last?.quotePerToken ||
    first.semantics !== last.semantics
  )
    return null;
  const a = first.quotePerToken;
  const b = last.quotePerToken;
  if (BigInt(a.numerator) === 0n) return null;
  return fraction(
    (BigInt(b.numerator) * BigInt(a.denominator) -
      BigInt(a.numerator) * BigInt(b.denominator)) *
      100n,
    BigInt(b.denominator) * BigInt(a.numerator),
  );
}
function identity(e) {
  return (
    e.id ??
    e.eventId ??
    JSON.stringify([
      e.programId,
      e.transactionSignature,
      e.instructionIndex,
      e.innerInstructionIndex ?? null,
      e.eventIndex ?? 0,
      e.eventType,
    ])
  );
}
function activeEvents(events) {
  const unique = new Map();
  const rank = { processed: 0, confirmed: 1, finalized: 2 };
  for (const e of events) {
    const id = identity(e);
    const previous = unique.get(id);
    // A caller must pass the latest persisted reconciliation state. Highest finality
    // wins duplicate observations; a later REVERTED/UNRESOLVED tombstone excludes it.
    if (
      !previous ||
      (e.reconciliationStatus && e.reconciliationStatus !== "ACTIVE") ||
      (rank[e.confirmationStatus] ?? 0) >=
        (rank[previous.confirmationStatus] ?? 0)
    )
      unique.set(id, e);
  }
  return [...unique.values()].filter(
    (e) =>
      e.reconciliationStatus === "ACTIVE" &&
      e.reverted !== true &&
      e.confirmationStatus !== "reverted",
  );
}
function summarize(trades, milliseconds, observedCoverage) {
  const buys = trades.filter((e) => e.eventType === BUY);
  const sells = trades.filter((e) => e.eventType === SELL);
  const distinct = (items) =>
    new Set(
      items
        .map((e) => e.wallet)
        .filter((v) => typeof v === "string" && v.length > 0),
    ).size;
  const attributed = trades.filter(
    (e) => typeof e.wallet === "string" && e.wallet.length > 0,
  );
  const tokenAmounts = trades.map((e) => raw(e.amountTokenRaw));
  const quoteAmounts = trades.map((e) => raw(e.amountQuoteRaw));
  const amountTotal = (amounts) =>
    amounts.reduce((n, value) => n + (value ?? 0n), 0n).toString();
  const wallets = new Map();
  for (const trade of attributed)
    wallets.set(trade.wallet, (wallets.get(trade.wallet) ?? 0) + 1);
  const validPrices = trades.map(eventPrice).filter(Boolean);
  const firstPrice = validPrices[0] ?? null;
  const latestPrice = validPrices.at(-1) ?? null;
  const financialComplete =
    trades.length > 0 &&
    tokenAmounts.every((v) => v !== null) &&
    quoteAmounts.every((v) => v !== null);
  return {
    buys: buys.length,
    sells: sells.length,
    swapCount: trades.length,
    transactionCount: new Set(trades.map((e) => e.transactionSignature)).size,
    distinctBuyers: distinct(buys),
    distinctSellers: distinct(sells),
    distinctTraders: distinct(trades),
    walletAttributionComplete: attributed.length === trades.length,
    unattributedSwaps: trades.length - attributed.length,
    observedTokenVolumeRaw: amountTotal(tokenAmounts),
    observedQuoteVolumeRaw: amountTotal(quoteAmounts),
    volumeCompleteWithinObservedTrades: financialComplete,
    missingTokenAmounts: tokenAmounts.filter((v) => v === null).length,
    missingQuoteAmounts: quoteAmounts.filter((v) => v === null).length,
    firstPrice,
    latestPrice,
    priceChangePercent: priceChange(firstPrice, latestPrice),
    swapFrequencyPerSecond: fraction(
      BigInt(trades.length) * 1000n,
      BigInt(milliseconds),
    ),
    topWalletSwapShare:
      trades.length && attributed.length === trades.length
        ? fraction(
            BigInt(Math.max(0, ...wallets.values())),
            BigInt(trades.length),
          )
        : null,
    observedTopWalletSwapShareLowerBound:
      trades.length && attributed.length
        ? fraction(
            BigInt(Math.max(0, ...wallets.values())),
            BigInt(trades.length),
          )
        : null,
    quoteVolumeUsd: null,
    priceUsd: null,
    coverage: observedCoverage,
    status:
      observedCoverage?.complete === true && financialComplete
        ? "OBSERVED_COMPLETE"
        : "PARTIAL",
  };
}

/** Bounded caller-selected event history. No synthetic prices, USD or holder estimates. */
export function aggregateMarket(
  events,
  { now = Date.now(), coverage = null } = {},
) {
  if (!Array.isArray(events) || !Number.isFinite(now))
    throw new Error("INVALID_MARKET_INPUT");
  const asOf = new Date(now).toISOString();
  const active = activeEvents(events);
  const observedCoverage = coverage ?? {
    complete: false,
    reason: "PROGRAM_FILTERED_OBSERVATIONS_NOT_GLOBAL_COVERAGE",
  };
  const creationByMint = new Map();
  const grouped = new Map();
  let missingTimestamps = 0;
  let futureEvents = 0;
  for (const event of active) {
    if (typeof event.tokenMint !== "string" || !event.tokenMint) continue;
    const at = time(event.eventTimestamp);
    if (at == null) missingTimestamps++;
    if (at != null && at > now) {
      futureEvents++;
      continue;
    }
    if (
      event.eventType === "TOKEN_CREATED" &&
      at != null &&
      ["VERIFIED_PROTOCOL_EVENT", "VERIFIED_INSTRUCTION", "VERIFIED"].includes(
        event.evidenceStatus,
      )
    ) {
      const previous = creationByMint.get(event.tokenMint);
      if (!previous || at < previous.at)
        creationByMint.set(event.tokenMint, { at, event });
    }
    const key = JSON.stringify([
      event.tokenMint,
      event.quoteMint ?? null,
      event.poolAddress ?? null,
    ]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  const groups = [...grouped.values()].map((items) => {
    items.sort(
      (a, b) =>
        a.slot - b.slot ||
        a.instructionIndex - b.instructionIndex ||
        (a.innerInstructionIndex ?? -1) - (b.innerInstructionIndex ?? -1),
    );
    const base = items[0];
    const creation = creationByMint.get(base.tokenMint);
    const trades = items.filter(
      (e) => e.eventType === BUY || e.eventType === SELL,
    );
    const timedTrades = trades.filter((e) => time(e.eventTimestamp) != null);
    const lastReserves = items
      .filter(
        (e) => e.reserves && Object.values(e.reserves).some((v) => v != null),
      )
      .at(-1);
    const graduation = items.find((e) => e.eventType === "TOKEN_GRADUATED");
    const migration = items.find((e) => e.eventType === "TOKEN_MIGRATED");
    const windows = Object.fromEntries(
      Object.entries(WINDOWS).map(([name, ms]) => [
        name,
        summarize(
          timedTrades.filter((e) => time(e.eventTimestamp) >= now - ms),
          ms,
          observedCoverage,
        ),
      ]),
    );
    return {
      tokenMint: base.tokenMint,
      quoteMint: base.quoteMint ?? null,
      poolAddress: base.poolAddress ?? null,
      protocols: [...new Set(items.map((e) => e.protocol))],
      firstProvenCreationAt: creation
        ? new Date(creation.at).toISOString()
        : null,
      creationTransactionSignature:
        creation?.event.transactionSignature ?? null,
      provenAgeSeconds: creation
        ? Math.floor((now - creation.at) / 1000)
        : null,
      graduatedAt: graduation?.eventTimestamp ?? null,
      migrationTransactionSignature: migration?.transactionSignature ?? null,
      latestProtocolReportedReserves: lastReserves
        ? {
            values: lastReserves.reserves,
            eventTimestamp: lastReserves.eventTimestamp,
            slot: lastReserves.slot,
            transactionSignature: lastReserves.transactionSignature,
            semantics:
              "PROTOCOL_EVENT_SNAPSHOT_CHECK_ADAPTER_FOR_PRE_OR_POST_TRADE",
          }
        : null,
      graduationProgress: null,
      liquidityAvailableRaw: null,
      estimatedImpact: null,
      usd: null,
      windows,
      untimedSwaps: trades.length - timedTrades.length,
      coverage: observedCoverage,
    };
  });
  return {
    asOf,
    coverage: observedCoverage,
    usd: null,
    missingTimestamps,
    futureEvents,
    groups,
  };
}
