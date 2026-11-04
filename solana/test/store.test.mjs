// Deterministic, synthetic storage scenarios. These fixtures are not Mainnet evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Store } from "../src/store.mjs";
import { canonicalEvent } from "../src/events.mjs";

const at = "2026-11-03T12:00:00.000Z";
const mintA = "So11111111111111111111111111111111111111112";
const mintB = "so11111111111111111111111111111111111111112";
const program = "6EF8rrecthR5Dkzon4z3qrrMMxGowpM6CRVH94zeKKV3";
const observation = (signature = "synthetic-signature-1", extra = {}) => ({
  signature,
  slot: 100,
  receivedAt: at,
  confirmationStatus: "confirmed",
  ...extra,
});
const event = (extra = {}) => ({
  protocol: "synthetic-test",
  programId: program,
  eventType: "TOKEN_BOUGHT",
  tokenMint: mintA,
  quoteMint: mintB,
  wallet: "synthetic-wallet",
  transactionSignature: "synthetic-signature-1",
  slot: 100,
  instructionIndex: 0,
  amountTokenRaw: "9007199254740993123456789",
  amountQuoteRaw: "18446744073709551615",
  tokenDecimals: 6,
  quoteDecimals: 9,
  eventTimestamp: at,
  receivedAt: at,
  evidenceSource: "deterministic-test-only",
  ...extra,
});
const transaction = (extra = {}) => ({
  slot: 100,
  meta: { err: null },
  ...extra,
});
function temporaryStore(t, options) {
  const directory = mkdtempSync(join(tmpdir(), "solana-store-test-"));
  const path = join(directory, "radar.sqlite");
  const store = new Store(path, options);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, path };
}
function complete(store, obs = observation(), events = [event()]) {
  store.receiveBatch([obs]);
  assert.equal(store.claim(obs.signature), true);
  return store.persistTransaction(obs, transaction({ slot: obs.slot }), events);
}

test("SQLite WAL persists exact raw amounts above 2^53 across reopen", (t) => {
  const { store, path } = temporaryStore(t);
  assert.equal(
    store.db.prepare("PRAGMA journal_mode").get().journal_mode,
    "wal",
  );
  complete(store);
  store.close();
  const reopened = new Store(path);
  try {
    const [actual] = reopened.events();
    assert.equal(actual.amountTokenRaw, "9007199254740993123456789");
    assert.equal(actual.amountQuoteRaw, "18446744073709551615");
    assert.equal(actual.transactionSignature, observation().signature);
    assert.equal(reopened.stats().pending, 0);
  } finally {
    reopened.close();
  }
});

test("duplicates preserve one inbox transaction, one event and one token", (t) => {
  const { store } = temporaryStore(t);
  const obs = observation();
  assert.equal(store.receiveBatch([obs, obs]), 1);
  assert.equal(store.receiveBatch([obs]), 0);
  store.persistTransaction(obs, transaction(), [event()]);
  store.persistTransaction(obs, transaction(), [event()]);
  assert.equal(store.stats().inbox, 1);
  assert.equal(store.stats().events, 1);
  assert.equal(store.stats().tokens, 1);
  assert.equal(store.stats().raw_transactions, 1);
  assert.equal(store.isDone(obs.signature), true);
});

test("token identities remain case-sensitive mint addresses despite duplicate symbols", (t) => {
  const { store } = temporaryStore(t);
  complete(store, observation(), [
    event({ eventType: "TOKEN_CREATED", symbol: "SAME", creator: "creator-A" }),
  ]);
  complete(store, observation("synthetic-signature-2"), [
    event({
      tokenMint: mintB,
      eventType: "TOKEN_CREATED",
      symbol: "SAME",
      creator: "creator-B",
    }),
  ]);
  assert.deepEqual(
    new Set(store.tokens().map((token) => token.mint)),
    new Set([mintA, mintB]),
  );
  assert.equal(store.events({ mint: mintA }).length, 1);
  assert.equal(store.events({ mint: mintB }).length, 1);
});

