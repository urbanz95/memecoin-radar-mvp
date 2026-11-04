// Synthetic Store fixtures only: these signatures and logs are not Mainnet evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Store } from "../src/store.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateMarket } from "../src/market.mjs";

const mint = "So11111111111111111111111111111111111111112";
const pool = "synthetic-pool";
const wallet = "synthetic-wallet";
const programId = "6EF8rrecthR5Dkzon4z3qrrMMxGowpM6CRVH94zeKKV3";
const now = Date.now();
const iso = (offset) => new Date(now + offset).toISOString();
function item(signature = "synthetic-signature", extra = {}, ordinal = 0) {
  const notification = {
    signature,
    programId,
    slot: 100,
    logs: ["synthetic test log"],
    receivedAt: iso(0),
    confirmationStatus: "confirmed",
    ...extra,
  };
  const sourceMessageSha256 = createHash("sha256")
    .update(JSON.stringify(notification.logs))
    .digest("hex");
  const observation = {
    id: createHash("sha256").update(JSON.stringify(["synthetic-log-store-test", signature, ordinal])).digest("hex"),
    chain: "solana",
    schemaVersion: 1,
    dataMode: "REAL_RPC_LOG_OBSERVATION",
    protocol: "synthetic-test",
    programId,
    eventType: "TOKEN_BOUGHT",
    transactionSignature: signature,
    slot: notification.slot,
    instructionIndex: null,
    innerInstructionIndex: null,
    tokenMint: mint,
    quoteMint: mint,
    poolAddress: pool,
    wallet,
    creator: null,
    amountTokenRaw: "9007199254740993123456789",
    amountQuoteRaw: "18446744073709551615",
    tokenDecimals: 6,
    quoteDecimals: 9,
    eventTimestamp: iso(0),
    receivedAt: notification.receivedAt,
    processedAt: iso(0),
    confirmationStatus: notification.confirmationStatus,
    reconciliationStatus: "UNRECONCILED",
    evidenceStatus: "VERIFIED_RPC_LOG_EVENT",
    completeness: "INCOMPLETE",
    contextCompleteness: "INCOMPLETE",
    evidenceSource: {
      kind: "rpc:logsSubscribe",
      transactionSignature: signature,
      sourceMessageSha256,
    },
    eventOrdinal: ordinal,
  };
  return { notification, observations: [observation] };
}
function storeFor(t, options) {
  const store = new Store(":memory:", options);
  t.after(() => store.close());
  return store;
}
const rawLogs = (store) =>
  store.db
    .prepare("SELECT * FROM selected_log_messages ORDER BY signature")
    .all();
function enrich(
  store,
  signature,
  { confirmationStatus = "confirmed", slot = 100, events = [] } = {},
) {
  const observation = {
    signature,
    slot,
    receivedAt: iso(0),
    confirmationStatus,
  };
  store.receiveBatch([observation]);
  store.persistTransaction(observation, { slot, meta: { err: null } }, events);
}

test("log batches are idempotent and never increment canonical events or token/pool projections", (t) => {
  const store = storeFor(t),
    batch = item();
  assert.equal(store.persistLogBatch([batch, batch]), 1);
  assert.equal(store.persistLogBatch([batch]), 0);
  assert.equal(store.stats().event_observations, 1);
  assert.equal(store.stats().events, 0);
  assert.equal(store.stats().tokens, 0);
  assert.equal(store.stats().pools, 0);
  assert.equal(store.stats().raw_transactions, 0);
  assert.equal(store.stats().inbox, 0);
  assert.equal(rawLogs(store).length, 1);
  assert.deepEqual(aggregateMarket(store.events()).groups, []);
});

test("observation identity and exact values remain distinct from canonical event identity", (t) => {
  const store = storeFor(t),
    batch = item();
  store.persistLogBatch([batch]);
  const [saved] = store.observations();
  assert.equal(saved.id, batch.observations[0].id);
  assert.equal(saved.instructionIndex, null);
  assert.equal(saved.innerInstructionIndex, null);
  assert.equal(saved.contextCompleteness, "INCOMPLETE");
  assert.equal(saved.completeness, "INCOMPLETE");
  assert.equal(saved.contextEnrichmentAvailable, false);
  assert.equal(saved.reconciliationStatus, "UNRECONCILED");
  assert.equal(saved.amountTokenRaw, "9007199254740993123456789");
  assert.equal(saved.amountQuoteRaw, "18446744073709551615");
});

