// Deterministic pipeline replay of archived Mainnet transactions. These are not live latency measurements.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scanner } from "../src/scanner.mjs";
import { Store } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";
import { PROGRAMS } from "../src/protocols/index.mjs";
import { serve } from "../src/api.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)))
    .result;
function setup(tx, overrides = {}) {
  const calls = [];
  let socket;
  const rpc = {
    assertMainnet: async () => {},
    close: async () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "getTransaction") return tx;
      if (method === "getSignatureStatuses")
        return {
          value: params[0].map(() => ({
            err: null,
            confirmationStatus: "finalized",
          })),
        };
      throw Error(`UNEXPECTED_TEST_RPC_${method}`);
    },
  };
  const store = new Store(overrides.dbPath ?? ":memory:");
  const config = {
    ...loadConfig({ SOLANA_PROGRAMS: "pump_fun" }),
    ...overrides,
  };
  const scanner = new Scanner(config, {
    rpc,
    store,
    socketFactory: (options) => {
      socket = {
        options,
        starts: 0,
        stops: 0,
        reconnects: [],
        start() {
          this.starts++;
        },
        stop() {
          this.stops++;
        },
        reconnect(reason) {
          this.reconnects.push(reason);
        },
      };
      return socket;
    },
  });
  const signature = tx?.transaction.signatures[0] ?? "missing-test-signature";
  const observation = {
    signature,
    slot: tx?.slot ?? 1,
    programId: PROGRAMS.find((p) => p.protocol === "pump_fun").programId,
    receivedAt: new Date().toISOString(),
    confirmationStatus: config.commitment,
    evidenceSource: "rpc:logsSubscribe",
  };
  return { scanner, store, calls, observation, rpc, getSocket: () => socket };
}

test("scanner persists and decodes a real Pump buy fixture once despite duplicate notifications, then reconciles finality", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, calls, observation, getSocket } = setup(tx);
  await scanner.start();
  t.after(() => scanner.stop());
  assert.equal(getSocket().starts, 1);
  scanner.receive(observation);
  scanner.receive(observation);
  scanner.flush();
  scanner.pump();
  await scanner.queue.drain();
  assert.equal(store.stats().inbox, 1);
  assert.equal(store.stats().pending, 0);
  const events = store.events({ signature: observation.signature });
  assert.ok(events.some((event) => event.eventType === "TOKEN_BOUGHT"));
  assert.ok(
    events.every(
      (event) => event.transactionSignature === tx.transaction.signatures[0],
    ),
  );
  assert.ok(events.every((event) => event.confirmationStatus === "confirmed"));
  assert.ok(
    events
      .filter((event) => event.eventType === "TOKEN_BOUGHT")
      .every(
        (event) =>
          typeof event.amountTokenRaw === "string" &&
          /^\d+$/.test(event.amountTokenRaw),
      ),
  );
  assert.equal(
    calls.filter((call) => call.method === "getTransaction").length,
    1,
  );
  assert.equal(calls[0].params[1].maxSupportedTransactionVersion, 1);
  await scanner.reconcile();
  assert.ok(
    store.events().every((event) => event.confirmationStatus === "finalized"),
  );
  assert.equal(
    scanner.health().metrics.counters.events_processed,
    events.length,
  );
});

test("scanner creation replay registers token by mint and preserves the creator evidence", async (t) => {
  const tx = fixture("raydium-launchlab-create-mainnet.json");
  const { scanner, store, observation } = setup(tx, {
    programs: ["raydium_launchlab"],
  });
  await scanner.start();
  t.after(() => scanner.stop());
  observation.programId = PROGRAMS.find(
    (p) => p.protocol === "raydium_launchlab",
  ).programId;
  scanner.receive(observation);
  scanner.flush();
  scanner.pump();
  await scanner.queue.drain();
  const created = store
    .events()
    .find((event) => event.eventType === "TOKEN_CREATED");
  assert.ok(created);
  assert.ok(created.tokenMint);
  assert.ok(created.creator);
  assert.equal(store.tokens()[0].mint, created.tokenMint);
  assert.equal(store.tokens()[0].creator, created.creator);
});

