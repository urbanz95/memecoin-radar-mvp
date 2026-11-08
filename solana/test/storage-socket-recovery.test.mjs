import test from "node:test";
import assert from "node:assert/strict";
import { Scanner } from "../src/scanner.mjs";
import { Store } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";

function setup() {
  const store = new Store(":memory:");
  const socket = {
    starts: 0, stops: 0, start() { this.starts++; }, stop() { this.stops++; },
  };
  const scanner = new Scanner({
    ...loadConfig({ SOLANA_PROGRAMS: "pump_fun" }),
    maxDurableBacklog: 64,
  }, {
    store,
    rpc: { async close() {} },
    oracle: { snapshot() { return null; } },
  });
  scanner.socket = socket;
  return { scanner, store, socket };
}

test("temporary SQLite failure resumes the same WebSocket after a successful write and cooldown", async () => {
  const { scanner, socket } = setup();
  try {
    scanner.pauseSocketForStorage();
    assert.equal(socket.stops, 1);
    assert.equal(scanner.health().metrics.gauges.websocket_storage_paused, true);
    scanner.persistMetrics();
    assert.equal(socket.starts, 0);
    scanner.storageSocketPausedAt -= 30001;
    scanner.persistMetrics();
    assert.equal(socket.starts, 1);
    assert.equal(scanner.storageSocketPausedAt, null);
    assert.equal(scanner.health().metrics.counters.websocket_storage_resumes, 1);
    assert.equal(scanner.health().metrics.gauges.websocket_storage_paused, false);
    assert.equal(scanner.recoveryPending, true);
    scanner.persistMetrics();
    assert.equal(socket.starts, 1);
  } finally {
    await scanner.stop();
  }
});

test("unresolved buffer errors never resume capture or drop pending observations", async () => {
  const { scanner, store, socket } = setup();
  const entry = {
    signature: "pending-storage-sig", slot: 1,
    receivedAt: new Date().toISOString(),
    confirmationStatus: "confirmed", evidenceSource: "rpc:logsSubscribe",
  };
  scanner.buffer.push(entry);
  const real = store.receiveBatch.bind(store);
  store.receiveBatch = () => { throw Error("SQLITE_BUSY"); };
  try {
    scanner.pauseSocketForStorage();
    scanner.storageSocketPausedAt -= 30001;
    scanner.persistMetrics();
    assert.equal(socket.starts, 0);
    assert.equal(socket.stops >= 2, true);
    assert.equal(scanner.buffer.length, 1);
    assert.equal(scanner.health().metrics.counters.websocket_storage_resume_deferred, 1);
    store.receiveBatch = real;
    scanner.storageSocketPausedAt -= 30001;
    scanner.persistMetrics();
    assert.equal(socket.starts, 1);
    assert.equal(scanner.buffer.length, 0);
    assert.equal(store.stats().pending, 1);
  } finally {
    store.receiveBatch = real;
    await scanner.stop();
  }
});

test("storage budget failure blocks socket restart until budget is healthy", async () => {
  const { scanner, store, socket } = setup();
  const original = store.checkBudget.bind(store);
  try {
    scanner.pauseSocketForStorage();
    scanner.storageSocketPausedAt -= 30001;
    store.checkBudget = () => { throw Error("STORAGE_BUDGET_EXCEEDED"); };
    scanner.persistMetrics();
    assert.equal(socket.starts, 0);
    assert.equal(scanner.storageSocketPausedAt !== null, true);
    store.checkBudget = original;
    scanner.storageSocketPausedAt -= 30001;
    scanner.persistMetrics();
    assert.equal(socket.starts, 1);
  } finally {
    store.checkBudget = original;
    await scanner.stop();
  }
});

test("backlog recovery cannot bypass a storage pause; shutdown cannot restart socket", async () => {
  const { scanner, socket } = setup();
  try {
    scanner.pauseSocketForStorage();
    scanner.overloadRecorded = true;
    scanner.pump();
    assert.equal(socket.starts, 0);
    scanner.stopping = true;
    scanner.storageSocketPausedAt -= 30001;
    scanner.persistMetrics();
    assert.equal(socket.starts, 0);
  } finally {
    scanner.stopping = false;
    await scanner.stop();
  }
});

test("recordMetrics write failure creates storage pause and does not fake recovery", async () => {
  const { scanner, store, socket } = setup();
  const real = store.recordMetrics.bind(store);
  try {
    store.recordMetrics = () => { throw Error("SQLITE_READONLY"); };
    assert.throws(() => scanner.persistMetrics(), /SQLITE_READONLY/);
    assert.equal(socket.stops, 1);
    assert.equal(scanner.health().metrics.counters.persistenceFailures, 1);
    store.recordMetrics = real;
    scanner.storageSocketPausedAt -= 30001;
    scanner.persistMetrics();
    assert.equal(socket.starts, 1);
  } finally {
    store.recordMetrics = real;
    await scanner.stop();
  }
});