test("selected raw log messages retain verifiable source hash and transaction signature", (t) => {
  const store = storeFor(t),
    batch = item();
  store.persistLogBatch([batch]);
  const [raw] = rawLogs(store),
    notification = JSON.parse(raw.payload),
    [saved] = store.observations();
  assert.equal(raw.signature, notification.signature);
  assert.equal(saved.transactionSignature, notification.signature);
  assert.deepEqual(notification.logs, batch.notification.logs);
  assert.equal(
    saved.evidenceSource.sourceMessageSha256,
    createHash("sha256")
      .update(JSON.stringify(notification.logs))
      .digest("hex"),
  );
});

test("duplicate notifications upgrade commitment monotonically and do not add rows", (t) => {
  const store = storeFor(t);
  const processed = item("upgraded", { confirmationStatus: "processed" });
  const confirmed = item("upgraded", { confirmationStatus: "confirmed" });
  const finalized = item("upgraded", { confirmationStatus: "finalized" });
  store.persistLogBatch([processed]);
  assert.equal(store.observations()[0].confirmationStatus, "processed");
  assert.equal(store.persistLogBatch([confirmed]), 0);
  assert.equal(store.observations()[0].confirmationStatus, "confirmed");
  assert.equal(store.persistLogBatch([finalized]), 0);
  store.persistLogBatch([processed]);
  assert.equal(store.observations()[0].confirmationStatus, "finalized");
  assert.equal(store.stats().event_observations, 1);
  assert.equal(
    JSON.parse(rawLogs(store)[0].payload).confirmationStatus,
    "finalized",
  );
});

test("observation filters select mint, wallet, pool and signature independently", (t) => {
  const store = storeFor(t),
    a = item("a"),
    b = item("b");
  b.observations[0] = {
    ...b.observations[0],
    tokenMint: "other-mint",
    wallet: "other-wallet",
    poolAddress: "other-pool",
  };
  store.persistLogBatch([a, b]);
  for (const filter of [
    { mint },
    { wallet },
    { poolAddress: pool },
    { signature: "a" },
  ]) {
    assert.deepEqual(
      store.observations(filter).map((e) => e.transactionSignature),
      ["a"],
    );
  }
  assert.equal(store.observations({ limit: 1 }).length, 1);
  assert.equal(store.observations({ mint: "missing" }).length, 0);
});

test("row cap evicts oldest observations and removes only unreferenced raw messages", (t) => {
  const store = storeFor(t);
  const a = item("a", { receivedAt: iso(-2000) }, 0);
  const secondA = item("a", { receivedAt: iso(-2000) }, 1).observations[0];
  a.observations.push(secondA);
  const b = item("b", { receivedAt: iso(0) });
  store.persistLogBatch([a, b], { maxRows: 2 });
  assert.equal(store.observations().length, 2);
  assert.equal(store.observations({ signature: "a" }).length, 1);
  assert.deepEqual(
    rawLogs(store).map((r) => r.signature),
    ["a", "b"],
  );
  store.persistLogBatch([item("c", { receivedAt: iso(1000) })], { maxRows: 2 });
  assert.deepEqual(
    new Set(store.observations().map((e) => e.transactionSignature)),
    new Set(["b", "c"]),
  );
  assert.deepEqual(
    rawLogs(store).map((r) => r.signature),
    ["b", "c"],
  );
});

test("time retention removes log observations and dangling raw logs separately from canonical retention", (t) => {
  const store = storeFor(t, { rawRetentionHours: 1, eventRetentionDays: 7 });
  store.persistLogBatch([
    item("old", { receivedAt: iso(-2 * 3600000) }),
    item("fresh"),
  ]);
  store.retain(now);
  assert.deepEqual(
    store.observations().map((e) => e.transactionSignature),
    ["fresh"],
  );
  assert.deepEqual(
    rawLogs(store).map((r) => r.signature),
    ["fresh"],
  );
  assert.equal(store.stats().events, 0);
});

