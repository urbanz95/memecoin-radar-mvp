import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodeTransaction, PROGRAMS } from "../src/protocols/index.mjs";
import {
  base58Encode,
  base58Decode,
  decodeBorsh,
} from "../src/protocols/borsh.mjs";
const fixture = (name) =>
  JSON.parse(fs.readFileSync(new URL("../fixtures/" + name, import.meta.url)));
const mint = "8TAyswcwuZrzUtsZzqSW1MCDi2VbRw9p1iwP63j8pump";
test("Mainnet Pump create_v2 proves mint/creator and first buy; v1 transaction + Token-2022", () => {
  const { events } = decodeTransaction(fixture("pump-create-v2-mainnet.json"), {
    confirmationStatus: "finalized",
  });
  const created = events.find((e) => e.eventType === "TOKEN_CREATED");
  assert.equal(created.tokenMint, mint);
  assert.ok(created.creator);
  assert.equal(
    created.tokenProgram,
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  );
  assert.ok(events.some((e) => e.eventType === "TOKEN_BOUGHT"));
  assert.equal(created.confirmationStatus, "finalized");
});
test("Mainnet Pump v3 buy exact raws; native quote established from instruction", () => {
  const r = decodeTransaction(fixture("pump-buy-v3-mainnet.json"));
  const e = r.events.find((e) => e.eventType === "TOKEN_BOUGHT");
  assert.equal(e.tokenMint, mint);
  assert.equal(e.amountTokenRaw, "1277814781087");
  assert.equal(e.amountQuoteRaw, "9777777");
  assert.equal(e.quoteMint, "So11111111111111111111111111111111111111112");
  assert.equal(e.instructionIndex, 0);
  assert.equal(e.innerInstructionIndex, 3);
  assert.equal(e.completeness, "INCOMPLETE");
  assert.ok(r.diagnostics.some((d) => d.code === "EVENT_TRAILING_BYTES"));
  assert.equal(
    r.events.filter((e) => e.eventType === "TOKEN_BOUGHT").length,
    1,
  );
});
test("Mainnet Pump routed sell preserves non-SOL quote and inner ownership", () => {
  const r = decodeTransaction(fixture("pump-sell-v3-routed-mainnet.json"));
  const e = r.events.find((e) => e.eventType === "TOKEN_SOLD");
  assert.equal(e.amountQuoteRaw, "2539");
  assert.equal(e.quoteMint, "AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES");
  assert.equal(e.innerInstructionIndex, 4);
  assert.ok(e.wallet);
});
test("Mainnet Pump routed v2 buy supported", () =>
  assert.ok(
    decodeTransaction(fixture("pump-buy-v2-routed-mainnet.json")).events.some(
      (e) => e.eventType === "TOKEN_BOUGHT",
    ),
  ));