test("unavailable enrichment remains retryable and produces no fabricated event", async (t) => {
  const { scanner, store, observation } = setup(null);
  await scanner.start();
  t.after(() => scanner.stop());
  store.receiveBatch([observation]);
  assert.equal(await scanner.processObservation(observation), false);
  assert.equal(store.stats().events, 0);
  assert.equal(store.stats().pending, 1);
  const row = store.db
    .prepare("SELECT attempts,status FROM inbox WHERE signature=?")
    .get(observation.signature);
  assert.equal(row.attempts, 1);
  assert.equal(row.status, "PENDING");
});

test("enrichment identity mismatch is rejected without admitting another transaction", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, observation } = setup(tx);
  await scanner.start();
  t.after(() => scanner.stop());
  observation.signature = "different-notification-signature";
  store.receiveBatch([observation]);
  assert.equal(await scanner.processObservation(observation), false);
  assert.equal(store.stats().events, 0);
  assert.equal(store.stats().raw_transactions, 0);
  assert.ok(store.stats().errors >= 1);
});

test("failed on-chain observation is retained as failed without unnecessary enrichment", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, observation, calls } = setup(tx);
  await scanner.start();
  t.after(() => scanner.stop());
  observation.onchainError = { InstructionError: [0, "Custom"] };
  store.receiveBatch([observation]);
  assert.equal(await scanner.processObservation(observation), true);
  assert.equal(store.stats().events, 0);
  assert.equal(calls.length, 0);
  assert.equal(store.isDone(observation.signature), true);
});

test("read API serves actual persisted replay data and refuses mutation", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, observation } = setup(tx);
  await scanner.start();
  store.receiveBatch([observation]);
  await scanner.processObservation(observation);
  const server = await serve(scanner, { host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await scanner.stop();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const events = await (
    await fetch(`${url}/events?signature=${observation.signature}`)
  ).json();
  assert.ok(events.data.some((event) => event.eventType === "TOKEN_BOUGHT"));
  assert.equal(events.coverage, "PARTIAL");
  assert.equal(
    (await fetch(`${url}/events`, { method: "POST", body: "{}" })).status,
    405,
  );
  assert.equal((await (await fetch(`${url}/health`)).json()).mode, "READ_ONLY");
  assert.equal((await fetch(`${url}/missing`)).status, 404);
});

test("processed failure is reconciled against successful confirmed transaction instead of becoming a definitive failure", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, observation, calls } = setup(tx, {
    commitment: "processed",
  });
  await scanner.start();
  t.after(() => scanner.stop());
  observation.onchainError = { InstructionError: [0, "TemporaryForkFailure"] };
  store.receiveBatch([observation]);
  assert.equal(await scanner.processObservation(observation), true);
  assert.equal(
    calls.filter((call) => call.method === "getTransaction").length,
    1,
  );
  assert.ok(store.events().some((event) => event.eventType === "TOKEN_BOUGHT"));
  assert.ok(
    store.events().every((event) => event.confirmationStatus === "confirmed"),
  );
  assert.equal(
    store.db
      .prepare("SELECT status FROM inbox WHERE signature=?")
      .get(observation.signature).status,
    "DONE",
  );
});

