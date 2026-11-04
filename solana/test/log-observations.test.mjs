// Deterministic replays of archived real Mainnet logs. No live latency claim.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeLogObservation } from "../src/log-observations.mjs";

const fixture = (file) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url)))
    .result;
function notification(file, overrides = {}) {
  const tx = fixture(file);
  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    logs: tx.meta.logMessages,
    err: tx.meta.err,
    receivedAt: "2026-11-03T22:00:00.000Z",
    confirmationStatus: "confirmed",
    ...overrides,
  };
}
const buy = (result) =>
  result.observations.find((event) => event.eventType === "TOKEN_BOUGHT");

test("real Pump log trade proves mint, user, direction and exact amounts while native quote and instruction context stay unknown", () => {
  const result = decodeLogObservation(notification("pump-buy-v3-mainnet.json"));
  const event = buy(result);
  assert.ok(event);
  assert.equal(event.tokenMint, "8TAyswcwuZrzUtsZzqSW1MCDi2VbRw9p1iwP63j8pump");
  assert.equal(event.amountTokenRaw, "1277814781087");
  assert.equal(event.amountQuoteRaw, "9777777");
  assert.ok(event.wallet);
  assert.equal(event.quoteMint, null);
  assert.equal(event.poolAddress, null);
  assert.equal(event.instructionIndex, null);
  assert.equal(event.innerInstructionIndex, null);
  assert.equal(event.tokenDecimals, null);
  assert.equal(event.eventTimestamp, "2026-11-03T21:44:54.000Z");
  assert.equal(event.completeness, "INCOMPLETE");
  assert.equal(event.contextCompleteness, "INCOMPLETE");
  assert.equal(event.reconciliationStatus, "UNRECONCILED");
  assert.equal(event.confirmationStatus, "confirmed");
  assert.equal(event.dataMode, "REAL_RPC_LOG_OBSERVATION");
  assert.equal(event.evidenceStatus, "VERIFIED_RPC_LOG_EVENT");
  assert.equal(event.evidenceSource.kind, "rpc:logsSubscribe");
  assert.match(event.evidenceSource.sourceMessageSha256, /^[0-9a-f]{64}$/);
  assert.ok(
    result.diagnostics.some((item) => item.code === "EVENT_TRAILING_BYTES"),
  );
});

test("real Pump creation log preserves creator and bonding curve without pretending the full transaction was fetched", () => {
  const result = decodeLogObservation(
    notification("pump-create-v2-mainnet.json"),
  );
  const event = result.observations.find(
    (item) => item.eventType === "TOKEN_CREATED",
  );
  assert.ok(event);
  assert.ok(event.creator);
  assert.ok(event.poolAddress);
  assert.ok(event.tokenProgram);
  assert.equal(event.eventTimestamp, "2026-11-03T21:43:38.000Z");
  assert.equal(event.instructionIndex, null);
  assert.equal(event.completeness, "INCOMPLETE");
  assert.equal(event.transaction, undefined);
  assert.equal(event.transactionContext, undefined);
});

test("real Pump graduation and PumpSwap migration logs remain distinct lifecycle observations", () => {
  const graduation = decodeLogObservation(
    notification("pump-graduation-mainnet.json"),
  ).observations.find((item) => item.eventType === "TOKEN_GRADUATED");
  const migrated = decodeLogObservation(
    notification("pump-migrate-v2-pumpswap-create-mainnet.json"),
  );
  const migration = migrated.observations.find(
    (item) => item.eventType === "TOKEN_MIGRATED",
  );
  const created = migrated.observations.find(
    (item) => item.eventType === "POOL_CREATED",
  );
  assert.ok(graduation);
  assert.ok(migration);
  assert.ok(created);
  assert.equal(graduation.tokenMint, migration.tokenMint);
  assert.equal(created.tokenMint, migration.tokenMint);
  assert.equal(migration.poolAddress, created.poolAddress);
  assert.equal(migration.quoteMint, null);
  assert.notEqual(created.creator, created.poolCreator);
});

test("real PumpSwap trade log does not invent mints from a known application or pool address", () => {
  const event = buy(
    decodeLogObservation(notification("pumpswap-buy-sol-mainnet.json")),
  );
  assert.ok(event);
  assert.ok(event.poolAddress);
  assert.ok(event.wallet);
  assert.equal(event.tokenMint, null);
  assert.equal(event.quoteMint, null);
  assert.equal(event.amountTokenRaw, "836051");
  assert.equal(event.amountQuoteRaw, "267815");
});

test("real CPMM log swap preserves mints and raw amounts but wallet and block timestamp remain unknown", () => {
  const result = decodeLogObservation(
    notification("raydium-cpmm-swap-mainnet.json"),
  );
  const event = result.observations.find(
    (item) => item.eventType === "TOKEN_SOLD",
  );
  assert.ok(event);
  assert.ok(event.tokenMint);
  assert.ok(event.quoteMint);
  assert.ok(event.poolAddress);
  assert.equal(event.wallet, null);
  assert.equal(event.eventTimestamp, null);
  assert.equal(event.amountTokenRaw, "444705362107");
  assert.equal(event.amountQuoteRaw, "603739667");
});