test("Mainnet PumpSwap buys/sells with base and quote from real instruction accounts", () => {
  for (const [name, type, amount] of [
    ["pumpswap-buy-routed-mainnet.json", "TOKEN_BOUGHT", "5999"],
    ["pumpswap-sell-routed-mainnet.json", "TOKEN_SOLD", "356501"],
    ["pumpswap-buy-sol-mainnet.json", "TOKEN_BOUGHT", "267815"],
  ]) {
    const r = decodeTransaction(fixture(name));
    const e = r.events.find((e) => e.eventType === type);
    assert.equal(e.amountQuoteRaw, amount);
    assert.ok(e.tokenMint);
    assert.ok(e.quoteMint);
    assert.ok(e.wallet);
    assert.equal(r.events.length, 1);
  }
});
test("Failed transaction does not fabricate events from existing successful logs", () => {
  const tx = fixture("pump-buy-v3-mainnet.json");
  tx.result.meta.err = { InstructionError: [0, "Custom"] };
  assert.equal(decodeTransaction(tx).events.length, 0);
});
test("Unknown instruction never classifies SPL transfer as swap", () => {
  const tx = {
    slot: 1,
    transaction: {
      signatures: ["synthetic"],
      message: {
        accountKeys: [PROGRAMS[0].programId],
        instructions: [
          {
            programIdIndex: 0,
            accounts: [],
            data: base58Encode(Buffer.alloc(8, 111)),
          },
        ],
      },
    },
    meta: { err: null, innerInstructions: [], logMessages: [] },
  };
  const r = decodeTransaction(tx);
  assert.deepEqual(r.events, []);
  assert.equal(r.diagnostics[0].code, "UNKNOWN_INSTRUCTION");
});
test("Financial exact integer > Number.MAX_SAFE_INTEGER and signed i128", () => {
  const b = Buffer.alloc(24);
  b.writeBigUInt64LE(18446744073709551615n);
  b.fill(255, 8);
  assert.deepEqual(
    decodeBorsh(
      [
        { name: "a", type: "u64" },
        { name: "b", type: "i128" },
      ],
      b,
    ).data,
    { a: "18446744073709551615", b: "-1" },
  );
});
test("Base58 roundtrip preserves leading zeroes", () => {
  for (const b of [
    Buffer.alloc(32),
    Buffer.from([0, 0, 1, 255]),
    Buffer.alloc(0),
  ])
    assert.deepEqual(base58Decode(base58Encode(b)), b);
});
// Synthetic fixtures below exercise lifecycle layouts only: they are not Mainnet proofs.
function encode(type, value, types) {
  if (typeof type === "string") {
    if (type === "pubkey")
      return base58Decode(value ?? "11111111111111111111111111111111");
    if (type === "bool") return Buffer.from([value ? 1 : 0]);
    if (type === "string") {
      const s = Buffer.from(value ?? "");
      const b = Buffer.alloc(4);
      b.writeUInt32LE(s.length);
      return Buffer.concat([b, s]);
    }
    const size = Number(type.slice(1)) / 8,
      b = Buffer.alloc(size);
    let n = BigInt(value ?? 0);
    if (n < 0) n += 1n << BigInt(size * 8);
    for (let i = 0; i < size; i++) {
      b[i] = Number(n & 255n);
      n >>= 8n;
    }
    return b;
  }
  if (type.defined)
    return encode(
      types.find((x) => x.name === (type.defined.name ?? type.defined)).type,
      value,
      types,
    );
  if (type.vec) {
    const a = value ?? [],
      len = Buffer.alloc(4);
    len.writeUInt32LE(a.length);
    return Buffer.concat([len, ...a.map((v) => encode(type.vec, v, types))]);
  }
  if (type.array)
    return Buffer.concat(
      Array.from({ length: type.array[1] }, (_, i) =>
        encode(type.array[0], value?.[i], types),
      ),
    );
  if (type.kind === "struct")
    return Buffer.concat(
      type.fields.map((f) => encode(f.type, value?.[f.name], types)),
    );
  throw Error("Unsupported synthetic type");
}
function eventTx(file, name, values) {
  const idl = JSON.parse(
    fs.readFileSync(new URL("../vendor/" + file, import.meta.url)),
  );
  const ev = idl.events.find((x) => x.name === name),
    type = idl.types.find((x) => x.name === name).type;
  const payload = Buffer.concat([
    Buffer.from(ev.discriminator),
    encode(type, values, idl.types),
  ]);
  return {
    slot: 1,
    blockTime: 1700000000,
    transaction: {
      signatures: ["SYNTHETIC_ONLY"],
      message: {
        accountKeys: [idl.address],
        instructions: [
          {
            programIdIndex: 0,
            accounts: [],
            data: base58Encode(Buffer.alloc(8, 99)),
          },
        ],
      },
    },
    meta: {
      err: null,
      innerInstructions: [],
      logMessages: [
        `Program ${idl.address} invoke [1]`,
        `Program data: ${payload.toString("base64")}`,
        `Program ${idl.address} success`,
      ],
    },
  };
}
test("SYNTHETIC Pump graduation and migration preserve token mint and target pool", () => {
  const d = {
    mint,
    user: mint,
    bonding_curve: mint,
    timestamp: "1700000000",
    quote_mint: "So11111111111111111111111111111111111111112",
  };
  assert.equal(
    decodeTransaction(eventTx("pump.json", "CompleteEvent", d)).events[0]
      .eventType,
    "TOKEN_GRADUATED",
  );
  const r = decodeTransaction(
    eventTx("pump.json", "CompletePumpAmmMigrationEvent", {
      ...d,
      pool: mint,
      mint_amount: "9007199254740993",
      sol_amount: "3",
    }),
  );
  assert.equal(r.events[0].eventType, "TOKEN_MIGRATED");
  assert.equal(r.events[0].amountTokenRaw, "9007199254740993");
  assert.equal(r.events[0].destinationProtocol, "pump_swap");
  const pool = decodeTransaction(
    eventTx("pump_amm.json", "CreatePoolEvent", {
      base_mint: mint,
      quote_mint: d.quote_mint,
      pool: mint,
      creator: mint,
      base_mint_decimals: 6,
      quote_mint_decimals: 9,
    }),
  );
  assert.equal(pool.events[0].eventType, "POOL_CREATED");
  assert.equal(pool.events[0].tokenMint, mint);
});
test("SYNTHETIC spoofed Program data outside owning program cannot fabricate swap", () => {
  const tx = eventTx("pump.json", "CompleteEvent", { mint, user: mint });
  tx.meta.logMessages[0] =
    "Program 11111111111111111111111111111111 invoke [1]";
  assert.equal(decodeTransaction(tx).events.length, 0);
});
test("Truncated Borsh mid-field fails explicitly", () =>
  assert.throws(
    () => decodeBorsh([{ name: "amount", type: "u64" }], Buffer.alloc(7)),
    /Truncated/,
  ));
