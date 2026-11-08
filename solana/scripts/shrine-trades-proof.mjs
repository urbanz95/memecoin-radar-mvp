// Ephemeral, read-only proof: Shrine selective free trade -> Solana confirmed tx.
// No keys, trades, deploys or writes to production. Diagnostic branch only.
import { io } from "socket.io-client";

const RPC = "https://solana-rpc.publicnode.com";
const PROGRAMS = {
  PUMPFUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PUMPSWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
};
const MAX_SOCK_MS = 90000;
const wait = ms => new Promise(r => setTimeout(r, ms));
const output = {
  startedAt: new Date().toISOString(), source: "shrine_free_selective",
  rpcEndpoint: "publicnode_read_only", subscriptionAck: "MISSING",
  connects: 0, disconnects: 0, newTokens: { PUMPFUN: 0, PUMPSWAP: 0 },
  tradeEvents: 0, captured: [], checks: [], tradeSubscriptions: [], rpcHttpCalls: 0,
  accountOrApiKeyUsed: false, transactionsSubmitted: false,
};
const targets = { PUMPFUN: new Set(), PUMPSWAP: new Set() };
const selected = {};
const socket = io("https://sol.shrine.trade", {
  transports: ["websocket"], reconnection: false, timeout: 15000,
  forceNew: true,
});
let done = false;
function redact(e) { return String(e?.message || e || "UNKNOWN").slice(0, 120); }
const observed = new Promise(resolve => {
  const timer = setTimeout(() => finish("PROBE_TIMEOUT"), MAX_SOCK_MS);
  function finish(reason) {
    if (done) return;
    done = true;
    output.stopReason = reason;
    clearTimeout(timer);
    socket.disconnect();
    resolve();
  }
  socket.on("connect_error", e => {
    output.connectionError = redact(e);
    finish("CONNECT_ERROR");
  });
  socket.on("connect", () => {
    output.connects++;
    socket.emit("subscribe_new_tokens", {
      protocols: ["PUMPFUN", "PUMPSWAP"],
    }, ack => {
      output.subscriptionAck = ack?.ok === true ? "OK" : redact(ack?.error);
    });
  });
  socket.on("new_token", e => {
    const p = e?.protocol, mint = e?.mint, pool = e?.pool;
    if (!targets[p] || typeof mint !== "string" || typeof pool !== "string") return;
    output.newTokens[p]++;
    if (targets[p].size >= (p === "PUMPFUN" ? 3 : 2) || targets[p].has(pool))
      return;
    targets[p].add(pool);
    const subscription = { protocol: p, mint, pool, ack: "PENDING" };
    output.tradeSubscriptions.push(subscription);
    socket.emit("subscribe_trades", { pool }, ack => {
      subscription.ack = ack?.ok === true ? "OK" : redact(ack?.error);
    });
  });
  socket.on("trade", e => {
    output.tradeEvents++;
    const p = e?.protocol;
    if (!PROGRAMS[p] || selected[p] || !targets[p].has(e?.pool) ||
        typeof e?.signature !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(e.signature)) return;
    selected[p] = {
      protocol: p, mint: e.mint, pool: e.pool, signature: e.signature,
      isBuy: e.is_buy, tokenAmount: e.token_amount,
      wallet: e.wallet, feedTimestamp: e.timestamp,
    };
    output.captured.push(selected[p]);
    if (selected.PUMPFUN && selected.PUMPSWAP)
      finish("BOTH_PROTOCOLS_CAPTURED");
  });
  socket.on("disconnect", () => {
    output.disconnects++;
    if (!done) finish("UNEXPECTED_DISCONNECT");
  });
});
await observed;
await wait(7000); // give the network time to reach confirmed commitment
let lastRpc = 0;
async function getConfirmed(signature) {
  const until = lastRpc + 5500 - Date.now();
  if (until > 0) await wait(until);
  lastRpc = Date.now();
  output.rpcHttpCalls++;
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: output.rpcHttpCalls,
        method: "getTransaction",
        params: [signature, {
          commitment: "confirmed", encoding: "jsonParsed",
          maxSupportedTransactionVersion: 1,
        }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    const j = await res.json();
    if (j?.error) return { error: "RPC_" + String(j.error.code), message: redact(j.error.message) };
    if (!res.ok) return { error: "HTTP_" + res.status };
    return { tx: j?.result ?? null };
  } catch (e) { return { error: redact(e) }; }
}
function summarize(t, tx) {
  if (!tx) return { confirmedTx: false };
  const meta = tx.meta || {};
  const accountKeys = (tx.transaction?.message?.accountKeys || [])
    .map(x => typeof x === "string" ? x : x.pubkey);
  const tokenBalances = list => (list || [])
    .filter(x => x.mint === t.mint && x.owner === t.wallet)
    .map(x => ({ amount: BigInt(x.uiTokenAmount?.amount || "0"),
                decimals: x.uiTokenAmount?.decimals || 0 }));
  const prev = tokenBalances(meta.preTokenBalances);
  const post = tokenBalances(meta.postTokenBalances);
  const prevValue = prev.reduce((a, b) => a + b.amount, 0n);
  const postValue = post.reduce((a, b) => a + b.amount, 0n);
  const delta = postValue - prevValue;
  const hasOwnerBalance = prev.length > 0 || post.length > 0;
  const sideMatches = hasOwnerBalance && delta !== 0n
    ? ((delta > 0n) === (t.isBuy === true)) : null;
  const logs = meta.logMessages || [];
  const programInvoked = logs.some(x => x.includes("Program " + PROGRAMS[t.protocol] + " invoke"));
  return {
    confirmedTx: true, slot: tx.slot,
    transactionSuccessful: meta.err === null,
    expectedProgramInvoked: programInvoked,
    expectedPoolInTransaction: accountKeys.includes(t.pool),
    mintInTokenBalanceChanges: [...(meta.preTokenBalances || []),
      ...(meta.postTokenBalances || [])].some(x => x.mint === t.mint),
    traderSideMatchesTokenBalanceDelta: sideMatches,
    transactionVersion: tx.version ?? "unknown",
  };
}
for (const trade of output.captured) {
  let query = await getConfirmed(trade.signature);
  if (!query.error && !query.tx) {
    await wait(5500);
    query = await getConfirmed(trade.signature);
  }
  output.checks.push({
    ...trade,
    ...(query.error ? { rpcError: query.error, message: query.message } :
      summarize(trade, query.tx)),
  });
}
output.captured.forEach(trade => {
  const matching = output.tradeSubscriptions.find(sub => sub.pool === trade.pool);
  trade.matchedPoolSubscriptionAck = matching?.ack ?? "UNKNOWN";
});
output.completedAt = new Date().toISOString();
output.verifiedWithProgram = output.checks.filter(x =>
  x.confirmedTx && x.transactionSuccessful &&
  x.expectedProgramInvoked && x.expectedPoolInTransaction).length;
console.log("SHRINE_TRADE_ONCHAIN_PROOF " + JSON.stringify(output));
