import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeTransaction } from "../src/protocols/registry.mjs";
import {
  mapRaydium,
  mapRaydiumInstruction,
} from "../src/protocols/raydium.mjs";
const fixture = (name) =>
  JSON.parse(readFileSync(new URL("../fixtures/" + name, import.meta.url)));
const WSOL = "So11111111111111111111111111111111111111112";

test("real Mainnet LaunchLab initialize_v2 creates mint and curve with proven creator", () => {
  const { events, diagnostics } = decodeTransaction(
    fixture("raydium-launchlab-create-mainnet.json"),
    { confirmationStatus: "finalized" },
  );
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    events.map((e) => e.eventType),
    ["TOKEN_CREATED", "POOL_CREATED", "TOKEN_BOUGHT", "CURVE_PROGRESS_UPDATED"],
  );
  assert.equal(
    events[0].creator,
    "Ep86vfFf3wT8AAvKtbdEyQWsrQ39wpDZ6vyzoTv7Nhxh",
  );
  assert.equal(
    events[0].tokenMint,
    "33AGKzTeV1NvhuMVMWiTja4xZYqwdi5aUo4JwurfLoat",
  );
  assert.equal(events[0].protocolData.symbol, "Apu");
  assert.equal(events[0].eventTimestamp, "2026-11-03T21:06:17.000Z");
  // LaunchLab real_base_after counts curve tokens SOLD; it is not vault inventory.
  assert.equal(events[2].reserves.soldTokenRaw, events[2].amountTokenRaw);
});

test("real Mainnet LaunchLab routed v1 transaction: event CPI and log are deduplicated", () => {
  const { events, diagnostics } = decodeTransaction(
    fixture("raydium-launchlab-buy-mainnet.json"),
    { confirmationStatus: "finalized" },
  );
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    events.map((e) => e.eventType),
    ["TOKEN_BOUGHT", "CURVE_PROGRESS_UPDATED"],
  );
  const buy = events[0];
  assert.equal(buy.tokenMint, "33AGKzTeV1NvhuMVMWiTja4xZYqwdi5aUo4JwurfLoat");
  assert.equal(buy.wallet, "CJUKGyRiRJxAWHtpDooB8p5ReDnbLnrPpffd5mQpEKEd");
  assert.equal(buy.amountTokenRaw, "37116764184");
  assert.equal(buy.amountQuoteRaw, "20254589");
  assert.equal(buy.tokenDecimals, 6);
  assert.equal(buy.instructionIndex, 0);
  assert.equal(buy.innerInstructionIndex, 14);
  assert.equal(buy.evidenceSource.kind, "anchor_emit_cpi");
  assert.equal(buy.confirmationStatus, "finalized");
});

test("real Mainnet CPMM routed swap: actual amounts, mints and wallet", () => {
  const { events, diagnostics } = decodeTransaction(
    fixture("raydium-cpmm-swap-mainnet.json"),
    { confirmationStatus: "finalized" },
  );
  assert.deepEqual(diagnostics, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "TOKEN_SOLD");
  assert.equal(
    events[0].tokenMint,
    "JCdE6KcCEUcgmhiCQfXTL11524wSgqJCnGtYDA757q4a",
  );
  assert.equal(events[0].amountTokenRaw, "444705362107");
  assert.equal(events[0].amountQuoteRaw, "603739667");
  assert.equal(
    events[0].wallet,
    "2ia7hqmTtE6AizaFcLDRW9Vk4c4gSAMWxxnCqj6xm2P1",
  );
  assert.equal(events[0].evidenceSource.kind, "anchor_program_data");
});

test("real Mainnet mere CPMM address mention creates no swap", () => {
  assert.deepEqual(
    decodeTransaction(fixture("raydium-cpmm-mention-only-mainnet.json")).events,
    [],
  );
});

test("deterministic CPMM new pool instruction maps exact mint addresses; no token creator inference", () => {
  const events = mapRaydiumInstruction("raydium_cpmm", {
    instructionName: "initialize",
    namedAccounts: {
      pool_state: "pool",
      token_0_mint: WSOL,
      token_1_mint: "mint",
      creator: "poolCreator",
      lp_mint: "lp",
    },
  });
  assert.equal(events[0].eventType, "POOL_CREATED");
  assert.equal(events[0].tokenMint, "mint");
  assert.equal(events[0].creator, null);
  assert.equal(events[0].amountTokenRaw, null);
});

test("deterministic LaunchLab funded status and migration remain distinct", () => {
  const events = mapRaydium(
    "raydium_launchlab",
    "TradeEvent",
    {
      pool_state: "curve",
      trade_direction: { variant: "Buy" },
      pool_status: { variant: "Migrate" },
      amount_in: "12",
      amount_out: "34",
    },
    {
      namedAccounts: {
        pool_state: "curve",
        base_token_mint: "mint",
        quote_token_mint: WSOL,
        payer: "wallet",
      },
    },
  );
  assert.ok(events.some((e) => e.eventType === "TOKEN_GRADUATED"));
  assert.ok(!events.some((e) => e.eventType === "TOKEN_MIGRATED"));
  const migrated = mapRaydiumInstruction("raydium_launchlab", {
    instructionName: "migrate_to_cpswap",
    namedAccounts: {
      pool_state: "curve",
      base_mint: "mint",
      quote_mint: WSOL,
      cpswap_pool: "target",
      payer: "wallet",
    },
  });
  assert.equal(migrated[0].eventType, "TOKEN_MIGRATED");
  assert.equal(migrated[0].poolAddress, "target");
});

test("deterministic unknown direction, ambiguous quote and missing accounts do not fabricate attribution", () => {
  assert.deepEqual(
    mapRaydium(
      "raydium_launchlab",
      "TradeEvent",
      { trade_direction: { variant: "Unknown" } },
      {},
    ),
    [],
  );
  assert.deepEqual(
    mapRaydium(
      "raydium_cpmm",
      "SwapEvent",
      { input_mint: "a", output_mint: "b" },
      {},
    ),
    [],
  );
  const result = mapRaydium(
    "raydium_launchlab",
    "TradeEvent",
    {
      pool_state: "pool",
      trade_direction: { variant: "Buy" },
      amount_in: "900719925474099312345",
      amount_out: "900719925474099312346",
    },
    {},
  );
  assert.equal(result[0].amountTokenRaw, "900719925474099312346");
  assert.equal(result[0].wallet, null);
  assert.equal(result[0].tokenMint, null);
  assert.equal(result[0].completeness, "INCOMPLETE");
});
