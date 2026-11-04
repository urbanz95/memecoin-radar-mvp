import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { base58Decode, decodeBorsh } from "./borsh.mjs";
import { mapPump } from "./pump.mjs";
import { mapRaydium, mapRaydiumInstruction } from "./raydium.mjs";
const specs = [
  ["pump_fun", "pump.json"],
  ["pump_swap", "pump_amm.json"],
  ["raydium_launchlab", "raydium_launchpad.json"],
  ["raydium_cpmm", "raydium_cpmm.json"],
];
const definitions = specs.map(([protocol, file]) => {
  const bytes = readFileSync(new URL("../../vendor/" + file, import.meta.url));
  const idl = JSON.parse(bytes);
  return {
    protocol,
    programId: idl.address ?? idl.metadata?.address,
    idl,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});
export const PROGRAMS = definitions.map(({ protocol, programId }) => ({
  protocol,
  programId,
}));
const byId = new Map(definitions.map((p) => [p.programId, p]));
const eventPrefix = Buffer.from("e445a52e51cb9a1d", "hex");
const address = (key) => (typeof key === "string" ? key : key?.pubkey);
function wireData(ix) {
  try {
    return typeof ix?.data === "string"
      ? base58Decode(ix.data)
      : Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}
function namedAccounts(idl, ix, keys) {
  const data = wireData(ix),
    def = idl.instructions.find((i) =>
      Buffer.from(i.discriminator ?? []).equals(data.subarray(0, 8)),
    );
  if (!def) return { instructionName: null, namedAccounts: {} };
  const flatten = (accounts) =>
    accounts.flatMap((a) => (a.accounts ? flatten(a.accounts) : [a]));
  return {
    instructionName: def.name,
    namedAccounts: Object.fromEntries(
      flatten(def.accounts).map((a, i) => [
        a.name,
        typeof ix.accounts?.[i] === "number"
          ? keys[ix.accounts[i]]
          : address(ix.accounts?.[i]),
      ]),
    ),
  };
}
export function decodeTransaction(input, options = {}) {
  const tx = input?.result ?? input,
    diagnostics = [],
    events = [];
  if (!tx?.transaction?.message || !tx.meta || tx.meta.err)
    return {
      events,
      diagnostics: tx?.meta?.err
        ? [{ code: "TRANSACTION_FAILED", error: tx.meta.err }]
        : [{ code: "TRANSACTION_UNAVAILABLE" }],
    };
  const signature = options.signature ?? tx.transaction.signatures?.[0];
  const keys = [
    ...(
      tx.transaction.message.accountKeys ??
      tx.transaction.message.staticAccountKeys ??
      []
    ).map(address),
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const entries = [];
  const make = (
    instruction,
    instructionIndex,
    innerInstructionIndex,
    parent = null,
  ) => {
    const programId = instruction.programId ?? keys[instruction.programIdIndex],
      p = byId.get(programId);
    const c = {
      tx,
      signature,
      receivedAt: options.receivedAt ?? new Date().toISOString(),
      confirmationStatus: options.confirmationStatus ?? "confirmed",
      instructionIndex,
      innerInstructionIndex,
      instruction,
      keys,
      programId,
      ...(p ? namedAccounts(p.idl, instruction, keys) : {}),
    };
    if (parent) {
      c.parentInstruction = parent.instruction;
      c.parentInstructionName = parent.instructionName;
      c.parentNamedAccounts = parent.namedAccounts;
    }
    return c;
  };
  for (const [i, ix] of tx.transaction.message.instructions.entries()) {
    const top = make(ix, i, null);
    entries.push(top);
    const stack = [top];
    for (const [j, inner] of (
      tx.meta.innerInstructions?.find((x) => x.index === i)?.instructions ?? []
    ).entries()) {
      const height = inner.stackHeight ?? 2;
      while (stack.length >= height) stack.pop();
      const c = make(inner, i, j, stack.at(-1) ?? top);
      entries.push(c);
      stack.push(c);
    }
  }
  const observedPayloads = new Map();
  const consume = (payload, c, source) => {
    const p = byId.get(c?.programId);
    if (!p) return;
    const ev = p.idl.events?.find((e) =>
      Buffer.from(e.discriminator ?? []).equals(payload.subarray(0, 8)),
    );
    if (!ev) {
      diagnostics.push({
        code: "UNKNOWN_EVENT",
        programId: p.programId,
        discriminator: payload.subarray(0, 8).toString("hex"),
      });
      return;
    }
    const type = p.idl.types.find((t) => t.name === ev.name)?.type;
    try {
      const decoded = decodeBorsh(
        type.fields,
        payload.subarray(8),
        p.idl.types,
      );
      if (decoded.trailingBytes)
        diagnostics.push({
          code: "EVENT_TRAILING_BYTES",
          eventName: ev.name,
          bytes: decoded.trailingBytes,
        });
      const mapped = p.protocol.startsWith("pump")
        ? mapPump(p.protocol, ev.name, decoded.data, c)
        : mapRaydium(p.protocol, ev.name, decoded.data, c);
      for (const partial of mapped) {
        const missing = [
          "tokenMint",
          "wallet",
          "amountTokenRaw",
          "amountQuoteRaw",
        ].filter(
          (k) =>
            partial[k] == null &&
            (k === "tokenMint" ||
              ["TOKEN_BOUGHT", "TOKEN_SOLD"].includes(partial.eventType)),
        );
        const balances = [
          ...(tx.meta.preTokenBalances ?? []),
          ...(tx.meta.postTokenBalances ?? []),
        ];
        const decimals = (mint) =>
          balances.find((b) => b.mint === mint)?.uiTokenAmount?.decimals ??
          null;
        events.push({
          chain: "solana",
          schemaVersion: 1,
          protocol: p.protocol,
          programId: p.programId,
          transactionSignature: signature,
          slot: tx.slot,
          instructionIndex: c.instructionIndex ?? null,
          innerInstructionIndex: c.innerInstructionIndex ?? null,
          receivedAt: c.receivedAt,
          processedAt: new Date().toISOString(),
          confirmationStatus: c.confirmationStatus,
          ...partial,
          tokenDecimals: partial.tokenDecimals ?? decimals(partial.tokenMint),
          quoteDecimals: partial.quoteDecimals ?? decimals(partial.quoteMint),
          evidenceSource: {
            kind: source,
            eventName: ev.name,
            idlSha256: p.sha256,
            transactionSignature: signature,
          },
          evidenceStatus: "VERIFIED_PROTOCOL_EVENT",
          confidence: null,
          completeness:
            missing.length ||
            decoded.trailingBytes ||
            decoded.missingFields.length
              ? "INCOMPLETE"
              : (partial.completeness ?? "COMPLETE"),
          missingFields: [...(partial.missingFields ?? []), ...missing],
          decoderMissingTrailingFields: decoded.missingFields,
          eventOrdinal: events.length,
        });
      }
    } catch (error) {
      diagnostics.push({
        code: "DECODER_FAILURE",
        programId: p.programId,
        eventName: ev.name,
        message: error.message,
      });
    }
  };
  // Build completed invocation frames before consuming any event. A router can
  // catch a failed inner CPI while the outer transaction still succeeds; all
  // events in that failed subtree must be discarded despite remaining in logs.
  const runtimeStack = [],
    logEvents = [];
  let cursor = 0;
  for (const log of tx.meta.logMessages ?? []) {
    const m = /^Program (\w+) invoke \[(\d+)\]$/.exec(log);
    if (m) {
      const depth = Number(m[2]);
      while (runtimeStack.length >= depth) runtimeStack.pop();
      const index = entries.findIndex(
        (c, i) => i >= cursor && c.programId === m[1],
      );
      const c =
        index >= 0
          ? entries[index]
          : {
              programId: m[1],
              tx,
              signature,
              keys,
              receivedAt: options.receivedAt ?? new Date().toISOString(),
              confirmationStatus: options.confirmationStatus ?? "confirmed",
              instructionIndex: null,
              innerInstructionIndex: null,
            };
      if (index >= 0) cursor = index + 1;
      const frame = {
        context: c,
        parent: runtimeStack.at(-1) ?? null,
        complete: false,
        failed: false,
      };
      c.runtimeFrame = frame;
      runtimeStack.push(frame);
      continue;
    }
    const ended = /^Program (\w+) (success|failed:.*)$/.exec(log);
    if (ended) {
      const frame = runtimeStack.pop();
      if (frame) {
        frame.complete = true;
        frame.failed = ended[2] !== "success";
      }
      continue;
    }
    if (log.startsWith("Program data: ") && runtimeStack.length)
      logEvents.push({
        payload: Buffer.from(log.slice(14), "base64"),
        context: runtimeStack.at(-1).context,
      });
  }
  const committed = (c) => {
    let frame = c.runtimeFrame;
    if (!frame) return false;
    for (; frame; frame = frame.parent)
      if (frame.failed || !frame.complete) return false;
    return true;
  };
  // Anchor emit_cpi self-instructions carry the full binary event payload.
  for (const c of entries) {
    const data = wireData(c.instruction);
    if (byId.has(c.programId) && data.subarray(0, 8).equals(eventPrefix)) {
      if (!committed(c)) {
        diagnostics.push({
          code: "EVENT_IN_FAILED_OR_UNRESOLVED_INVOCATION",
          programId: c.programId,
          instructionIndex: c.instructionIndex,
          innerInstructionIndex: c.innerInstructionIndex,
        });
        continue;
      }
      const payload = data.subarray(8),
        hex = payload.toString("hex");
      observedPayloads.set(hex, (observedPayloads.get(hex) ?? 0) + 1);
      consume(payload, c, "anchor_emit_cpi");
    }
  }
  // Runtime-owned data events are consumed only after the owning invocation and
  // every ancestor succeeded. Payload matches are deduplicated against emit_cpi.
  for (const { payload, context: c } of logEvents) {
    if (!committed(c)) continue;
    const hex = payload.toString("hex"),
      count = observedPayloads.get(hex) ?? 0;
    if (count) {
      observedPayloads.set(hex, count - 1);
      continue;
    }
    consume(payload, c, "anchor_program_data");
  }
  for (const c of entries) {
    const p = byId.get(c.programId);
    if (!p) continue;
    const data = wireData(c.instruction);
    if (data.subarray(0, 8).equals(eventPrefix)) continue;
    if (!c.instructionName)
      diagnostics.push({
        code: "UNKNOWN_INSTRUCTION",
        programId: c.programId,
        instructionIndex: c.instructionIndex,
        innerInstructionIndex: c.innerInstructionIndex,
        discriminator: data.subarray(0, 8).toString("hex"),
      });
    if (p.protocol.startsWith("raydium") && committed(c))
      for (const e of mapRaydiumInstruction(p.protocol, c) ?? []) {
        if (
          events.some(
            (x) =>
              x.eventType === e.eventType && x.poolAddress === e.poolAddress,
          )
        )
          continue;
        events.push({
          chain: "solana",
          schemaVersion: 1,
          protocol: p.protocol,
          programId: p.programId,
          transactionSignature: signature,
          slot: tx.slot,
          instructionIndex: c.instructionIndex,
          innerInstructionIndex: c.innerInstructionIndex,
          receivedAt: c.receivedAt,
          processedAt: new Date().toISOString(),
          confirmationStatus: c.confirmationStatus,
          evidenceStatus: "VERIFIED_INSTRUCTION",
          ...e,
          evidenceSource: {
            kind: "successful_instruction",
            instructionName: c.instructionName,
            idlSha256: p.sha256,
          },
          eventOrdinal: events.length,
        });
      }
  }
  return { events, diagnostics };
}
