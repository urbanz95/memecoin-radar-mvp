import { createHash } from "node:crypto";
import { decodeTransaction } from "./protocols/index.mjs";

const stages = new Set(["processed", "confirmed", "finalized"]);
const fields = [
  "tokenMint",
  "quoteMint",
  "poolAddress",
  "wallet",
  "creator",
  "amountTokenRaw",
  "amountQuoteRaw",
  "tokenDecimals",
  "quoteDecimals",
  "eventTimestamp",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const failure = (code) => ({ observations: [], diagnostics: [{ code }] });

/**
 * Decode only facts present in a real RPC logs notification. The temporary
 * decoder context supplies no instructions, account roles, balances or block
 * timestamp; it is never returned as evidence or represented as a transaction.
 * These observations remain separate from enriched canonical market events.
 */
export function decodeLogObservation(notification) {
  try {
    if (
      !notification ||
      typeof notification !== "object" ||
      typeof notification.signature !== "string" ||
      !notification.signature.length ||
      notification.signature.length > 128 ||
      !Number.isSafeInteger(notification.slot) ||
      notification.slot < 0 ||
      !Array.isArray(notification.logs) ||
      notification.logs.length > 16384 ||
      notification.logs.some((line) => typeof line !== "string") ||
      !stages.has(notification.confirmationStatus)
    )
      return failure("INVALID_LOG_OBSERVATION");
    const serializedLogs = JSON.stringify(notification.logs);
    if (Buffer.byteLength(serializedLogs) > 2 * 1024 * 1024)
      return failure("LOG_OBSERVATION_SIZE_LIMIT");
    // Runtime prefixes cannot be supplied by a program's `msg!` log (which is
    // prefixed `Program log:`). Reject malformed ownership traces rather than
    // accidentally assigning a payload to another programme's invocation.
    const trace = [];
    for (const line of notification.logs) {
      const entered = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
      if (entered) {
        if (Number(entered[2]) !== trace.length + 1)
          return failure("INVALID_RUNTIME_LOG_TRACE");
        trace.push(entered[1]);
        continue;
      }
      const ended = /^Program (\w+) (success|failed:.*)$/.exec(line);
      if (ended && trace.pop() !== ended[1])
        return failure("INVALID_RUNTIME_LOG_TRACE");
    }
    const sourceMessageSha256 = sha256(serializedLogs);
    const receivedAt = notification.receivedAt ?? new Date().toISOString();
    if (
      typeof receivedAt !== "string" ||
      !Number.isFinite(Date.parse(receivedAt))
    )
      return failure("INVALID_LOG_RECEIVED_AT");
    if (notification.err != null || notification.onchainError != null)
      return failure("LOG_TRANSACTION_FAILED");
    const diagnostics = [];
    if (notification.logs.some((line) => /^Log truncated\b/i.test(line)))
      diagnostics.push({ code: "LOGS_TRUNCATED_COVERAGE_PARTIAL" });
    // This is a decoder input shape, not a fetched or reconstructed transaction.
    const context = {
      slot: notification.slot,
      blockTime: null,
      transaction: {
        signatures: [notification.signature],
        message: { accountKeys: [], instructions: [] },
      },
      meta: {
        err: null,
        logMessages: notification.logs,
        innerInstructions: [],
        preTokenBalances: [],
        postTokenBalances: [],
      },
    };
    const decoded = decodeTransaction(context, {
      signature: notification.signature,
      receivedAt,
      confirmationStatus: notification.confirmationStatus,
    });
    diagnostics.push(...decoded.diagnostics);
    const observations = decoded.events.map((event, ordinal) => {
      const observation = {
        chain: "solana",
        schemaVersion: 1,
        dataMode: "REAL_RPC_LOG_OBSERVATION",
        protocol: event.protocol,
        programId: event.programId,
        eventType: event.eventType,
        transactionSignature: notification.signature,
        slot: notification.slot,
        instructionIndex: null,
        innerInstructionIndex: null,
        ...Object.fromEntries(
          fields.map((name) => [name, event[name] ?? null]),
        ),
        receivedAt,
        processedAt: event.processedAt,
        confirmationStatus: notification.confirmationStatus,
        reconciliationStatus: "UNRECONCILED",
        evidenceStatus: "VERIFIED_RPC_LOG_EVENT",
        completeness: "INCOMPLETE",
        contextCompleteness: "INCOMPLETE",
        confidence: null,
        missingFields: [
          ...new Set([
            "instructionIndex",
            "transactionContext",
            ...(event.missingFields ?? []),
            ...fields.filter((name) => event[name] == null),
          ]),
        ],
        evidenceSource: {
          kind: "rpc:logsSubscribe",
          eventEncoding: event.evidenceSource?.kind ?? "anchor_program_data",
          eventName: event.evidenceSource?.eventName ?? null,
          idlSha256: event.evidenceSource?.idlSha256 ?? null,
          sourceMessageSha256,
          transactionSignature: notification.signature,
          subscribedProgramId: notification.programId ?? null,
        },
        eventOrdinal: ordinal,
      };
      for (const name of ["amountTokenRaw", "amountQuoteRaw"]) {
        if (
          observation[name] !== null &&
          (typeof observation[name] !== "string" ||
            !/^\d+$/.test(observation[name]))
        )
          throw Error("INVALID_LOG_RAW_AMOUNT");
      }
      for (const name of [
        "reserves",
        "tokenProgram",
        "totalSupplyRaw",
        "poolCreator",
        "protocolQuoteMint",
        "quoteMintEvidence",
        "financialSemantics",
        "destinationProtocol",
        "protocolData",
        "name",
        "symbol",
        "uri",
      ]) {
        if (event[name] !== undefined) observation[name] = event[name];
      }
      observation.id = sha256(
        JSON.stringify([
          "solana-log-observation-v1",
          notification.signature,
          event.programId,
          sourceMessageSha256,
          ordinal,
          event.eventType,
        ]),
      );
      return observation;
    });
    if (!observations.length && !diagnostics.length)
      diagnostics.push({ code: "NO_SUPPORTED_LOG_EVENT" });
    return { observations, diagnostics };
  } catch {
    // One malformed/unknown notification cannot terminate the continuous reader.
    return failure("LOG_OBSERVATION_DECODER_FAILURE");
  }
}
