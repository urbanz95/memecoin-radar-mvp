import { createHash } from "node:crypto";
export const EVENT_TYPES = new Set([
  "TOKEN_CREATED",
  "TOKEN_BOUGHT",
  "TOKEN_SOLD",
  "POOL_CREATED",
  "LIQUIDITY_ADDED",
  "LIQUIDITY_REMOVED",
  "CURVE_PROGRESS_UPDATED",
  "TOKEN_GRADUATED",
  "TOKEN_MIGRATED",
  "TOKEN_AUTHORITY_CHANGED",
]);
export const CONFIRMATIONS = ["processed", "confirmed", "finalized"];
export function canonicalEvent(input, { now = Date.now() } = {}) {
  if (!EVENT_TYPES.has(input.eventType)) throw Error("UNKNOWN_EVENT_TYPE");
  if (
    !input.programId ||
    !input.protocol ||
    !input.transactionSignature ||
    !Number.isSafeInteger(input.slot) ||
    input.slot < 0 ||
    !Number.isInteger(input.instructionIndex) ||
    input.instructionIndex < 0
  )
    throw Error("EVENT_IDENTITY_INCOMPLETE");
  const event = {
    chain: "solana",
    protocol: input.protocol,
    programId: input.programId,
    eventType: input.eventType,
    tokenMint: null,
    quoteMint: null,
    poolAddress: null,
    transactionSignature: input.transactionSignature,
    slot: input.slot,
    instructionIndex: input.instructionIndex,
    innerInstructionIndex: null,
    wallet: null,
    creator: null,
    amountTokenRaw: null,
    amountQuoteRaw: null,
    tokenDecimals: null,
    quoteDecimals: null,
    eventTimestamp: null,
    receivedAt: new Date(now).toISOString(),
    processedAt: new Date(now).toISOString(),
    confirmationStatus: "confirmed",
    evidenceSource: null,
    schemaVersion: 1,
    completeness: "INCOMPLETE",
    evidenceStatus: "UNVERIFIED",
    reconciliationStatus: "ACTIVE",
    ...input,
  };
  if (
    event.chain !== "solana" ||
    event.schemaVersion !== 1 ||
    !CONFIRMATIONS.includes(event.confirmationStatus)
  )
    throw Error("EVENT_DOMAIN_INVALID");
  for (const field of ["amountTokenRaw", "amountQuoteRaw"]) {
    if (typeof event[field] === "bigint")
      event[field] = event[field].toString();
    if (
      event[field] !== null &&
      (typeof event[field] !== "string" || !/^\d+$/.test(event[field]))
    )
      throw Error("RAW_AMOUNT_REQUIRES_UNSIGNED_INTEGER_STRING");
  }
  for (const field of ["tokenDecimals", "quoteDecimals"])
    if (
      event[field] !== null &&
      (!Number.isInteger(event[field]) ||
        event[field] < 0 ||
        event[field] > 255)
    )
      throw Error("INVALID_DECIMALS");
  // Anchor may emit more than one event inside a single CPI: eventIndex is part of the identity.
  event.id = createHash("sha256")
    .update(
      JSON.stringify([
        event.chain,
        event.programId,
        event.transactionSignature,
        event.instructionIndex,
        event.innerInstructionIndex,
        event.eventIndex ?? event.eventOrdinal ?? 0,
        event.eventType,
      ]),
    )
    .digest("hex");
  return event;
}
