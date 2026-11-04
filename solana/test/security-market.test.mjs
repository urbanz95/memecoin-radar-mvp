import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  decodeMintAccount,
  inspectMint,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from "../src/security.mjs";
import { aggregateMarket } from "../src/market.mjs";

// These are synthetic binary layouts, not claims about Mainnet token risk.
function mint({
  owner = TOKEN_PROGRAM,
  supply = 18446744073709551615n,
  mintAuthority = false,
  freezeAuthority = false,
  extensions = [],
} = {}) {
  const base = Buffer.alloc(extensions.length ? 166 : 82);
  base.writeBigUInt64LE(supply, 36);
  base[44] = 9;
  base[45] = 1;
  if (mintAuthority) {
    base.writeUInt32LE(1, 0);
    base.fill(2, 4, 36);
  }
  if (freezeAuthority) {
    base.writeUInt32LE(1, 46);
    base.fill(3, 50, 82);
  }
  if (extensions.length) base[165] = 1;
  const tlv = extensions.map(([type, data]) => {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(type);
    header.writeUInt16LE(data.length, 2);
    return Buffer.concat([header, data]);
  });
  return {
    owner,
    executable: false,
    data: [Buffer.concat([base, ...tlv]).toString("base64"), "base64"],
  };
}
const NOW = Date.UTC(2026, 10, 3, 12);
const rpcWith = (account) => ({
  request: async (method) => {
    assert.equal(method, "getAccountInfo");
    return { context: { slot: 123 }, value: account };
  },
});

test("archived REAL Mainnet SOL mint response decodes independently of lossy JSON numeric metadata", () => {
  const bytes = readFileSync(
    new URL("../fixtures/security-mainnet-sol.json", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "b2bf5c0cbc4d30ca305f358b2faddae24d31e67d2e65a6c77d7937387f79684a",
  );
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.result.context.slot, 465055449);
  const decoded = decodeMintAccount(fixture.result.value);
  assert.equal(decoded.tokenProgram, TOKEN_PROGRAM);
  assert.equal(decoded.decimals, 9);
  assert.equal(decoded.mintAuthority, null);
  assert.equal(decoded.freezeAuthority, null);
  assert.equal(decoded.supplyRaw, "0");
  assert.equal(decoded.initialized, true);
  assert.equal(
    decoded.accountDataSha256,
    "b0f919425a529f4971ef8dabd535aec34947d5c8c4885df80dae91635b98c5f3",
  );
});

