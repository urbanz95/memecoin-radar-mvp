// Deterministic regression tests. Error/fork responses below are SYNTHETIC.
// Successful decoder input is an archived Mainnet transaction, not a live RPC test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/store.mjs";
import { Scanner } from "../src/scanner.mjs";
import { loadConfig } from "../src/config.mjs";
import { decodeTransaction, PROGRAMS } from "../src/protocols/index.mjs";

const successful = () =>
  JSON.parse(
    readFileSync(
      new URL("../fixtures/pump-buy-v3-mainnet.json", import.meta.url),
    ),
  ).result;
const syntheticFailure = { InstructionError: [0, { Custom: 6001 }] };
function observation(tx, extra = {}) {
  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    programId: PROGRAMS.find((p) => p.protocol === "pump_fun").programId,
    receivedAt: new Date().toISOString(),
    confirmationStatus: "confirmed",
    evidenceSource: "rpc:logsSubscribe",
    ...extra,
  };
}
function persistSuccess(store, tx = successful()) {
  const seen = observation(tx);
  store.receiveBatch([seen]);
  assert.equal(store.claim(seen.signature), true);
  const decoded = decodeTransaction(tx, seen);
  assert.ok(decoded.events.length > 0);
  store.persistTransaction(seen, tx, decoded.events, decoded.diagnostics);
  return { tx, seen };
}
function scannerWith(store, tx) {
  const requests = [];
  const rpc = {
    assertMainnet: async () => {},
    close: async () => {},
    async request(method, params) {
      requests.push({ method, params });
      assert.equal(method, "getTransaction");
      return tx;
    },
  };
  const config = {
    ...loadConfig({ SOLANA_PROGRAMS: "pump_fun" }),
    logObservationsEnabled: false,
  };
  const scanner = new Scanner(config, {
    store,
    rpc,
    socketFactory: () => ({ start() {}, stop() {}, reconnect() {} }),
  });
  return { scanner, requests };
}

test("a weaker processed error cannot terminally revoke confirmed events and block later finalization", () => {
  const store = new Store(":memory:");
  try {
    const { tx, seen } = persistSuccess(store);
    store.reconcile(seen.signature, {
      slot: tx.slot,
      confirmationStatus: "processed",
      err: syntheticFailure,
    });
    assert.equal(
      store.transaction(seen.signature).reconciliation,
      "UNRESOLVED",
    );
    assert.equal(store.transaction(seen.signature).confirmation, "confirmed");
    assert.ok(
      store.nonFinalized().some((row) => row.signature === seen.signature),
    );
    assert.ok(
      store
        .events()
        .every((event) => event.reconciliationStatus === "UNRESOLVED"),
    );
    store.reconcile(seen.signature, {
      slot: tx.slot,
      confirmationStatus: "finalized",
      err: null,
    });
    assert.equal(store.transaction(seen.signature).confirmation, "finalized");
    assert.equal(store.transaction(seen.signature).reconciliation, "ACTIVE");
    assert.ok(
      store
        .events()
        .every(
          (event) =>
            event.confirmationStatus === "finalized" &&
            event.reconciliationStatus === "ACTIVE",
        ),
    );
  } finally {
    store.close();
  }
});

test("a confirmed error requires fresh enrichment before successful finality reactivates old events", async () => {
  const store = new Store(":memory:");
  const { tx, seen } = persistSuccess(store),
    { scanner, requests } = scannerWith(store, tx);
  try {
    store.reconcile(seen.signature, {
      slot: tx.slot,
      confirmationStatus: "confirmed",
      err: syntheticFailure,
    });
    assert.equal(store.transaction(seen.signature).reconciliation, "REVERTED");
    assert.equal(store.nonFinalized().length, 1);
    store.reconcile(seen.signature, {
      slot: tx.slot,
      confirmationStatus: "finalized",
      err: null,
    });
    assert.equal(
      store.transaction(seen.signature).reconciliation,
      "UNRESOLVED",
    );
    assert.ok(
      store.events().every((e) => e.reconciliationStatus === "UNRESOLVED"),
    );
    const pending = store.pending().find((o) => o.signature === seen.signature);
    assert.ok(pending);
    assert.equal(pending.confirmationStatus, "finalized");
    assert.equal(await scanner.processObservation(pending), true);
    assert.equal(requests[0].params[1].commitment, "finalized");
    assert.ok(
      store
        .events()
        .every(
          (e) =>
            e.reconciliationStatus === "ACTIVE" &&
            e.confirmationStatus === "finalized",
        ),
    );
  } finally {
    await scanner.stop();
  }
});