test("SYNTHETIC caught inner CPI failure rolls back its emitted events", () => {
  const tx = eventTx("pump.json", "CompleteEvent", { mint, user: mint });
  const programme = tx.transaction.message.accountKeys[0];
  tx.transaction.message.accountKeys.push("11111111111111111111111111111111");
  const inner = tx.transaction.message.instructions[0];
  tx.transaction.message.instructions = [
    { programIdIndex: 1, accounts: [], data: "11111111" },
  ];
  tx.meta.innerInstructions = [
    { index: 0, instructions: [{ ...inner, stackHeight: 2 }] },
  ];
  tx.meta.logMessages = [
    `Program 11111111111111111111111111111111 invoke [1]`,
    `Program ${programme} invoke [2]`,
    tx.meta.logMessages[1],
    `Program ${programme} failed: custom program error: 0x1`,
    `Program 11111111111111111111111111111111 success`,
  ];
  assert.equal(tx.meta.err, null);
  assert.equal(decodeTransaction(tx).events.length, 0);
});
test("SYNTHETIC PumpSwap pool creator remains distinct from token coin_creator", () => {
  const poolCreator = "So11111111111111111111111111111111111111112";
  const r = decodeTransaction(
    eventTx("pump_amm.json", "CreatePoolEvent", {
      base_mint: mint,
      quote_mint: poolCreator,
      pool: mint,
      creator: poolCreator,
      coin_creator: mint,
    }),
  );
  assert.equal(r.events[0].creator, mint);
  assert.equal(r.events[0].wallet, poolCreator);
  assert.equal(r.events[0].poolCreator, poolCreator);
  assert.equal(r.events[0].quoteDecimals, 0); // explicit IDL event decimal zero is authoritative
  const unknown = decodeTransaction(
    eventTx("pump_amm.json", "CreatePoolEvent", {
      base_mint: mint,
      quote_mint: poolCreator,
      pool: mint,
      creator: poolCreator,
    }),
  );
  assert.equal(unknown.events[0].creator, null);
});
test("Mainnet Pump migrate_v2 creates PumpSwap pool with continued mint identity and distinct creator actors", () => {
  const { events, diagnostics } = decodeTransaction(
    fixture("pump-migrate-v2-pumpswap-create-mainnet.json"),
    { confirmationStatus: "finalized" },
  );
  assert.deepEqual(diagnostics, []);
  const pool = events.find((e) => e.eventType === "POOL_CREATED"),
    migration = events.find((e) => e.eventType === "TOKEN_MIGRATED");
  assert.equal(pool.tokenMint, "BxGdDCJDHr35RwpxFomSnSGXMYyk32c1YNVAdiwjpump");
  assert.equal(migration.tokenMint, pool.tokenMint);
  assert.equal(migration.poolAddress, pool.poolAddress);
  assert.equal(migration.destinationProtocol, "pump_swap");
  assert.equal(migration.amountTokenRaw, "206900000000000");
  assert.equal(pool.creator, "ArLugmai8XHkZY4cvz3hM3jPeEwz7FA7CgZUSXQtZq1X");
  assert.notEqual(pool.poolCreator, pool.creator);
  assert.equal(pool.wallet, pool.poolCreator);
  assert.equal(pool.completeness, "COMPLETE");
  assert.equal(migration.completeness, "COMPLETE");
  assert.equal(migration.quoteDecimals, 9);
});
test("Mainnet Pump final curve buy graduates then migrates same mint into PumpSwap", () => {
  const grad = decodeTransaction(fixture("pump-graduation-mainnet.json"), {
    confirmationStatus: "finalized",
  });
  const graduation = grad.events.find((e) => e.eventType === "TOKEN_GRADUATED");
  assert.ok(graduation);
  assert.equal(graduation.completeness, "COMPLETE");
  assert.equal(graduation.slot, 465057017);
  assert.equal(
    graduation.quoteMint,
    "So11111111111111111111111111111111111111112",
  );
  const migration = decodeTransaction(
    fixture("pump-migrate-v2-pumpswap-create-mainnet.json"),
  ).events.find((e) => e.eventType === "TOKEN_MIGRATED");
  assert.equal(graduation.tokenMint, migration.tokenMint);
  assert.ok(migration.slot > graduation.slot);
  assert.ok(
    grad.events.some(
      (e) =>
        e.eventType === "TOKEN_BOUGHT" && e.tokenMint === graduation.tokenMint,
    ),
  );
});
test("Mainnet Raydium CPMM initialize proves new pool through successful instruction", () => {
  const r = decodeTransaction(fixture("raydium-cpmm-create-mainnet.json"), {
    confirmationStatus: "finalized",
  });
  assert.deepEqual(r.diagnostics, []);
  const e = r.events.find((e) => e.eventType === "POOL_CREATED");
  assert.equal(e.tokenMint, "C6LAj9qFHJyhd9NSxgFQ3wtvMtHAvFaSQ7bh77Uv7S56");
  assert.equal(e.quoteMint, "So11111111111111111111111111111111111111112");
  assert.ok(e.poolAddress);
  assert.equal(e.slot, 465056117);
  assert.equal(e.evidenceStatus, "VERIFIED_INSTRUCTION");
  assert.equal(e.creator, null);
  assert.ok(e.wallet);
});