test("SPL mint binary decoding preserves u64 precision and explicit null authorities", () => {
  const value = decodeMintAccount(mint());
  assert.equal(value.supplyRaw, "18446744073709551615");
  assert.equal(value.decimals, 9);
  assert.equal(value.mintAuthority, null);
  assert.equal(value.freezeAuthority, null);
  assert.equal(value.initialized, true);
  assert.deepEqual(value.extensions, []);
  assert.match(value.accountDataSha256, /^[a-f0-9]{64}$/);
});
test("absence of mint/freeze authority does not make overall token safe", async () => {
  const report = await inspectMint(rpcWith(mint()), "mint", { now: NOW });
  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.checks.mintAuthority.status, "PASS");
  assert.equal(report.holders.ownerDistributionComplete, false);
  assert.equal(report.liquidity.status, "UNKNOWN");
  assert.equal(report.authorityHistory.status, "INCOMPLETE");
});
test("active mint/freeze authority is a known policy rejection", async () => {
  const report = await inspectMint(
    rpcWith(mint({ mintAuthority: true, freezeAuthority: true })),
    "mint",
  );
  assert.equal(report.status, "REJECTED");
  assert.equal(report.checks.mintAuthority.status, "REJECTED");
  assert.equal(report.checks.freezeAuthority.status, "REJECTED");
});
test("Token-2022 extensions report fees, hooks, permanent delegate, pausable, permissioned burn", async () => {
  const fee = Buffer.alloc(108);
  fee.fill(4, 0, 32);
  fee.writeBigUInt64LE(999999999999999999n, 80);
  fee.writeUInt16LE(250, 88);
  fee.writeUInt16LE(500, 106);
  const hook = Buffer.alloc(64);
  hook.fill(5, 32);
  const delegate = Buffer.alloc(32, 6);
  const pausable = Buffer.alloc(33);
  pausable[32] = 1;
  const account = mint({
    owner: TOKEN_2022_PROGRAM,
    extensions: [
      [1, fee],
      [12, delegate],
      [14, hook],
      [26, pausable],
      [28, Buffer.alloc(32, 7)],
    ],
  });
  const report = await inspectMint(rpcWith(account), "mint");
  assert.equal(report.status, "REJECTED");
  assert.deepEqual(
    report.mint.extensions.map((e) => e.name),
    [
      "TransferFeeConfig",
      "PermanentDelegate",
      "TransferHook",
      "Pausable",
      "PermissionedBurn",
    ],
  );
  assert.ok(report.mint.extensions.every((e) => e.status === "REJECTED"));
  assert.equal(
    report.mint.extensions[0].olderTransferFee.maximumFeeRaw,
    "999999999999999999",
  );
  assert.equal(report.mint.extensions[0].newerTransferFee.basisPoints, 500);
  assert.equal(report.mint.extensions[3].paused, true);
});
test("unknown extensions remain incomplete and malformed layouts never pass", async () => {
  const unknown = mint({
    owner: TOKEN_2022_PROGRAM,
    extensions: [[333, Buffer.alloc(8)]],
  });
  const report = await inspectMint(rpcWith(unknown), "mint");
  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.checks.extensions.status, "INCOMPLETE");
  assert.equal(report.mint.extensions[0].name, "UnknownExtension");
  const bad = mint({
    owner: TOKEN_2022_PROGRAM,
    extensions: [[26, Buffer.alloc(2)]],
  });
  assert.throws(() => decodeMintAccount(bad), /INVALID_EXTENSION_LENGTH/);
  assert.equal((await inspectMint(rpcWith(bad), "mint")).status, "UNKNOWN");
  assert.throws(
    () => decodeMintAccount({ ...mint(), owner: "unrecognized" }),
    /UNSUPPORTED_MINT_OWNER/,
  );
  assert.throws(
    () => decodeMintAccount({ ...mint(), executable: true }),
    /UNSUPPORTED_MINT_OWNER/,
  );
});
test("default frozen/non-transferable and invalid duplicate/account TLVs are explicit", async () => {
  const blocked = mint({
    owner: TOKEN_2022_PROGRAM,
    extensions: [
      [6, Buffer.from([2])],
      [9, Buffer.alloc(0)],
    ],
  });
  assert.equal(
    (await inspectMint(rpcWith(blocked), "mint")).status,
    "REJECTED",
  );
  assert.throws(
    () =>
      decodeMintAccount(
        mint({
          owner: TOKEN_2022_PROGRAM,
          extensions: [
            [26, Buffer.alloc(33)],
            [26, Buffer.alloc(33)],
          ],
        }),
      ),
    /INVALID_EXTENSION_TLV/,
  );
  assert.throws(
    () =>
      decodeMintAccount(
        mint({ owner: TOKEN_2022_PROGRAM, extensions: [[2, Buffer.alloc(8)]] }),
      ),
    /ACCOUNT_EXTENSION_ON_MINT/,
  );
  const data = Buffer.from(mint().data[0], "base64");
  data.writeUInt32LE(2);
  assert.throws(
    () =>
      decodeMintAccount({
        ...mint(),
        data: [data.toString("base64"), "base64"],
      }),
    /INVALID_AUTHORITY_OPTION/,
  );
});
test("missing RPC data stays UNKNOWN and provider error secrets are not persisted", async () => {
  assert.equal((await inspectMint(rpcWith(null), "mint")).status, "UNKNOWN");
  const report = await inspectMint(
    {
      request: async () => {
        throw Error("https://secret:key@provider/secret");
      },
    },
    "mint",
  );
  assert.equal(report.error, "MINT_INSPECTION_FAILED");
  assert.ok(!JSON.stringify(report).includes("secret"));
});
test("largest token accounts remain an incomplete sample, not a holder census", async () => {
  const rpc = {
    request: async (method) =>
      method === "getAccountInfo"
        ? { context: { slot: 10 }, value: mint() }
        : {
            context: { slot: 11 },
            value: [
              { address: "accountA", amount: "9007199254740999" },
              { address: "accountB", amount: "3" },
            ],
          },
  };
  const report = await inspectMint(rpc, "mint", {
    includeLargestAccounts: true,
  });
  assert.equal(report.holders.status, "INCOMPLETE");
  assert.equal(report.holders.ownerDistributionComplete, false);
  assert.equal(report.holders.sampledAmountRaw, "9007199254741002");
  assert.equal(report.holders.contextSlot, 11);
  assert.equal(report.holders.supplyContextSlot, 10);
  assert.equal(report.status, "INCOMPLETE");
});

