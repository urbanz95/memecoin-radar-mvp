import test from "node:test";
import assert from "node:assert/strict";
import { mapPump } from "../src/protocols/pump.mjs";

test("PumpSwap event cannot inherit mint attribution from a different pool", () => {
  // Adversarial deterministic context, not a Mainnet transaction: parent
  // association can be uncertain when RPC inner stackHeight is unavailable.
  const [event] = mapPump(
    "pump_swap",
    "BuyEvent",
    {
      pool: "event-pool",
      user: "buyer",
      base_amount_out: "17",
      user_quote_amount_in: "19",
    },
    {
      parentNamedAccounts: {
        pool: "different-pool",
        base_mint: "unrelated-base-mint",
        quote_mint: "unrelated-quote-mint",
      },
    },
  );
  assert.equal(event.poolAddress, "event-pool");
  assert.equal(event.amountTokenRaw, "17");
  assert.equal(event.tokenMint, null);
  assert.equal(event.quoteMint, null);
  assert.equal(event.completeness, "INCOMPLETE");
});

test("PumpSwap prefers a proven matching instruction over unrelated parent accounts", () => {
  const [event] = mapPump(
    "pump_swap",
    "SellEvent",
    {
      pool: "correct-pool",
      user: "user",
      base_amount_in: "7",
      user_quote_amount_out: "9",
    },
    {
      namedAccounts: {
        pool: "correct-pool",
        base_mint: "actual-mint",
        quote_mint: "actual-quote",
      },
      parentNamedAccounts: {
        pool: "other-pool",
        base_mint: "wrong-mint",
        quote_mint: "wrong-quote",
      },
    },
  );
  assert.equal(event.tokenMint, "actual-mint");
  assert.equal(event.quoteMint, "actual-quote");
  assert.equal(event.poolAddress, "correct-pool");
});
