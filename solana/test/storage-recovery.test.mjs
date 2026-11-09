// Simulated failures: never connect to Mainnet and never create paid requests.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { LogSocket } from "../src/websocket.mjs";
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
    assert.equal(store.gaps().some(x => x.code === "PERSISTENCE_PAUSE_RECOVERED"), true);
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

class LocalWebSocket extends WebSocket {}
async function waitFor(predicate, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw Error("LOCAL_WS_WAIT_TIMEOUT");
    await pause(10);
  }
}
test("real local WebSocket resumes after transient SQLite write failure and receives a new notification", async (t) => {
  const server = new WebSocketServer({host:"127.0.0.1",port:0});
  await once(server,"listening");
  const connections = [];
  server.on("connection",client => {
    connections.push(client);
    client.on("message",bytes => {
      const request = JSON.parse(bytes.toString());
      client.send(JSON.stringify({jsonrpc:"2.0",id:request.id,result:200}));
    });
  });
  const store = new Store(":memory:");
  const wsUrl = "ws://127.0.0.1:" + server.address().port;
  const config = loadConfig({
    SOLANA_PROGRAMS:"pump_fun",
    SOLANA_LOG_OBSERVATIONS_ENABLED:"true",
    SOLANA_WS_NO_LOG_TIMEOUT_MS:"0",
    SOLANA_CONTEXT_PRIORITIES_ENABLED:"true",
    SOLANA_CONTEXT_MAX_PRIORITY:"0",
  });
  const scanner = new Scanner(config,{
    store,
    rpc:{
      async assertMainnet(){},
      async close(){},
      async request(){throw Error("UNEXPECTED_REMOTE_RPC");},
    },
    socketFactory: opts => new LogSocket({
      ...opts,url:wsUrl,WebSocketImpl:LocalWebSocket,
      reconnectBaseMs:20,reconnectMaxMs:100,
      heartbeatMs:100,idleTimeoutMs:2000,
    }),
  });
  t.after(async () => {
    await scanner.stop();
    for(const c of connections) c.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  await scanner.start();
  await waitFor(() => scanner.metrics.snapshot().gauges.websocket_connected === true);
  const original = store.receiveBatch.bind(store);
  let calls = 0;
  store.receiveBatch = items => {
    if (++calls === 1) throw Object.assign(Error("simulate transient SQLite lock"),{code:"SQLITE_BUSY"});
    return original(items);
  };
  scanner.buffer.push({
    signature:"local-integration-sig",slot:100,
    programId,receivedAt:new Date().toISOString(),
    confirmationStatus:"confirmed",evidenceSource:"rpc:logsSubscribe",
  });
  assert.throws(() => scanner.flush(),/simulate transient SQLite lock/);
  assert.equal(scanner.storagePaused,true);
  assert.equal(scanner.metrics.snapshot().gauges.websocket_connected,false);
  scanner.storageRetryAt=0;
  scanner.storageRecoveryWatchdog();
  await waitFor(() => connections.length >= 2 &&
    scanner.metrics.snapshot().gauges.websocket_connected === true);
  connections.at(-1).send(JSON.stringify({
    jsonrpc:"2.0",method:"logsNotification",
    params:{
      subscription:200,
      result:{context:{slot:101},value:{signature:"local-recovery-event",err:null,logs:[]}},
    },
  }));
  await waitFor(() => scanner.metrics.snapshot().counters.log_notifications >= 1);
  assert.equal(store.stats().inbox >= 1,true);
  assert.equal(scanner.storagePaused,false);
  assert.equal(scanner.metrics.snapshot().counters.websocket_storage_recoveries,1);
});
