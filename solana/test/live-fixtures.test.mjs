import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseRpcJson } from "../src/rpc.mjs";
import { decodeTransaction } from "../src/protocols/registry.mjs";
import { base58Decode } from "../src/protocols/borsh.mjs";
import { decodeLogObservation } from "../src/log-observations.mjs";

const read = (file) => readFileSync(new URL("../fixtures/" + file, import.meta.url));
const manifest = JSON.parse(read("LIVE-VALIDATION-MANIFEST.json"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
function capture(name) {
  const entry = manifest.fixtures.find((f) => f.file === name + ".json");
  assert.ok(entry, name);
  const tx = parseRpcJson(read(entry.file).toString()).result;
  const decoded = decodeTransaction(tx, {
    confirmationStatus: "finalized",
    receivedAt: entry.capturedAt,
  });
  const event = decoded.events.find((e) => e.eventType === entry.targetEventType);
  assert.ok(event);
  return { entry, tx, event, ...decoded };
}
function ownerDelta(tx, owner, mint) {
  const sum = (balances) => balances
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
}
function transfers(tx) {
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  return [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions),
  ].flatMap((ix) => {
    if (!TOKEN_PROGRAMS.has(keys[ix.programIdIndex])) return [];
    const data = base58Decode(ix.data);
    // SPL TransferChecked proves movement amounts, never swap classification.
    return data.length === 10 && data[0] === 12
      ? [{ mint: keys[ix.accounts[1]], amount: data.readBigUInt64LE(1).toString() }]
      : [];
  });
}

test("additional Mainnet fixture bodies and observed log evidence have reproducible provenance", () => {
  assert.equal(manifest.fixtures.length, 4);
  for (const entry of manifest.fixtures) {
    assert.equal(entry.synthetic, false);
    assert.equal(entry.representation, "UNMODIFIED_HTTP_JSON_RPC_RESPONSE_BODY");
    assert.equal(sha(read(entry.file)), entry.sha256);
    assert.equal(sha(read(entry.notificationFile)), entry.notificationSha256);
    assert.equal(sha(read(entry.observationFile)), entry.observationSha256);
    const notification = JSON.parse(read(entry.notificationFile));
    const response = parseRpcJson(read(entry.file).toString());
    assert.equal(response.result.transaction.signatures[0], entry.signature);
    assert.equal(response.result.meta.err, null);
    assert.equal(response.result.slot, entry.slot);
    assert.equal(notification.signature, entry.signature);
    assert.equal(sha(JSON.stringify(notification.logs)), entry.sourceMessageSha256);
    assert.deepEqual(response.result.meta.logMessages, notification.logs);
    assert.ok(Date.parse(entry.capturedAt) - Date.parse(notification.receivedAt) >= 60000);
    assert.equal(entry.params[1].commitment, "finalized");
  }
});

test("real CPMM buy matches exact wallet credit and TransferChecked amounts", () => {
  const { event: e, tx, diagnostics } = capture("raydium-cpmm-buy-live-mainnet");
  assert.deepEqual(diagnostics, []);
  assert.equal(e.transactionSignature, "5YBKmZ3RF9K2Hnj6ZCPEpyjsfuJqdjqaphYH2uPXo7eLUofsuu7FN775Nxdvq2wZUqUXDxhpKgyt6Aqr6c78P6Lh");
  assert.equal(e.eventType, "TOKEN_BOUGHT");
  assert.equal(e.tokenMint, "9NiHcbT8EohKJid1RdU3232tATmM1CvYemTeCP5iwro");
  assert.equal(e.quoteMint, WSOL);
  assert.equal(e.wallet, "DE2QJA9pMeCQtpXARPnMaTPKhFaScxuQQeGbamWjwmNY");
  assert.equal(e.amountTokenRaw, "3787710841");
  assert.equal(e.amountQuoteRaw, "5000000");
  assert.equal(ownerDelta(tx, e.wallet, e.tokenMint), BigInt(e.amountTokenRaw));
  assert.deepEqual(transfers(tx), [
    { mint: WSOL, amount: e.amountQuoteRaw },
    { mint: e.tokenMint, amount: e.amountTokenRaw },
  ]);
  assert.equal(e.completeness, "COMPLETE");
});

test("real CPMM deposit matches exact token debit and both transfers", () => {
  const { event: e, tx, diagnostics } = capture("raydium-cpmm-deposit-live-mainnet");
  assert.deepEqual(diagnostics, []);
  assert.equal(e.transactionSignature, "3HsVr9zkSCAQAaxV5Afq6pdyuGCfRJxgvEV65JhoXMTBVam5NoHEmvnxhvw4FUTCbnKV5oGymdKieGx8RgLAvfdQ");
  assert.equal(e.eventType, "LIQUIDITY_ADDED");
  assert.equal(e.tokenMint, "5uY4RXyTkkHBkhatNzCmTphAhBS3LU6yaLd9b9uAhQAb");
  assert.equal(e.wallet, "6vbGpTsZqdToRB9EbtsbrYyxGuEyZ2iSZJ3HCX98tnsj");
  assert.equal(e.amountTokenRaw, "8844415386");
  assert.equal(e.amountQuoteRaw, "6697359");
  assert.equal(ownerDelta(tx, e.wallet, e.tokenMint), -BigInt(e.amountTokenRaw));
  assert.deepEqual(transfers(tx), [
    { mint: WSOL, amount: e.amountQuoteRaw },
    { mint: e.tokenMint, amount: e.amountTokenRaw },
  ]);
  assert.equal(e.evidenceSource.eventName, "LpChangeEvent");
  assert.equal(e.completeness, "COMPLETE");
});

test("real routed LaunchLab sell preserves protocol net amount separately from gross Token-2022 debit", () => {
  const { event: e, tx, diagnostics, events } = capture("raydium-launchlab-sell-live-mainnet");
  assert.deepEqual(diagnostics, []);
  assert.equal(tx.version, 1);
  assert.equal(e.transactionSignature, "5zxj2nBxmoJNw5Tm9A8MuBTU4tFRHrnpP27s1iAs9sjPB7Ug9no7JYgZqnb5sVNeUycaXJ65rCALPiJrU8m17YJa");
  assert.equal(e.eventType, "TOKEN_SOLD");
  assert.equal(e.tokenMint, "BHNMLnhoboeNhxkVP3EYWWm78gp3oQyA4ZumjXE6PuXG");
  assert.equal(e.quoteMint, WSOL);
  assert.equal(e.wallet, "CZHo6oDBnrd5eftKnrFiWF7JYcFPVB7CkwnCsMtophA9");
  assert.equal(e.amountTokenRaw, "1461251792189");
  assert.equal(e.amountQuoteRaw, "112716209");
  assert.equal(ownerDelta(tx, "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh", e.tokenMint), BigInt(e.amountTokenRaw));
  const grossDebit = -ownerDelta(tx, e.wallet, e.tokenMint);
  assert.equal(grossDebit, 1506445146587n);
  assert.equal(grossDebit - BigInt(e.amountTokenRaw), 45193354398n);
  assert.ok(transfers(tx).some((t) => t.mint === e.tokenMint && t.amount === grossDebit.toString()));
  assert.ok(transfers(tx).some((t) => t.mint === WSOL && t.amount === e.amountQuoteRaw));
  assert.deepEqual(events.map((x) => x.eventType), ["TOKEN_SOLD", "CURVE_PROGRESS_UPDATED"]);
  assert.equal(e.evidenceSource.kind, "anchor_emit_cpi");
  assert.equal(e.completeness, "COMPLETE");
});

test("real PumpSwap withdrawal preserves protocol base/quote and unknown eight-byte suffix", () => {
  const { event: e, tx, diagnostics } = capture("pumpswap-withdraw-live-mainnet");
  assert.equal(e.transactionSignature, "k7T73r5bpfAdoCxS47kSP7DSNTtA1Mvbj7WLKEHZ4JV6Cw2zPmm9x4NTVUiv9RfjBFMmfK2wA6UmzjyWYHmUwdE");
  assert.equal(e.eventType, "LIQUIDITY_REMOVED");
  // PumpSwap's actual base is WSOL in this pool; never flip mints by symbol.
  assert.equal(e.tokenMint, WSOL);
  assert.equal(e.quoteMint, "63D1CM1w82so55yRNYciyez79RtzAmCXiekraEDL5UeQ");
  assert.equal(e.wallet, "7ZX39RMAxqcESVamv2jWVj8GuYryj9g1snDPUmFAowjd");
  assert.equal(e.amountTokenRaw, "393487206758");
  assert.equal(e.amountQuoteRaw, "6438956338798");
  assert.equal(ownerDelta(tx, e.wallet, e.quoteMint), BigInt(e.amountQuoteRaw));
  assert.deepEqual(transfers(tx), [
    { mint: WSOL, amount: e.amountTokenRaw },
    { mint: e.quoteMint, amount: e.amountQuoteRaw },
  ]);
  assert.equal(e.completeness, "INCOMPLETE");
  assert.deepEqual(diagnostics, [{ code: "EVENT_TRAILING_BYTES", eventName: "WithdrawEvent", bytes: 8 }]);
});

test("real log snapshots remain incomplete observations before finalized transaction enrichment", () => {
  for (const entry of manifest.fixtures) {
    const notification = JSON.parse(read(entry.notificationFile));
    const original = JSON.parse(read(entry.observationFile));
    const { observations } = decodeLogObservation(notification);
    const obs = observations.find((e) => e.protocol === entry.protocol && e.eventType === entry.targetEventType);
    assert.ok(obs);
    assert.equal(obs.dataMode, "REAL_RPC_LOG_OBSERVATION");
    assert.equal(obs.contextCompleteness, "INCOMPLETE");
    assert.equal(obs.confirmationStatus, "confirmed");
    assert.equal(obs.reconciliationStatus, "UNRECONCILED");
    assert.equal(obs.instructionIndex, null);
    // PumpSwap's binary event includes its user; instruction-only roles stay null.
    assert.equal(obs.wallet, original.wallet);
    assert.ok(obs.missingFields.includes("transactionContext"));
    assert.equal(obs.evidenceSource.sourceMessageSha256, entry.sourceMessageSha256);
    assert.equal(obs.amountTokenRaw, original.amountTokenRaw);
    assert.equal(obs.amountQuoteRaw, original.amountQuoteRaw);
    assert.equal(capture(entry.file.replace(/\.json$/, "")).event.confirmationStatus, "finalized");
  }
});
