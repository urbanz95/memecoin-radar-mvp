// Mock RPC history plus real SQLite. No synthetic signature is Mainnet evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { recoverProgram } from "../src/recovery.mjs";

const programId = "6EF8rrecthR5Dkzon4z3qrrMMxGowpM6CRVH94zeKKV3";
const now = () => Date.parse("2026-11-03T12:00:00.000Z");
const row = (signature, slot, extra = {}) => ({
  signature,
  slot,
  err: null,
  confirmationStatus: "confirmed",
  ...extra,
});
function setup(
  t,
  pages,
  { previous = { signature: "anchor", slot: 90 } } = {},
) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  if (previous) store.advanceCheckpoint(programId, previous);
  const calls = [],
    processed = [],
    counters = {};
  const rpc = {
    async request(method, params) {
      calls.push({ method, params });
      assert.equal(method, "getSignaturesForAddress");
      assert.equal(params[0], programId);
      assert.equal(params[1].commitment, "confirmed");
      const result = pages[calls.length - 1];
      if (result instanceof Error) throw result;
      assert.notEqual(result, undefined, "unexpected extra history request");
      return result;
    },
  };
  const metrics = {
    inc(name) {
      counters[name] = (counters[name] ?? 0) + 1;
    },
  };
  const processObservation = async (observation) => {
    processed.push(observation.signature);
    assert.equal(store.claim(observation.signature), true);
    if (observation.onchainError)
      store.completeFailed(observation, observation.onchainError);
    else
      store.persistTransaction(
        observation,
        { slot: observation.slot, meta: { err: null } },
        [],
      );
    return true;
  };
  const recover = (options) =>
    recoverProgram({
      rpc,
      store,
      programId,
      processObservation,
      metrics,
      maxPages: 5,
      pageSize: 2,
      now,
      ...options,
    });
  return {
    store,
    rpc,
    calls,
    processed,
    metrics,
    counters,
    processObservation,
    recover,
  };
}

test("reconnection recovers paginated lost history oldest first up to the persisted anchor", async (t) => {
  const s = setup(t, [
    [row("newest", 103), row("middle", 102)],
    [row("oldest-missing", 101), row("anchor", 90)],
  ]);
  const result = await s.recover();
  assert.deepEqual(s.processed, ["oldest-missing", "middle", "newest"]);
  assert.deepEqual(
    s.calls.map((call) => call.params[1].before ?? null),
    [null, "middle"],
  );
  assert.equal(result.complete, true);
  assert.equal(result.checkpointAdvanced, true);
  assert.equal(result.recovered, 3);
  assert.equal(result.pages, 2);
  assert.equal(s.store.checkpoint(programId).signature, "newest");
  assert.equal(s.store.checkpoint(programId).continuity, "RPC_ANCHOR_REACHED");
  assert.equal(s.store.gaps().length, 0);
});

test("duplicate signatures from overlapping pages are persisted and processed only once", async (t) => {
  const s = setup(t, [
    [row("newest", 103), row("middle", 102)],
    [row("middle", 102), row("oldest-missing", 101)],
    [row("anchor", 90), row("older-not-needed", 80)],
  ]);
  const result = await s.recover();
  assert.equal(result.complete, true);
  assert.equal(result.selected, 3);
  assert.equal(new Set(s.processed).size, 3);
  assert.equal(s.store.stats().inbox, 3);
  assert.equal(s.store.stats().raw_transactions, 3);
});

test("first start establishes an explicit bounded initial history boundary", async (t) => {
  const s = setup(t, [[row("newest", 103), row("older", 102)]], {
    previous: null,
  });
  const result = await s.recover();
  assert.equal(s.calls.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.gap, "INITIAL_HISTORY_BOUNDARY");
  assert.equal(result.checkpointAdvanced, true);
  assert.equal(s.store.checkpoint(programId).continuity, "PARTIAL");
  assert.equal(s.store.checkpoint(programId).priorAnchor, null);
  assert.equal(s.store.gaps()[0].code, "INITIAL_HISTORY_BOUNDARY");
  assert.equal(s.counters.recoveryGaps, 1);
});