let serial = 0;
function event(eventType, ageMs, extra = {}) {
  const n = ++serial;
  return {
    id: String(n),
    eventType,
    protocol: "fixture",
    programId: "program",
    tokenMint: "MintA",
    quoteMint: "SOL",
    poolAddress: "pool",
    transactionSignature: "signature" + n,
    slot: 1000000 - ageMs,
    instructionIndex: 0,
    wallet: "walletA",
    amountTokenRaw: "100",
    amountQuoteRaw: "200",
    tokenDecimals: 0,
    quoteDecimals: 0,
    eventTimestamp: new Date(NOW - ageMs).toISOString(),
    confirmationStatus: "confirmed",
    reconciliationStatus: "ACTIVE",
    evidenceStatus: "VERIFIED_PROTOCOL_EVENT",
    ...extra,
  };
}
test("market windows count swaps separately from transactions and unique traders", () => {
  const events = [
    event("TOKEN_BOUGHT", 1000),
    event("TOKEN_BOUGHT", 2000),
    event("TOKEN_SOLD", 4000, { wallet: "walletB" }),
    event("TOKEN_BOUGHT", 20000, { wallet: "walletC" }),
    event("TOKEN_SOLD", 70000),
  ];
  events[1].transactionSignature = events[0].transactionSignature;
  const group = aggregateMarket(events, { now: NOW }).groups[0];
  const w = group.windows["5s"];
  assert.equal(w.swapCount, 3);
  assert.equal(w.transactionCount, 2);
  assert.equal(w.distinctBuyers, 1);
  assert.equal(w.distinctSellers, 1);
  assert.equal(w.distinctTraders, 2);
  assert.equal(group.windows["30s"].swapCount, 4);
  assert.equal(group.windows["1m"].swapCount, 4);
  assert.equal(group.windows["5m"].swapCount, 5);
  assert.equal(group.windows["15m"].swapCount, 5);
  assert.equal(w.status, "PARTIAL");
  assert.equal(w.quoteVolumeUsd, null);
  assert.deepEqual(w.swapFrequencyPerSecond, {
    numerator: "3",
    denominator: "5",
  });
});
test("market financial sums and rational prices stay exact beyond Number precision", () => {
  const large = 9007199254740993123456789n;
  const events = [
    event("TOKEN_BOUGHT", 4000, {
      amountTokenRaw: large.toString(),
      amountQuoteRaw: large.toString(),
    }),
    event("TOKEN_SOLD", 1000, {
      amountTokenRaw: large.toString(),
      amountQuoteRaw: (large * 3n).toString(),
    }),
  ];
  const w = aggregateMarket(events, { now: NOW }).groups[0].windows["5s"];
  assert.equal(w.observedTokenVolumeRaw, (large * 2n).toString());
  assert.equal(w.observedQuoteVolumeRaw, (large * 4n).toString());
  assert.deepEqual(w.latestPrice.quotePerToken, {
    numerator: "3",
    denominator: "1",
  });
  assert.deepEqual(w.priceChangePercent, {
    numerator: "200",
    denominator: "1",
  });
});
test("incomplete amounts/decimals/wallets remain partial, untimed swaps excluded from windows", () => {
  const events = [
    event("TOKEN_BOUGHT", 1000, { amountQuoteRaw: null, wallet: null }),
    event("TOKEN_SOLD", 2000, { tokenDecimals: null }),
    event("TOKEN_BOUGHT", 3000, { eventTimestamp: null }),
  ];
  const report = aggregateMarket(events, { now: NOW });
  const group = report.groups[0];
  const w = group.windows["5s"];
  assert.equal(w.swapCount, 2);
  assert.equal(w.unattributedSwaps, 1);
  assert.equal(w.missingQuoteAmounts, 1);
  assert.equal(w.volumeCompleteWithinObservedTrades, false);
  assert.equal(w.walletAttributionComplete, false);
  assert.equal(w.topWalletSwapShare, null);
  assert.deepEqual(w.observedTopWalletSwapShareLowerBound, {
    numerator: "1",
    denominator: "2",
  });
  assert.equal(w.latestPrice.quotePerToken, null);
  assert.equal(w.priceChangePercent, null);
  assert.equal(group.untimedSwaps, 1);
  assert.equal(report.missingTimestamps, 1);
});
test("duplicates and unresolved/reverted observations do not inflate market data", () => {
  const buy = event("TOKEN_BOUGHT", 1000);
  const report = aggregateMarket(
    [
      buy,
      { ...buy, confirmationStatus: "finalized" },
      event("TOKEN_BOUGHT", 1000, { reconciliationStatus: "UNRESOLVED" }),
      event("TOKEN_SOLD", 1000, { reconciliationStatus: "REVERTED" }),
      event("TOKEN_SOLD", 1000, { reconciliationStatus: undefined }),
    ],
    { now: NOW },
  );
  assert.equal(report.groups[0].windows["5s"].swapCount, 1);
  assert.equal(
    aggregateMarket([buy, { ...buy, reconciliationStatus: "REVERTED" }], {
      now: NOW,
    }).groups.length,
    0,
  );
});
test("mint identity survives duplicate symbols and age requires a verified creation", () => {
  const report = aggregateMarket(
    [
      event("TOKEN_CREATED", 20000, { symbol: "SAME" }),
      event("TOKEN_BOUGHT", 1000, { symbol: "SAME" }),
      event("TOKEN_BOUGHT", 1000, { tokenMint: "MintB", symbol: "SAME" }),
      event("TOKEN_CREATED", 20000, {
        tokenMint: "MintB",
        evidenceStatus: "UNVERIFIED",
      }),
    ],
    { now: NOW },
  );
  assert.equal(report.groups.length, 2);
  assert.equal(
    report.groups.find((g) => g.tokenMint === "MintA").provenAgeSeconds,
    20,
  );
  assert.equal(
    report.groups.find((g) => g.tokenMint === "MintB").provenAgeSeconds,
    null,
  );
});
test("future data excluded, protocol reserves do not imply withdrawable liquidity or graduation percentage", () => {
  const report = aggregateMarket(
    [
      event("TOKEN_BOUGHT", -10000),
      event("CURVE_PROGRESS_UPDATED", 1000, {
        reserves: {
          realTokenRaw: "10",
          virtualQuoteRaw: "-40",
          realQuoteRaw: "100",
        },
      }),
    ],
    { now: NOW },
  );
  assert.equal(report.futureEvents, 1);
  const group = report.groups[0];
  assert.equal(group.windows["5s"].swapCount, 0);
  assert.equal(
    group.latestProtocolReportedReserves.values.virtualQuoteRaw,
    "-40",
  );
  assert.equal(group.liquidityAvailableRaw, null);
  assert.equal(group.graduationProgress, null);
});
