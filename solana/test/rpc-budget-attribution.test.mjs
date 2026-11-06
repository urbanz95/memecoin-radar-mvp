import test from "node:test";
import assert from "node:assert/strict";
import { RpcClient } from "../src/rpc.mjs";
import { Metrics } from "../src/metrics.mjs";

const reply = (id) => new Response(JSON.stringify({
  jsonrpc: "2.0", id, result: null,
}), { headers: { "content-type": "application/json" } });

test("RPC budget attribution counts retries and every fixed-purpose bucket", async () => {
  const metrics = new Metrics();
  let calls = 0;
  let now = 0;
  const rpc = new RpcClient({
    metrics,
    requestsPerMinute: 60000,
    retries: 1,
    random: () => 0,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    fetchImpl: async (_url, init) => {
      const id = JSON.parse(init.body).id;
      if (++calls === 1) return new Response("", { status: 503 });
      return reply(id);
    },
  });
  try {
    await rpc.request("getTransaction", [], { priority: 0 }); // retry included
    await rpc.request("getTransaction", [], { priority: 3 });
    await rpc.request("getTransaction", [], { priority: 42 }); // unknown, not P0
    await rpc.request("getSignaturesForAddress");
    await rpc.request("getSignatureStatuses");
    await rpc.request("getAccountInfo");
    await rpc.request("getTokenLargestAccounts");
    await rpc.request("getSlot");
    const counters = metrics.snapshot().counters;
    assert.equal(counters.rpc_requests, 9);
    assert.equal(counters.rpc_budget_enrichment_p0, 2);
    assert.equal(counters.rpc_budget_enrichment_p3, 1);
    assert.equal(counters.rpc_budget_enrichment_unclassified, 1);
    assert.equal(counters.rpc_budget_recovery, 1);
    assert.equal(counters.rpc_budget_finality, 1);
    assert.equal(counters.rpc_budget_security, 2);
    assert.equal(counters.rpc_budget_other, 1);
    // rpc_budget_waits measures throttle pressure, not HTTP attempts.
    // Count only the fixed per-attempt attribution buckets.
    const bucketNames = [
      "enrichment_p0", "enrichment_p1", "enrichment_p2", "enrichment_p3",
      "enrichment_unclassified", "recovery", "finality", "security", "other",
    ];
    const attributedAttempts = bucketNames.reduce(
      (total, bucket) => total + (counters[`rpc_budget_${bucket}`] ?? 0),
      0,
    );
    assert.ok(counters.rpc_budget_waits > 0);
    assert.equal(attributedAttempts, counters.rpc_requests);
  } finally {
    await rpc.close();
  }
});

test("RPC read-only guard rejects unsupported methods before counting", async () => {
  const metrics = new Metrics();
  const rpc = new RpcClient({ metrics, fetchImpl: async () => reply(1) });
  try {
    await assert.rejects(rpc.request("sendTransaction"), /READ_ONLY/);
    assert.equal(metrics.snapshot().counters.rpc_requests ?? 0, 0);
  } finally {
    await rpc.close();
  }
});