test("insufficient retained history remains a gap even after available events persist", async (t) => {
  const s = setup(t, [[row("newest", 103), row("oldest-available", 102)], []]);
  const result = await s.recover();
  assert.equal(result.complete, false);
  assert.equal(result.gap, "HISTORY_ANCHOR_NOT_REACHED");
  assert.equal(result.recovered, 2);
  assert.equal(result.checkpointAdvanced, true);
  const gap = s.store.gaps()[0];
  assert.equal(gap.code, "HISTORY_ANCHOR_NOT_REACHED");
  assert.equal(gap.payload.anchor.signature, "anchor");
  assert.equal(gap.payload.oldest.signature, "oldest-available");
  assert.equal(s.store.checkpoint(programId).continuity, "PARTIAL");
});

test("maxPages bounds each tick and preserves the anchor with durable continuation", async (t) => {
  const s = setup(t, [[row("newest", 103), row("middle", 102)]]);
  const result = await s.recover({ maxPages: 1 });
  assert.equal(s.calls.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(result.continuation, true);
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
  assert.ok(
    s.store.recoveryState(programId),
    "pagination state must survive between ticks",
  );
  assert.equal(s.store.isDone("newest"), true);
  assert.equal(s.store.isDone("middle"), true);
});

test("recovery resumes the saved before cursor on the next tick and commits the original head", async (t) => {
  const s = setup(t, [
    [row("original-head", 103), row("middle", 102)],
    [row("oldest-missing", 101), row("anchor", 90)],
  ]);
  const first = await s.recover({ maxPages: 1 });
  assert.equal(first.continuation, true);
  assert.equal(first.checkpointAdvanced, false);
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
  const second = await s.recover({ maxPages: 1 });
  assert.equal(s.calls[1].params[1].before, "middle");
  assert.equal(second.complete, true);
  assert.equal(second.checkpointAdvanced, true);
  assert.equal(s.store.checkpoint(programId).signature, "original-head");
  assert.equal(s.store.checkpoint(programId).priorAnchor, "anchor");
  assert.equal(s.store.checkpoint(programId).continuity, "RPC_ANCHOR_REACHED");
  assert.equal(s.store.recoveryState(programId), null);
  assert.deepEqual(
    new Set(s.processed),
    new Set(["original-head", "middle", "oldest-missing"]),
  );
});

test("RPC failure during continuation preserves the cursor and old checkpoint for the next tick", async (t) => {
  const s = setup(t, [
    [row("original-head", 103), row("middle", 102)],
    Object.assign(new Error("rate limited"), { code: "HTTP_429" }),
    [row("oldest-missing", 101), row("anchor", 90)],
  ]);
  await s.recover({ maxPages: 1 });
  const cursor = s.store.recoveryState(programId);
  const failed = await s.recover({ maxPages: 1 });
  assert.equal(failed.gap, "RECOVERY_ERROR");
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
  assert.deepEqual(s.store.recoveryState(programId), cursor);
  const resumed = await s.recover({ maxPages: 1 });
  assert.equal(s.calls[2].params[1].before, "middle");
  assert.equal(resumed.complete, true);
  assert.equal(s.store.checkpoint(programId).signature, "original-head");
  assert.equal(s.store.recoveryState(programId), null);
});

test("unavailable transaction cannot advance checkpoint even when another persists", async (t) => {
  const s = setup(t, [
    [row("newest", 103), row("unavailable", 102)],
    [row("anchor", 90)],
  ]);
  const result = await s.recover({
    processObservation: async (observation) => {
      if (observation.signature === "unavailable") return false;
      return s.processObservation(observation);
    },
  });
  assert.equal(result.complete, false);
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
  assert.equal(s.store.isDone("newest"), true);
  assert.equal(s.store.isDone("unavailable"), false);
  assert.equal(s.store.pending().length, 1);
});

test("process callback claiming success without durable writes cannot advance checkpoint", async (t) => {
  const s = setup(t, [[row("newest", 103), row("anchor", 90)]]);
  const result = await s.recover({ processObservation: async () => true });
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(result.complete, false);
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
});

test("persistence failure retains old checkpoint and durable pending observations", async (t) => {
  const s = setup(t, [[row("newest", 103), row("anchor", 90)]]);
  const result = await s.recover({
    processObservation: async (observation) => {
      s.store.claim(observation.signature);
      throw Object.assign(new Error("SQLITE_FULL"), { code: "SQLITE_FULL" });
    },
  });
  assert.equal(result.complete, false);
  assert.equal(result.gap, "RECOVERY_ERROR");
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
  assert.equal(s.store.stats().pending, 1);
  assert.equal(s.store.gaps()[0].payload.code, "SQLITE_FULL");
});

test("429 returned by RPC after retry exhaustion records recovery error without advancing", async (t) => {
  const s = setup(t, [
    Object.assign(new Error("RPC rate limited"), { code: "HTTP_429" }),
  ]);
  const result = await s.recover();
  assert.equal(result.gap, "RECOVERY_ERROR");
  assert.equal(result.complete, false);
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
  assert.equal(s.store.stats().inbox, 0);
  assert.equal(s.store.gaps()[0].payload.code, "HTTP_429");
  assert.equal(s.counters.recoveryGaps, 1);
});

test("empty history cannot overwrite a checkpoint or imply no lost events", async (t) => {
  const s = setup(t, [[]]);
  const result = await s.recover();
  assert.equal(result.complete, false);
  assert.equal(result.recovered, 0);
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
  assert.equal(s.store.gaps()[0].code, "HISTORY_ANCHOR_NOT_REACHED");
});

test("replayed recovery sees durable duplicates and does not invoke decoder again", async (t) => {
  const s = setup(t, [
    [row("newest", 103), row("anchor", 90)],
    [row("newest", 103), row("anchor", 90)],
  ]);
  const first = await s.recover();
  assert.equal(first.recovered, 1);
  const second = await s.recover();
  assert.equal(second.complete, true);
  assert.equal(second.selected, 0);
  assert.deepEqual(s.processed, ["newest"]);
  assert.equal(s.store.stats().inbox, 1);
});

test("failed on-chain transactions can complete history without normalized market events", async (t) => {
  const s = setup(t, [
    [
      row("failed", 103, { err: { InstructionError: [0, "Custom"] } }),
      row("anchor", 90),
    ],
  ]);
  const result = await s.recover();
  assert.equal(result.complete, true);
  assert.equal(s.store.isDone("failed"), true);
  assert.equal(s.store.events().length, 0);
  assert.equal(s.store.stats().errors, 1);
});

test("stalled pagination is an explicit error and cannot move the checkpoint", async (t) => {
  const s = setup(t, [
    [row("newest", 103), row("stuck", 102)],
    [row("newest", 103), row("stuck", 102)],
  ]);
  const result = await s.recover();
  assert.equal(result.complete, false);
  assert.equal(result.gap, "RECOVERY_ERROR");
  assert.equal(s.store.gaps()[0].payload.code, "HISTORY_CURSOR_STALLED");
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
});

test("invalid history observations fail atomically and retain prior checkpoint", async (t) => {
  const s = setup(t, [[row("invalid", NaN), row("anchor", 90)]]);
  const result = await s.recover();
  assert.equal(result.gap, "RECOVERY_ERROR");
  assert.equal(s.store.gaps()[0].payload.code, "INVALID_OBSERVATION");
  assert.equal(s.store.stats().inbox, 0);
  assert.equal(s.store.checkpoint(programId).signature, "anchor");
});