test("shutdown closes RPC before draining blocked work and preserves flushed and pending inbox across restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "solana-scanner-stop-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "scanner.sqlite");
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, rpc, observation } = setup(tx, { dbPath });
  let rejectFetch, startedFetch;
  const started = new Promise((resolve) => {
    startedFetch = resolve;
  });
  const actions = [];
  rpc.request = async (method) => {
    assert.equal(method, "getTransaction");
    actions.push("fetch");
    startedFetch();
    return new Promise((_resolve, reject) => {
      rejectFetch = reject;
    });
  };
  rpc.close = async () => {
    actions.push("rpc-close");
    rejectFetch(Object.assign(Error("CLOSED"), { code: "CLOSED" }));
  };
  await scanner.start();
  scanner.receive(observation);
  scanner.flush();
  scanner.pump();
  await started;
  const buffered = {
    ...observation,
    signature: "buffered-during-shutdown",
    slot: observation.slot + 1,
  };
  scanner.receive(buffered);
  await scanner.stop();
  assert.deepEqual(actions, ["fetch", "rpc-close"]);
  const resumed = setup(tx, { dbPath });
  const rows = resumed.store.pending(10, Date.now() + 60000);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.signature === buffered.signature));
  assert.equal(
    rows.find((row) => row.signature === observation.signature).attempts,
    1,
  );
  resumed.store.db
    .prepare("UPDATE inbox SET next_at=0 WHERE signature=?")
    .run(observation.signature);
  assert.equal(
    await resumed.scanner.processObservation(
      rows.find((row) => row.signature === observation.signature),
    ),
    true,
  );
  assert.ok(
    resumed.store.events().some((event) => event.eventType === "TOKEN_BOUGHT"),
  );
  assert.equal(resumed.store.stats().pending, 1);
  await resumed.scanner.stop();
});

test("disconnect persists the actual reason and configured WebSocket timeouts reach connection manager", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, getSocket } = setup(tx, {
    reconnectMaxMs: 12345,
    idleTimeoutMs: 45678,
  });
  await scanner.start();
  t.after(() => scanner.stop());
  const socket = getSocket();
  assert.equal(socket.options.reconnectMaxMs, 12345);
  assert.equal(socket.options.idleTimeoutMs, 45678);
  socket.options.onDisconnect({
    reason: "HEARTBEAT_TIMEOUT",
    receivedAt: new Date().toISOString(),
  });
  assert.equal(store.gaps()[0].code, "WEBSOCKET_DISCONNECTED");
  assert.equal(store.gaps()[0].payload.reason, "HEARTBEAT_TIMEOUT");
  assert.equal(scanner.recoveryPending, true);
});

test("durable overload stops capture, retains work, emits one gap and resumes only after drain", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, observation, getSocket } = setup(tx, {
    logObservationsEnabled: false,
    maxDurableBacklog: 1,
    queueCapacity: 1,
    processingConcurrency: 1,
  });
  await scanner.start();
  t.after(() => scanner.stop());
  store.receiveBatch(
    Array.from({ length: 3 }, (_unused, index) => ({
      ...observation,
      signature: `failed-fixture-${index}`,
      onchainError: { InstructionError: [0, "FixtureFailure"] },
    })),
  );
  scanner.pump();
  assert.equal(getSocket().stops, 1);
  assert.equal(store.stats().inbox, 3);
  assert.equal(scanner.metrics.snapshot().gauges.coverageOverloaded, true);
  for (let index = 0; index < 4; index++) {
    await scanner.queue.drain();
    scanner.pump();
  }
  assert.equal(store.stats().pending, 0);
  assert.equal(
    store.gaps().filter((gap) => gap.code === "DURABLE_BACKPRESSURE").length,
    1,
  );
  assert.equal(getSocket().starts, 2);
  assert.equal(scanner.recoveryPending, true);
  assert.equal(scanner.metrics.snapshot().gauges.coverageOverloaded, false);
});

test("historical recovery latency stays separate from live notification latency", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, observation } = setup(tx);
  await scanner.start();
  t.after(() => scanner.stop());
  observation.evidenceSource = "rpc:getSignaturesForAddress";
  store.receiveBatch([observation]);
  assert.equal(await scanner.processObservation(observation), true);
  const histograms = scanner.metrics.snapshot().histograms;
  assert.equal(histograms.recoveryProcessingLatencyMs.count, 1);
  assert.equal(histograms.eventProcessingLatencyMs, undefined);
  assert.equal(histograms.onchainToReceiveLatencyMs, undefined);
});