test("an invalid event rolls back raw transaction, normalized events, token and inbox completion", (t) => {
  const { store } = temporaryStore(t);
  const obs = observation();
  store.receiveBatch([obs]);
  store.claim(obs.signature);
  assert.throws(
    () =>
      store.persistTransaction(obs, transaction(), [
        event(),
        event({ instructionIndex: 1, amountTokenRaw: 9007199254740992 }),
      ]),
    /RAW_AMOUNT_REQUIRES_UNSIGNED_INTEGER_STRING/,
  );
  assert.equal(store.stats().events, 0);
  assert.equal(store.stats().raw_transactions, 0);
  assert.equal(store.stats().tokens, 0);
  assert.equal(store.transaction(obs.signature), undefined);
  assert.equal(store.isDone(obs.signature), false);
  assert.equal(
    store.db.prepare("SELECT status FROM inbox").get().status,
    "PROCESSING",
  );
});

test("receiveBatch rolls back its entire batch when an observation is invalid", (t) => {
  const { store } = temporaryStore(t);
  assert.throws(
    () =>
      store.receiveBatch([observation(), observation("bad", { slot: NaN })]),
    /INVALID_OBSERVATION/,
  );
  assert.equal(store.stats().inbox, 0);
});

test("checkpoint advances only once all required signatures are durably complete", (t) => {
  const { store, path } = temporaryStore(t);
  const a = observation("a"),
    b = observation("b");
  store.receiveBatch([a, b]);
  store.advanceCheckpoint(program, { slot: 90, signature: "prior" });
  assert.throws(
    () =>
      store.advanceCheckpoint(program, { slot: 100, signature: "b" }, [
        "a",
        "b",
      ]),
    /CHECKPOINT_BEFORE_PERSISTENCE/,
  );
  store.persistTransaction(a, transaction(), [event()]);
  assert.throws(
    () =>
      store.advanceCheckpoint(program, { slot: 100, signature: "b" }, [
        "a",
        "b",
      ]),
    /CHECKPOINT_BEFORE_PERSISTENCE/,
  );
  assert.equal(store.checkpoint(program).slot, 90);
  store.completeFailed(b, { InstructionError: [0, "Custom"] });
  store.advanceCheckpoint(program, { slot: 100, signature: "b" }, ["a", "b"]);
  store.close();
  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.checkpoint(program), {
      slot: 100,
      signature: "b",
    });
  } finally {
    reopened.close();
  }
});

test(
  "process killed before SQLite COMMIT cannot publish events or advance checkpoint",
  { timeout: 15000 },
  async (t) => {
    const { store, path } = temporaryStore(t);
    const obs = observation();
    store.receiveBatch([obs]);
    store.advanceCheckpoint(program, { slot: 90, signature: "prior" });
    store.close();
    const moduleUrl = new URL("../src/store.mjs", import.meta.url).href;
    const childSource = `
    import { Store } from ${JSON.stringify(moduleUrl)};
    const s = new Store(${JSON.stringify(path)});
    s.claim(${JSON.stringify(obs.signature)});
    const original = s.db.exec.bind(s.db);
    s.db.exec = sql => {
      if (sql === 'COMMIT') {
        process.stdout.write('READY\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return original(sql);
    };
    s.persistTransaction(${JSON.stringify(obs)}, ${JSON.stringify(transaction())}, [${JSON.stringify(event())}]);
  `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", childSource],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    const exited = once(child, "exit");
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (value) => {
        output += value;
        if (output.includes("READY")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error(`child exited before COMMIT interception: ${stderr}`)),
      );
    });
    child.kill("SIGKILL");
    await exited;
    const reopened = new Store(path);
    try {
      assert.equal(reopened.stats().events, 0);
      assert.equal(reopened.stats().raw_transactions, 0);
      assert.equal(reopened.transaction(obs.signature), undefined);
      assert.deepEqual(reopened.checkpoint(program), {
        slot: 90,
        signature: "prior",
      });
      assert.equal(reopened.pending().length, 1);
      assert.equal(reopened.claim(obs.signature), true);
      reopened.persistTransaction(obs, transaction(), [event()]);
      reopened.advanceCheckpoint(
        program,
        { slot: 100, signature: obs.signature },
        [obs.signature],
      );
      assert.equal(reopened.events().length, 1);
    } finally {
      reopened.close();
    }
  },
);

test("restart requeues PROCESSING inbox work with retry attempts intact", (t) => {
  const { store, path } = temporaryStore(t);
  const obs = observation();
  store.receiveBatch([obs]);
  store.retry(obs.signature, "HTTP_429", { delayMs: 0 });
  assert.equal(store.claim(obs.signature), true);
  store.close();
  const reopened = new Store(path);
  try {
    const [pending] = reopened.pending();
    assert.equal(pending.signature, obs.signature);
    assert.equal(pending.attempts, 1);
    assert.equal(reopened.claim(obs.signature), true);
  } finally {
    reopened.close();
  }
});