test("storage budget rejects a whole log batch explicitly without publishing raw or decoded rows", (t) => {
  const store = storeFor(t, { maxBytes: 1 });
  assert.throws(
    () => store.persistLogBatch([item()]),
    /STORAGE_BUDGET_EXCEEDED/,
  );
  assert.equal(store.observations().length, 0);
  assert.equal(rawLogs(store).length, 0);
});

test("an invalid item causes the entire log batch transaction to roll back", (t) => {
  const store = storeFor(t),
    invalid = item("bad");
  invalid.observations[0].receivedAt = "not-a-timestamp";
  assert.throws(() => store.persistLogBatch([item("valid"), invalid]));
  assert.equal(store.observations().length, 0);
  assert.equal(rawLogs(store).length, 0);
});

test("empty decoder output retains no selected logs and creates no placeholder events", (t) => {
  const store = storeFor(t),
    batch = item();
  batch.observations = [];
  assert.equal(store.persistLogBatch([batch]), 0);
  assert.equal(store.observations().length, 0);
  assert.equal(rawLogs(store).length, 0);
  assert.equal(store.events().length, 0);
});

test("enriched transaction joins finality and reconciliation without turning observations into market events", (t) => {
  const store = storeFor(t);
  store.persistLogBatch([item("joined", { confirmationStatus: "processed" })]);
  enrich(store, "joined");
  let [saved] = store.observations();
  assert.equal(saved.contextEnrichmentAvailable, true);
  assert.equal(saved.confirmationStatus, "confirmed");
  assert.equal(saved.reconciliationStatus, "ACTIVE");
  assert.equal(saved.instructionIndex, null);
  assert.equal(saved.contextCompleteness, "INCOMPLETE");
  assert.equal(store.events().length, 0);
  assert.deepEqual(aggregateMarket(store.events()).groups, []);
  store.reconcile("joined", {
    confirmationStatus: "confirmed",
    slot: 100,
    err: { InstructionError: [0, "Custom"] },
  });
  [saved] = store.observations();
  assert.equal(saved.reconciliationStatus, "REVERTED");
  assert.equal(store.stats().events, 0);
  assert.equal(store.stats().event_observations, 1);
});

test("log observation and canonical swap count exactly once in their respective datasets", (t) => {
  const store = storeFor(t),
    batch = item("one-swap");
  store.persistLogBatch([batch]);
  const canonical = {
    ...batch.observations[0],
    instructionIndex: 0,
    evidenceStatus: "VERIFIED_PROTOCOL_EVENT",
    reconciliationStatus: "ACTIVE",
  };
  enrich(store, "one-swap", { events: [canonical] });
  assert.equal(store.events().length, 1);
  assert.equal(store.observations().length, 1);
  const market = aggregateMarket(store.events(), { now });
  assert.equal(market.groups.length, 1);
  assert.equal(market.groups[0].windows["1m"].swapCount, 1);
});

test("notification and observation signature mismatch is rejected before evidence references can diverge", (t) => {
  const store = storeFor(t),
    batch = item("raw-signature");
  batch.observations[0].transactionSignature = "different-signature";
  assert.throws(() => store.persistLogBatch([batch]));
  assert.equal(store.observations().length, 0);
  assert.equal(rawLogs(store).length, 0);
});

test("joining a canonical transaction at a different slot cannot confirm the old log data", (t) => {
  const store = storeFor(t);
  store.persistLogBatch([
    item("moved", { slot: 100, confirmationStatus: "processed" }),
  ]);
  enrich(store, "moved", { slot: 101 });
  const [saved] = store.observations();
  assert.equal(saved.reconciliationStatus, "UNRESOLVED");
  assert.equal(saved.slot, 100);
});

