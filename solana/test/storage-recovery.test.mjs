// Simulated failures: never connect to Mainnet and never create paid requests.
import test from "node:test";
import assert from "node:assert/strict";
import { Scanner } from "../src/scanner.mjs";
import { Store } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";
import { PROGRAMS } from "../src/protocols/index.mjs";

const programId = PROGRAMS.find(p => p.protocol === "pump_fun").programId;
function makeScanner() {
  const store = new Store(":memory:");
  const socket = {
    stopped: true, starts: 0, stops: 0,
    start() { this.stopped = false; this.starts++; },
    stop() { this.stopped = true; this.stops++; },
    reconnect() { this.stop(); }
  };
  const rpc = {
    async assertMainnet() {},
    async close() {},
    async request() { throw Error("UNEXPECTED_RPC_IN_STORAGE_RECOVERY_TEST"); }
  };
  const config = loadConfig({
    SOLANA_PROGRAMS: "pump_fun",
    SOLANA_LOG_OBSERVATIONS_ENABLED: "true",
    SOLANA_WS_NO_LOG_TIMEOUT_MS: "45000",
  });
  const scanner = new Scanner(config, {
    store, rpc, socketFactory: () => socket,
  });
  const observation = {
    signature: "synthetic-storage-signature",
    slot: 123,
    programId,
    receivedAt: new Date().toISOString(),
    confirmationStatus: "confirmed",
    evidenceSource: "rpc:logsSubscribe",
  };
  return { scanner, store, socket, observation };
}

test("transient SQLite batch error stops ingestion, retains buffered data and resumes only after durable writes", async () => {
  const { scanner, store, socket, observation } = makeScanner();
  await scanner.start();
  const original = store.receiveBatch.bind(store);
  let attempts = 0;
  store.receiveBatch = items => {
    if (++attempts === 1) throw Object.assign(Error("mock transient failure"), {code:"SQLITE_BUSY"});
    return original(items);
  };
  try {
    scanner.buffer.push(observation);
    assert.throws(() => scanner.flush(), /transient failure/);
    assert.equal(scanner.storagePaused, true);
    assert.equal(scanner.buffer.length, 1);
    assert.equal(store.stats().inbox, 0);
    assert.equal(socket.stops, 1);
    assert.equal(scanner.health().status, "DEGRADED");
    assert.equal(scanner.health().metrics.gauges.websocket_storage_last_error_code, "SQLITE_BUSY");
    // The high-frequency flush loop must not spin against a broken database.
    scanner.flush();
    assert.equal(attempts, 1);
    scanner.storageRecoveryWatchdog();
    assert.equal(attempts, 1);
    scanner.storageRetryAt = 0; // simulate passage of bounded retry deadline
    scanner.storageRecoveryWatchdog();
    assert.equal(scanner.storagePaused, false);
    assert.equal(store.stats().inbox, 1);
    assert.equal(scanner.buffer.length, 0);
    assert.equal(socket.starts, 2);
    assert.equal(scanner.health().metrics.counters.websocket_storage_recoveries, 1);
    assert.equal(store.gaps().some(x => x.reason === "PERSISTENCE_PAUSE_RECOVERED"), true);
  } finally {
    await scanner.stop();
  }
});

test("decoded observation batch survives persistence error and is retried once", async () => {
  const { scanner, store, socket } = makeScanner();
  await scanner.start();
  const original = store.persistLogBatch.bind(store);
  let calls = 0;
  store.persistLogBatch = (items, opts) => {
    if (++calls === 1) throw Object.assign(Error("test write unavailable"), {code:"SQLITE_IOERR"});
    return original(items, opts);
  };
  try {
    scanner.observationBuffer.push({
      notification: {
        signature:"synthetic-log-signature",slot:124,logs:["Program log: synthetic"],
        receivedAt:new Date().toISOString(),confirmationStatus:"confirmed",
      },
      observations:[],
    });
    assert.throws(() => scanner.flush(), /write unavailable/);
    assert.equal(scanner.observationBuffer.length,1);
    assert.equal(socket.stopped,true);
    scanner.storageRetryAt=0;
    scanner.storageRecoveryWatchdog();
    assert.equal(calls,2);
    assert.equal(scanner.observationBuffer.length,0);
    assert.equal(socket.stopped,false);
  } finally {
    await scanner.stop();
  }
});

test("a failed SQLite write canary keeps ingestion paused, with bounded retry delay", async () => {
  const { scanner, store, socket } = makeScanner();
  await scanner.start();
  const original = store.recordMetrics.bind(store);
  store.recordMetrics = () => { throw Object.assign(Error("mock unavailable metric table"),{code:"SQLITE_IOERR"}); };
  try {
    scanner.pauseForStorageError(Error("simulated initial storage failure"));
    assert.equal(socket.stopped,true);
    scanner.storageRetryAt=0;
    scanner.storageRecoveryWatchdog();
    assert.equal(scanner.storagePaused,true);
    assert.equal(socket.starts,1);
    assert.equal(scanner.health().metrics.counters.websocket_storage_recovery_failures,1);
    assert.ok(scanner.storageRetryAt>Date.now());
    assert.ok(scanner.health().metrics.gauges.websocket_storage_retry_delay_ms<=60000);
    // The failure is not leaked as a raw message or a provider URL.
    assert.equal(scanner.health().metrics.gauges.websocket_storage_last_error_code,"SQLITE_IOERR");
    store.recordMetrics=original;
    scanner.storageRetryAt=0;
    scanner.storageRecoveryWatchdog();
    assert.equal(scanner.storagePaused,false);
    assert.equal(socket.starts,2);
  } finally {
    store.recordMetrics=original;
    await scanner.stop();
  }
});

test("watchdog revives an unexpectedly stopped socket but does not restart an intentional shutdown", async () => {
  const { scanner, socket } = makeScanner();
  await scanner.start();
  socket.stop();
  assert.equal(socket.starts,1);
  scanner.storageRecoveryWatchdog();
  scanner.storageRecoveryWatchdog();
  assert.equal(socket.starts,2);
  assert.equal(scanner.health().metrics.counters.websocket_unexpected_stops,1);
  await scanner.stop();
  scanner.storageRecoveryWatchdog();
  assert.equal(socket.starts,2);
});
