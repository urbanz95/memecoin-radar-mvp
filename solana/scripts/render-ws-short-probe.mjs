// Read-only short observer of Render public /health. No Solana HTTP RPC.
const HEALTH = "https://solana-pump-radar-mvp.onrender.com/health";
const INTERVAL_MS = 3000;
const MAX_DURATION_MS = 90000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const samples = [];
const startedMs = Date.now();
const readCount = (o, name) => Number.isFinite(o?.[name]) ? o[name] : null;
while (Date.now() - startedMs <= MAX_DURATION_MS) {
  const sampledAt = new Date().toISOString();
  try {
    const response = await fetch(HEALTH, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6500),
    });
    if (!response.ok) throw Error("HTTP_" + response.status);
    const h = await response.json();
    if (h?.chain !== "solana" || h?.mode !== "READ_ONLY") throw Error("NOT_SCANNER");
    const g = h.metrics?.gauges ?? {};
    const c = h.metrics?.counters ?? {};
    const lastEventMs = Date.parse(g.lastEventReceived ?? "");
    const lag = Number.isFinite(lastEventMs)
      ? Math.max(0, Date.now() - lastEventMs) / 1000 : null;
    samples.push({
      at: sampledAt, status: h.status,
      connected: g.websocket_connected === true,
      lagSec: lag === null ? null : Math.round(lag * 10) / 10,
      notifications: readCount(c, "notificationsReceived"),
      disconnects: readCount(c, "websocket_disconnects"),
      reconnects: readCount(c, "reconnect_count"),
      persists: readCount(c, "logObservationsPersisted"),
      storagePaused: g.websocket_storage_paused === true,
    });
  } catch (e) {
    samples.push({ at: sampledAt, error: String(e?.message || e).slice(0, 100) });
  }
  const next = startedMs + samples.length * INTERVAL_MS;
  if (next > Date.now() && next - startedMs <= MAX_DURATION_MS) {
    await sleep(next - Date.now());
  } else if (Date.now() - startedMs > MAX_DURATION_MS - INTERVAL_MS) {
    break;
  }
}
const ok = samples.filter(x => !x.error);
const first = ok[0], last = ok.at(-1);
const difference = key => first?.[key] === null || last?.[key] === null ||
  !Number.isFinite(first?.[key]) || !Number.isFinite(last?.[key])
  ? null : last[key] - first[key];
let longestDisconnectedStreak = 0, streak = 0;
for (const s of samples) {
  if (s.connected === false && !s.error) {
    streak++;
    longestDisconnectedStreak = Math.max(longestDisconnectedStreak, streak);
  } else streak = 0;
}
const output = {
  kind: "RENDER_WS_SHORT_PROBE_READ_ONLY",
  startedAt: new Date(startedMs).toISOString(),
  completedAt: new Date().toISOString(),
  measuredSeconds: Math.round((Date.now() - startedMs) / 1000),
  requestedIntervalSec: INTERVAL_MS / 1000,
  totalSamples: samples.length,
  successfulSamples: ok.length,
  httpFailures: samples.length - ok.length,
  connectedSamples: ok.filter(x => x.connected).length,
  disconnectedSamples: ok.filter(x => !x.connected).length,
  observedDisconnectedPercent: ok.length ?
    Math.round(ok.filter(x => !x.connected).length / ok.length * 1000) / 10 : null,
  longestConsecutiveDisconnectedSamples: longestDisconnectedStreak,
  longestObservedDisconnectSequenceApproxSec: longestDisconnectedStreak * INTERVAL_MS / 1000,
  maxObservedLogAgeSec: ok.length ? Math.max(...ok.map(x => x.lagSec ?? 0)) : null,
  staleLogSamplesOver45Sec: ok.filter(x => x.lagSec !== null && x.lagSec > 45).length,
  storagePausedSamples: ok.filter(x => x.storagePaused).length,
  notificationDelta: difference("notifications"),
  disconnectCounterDelta: difference("disconnects"),
  reconnectCounterDelta: difference("reconnects"),
  persistedCounterDelta: difference("persists"),
  firstSample: first ?? null,
  lastSample: last ?? null,
  limitations: "Samples estimate connection status ONLY at observed instants. Not actual total downtime nor fraction of missed trades; multiple reconnects between samples can be invisible.",
  rpcSolanaHttpCalls: 0, productionChanged: false,
};
console.log("RENDER_WS_SHORT_PROBE " + JSON.stringify(output));