test("canonical context cannot downgrade stronger finalized RPC log commitment", (t) => {
  const store = storeFor(t);
  store.persistLogBatch([
    item("finalized-log", { confirmationStatus: "finalized" }),
  ]);
  enrich(store, "finalized-log", { confirmationStatus: "confirmed" });
  assert.equal(store.observations()[0].confirmationStatus, "finalized");
});

test('conflicting log payloads for one signature must never leave unverifiable observation references', t => {
  const store = storeFor(t), first = item('fork-log'), second = item('fork-log');
  second.notification.logs = ['different synthetic fork log'];
  second.observations[0].evidenceSource.sourceMessageSha256 = createHash('sha256').update(JSON.stringify(second.notification.logs)).digest('hex');
  second.observations[0].id += ':different-payload';
  store.persistLogBatch([first]);
  try { store.persistLogBatch([second]); } catch {
    assert.equal(store.observations().length, 1, 'a rejected conflict must roll back entirely');
  }
  const retainedHashes = new Set(rawLogs(store).map(r => createHash('sha256').update(JSON.stringify(JSON.parse(r.payload).logs)).digest('hex')));
  for (const observation of store.observations()) assert.ok(retainedHashes.has(observation.evidenceSource.sourceMessageSha256), 'each retained observation needs its matching raw log payload');
});

test('raw log source hash mismatch is rejected atomically', t => {
  const store = storeFor(t), batch = item('hash-mismatch');
  batch.observations[0].evidenceSource.sourceMessageSha256 = '0'.repeat(64);
  assert.throws(() => store.persistLogBatch([batch]));
  assert.equal(store.observations().length, 0);
  assert.equal(rawLogs(store).length, 0);
});

test('reopening an old three-column selected logs schema migrates existing evidence without loss', t => {
  const directory = mkdtempSync(join(tmpdir(), 'solana-log-migration-test-'));
  const path = join(directory, 'radar.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = item('legacy-log', { confirmationStatus: 'processed' });
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE selected_log_messages(signature TEXT PRIMARY KEY, received_at INTEGER NOT NULL, payload TEXT NOT NULL)');
  legacy.prepare('INSERT INTO selected_log_messages VALUES(?,?,?)').run(previous.notification.signature, Date.parse(previous.notification.receivedAt), JSON.stringify(previous.notification));
  legacy.close();
  const store = new Store(path);
  try {
    assert.equal(rawLogs(store).length, 1);
    assert.deepEqual(JSON.parse(rawLogs(store)[0].payload), previous.notification);
    const upgraded = item('legacy-log', { confirmationStatus: 'finalized' });
    store.persistLogBatch([upgraded]);
    assert.equal(rawLogs(store).length, 1);
    assert.equal(JSON.parse(rawLogs(store)[0].payload).confirmationStatus, 'finalized');
    assert.equal(store.observations().length, 1);
    const changed = item('legacy-log');
    changed.notification.logs = ['different migrated synthetic log'];
    changed.observations[0].evidenceSource.sourceMessageSha256 = createHash('sha256').update(JSON.stringify(changed.notification.logs)).digest('hex');
    changed.observations[0].id = createHash('sha256').update('migration-changed-payload').digest('hex');
    store.persistLogBatch([changed]);
    assert.equal(rawLogs(store).length, 2);
    assert.equal(store.observations().length, 2);
  } finally { store.close(); }
});

test('row pruning removes unreferenced payload variants even while the signature remains', t => {
  const store = storeFor(t), first = item('same-signature', { receivedAt: iso(-1000) });
  const second = item('same-signature', { receivedAt: iso(0) });
  second.notification.logs = ['newer synthetic payload variant'];
  second.observations[0].evidenceSource.sourceMessageSha256 = createHash('sha256').update(JSON.stringify(second.notification.logs)).digest('hex');
  second.observations[0].id = createHash('sha256').update('newer-variant').digest('hex');
  store.persistLogBatch([first, second], { maxRows: 1 });
  assert.equal(store.observations().length, 1);
  assert.equal(rawLogs(store).length, 1);
  assert.deepEqual(JSON.parse(rawLogs(store)[0].payload).logs, second.notification.logs);
});
