import test from "node:test";
import assert from "node:assert/strict";
import { RpcClient } from "../src/rpc.mjs";
import { Metrics } from "../src/metrics.mjs";

test("failed HTTP attempts remain attributed without inflating completed requests", async () => {
  const metrics = new Metrics();
  let calls = 0;
  const rpc = new RpcClient({
    metrics,
    requestsPerMinute: 60000,
    retries: 0,
    fetchImpl: async () => {
      calls++;
      return new Response("", { status: 503 });
    },
  });
  try {
    await assert.rejects(
      rpc.request("getTransaction", [], { priority: 2 }),
      (error) => error.code === "HTTP_503",
    );
    const counters = metrics.snapshot().counters;
    assert.equal(calls, 1);
    assert.equal(counters.rpc_requests, 1);
    assert.equal(counters.rpc_budget_enrichment_p2, 1);
    assert.equal(counters.rpc_errors, 1);
    assert.equal(counters.rpc_retries ?? 0, 0);
    assert.equal(counters.rpc_budget_waits ?? 0, 0);
    assert.equal(
      ["enrichment_p0", "enrichment_p1", "enrichment_p2", "enrichment_p3",
        "enrichment_unclassified", "recovery", "finality", "security", "other"]
        .reduce((total, name) => total + (counters[`rpc_budget_${name}`] ?? 0), 0),
      counters.rpc_requests,
    );
  } finally {
    await rpc.close();
  }
});
