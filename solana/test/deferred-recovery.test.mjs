// Deterministic RPC history plus real SQLite; these signatures are not Mainnet proofs.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { recoverProgram } from "../src/recovery.mjs";

const programId = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const row = (signature, slot) => ({
  signature,
  slot,
  err: null,
  confirmationStatus: "confirmed",
});
const observation = (signature, slot) => ({
  ...row(signature, slot),
  programId,
  receivedAt: new Date().toISOString(),
  evidenceSource: "rpc:getSignaturesForAddress",
  onchainError: null,
});
function setup(t, pages) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.advanceCheckpoint(programId, { signature: "anchor", slot: 90 });
  const calls = [],
    processed = [];
  const rpc = {
    async request(method, params) {
      assert.equal(method, "getSignaturesForAddress");
      calls.push(params);
      const page = pages.shift();
      if (page instanceof Error) throw page;
      assert.ok(page, "unexpected extra RPC history page");
      return page;
    },
  };
  const persist = async (item) => {
    processed.push(item.signature);
    assert.equal(store.claim(item.signature), true);
    store.persistTransaction(
      item,
      { slot: item.slot, meta: { err: null } },
      [],
    );
    return true;
  };
  const recover = (processObservation = persist) =>
    recoverProgram({
      rpc,
      store,
      programId,
      processObservation,
      pageSize: 2,
      maxPages: 1,
    });
  return { store, calls, processed, persist, recover };
}
function seedEighthAttempt(store, signature = "hole", slot = 102) {
  const item = observation(signature, slot);
  store.receiveBatch([item]);
  store.db
    .prepare("UPDATE inbox SET attempts=7 WHERE signature=?")
    .run(signature);
  return item;
}

test("eighth unavailable enrichment persists a hole and lets recovery continue to older pages", async (t) => {
  const s = setup(t, [
    [row("head", 103), row("hole", 102)],
    [row("older", 101), row("anchor", 90)],
  ]);
  seedEighthAttempt(s.store);
  const first = await s.recover(async (item) => {
    if (item.signature !== "hole") return s.persist(item);
    assert.equal(s.store.claim(item.signature), true);
    s.store.retry(item.signature, "HISTORY_NOT_AVAILABLE", { delayMs: 1 });
    return false;
  });
  assert.equal(first.continuation, true);
  assert.equal(first.complete, false);
  assert.equal(first.transactionHoles, 1);
  assert.equal(s.store.isDone("hole"), false);
  assert.equal(s.store.isSettled("hole"), true);
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
  assert.equal(s.store.recoveryState(programId).before, "hole");
  assert.equal(s.store.recoveryState(programId).hadHoles, true);
  assert.deepEqual(
    s.store.gaps().find((g) => g.code === "HISTORY_TRANSACTION_HOLES").payload
      .signatures,
    ["hole"],
  );

  const second = await s.recover();
  assert.equal(s.calls[1][1].before, "hole");
  assert.equal(second.complete, false);
  assert.equal(second.gap, "HISTORY_TRANSACTION_HOLES");
  assert.equal(second.checkpointAdvanced, true);
  assert.equal(second.hadHoles, true);
  assert.equal(s.store.checkpoint(programId).signature, "head");
  assert.equal(s.store.checkpoint(programId).continuity, "PARTIAL");
  assert.equal(s.store.checkpoint(programId).transactionHoles, true);
  assert.deepEqual(s.processed, ["head", "older"]);
  assert.equal(s.store.recoveryState(programId), null);

  // Advancing a partial history cursor must not delete the durable retry job.
  assert.equal(
    s.store.pending().some((item) => item.signature === "hole"),
    false,
  );
  const deferred = s.store.db
    .prepare("SELECT status,next_at FROM inbox WHERE signature='hole'")
    .get();
  assert.equal(deferred.status, "UNAVAILABLE");
  assert.ok(deferred.next_at > Date.now());
  s.store.db.prepare("UPDATE inbox SET next_at=0 WHERE signature='hole'").run();
  const retry = s.store.pending().find((item) => item.signature === "hole");
  assert.ok(retry);
  assert.equal(await s.persist(retry), true);
  assert.equal(s.store.isDone("hole"), true);
  assert.equal(s.store.stats().events, 0);
});

test("an already deferred signature is not retried before its cooldown or counted as recovered", async (t) => {
  const s = setup(t, [[row("hole", 102), row("anchor", 90)]]);
  const hole = seedEighthAttempt(s.store);
  assert.equal(s.store.claim(hole.signature), true);
  s.store.retry(hole.signature, "HISTORY_NOT_AVAILABLE");
  const result = await s.recover(async () => {
    throw Error("deferred job must wait for its independent retry");
  });
  assert.equal(result.recovered, 0);
  assert.equal(result.complete, false);
  assert.equal(result.checkpointAdvanced, true);
  assert.equal(s.store.checkpoint(programId).continuity, "PARTIAL");
  assert.equal(s.store.isDone("hole"), false);
  assert.equal(s.store.isSettled("hole"), true);
});

test("a transient pending failure remains uncommitted history rather than a declared coverage hole", async (t) => {
  const s = setup(t, [[row("head", 103), row("pending", 102)]]);
  const result = await s.recover(async (item) => {
    if (item.signature !== "pending") return s.persist(item);
    assert.equal(s.store.claim(item.signature), true);
    s.store.retry(item.signature, "TEMPORARY_UNAVAILABLE", { delayMs: 10000 });
    return false;
  });
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(result.hadHoles, false);
  assert.equal(s.store.recoveryState(programId), null);
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
  assert.equal(s.store.isSettled("pending"), false);
  assert.equal(
    s.store.gaps().some((g) => g.code === "HISTORY_TRANSACTION_HOLES"),
    false,
  );
});

test("RPC interruption after a deferred hole preserves the partial coverage flag across continuation", async (t) => {
  const s = setup(t, [
    [row("head", 103), row("hole", 102)],
    Object.assign(Error("rate limited"), { code: "HTTP_429" }),
    [row("older", 101), row("anchor", 90)],
  ]);
  const hole = seedEighthAttempt(s.store);
  assert.equal(s.store.claim(hole.signature), true);
  s.store.retry(hole.signature, "NOT_RETAINED");
  await s.recover();
  const saved = s.store.recoveryState(programId);
  const interrupted = await s.recover();
  assert.equal(interrupted.gap, "RECOVERY_ERROR");
  assert.deepEqual(s.store.recoveryState(programId), saved);
  const resumed = await s.recover();
  assert.equal(resumed.complete, false);
  assert.equal(resumed.gap, "HISTORY_TRANSACTION_HOLES");
  assert.equal(s.store.checkpoint(programId).continuity, "PARTIAL");
  assert.equal(s.store.isDone("older"), true);
});

test("a callback claiming success without committing cannot inflate recovered count", async (t) => {
  const s = setup(t, [[row("uncommitted", 102), row("anchor", 90)]]);
  const result = await s.recover(async () => true);
  assert.equal(result.recovered, 0);
  assert.equal(result.complete, false);
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
});