test("checkpoint advancement and continuation removal commit atomically or both roll back", () => {
  const store = new Store(":memory:");
  const programId = PROGRAMS[0].programId;
  try {
    store.advanceCheckpoint(programId, {
      signature: "previous-anchor",
      slot: 1,
    });
    store.saveRecoveryState(programId, {
      before: "older-page",
      head: { signature: "new-anchor", slot: 3 },
      targetSignature: "previous-anchor",
    });
    store.db.exec(
      "CREATE TRIGGER fail_recovery_clear BEFORE DELETE ON recovery_state BEGIN SELECT RAISE(ABORT,'fixture interruption'); END;",
    );
    assert.throws(
      () =>
        store.advanceCheckpoint(programId, {
          signature: "new-anchor",
          slot: 3,
        }),
      /fixture interruption/,
    );
    assert.equal(store.checkpoint(programId).signature, "previous-anchor");
    assert.equal(store.recoveryState(programId).before, "older-page");
    store.db.exec("DROP TRIGGER fail_recovery_clear");
    store.advanceCheckpoint(programId, { signature: "new-anchor", slot: 3 });
    assert.equal(store.checkpoint(programId).signature, "new-anchor");
    assert.equal(store.recoveryState(programId), null);
  } finally {
    store.close();
  }
});

test("log observation fast path remains connected at context capacity, persists idempotently and stays outside market events", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, observation, getSocket, calls } = setup(tx, {
    logObservationsEnabled: true,
    maxDurableBacklog: 1,
    queueCapacity: 1,
    processingConcurrency: 1,
  });
  await scanner.start();
  t.after(() => scanner.stop());
  store.receiveBatch([
    {
      ...observation,
      signature: "existing-context-backlog",
      onchainError: { InstructionError: [0, "FixtureFailure"] },
    },
  ]);
  scanner.pump();
  assert.equal(scanner.contextBacklog, 1);
  assert.equal(getSocket().stops, 0);
  const notification = {
    ...observation,
    logs: tx.meta.logMessages,
    err: tx.meta.err,
  };
  scanner.receive(notification);
  scanner.receive(notification);
  scanner.flush();
  await scanner.queue.drain();
  const observations = store.observations({ signature: observation.signature });
  assert.equal(observations.length, 2);
  assert.equal(new Set(observations.map((item) => item.id)).size, 2);
  assert.ok(observations.some((item) => item.eventType === "TOKEN_BOUGHT"));
  assert.ok(
    observations.every(
      (item) =>
        item.completeness === "INCOMPLETE" &&
        item.contextCompleteness === "INCOMPLETE",
    ),
  );
  assert.ok(
    observations.every(
      (item) =>
        item.instructionIndex === null &&
        item.contextEnrichmentAvailable === false,
    ),
  );
  assert.ok(
    observations.every(
      (item) => item.evidenceSource.kind === "rpc:logsSubscribe",
    ),
  );
  assert.ok(observations.every((item) => item.quoteMint === null));
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM selected_log_messages").get().n,
    1,
  );
  assert.equal(store.stats().event_observations, 2);
  assert.equal(store.stats().inbox, 1);
  assert.equal(store.stats().events, 0);
  assert.equal(store.stats().tokens, 0);
  assert.equal(store.stats().pools, 0);
  assert.deepEqual(scanner.market().groups, []);
  assert.equal(scanner.metrics.snapshot().counters.contextEnrichmentSkipped, 2);
  assert.equal(scanner.metrics.snapshot().counters.contextSkippedDurableBacklog, 2);
  assert.equal(scanner.metrics.snapshot().counters.contextSkippedIngressBuffer ?? 0, 0);
  assert.equal(scanner.metrics.snapshot().counters.logObservationsPersisted, 2);
  assert.equal(calls.length, 0);
  assert.equal(getSocket().stops, 0);
});