test("real LaunchLab log trade proves pool and amounts but does not invent instruction accounts or timestamps", () => {
  const event = buy(
    decodeLogObservation(notification("raydium-launchlab-buy-mainnet.json")),
  );
  assert.ok(event);
  assert.ok(event.poolAddress);
  assert.equal(event.tokenMint, null);
  assert.equal(event.quoteMint, null);
  assert.equal(event.wallet, null);
  assert.equal(event.eventTimestamp, null);
  assert.equal(event.amountTokenRaw, "37116764184");
});

test("instruction-only real CPMM creation and mere address mentions cannot create a log event", () => {
  for (const file of [
    "raydium-cpmm-create-mainnet.json",
    "raydium-cpmm-mention-only-mainnet.json",
  ]) {
    const result = decodeLogObservation(notification(file));
    assert.equal(result.observations.length, 0);
    assert.ok(
      result.diagnostics.some((item) => item.code === "NO_SUPPORTED_LOG_EVENT"),
    );
  }
});

test("identical notifications deduplicate across subscription delivery and confirmation upgrades", () => {
  const input = notification("pump-buy-v3-mainnet.json");
  const first = decodeLogObservation({
    ...input,
    confirmationStatus: "processed",
    programId: "first-subscription",
  });
  const second = decodeLogObservation({
    ...input,
    confirmationStatus: "finalized",
    receivedAt: "2026-11-03T22:01:00.000Z",
    programId: "second-subscription",
  });
  assert.deepEqual(
    first.observations.map((item) => item.id),
    second.observations.map((item) => item.id),
  );
  assert.equal(first.observations[0].confirmationStatus, "processed");
  assert.equal(second.observations[0].confirmationStatus, "finalized");
  assert.equal(
    new Set(first.observations.map((item) => item.id)).size,
    first.observations.length,
  );
});

test("failed transactions, unknown instructions and malformed notification data produce no fabricated observations", () => {
  const input = notification("pump-buy-v3-mainnet.json");
  for (const patch of [
    { err: { InstructionError: [0, "Custom"] } },
    { onchainError: "FAILED" },
    { slot: -1 },
    { signature: null },
    { logs: [4] },
    { confirmationStatus: "secure" },
    { receivedAt: "invalid" },
  ]) {
    const result = decodeLogObservation({ ...input, ...patch });
    assert.equal(result.observations.length, 0);
    assert.ok(result.diagnostics.length);
  }
  assert.equal(decodeLogObservation(null).observations.length, 0);
  assert.equal(
    decodeLogObservation({
      ...input,
      logs: ["Program log: buy sell launch token"],
    }).observations.length,
    0,
  );
});

test("caught CPI failure and truncation cannot publish events from unsuccessful or unfinished runtime frames", () => {
  const input = notification("pump-buy-v3-mainnet.json");
  const program = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const router = "11111111111111111111111111111111";
  const data = input.logs.find((line) => line.startsWith("Program data: "));
  assert.ok(data);
  const caughtFailure = [
    `Program ${router} invoke [1]`,
    `Program ${program} invoke [2]`,
    data,
    `Program ${program} failed: custom program error: 0x1`,
    `Program ${router} success`,
  ];
  assert.equal(
    decodeLogObservation({ ...input, logs: caughtFailure }).observations.length,
    0,
  );
  const truncated = decodeLogObservation({
    ...input,
    logs: [`Program ${program} invoke [1]`, data, "Log truncated"],
  });
  assert.equal(truncated.observations.length, 0);
  assert.ok(
    truncated.diagnostics.some(
      (item) => item.code === "LOGS_TRUNCATED_COVERAGE_PARTIAL",
    ),
  );
  const spoofed = [
    `Program ${router} invoke [1]`,
    data,
    `Program ${router} success`,
  ];
  assert.equal(
    decodeLogObservation({ ...input, logs: spoofed }).observations.length,
    0,
  );
});

test("log input size is bounded before decoding", () => {
  const input = notification("pump-buy-v3-mainnet.json");
  assert.equal(
    decodeLogObservation({ ...input, logs: ["x".repeat(2 * 1024 * 1024)] })
      .diagnostics[0].code,
    "LOG_OBSERVATION_SIZE_LIMIT",
  );
  assert.equal(
    decodeLogObservation({ ...input, logs: Array(16385).fill("") })
      .diagnostics[0].code,
    "INVALID_LOG_OBSERVATION",
  );
});

test("malformed runtime ownership traces cannot attribute another programme payload", () => {
  const input = notification("pump-buy-v3-mainnet.json");
  const program = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const other = "11111111111111111111111111111111";
  const data = input.logs.find((line) => line.startsWith("Program data: "));
  for (const logs of [
    [`Program ${program} invoke [1]`, data, `Program ${other} success`],
    [`Program ${program} invoke [2]`, data, `Program ${program} success`],
  ]) {
    const result = decodeLogObservation({ ...input, logs });
    assert.equal(result.observations.length, 0);
    assert.equal(result.diagnostics[0].code, "INVALID_RUNTIME_LOG_TRACE");
  }
});