test("processed observations remain provisional and finality upgrades never regress", (t) => {
  const { store } = temporaryStore(t);
  complete(store, observation(undefined, { confirmationStatus: "processed" }));
  assert.equal(store.events()[0].confirmationStatus, "processed");
  assert.equal(store.nonFinalized().length, 1);
  store.reconcile(observation().signature, {
    confirmationStatus: "confirmed",
    err: null,
  });
  assert.equal(store.events()[0].confirmationStatus, "confirmed");
  store.reconcile(observation().signature, {
    confirmationStatus: "finalized",
    err: null,
  });
  store.reconcile(observation().signature, {
    confirmationStatus: "processed",
    err: null,
  });
  assert.equal(store.events()[0].confirmationStatus, "finalized");
  assert.equal(store.nonFinalized().length, 0);
});

test("unresolved signature remains eligible for a later finality reconciliation", (t) => {
  const { store } = temporaryStore(t);
  complete(store, observation(undefined, { confirmationStatus: "processed" }));
  store.reconcile(observation().signature, null);
  assert.equal(store.events()[0].reconciliationStatus, "UNRESOLVED");
  assert.equal(store.gaps()[0].code, "FINALITY_UNRESOLVED");
  assert.equal(store.nonFinalized().length, 1);
  store.reconcile(observation().signature, {
    confirmationStatus: "finalized",
    err: null,
  });
  assert.equal(store.events()[0].reconciliationStatus, "ACTIVE");
  assert.equal(store.events()[0].confirmationStatus, "finalized");
});

test("reverted transaction preserves evidence, records a gap and exits active reconciliation", (t) => {
  const { store } = temporaryStore(t);
  complete(store, observation(undefined, { confirmationStatus: "processed" }));
  store.reconcile(observation().signature, {
    confirmationStatus: "finalized",
    err: { InstructionError: [0, "Custom"] },
  });
  assert.equal(store.events().length, 1);
  assert.equal(store.events()[0].reconciliationStatus, "REVERTED");
  assert.equal(
    store.transaction(observation().signature).reconciliation,
    "REVERTED",
  );
  assert.equal(store.gaps()[0].code, "FINALITY_REVERTED");
  assert.equal(store.nonFinalized().length, 0);
});

test("retention removes old completed evidence while preserving pending work and checkpoint", (t) => {
  const { store } = temporaryStore(t, {
    rawRetentionHours: 1,
    eventRetentionDays: 1,
  });
  complete(store);
  store.receiveBatch([observation("pending")]);
  store.advanceCheckpoint(
    program,
    { slot: 100, signature: observation().signature },
    [observation().signature],
  );
  const future = Date.now() + 2 * 86400000;
  store.retain(future);
  assert.equal(store.events().length, 0);
  assert.equal(store.stats().raw_transactions, 0);
  assert.equal(store.stats().pending, 1);
  assert.equal(store.pending()[0].signature, "pending");
  assert.equal(store.checkpoint(program).slot, 100);
  assert.equal(store.tokens().length, 1);
});

test("storage budget refuses observations explicitly without silently dropping them", (t) => {
  const { store } = temporaryStore(t, { maxBytes: 1 });
  assert.throws(
    () => store.receiveBatch([observation()]),
    /STORAGE_BUDGET_EXCEEDED/,
  );
  assert.equal(store.stats().inbox, 0);
});

test("event identity includes inner instruction/event index and raw values reject Number", () => {
  const a = canonicalEvent(event());
  const b = canonicalEvent(event({ innerInstructionIndex: 1 }));
  const c = canonicalEvent(event({ innerInstructionIndex: 1, eventIndex: 1 }));
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  assert.equal(
    canonicalEvent(event({ amountTokenRaw: 18446744073709551615n }))
      .amountTokenRaw,
    "18446744073709551615",
  );
  assert.throws(
    () => canonicalEvent(event({ amountTokenRaw: 1 })),
    /RAW_AMOUNT_REQUIRES_UNSIGNED_INTEGER_STRING/,
  );
  assert.throws(
    () => canonicalEvent(event({ amountQuoteRaw: "-1" })),
    /RAW_AMOUNT_REQUIRES_UNSIGNED_INTEGER_STRING/,
  );
});