test("context admission attributes ingress pressure separately from durable backlog", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, observation, calls } = setup(tx, {
    logObservationsEnabled: true,
    maxDurableBacklog: 1,
  });
  await scanner.start();
  t.after(() => scanner.stop());
  scanner.contextBacklog = 0;
  scanner.buffer.push({ ...observation, signature: "already-buffered" });
  scanner.receive({
    ...observation,
    logs: tx.meta.logMessages,
    err: tx.meta.err,
  });
  scanner.flush();
  assert.equal(scanner.metrics.snapshot().counters.contextEnrichmentSkipped, 1);
  assert.equal(scanner.metrics.snapshot().counters.contextSkippedIngressBuffer, 1);
  assert.equal(scanner.metrics.snapshot().counters.contextSkippedDurableBacklog ?? 0, 0);
  assert.equal(calls.length, 0);
});

test("observations API exposes incomplete context explicitly and cannot inflate canonical market data", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, observation } = setup(tx, {
    logObservationsEnabled: true,
    maxDurableBacklog: 1,
  });
  await scanner.start();
  scanner.contextBacklog = 1;
  const notification = {
    ...observation,
    logs: tx.meta.logMessages,
    err: tx.meta.err,
  };
  scanner.receive(notification);
  scanner.receive(notification);
  scanner.flush();
  const server = await serve(scanner, { host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await scanner.stop();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = await (
    await fetch(`${url}/observations?signature=${observation.signature}`)
  ).json();
  assert.equal(result.context, "RPC_LOGS_WITH_INCOMPLETE_TRANSACTION_CONTEXT");
  assert.equal(result.mergedWithMarket, false);
  assert.equal(result.coverage, "PARTIAL");
  assert.equal(result.data.length, 2);
  const mint = result.data[0].tokenMint;
  const filtered = await (
    await fetch(`${url}/observations?mint=${mint}&limit=1`)
  ).json();
  assert.equal(filtered.data.length, 1);
  assert.equal(filtered.data[0].tokenMint, mint);
  assert.deepEqual((await (await fetch(`${url}/events`)).json()).data, []);
  assert.deepEqual((await (await fetch(`${url}/market`)).json()).groups, []);
  assert.equal(store.stats().event_observations, 2);
  assert.equal(
    (await fetch(`${url}/observations`, { method: "DELETE" })).status,
    405,
  );
});

test("finalized observations request finalized enrichment before publishing finalized events", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, observation, calls } = setup(tx, {
    commitment: "finalized",
  });
  await scanner.start();
  t.after(() => scanner.stop());
  store.receiveBatch([observation]);
  assert.equal(await scanner.processObservation(observation), true);
  assert.equal(calls[0].method, "getTransaction");
  assert.equal(calls[0].params[1].commitment, "finalized");
  assert.ok(store.events().length > 0);
  assert.ok(
    store.events().every((event) => event.confirmationStatus === "finalized"),
  );
});

test("processed observation confirmed in another slot preserves canonical slot and records the fork change", async (t) => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  const { scanner, store, observation, calls } = setup(tx, {
    commitment: "processed",
  });
  await scanner.start();
  t.after(() => scanner.stop());
  observation.slot = tx.slot - 1;
  store.receiveBatch([observation]);
  assert.equal(await scanner.processObservation(observation), true);
  assert.equal(calls[0].params[1].commitment, "confirmed");
  assert.ok(store.events().length > 0);
  assert.ok(
    store
      .events()
      .every(
        (event) =>
          event.slot === tx.slot && event.confirmationStatus === "confirmed",
      ),
  );
  assert.equal(store.transaction(observation.signature).slot, tx.slot);
  const gap = store
    .gaps()
    .find((item) => item.code === "EARLY_OBSERVATION_SLOT_CHANGED");
  assert.ok(gap);
  assert.equal(gap.payload.observedSlot, tx.slot - 1);
  assert.equal(gap.payload.confirmedSlot, tx.slot);
});
