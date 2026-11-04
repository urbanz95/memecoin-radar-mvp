// Deterministic API/persistence tests. Network is loopback only; market rows are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { serve } from "../src/api.mjs";
import { Scanner } from "../src/scanner.mjs";
import { Store } from "../src/store.mjs";

const mint = "So11111111111111111111111111111111111111112";
const programId = "6EF8rrecthR5Dkzon4z3qrrMMxGowpM6CRVH94zeKKV3";
const at = new Date().toISOString();
function observation(signature = "synthetic-api-signature") {
  return {
    signature,
    slot: 100,
    receivedAt: at,
    confirmationStatus: "confirmed",
  };
}
function normalizedEvent(extra = {}) {
  return {
    protocol: "synthetic-api-test",
    programId,
    eventType: "TOKEN_CREATED",
    tokenMint: mint,
    quoteMint: mint,
    poolAddress: "synthetic-pool",
    wallet: "synthetic-wallet",
    creator: "synthetic-creator",
    slot: 100,
    instructionIndex: 0,
    eventTimestamp: at,
    evidenceSource: "deterministic-test-only",
    evidenceStatus: "VERIFIED_PROTOCOL_EVENT",
    ...extra,
  };
}
function persist(store, extra = {}, signature) {
  const obs = observation(signature);
  store.receiveBatch([obs]);
  store.persistTransaction(obs, { slot: 100, meta: { err: null } }, [
    normalizedEvent(extra),
  ]);
  return obs.signature;
}
async function api(t) {
  const store = new Store(":memory:");
  const scanner = new Scanner(
    { dbPath: ":memory:", programs: ["pump_fun"], securityEnabled: false },
    {
      store,
      rpc: {
        close: async () => {},
        assertMainnet: async () => {},
        request: async () => {
          throw Error("NO_EXTERNAL_RPC_IN_API_TEST");
        },
      },
    },
  );
  const server = await serve(scanner, { host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await scanner.stop();
  });
  const read = async (path) => {
    const response = await fetch(origin + path);
    return { response, body: await response.json() };
  };
  return { store, scanner, origin, read };
}

test("health reports partial/degraded state and no invented latency before observations", async (t) => {
  const { read } = await api(t);
  const { response, body } = await read("/health");
  assert.equal(response.status, 200);
  assert.equal(body.chain, "solana");
  assert.equal(body.mode, "READ_ONLY");
  assert.equal(body.coverage, "PARTIAL");
  assert.equal(body.status, "DEGRADED");
  assert.equal(body.startedAt, null);
  assert.equal(body.storage.events, 0);
  assert.equal(body.metrics.histograms.eventProcessingLatencyMs, undefined);
  assert.equal(body.metrics.gauges.mainnetVerified, undefined);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
test("all mutation verbs are refused without mutating persisted state", async (t) => {
  const { store, origin } = await api(t);
  persist(store);
  const before = store.stats();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(origin + "/events", {
      method,
      body: '{"scoring":"override"}',
    });
    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { error: "READ_ONLY" });
  }
  assert.deepEqual(store.stats(), before);
});
test("event filters use exact mint/wallet/signature and bounded limits", async (t) => {
  const { store, read } = await api(t);
  const signature = persist(store);
  persist(
    store,
    {
      instructionIndex: 1,
      tokenMint: "different-mint",
      wallet: "other-wallet",
    },
    "synthetic-api-signature-2",
  );
  const match = await read(
    "/events?mint=" + mint + "&wallet=synthetic-wallet&signature=" + signature,
  );
  assert.equal(match.body.coverage, "PARTIAL");
  assert.equal(match.body.data.length, 1);
  assert.equal(match.body.data[0].tokenMint, mint);
  assert.equal(
    (await read("/events?mint=" + mint.toLowerCase())).body.data.length,
    0,
  );
  assert.equal((await read("/events?limit=1")).body.data.length, 1);
  assert.equal(
    (await read("/events?mint=" + encodeURIComponent("' OR 1=1 --"))).body.data
      .length,
    0,
  );
  assert.equal(store.stats().events, 2);
});
test("token projection revokes creation/creator proof when transaction is reverted", async (t) => {
  const { store, read } = await api(t);
  const signature = persist(store);
  const before = (await read("/tokens")).body.data[0];
  assert.equal(before.createdAt, at);
  assert.equal(before.creator, "synthetic-creator");
  store.reconcile(signature, {
    slot: 100,
    confirmationStatus: "confirmed",
    err: { InstructionError: [0, "Custom"] },
  });
  const after = (await read("/tokens")).body.data[0];
  assert.equal(after.mint, mint);
  assert.equal(after.createdAt, null);
  assert.equal(after.creator, null);
  assert.equal(after.reconciliationStatus, "REVERTED");
  const events = (await read("/events")).body.data;
  assert.equal(events[0].reconciliationStatus, "REVERTED");
  assert.equal((await read("/market")).body.groups.length, 0);
});
test("null status is unresolved rather than definite reversal and excluded from market", async (t) => {
  const { store, read } = await api(t);
  const signature = persist(store, {
    eventType: "TOKEN_BOUGHT",
    amountTokenRaw: "3",
    amountQuoteRaw: "7",
  });
  store.reconcile(signature, null);
  assert.equal(
    (await read("/events")).body.data[0].reconciliationStatus,
    "UNRESOLVED",
  );
  assert.equal((await read("/market")).body.groups.length, 0);
  assert.ok(
    (await read("/gaps")).body.data.some(
      (g) => g.code === "FINALITY_UNRESOLVED",
    ),
  );
});
test("security has no safety conclusion for unknown mint and preserves incomplete evidence", async (t) => {
  const { store, read } = await api(t);
  assert.equal((await read("/security?mint=unknown-mint")).body.data, null);
  store.security(mint, {
    status: "INCOMPLETE",
    securityConclusion: null,
    mintAuthority: null,
    freezeAuthority: null,
  });
  const data = (await read("/security?mint=" + mint)).body.data;
  assert.equal(data.status, "INCOMPLETE");
  assert.equal(data.securityConclusion, null);
  assert.equal((await read("/missing")).response.status, 404);
});
test("different status slot cannot finalize event decoded in original slot", async (t) => {
  const { store, read } = await api(t);
  const signature = persist(store);
  store.reconcile(signature, {
    slot: 200,
    confirmationStatus: "finalized",
    err: null,
  });
  const row = (await read("/events")).body.data[0];
  assert.equal(row.confirmationStatus, "confirmed");
  assert.equal(row.reconciliationStatus, "UNRESOLVED");
  assert.ok(
    (await read("/gaps")).body.data.some(
      (g) => g.code === "FINALITY_SLOT_MISMATCH",
    ),
  );
});
test("malformed status with missing confirmation stage cannot restore active state", async (t) => {
  const { store, read } = await api(t);
  const signature = persist(store);
  store.reconcile(signature, { slot: 100, err: null });
  const row = (await read("/events")).body.data[0];
  assert.equal(row.reconciliationStatus, "UNRESOLVED");
  assert.equal(row.confirmationStatus, "confirmed");
});
