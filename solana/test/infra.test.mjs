import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { Metrics } from "../src/metrics.mjs";
import { BoundedQueue } from "../src/queue.mjs";
import { RpcClient, parseRpcJson, MAINNET_GENESIS_HASH } from "../src/rpc.mjs";
import { LogSocket } from "../src/websocket.mjs";
import { loadConfig } from "../src/config.mjs";

test("metrics uses bounded recent samples and distinguishes empty measurements", () => {
  let now = 0;
  const metrics = new Metrics({ reservoirSize: 3, now: () => now });
  assert.deepEqual(metrics.snapshot().histograms, {});
  for (const n of [1, 2, 3, 100]) metrics.observe("latency", n);
  metrics.inc("rpc_requests", 2);
  metrics.inc("events_processed", 3);
  assert.equal(metrics.snapshot().histograms.latency.retainedSamples, 3);
  assert.equal(metrics.snapshot().histograms.latency.p95, 100);
  assert.equal(metrics.snapshot().histograms.latency.count, 4);
  assert.equal(metrics.snapshot().rpcRequestsPerMinute, 2);
  now = 60001;
  assert.equal(metrics.snapshot().rpcRequestsPerMinute, 0);
  assert.equal(metrics.snapshot().eventsPerSecond, 0);
});

test("queue rejects backpressure, contains task failure and drains accepted tasks", async () => {
  let release;
  let completed = 0;
  const errors = [];
  const metrics = new Metrics();
  const queue = new BoundedQueue({
    capacity: 2,
    concurrency: 1,
    metrics,
    onError: (error) => errors.push(error.message),
  });
  assert.equal(
    queue.submit(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
    true,
  );
  assert.equal(
    queue.submit(() => {
      completed++;
      throw Error("task failed");
    }),
    true,
  );
  assert.equal(
    queue.submit(() => {
      completed++;
    }),
    false,
  );
  await delay(0);
  assert.equal(queue.depth, 2);
  release();
  await queue.drain();
  assert.equal(completed, 1);
  assert.deepEqual(errors, ["task failed"]);
  assert.equal(queue.depth, 0);
  await queue.stop();
  assert.equal(
    queue.submit(() => {}),
    false,
  );
  assert.equal(metrics.snapshot().counters.queue_overflows, 2);
});

test("RPC parser preserves u64 precision and leaves text and normal numbers unchanged", () => {
  const value = parseRpcJson(
    '{"amount":18446744073709551615,"slot":400000000,"quoted":"18446744073709551615 \\\"", "n":-9007199254740993,"small":1.25}',
  );
  assert.equal(value.amount, "18446744073709551615");
  assert.equal(value.slot, 400000000);
  assert.equal(value.n, "-9007199254740993");
  assert.equal(value.small, 1.25);
  assert.equal(value.quoted, '18446744073709551615 "');
});

const response = (id, result) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json" },
  });

test("RPC method allowlist prevents transaction submission and rejects non-mainnet", async () => {
  const client = new RpcClient({
    retries: 0,
    fetchImpl: async (_url, init) =>
      response(JSON.parse(init.body).id, "devnet-genesis"),
  });
  await assert.rejects(client.request("sendTransaction", ["bad"]), /READ_ONLY/);
  await assert.rejects(client.assertMainnet(), /MAINNET_REQUIRED/);
  await client.close();
});

test("RPC verifies Mainnet and handles 429 Retry-After with bounded retry", async () => {
  let calls = 0,
    now = 0;
  const waits = [];
  const metrics = new Metrics();
  const client = new RpcClient({
    metrics,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      await delay(0);
      now += ms;
    },
    random: () => 0,
    fetchImpl: async (_url, init) => {
      if (++calls === 1)
        return new Response("", {
          status: 429,
          headers: { "retry-after": "2" },
        });
      return response(JSON.parse(init.body).id, MAINNET_GENESIS_HASH);
    },
  });
  assert.equal(await client.assertMainnet(), MAINNET_GENESIS_HASH);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(metrics.snapshot().counters.rate_limit_errors, 1);
  await client.close();
});

test("RPC spaces concurrent requests across the global budget without bursting", async () => {
  let now = 0;
  const starts = [];
  const waits = [];
  const client = new RpcClient({
    requestsPerMinute: 2,
    maxConcurrency: 3,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      await delay(0);
      now += ms;
    },
    fetchImpl: async (_url, init) => {
      starts.push(now);
      return response(JSON.parse(init.body).id, 1);
    },
  });
  assert.deepEqual(
    await Promise.all([
      client.request("getSlot"),
      client.request("getSlot"),
      client.request("getSlot"),
    ]),
    [1, 1, 1],
  );
  assert.deepEqual(starts, [0, 30000, 60000]);
  assert.deepEqual(waits, [30000, 30000]);
  await client.close();
});

test("429 Retry-After remains a global cooldown after retry exhaustion", async () => {
  let now = 0,
    calls = 0;
  const starts = [];
  const client = new RpcClient({
    retries: 0,
    maxConcurrency: 1,
    now: () => now,
    sleep: async (ms) => {
      await delay(0);
      now += ms;
    },
    fetchImpl: async (_url, init) => {
      starts.push(now);
      if (++calls === 1)
        return new Response("", {
          status: 429,
          headers: { "retry-after": "2" },
        });
      return response(JSON.parse(init.body).id, 3);
    },
  });
  await assert.rejects(client.request("getSlot"), /HTTP_429/);
  assert.equal(await client.request("getSlot"), 3);
  assert.deepEqual(starts, [0, 2000]);
  await client.close();
});