for (const changedSlot of [false, true]) {
  test(`a synthetic confirmed failure can be re-enriched after successful status${changedSlot ? " at another slot" : " at the same slot"}`, async () => {
    const tx = successful(),
      store = new Store(":memory:");
    const seen = observation(tx, {
      slot: changedSlot ? tx.slot - 1 : tx.slot,
      onchainError: syntheticFailure,
    });
    const { scanner, requests } = scannerWith(store, tx);
    try {
      store.receiveBatch([seen]);
      assert.equal(store.claim(seen.signature), true);
      store.completeFailed(seen, syntheticFailure);
      assert.equal(
        store.db
          .prepare("SELECT status FROM inbox WHERE signature=?")
          .get(seen.signature).status,
        "FAILED",
      );
      assert.equal(
        store.transaction(seen.signature)?.confirmation,
        "confirmed",
      );
      assert.ok(
        store.nonFinalized().some((row) => row.signature === seen.signature),
      );
      assert.equal(store.events().length, 0);
      store.reconcile(seen.signature, {
        slot: tx.slot,
        confirmationStatus: "confirmed",
        err: null,
      });
      const pending = store
        .pending(10, Date.now() + 60000)
        .find((row) => row.signature === seen.signature);
      assert.ok(
        pending,
        "successful reconciliation must requeue the failed observation",
      );
      assert.equal(pending.slot, tx.slot);
      assert.ok(!pending.onchainError);
      assert.equal(await scanner.processObservation(pending), true);
      assert.equal(requests.length, 1);
      assert.ok(
        store.events().some((event) => event.eventType === "TOKEN_BOUGHT"),
      );
      assert.equal(store.transaction(seen.signature).slot, tx.slot);
      assert.equal(store.transaction(seen.signature).reconciliation, "ACTIVE");
    } finally {
      await scanner.stop();
    }
  });
}

test("finalized on-chain failure is terminal and produces no market events", () => {
  const tx = successful(),
    store = new Store(":memory:");
  try {
    const seen = observation(tx, {
      confirmationStatus: "finalized",
      onchainError: syntheticFailure,
    });
    store.receiveBatch([seen]);
    assert.equal(store.claim(seen.signature), true);
    store.completeFailed(seen, syntheticFailure);
    assert.equal(store.transaction(seen.signature)?.confirmation, "finalized");
    assert.equal(store.isDone(seen.signature), true);
    assert.equal(
      store.nonFinalized().some((row) => row.signature === seen.signature),
      false,
    );
    assert.equal(store.events().length, 0);
  } finally {
    store.close();
  }
});

for (const invalidSlot of [-1, 1.5, "465054514"]) {
  test(`an explicitly invalid status slot ${JSON.stringify(invalidSlot)} cannot finalize existing events`, () => {
    const store = new Store(":memory:");
    try {
      const { seen } = persistSuccess(store);
      store.reconcile(seen.signature, {
        slot: invalidSlot,
        confirmationStatus: "finalized",
        err: null,
      });
      assert.equal(store.transaction(seen.signature).confirmation, "confirmed");
      assert.equal(
        store.transaction(seen.signature).reconciliation,
        "UNRESOLVED",
      );
      assert.ok(
        store.nonFinalized().some((row) => row.signature === seen.signature),
      );
    } finally {
      store.close();
    }
  });
}

test("status without a recognized confirmation level remains unresolved", () => {
  const store = new Store(":memory:");
  try {
    const { tx, seen } = persistSuccess(store);
    store.reconcile(seen.signature, {
      slot: tx.slot,
      err: null,
      confirmationStatus: "unknown",
    });
    assert.equal(store.transaction(seen.signature).confirmation, "confirmed");
    assert.equal(
      store.transaction(seen.signature).reconciliation,
      "UNRESOLVED",
    );
  } finally {
    store.close();
  }
});

for (const mismatch of ["signature", "slot"]) {
  test(`a failed RPC transaction with mismatching ${mismatch} cannot terminally complete another observation`, async () => {
    const tx = successful(),
      store = new Store(":memory:");
    tx.meta.err = syntheticFailure;
    const seen = observation(
      tx,
      mismatch === "signature"
        ? { signature: "synthetic-other-signature" }
        : { slot: tx.slot + 1 },
    );
    const { scanner } = scannerWith(store, tx);
    try {
      store.receiveBatch([seen]);
      assert.equal(await scanner.processObservation(seen), false);
      assert.equal(store.isDone(seen.signature), false);
      assert.equal(store.transaction(seen.signature), undefined);
      assert.equal(store.events().length, 0);
      assert.equal(
        store.db
          .prepare("SELECT status FROM inbox WHERE signature=?")
          .get(seen.signature).status,
        "PENDING",
      );
    } finally {
      await scanner.stop();
    }
  });
}