test("closing RPC cancels rate-limit waits promptly", async () => {
  const client = new RpcClient({
    requestsPerMinute: 1,
    fetchImpl: async (_url, init) => response(JSON.parse(init.body).id, 1),
  });
  await client.request("getSlot");
  const pending = client.request("getSlot");
  // Attach rejection before closing so cancellation cannot become an unhandled rejection.
  const rejected = assert.rejects(pending);
  await delay(5);
  await client.close();
  await rejected;
});

test("RPC bounds payload, rejects malformed envelopes and propagates unavailable history", async () => {
  for (const [body, expected, maxResponseBytes] of [
    ["x".repeat(100), /RESPONSE_LIMIT/, 10],
    ['{"jsonrpc":"2.0","id":88,"result":1}', /INVALID_ENVELOPE/, 1000],
    ['{"jsonrpc":"2.0","id":1,"error":{"code":-32009}}', /-32009/, 1000],
  ]) {
    const client = new RpcClient({
      retries: 0,
      maxResponseBytes,
      fetchImpl: async () => new Response(body),
    });
    await assert.rejects(
      client.request("getTransaction", ["signature"]),
      expected,
    );
    await client.close();
  }
});

test("RPC concurrency remains bounded under concurrent enrichment", async () => {
  let active = 0;
  let maxActive = 0;
  const client = new RpcClient({
    requestsPerMinute: 60000,
    maxConcurrency: 2,
    fetchImpl: async (_url, init) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(2);
      active--;
      return response(JSON.parse(init.body).id, 1);
    },
  });
  await Promise.all(
    Array.from({ length: 12 }, () => client.request("getSlot")),
  );
  assert.equal(maxActive, 2);
  await client.close();
});

class LocalWebSocket extends WebSocket {}
const programs = [
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
];
async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("test timed out");
    await delay(5);
  }
}

test("WebSocket separates mentions subscriptions, decodes notification and resubscribes after disconnect", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const messages = [];
  const clients = [];
  const received = [];
  const disconnects = [];
  let connects = 0;
  server.on("connection", (socket) => {
    clients.push(socket);
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString());
      messages.push(request);
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: request.id + 100,
        }),
      );
      if (request.params[0].mentions[0] === programs[0])
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              subscription: request.id + 100,
              result: {
                context: { slot: 42 },
                value: {
                  signature: "realistic-test-only-signature",
                  err: null,
                  logs: ["Program data: fixture"],
                },
              },
            },
          }),
        );
    });
  });
  const metrics = new Metrics();
  const socket = new LogSocket({
    url: `ws://127.0.0.1:${server.address().port}`,
    programs,
    WebSocketImpl: LocalWebSocket,
    metrics,
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    heartbeatMs: 1000,
    idleTimeoutMs: 10000,
    onLog: (value) => received.push(value),
    onConnect: () => connects++,
    onDisconnect: (value) => disconnects.push(value),
  });
  t.after(async () => {
    socket.stop();
    clients.forEach((client) => client.terminate());
    await new Promise((resolve) => server.close(resolve));
  });
  socket.start();
  await waitFor(() => connects === 1 && received.length === 1);
  assert.equal(messages.length, 2);
  assert.ok(
    messages.every((message) => message.params[0].mentions.length === 1),
  );
  assert.equal(received[0].programId, programs[0]);
  assert.equal(received[0].slot, 42);
  assert.equal(received[0].confirmationStatus, "confirmed");
  clients[0].terminate();
  await waitFor(() => connects === 2 && received.length === 2);
  assert.equal(messages.length, 4);
  assert.ok(disconnects.length >= 1);
  assert.ok(metrics.snapshot().counters.reconnect_count >= 1);
});

test("WebSocket forces reconnect when consumer rejects work, without silently dropping coverage", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const clients = [];
  server.on("connection", (client) => {
    clients.push(client);
    client.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString());
      client.send(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 8 }),
      );
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 8,
            result: {
              context: { slot: 1 },
              value: { signature: "fixture", err: null, logs: [] },
            },
          },
        }),
      );
    });
  });
  let reason;
  const socket = new LogSocket({
    url: `ws://127.0.0.1:${server.address().port}`,
    programs: [programs[0]],
    WebSocketImpl: LocalWebSocket,
    reconnectBaseMs: 1000,
    onLog: () => false,
    onDisconnect: (value) => {
      reason = value.reason;
    },
  });
  t.after(async () => {
    socket.stop();
    clients.forEach((client) => client.terminate());
    await new Promise((resolve) => server.close(resolve));
  });
  socket.start();
  await waitFor(() => reason === "BACKPRESSURE");
  assert.equal(socket.ready, false);
});

test("WebSocket detects missing subscription acknowledgements", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const clients = [];
  server.on("connection", (client) => clients.push(client));
  let reason;
  const socket = new LogSocket({
    url: `ws://127.0.0.1:${server.address().port}`,
    programs: [programs[0]],
    WebSocketImpl: LocalWebSocket,
    ackTimeoutMs: 30,
    reconnectBaseMs: 1000,
    onDisconnect: (value) => {
      reason = value.reason;
    },
  });
  t.after(async () => {
    socket.stop();
    clients.forEach((client) => client.terminate());
    await new Promise((resolve) => server.close(resolve));
  });
  socket.start();
  await waitFor(() => reason === "SUBSCRIPTION_TIMEOUT");
});

test("configuration rejects invalid or financial network settings and bounds resources", () => {
  assert.equal(loadConfig({}).commitment, "confirmed");
  assert.equal(loadConfig({}).rpcConcurrency, 2);
  assert.throws(
    () => loadConfig({ SOLANA_RPC_HTTP_URL: "file:///tmp/key" }),
    /INVALID/,
  );
  assert.throws(
    () => loadConfig({ SOLANA_COMMITMENT: "optimistic" }),
    /INVALID/,
  );
  assert.throws(() => loadConfig({ SOLANA_QUEUE_CAPACITY: "0" }), /INVALID/);
});
