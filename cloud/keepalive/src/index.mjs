// Cloudflare Worker for the EXISTING Render Solana radar.
// Cron */5: probe Render /health, then archive up to 50 verified radar candidates
// into the bound D1 database. This does not trade or replace the scanner.
// 2026-11-08: synchronized from the manual Cloudflare dashboard deployment.
const FIVE_MINUTES = 5 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 50;

export function checkedRenderHealthUrl(value) {
  if (typeof value !== "string" || !value.length || value.length > 230)
    throw Error("MISSING_RENDER_HEALTH_URL");
  let url;
  try { url = new URL(value); }
  catch { throw Error("INVALID_RENDER_HEALTH_URL"); }
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.onrender\.com$/i.test(url.hostname) ||
    url.pathname !== "/health" ||
    url.search || url.hash || url.username || url.password || url.port
  ) throw Error("INVALID_RENDER_HEALTH_URL");
  return url.href;
}

async function readJson(fetchFn, url) {
  const response = await fetchFn(url, {
    method: "GET",
    // Cloudflare Workers does not accept redirect:"error". Never follow
    // redirects to an unvalidated destination; a 3xx is an HTTP failure.
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(35000),
  });
  if (!response.ok) throw Error("RENDER_HTTP_" + response.status);
  return response.json();
}

export async function checkRadar(fetchFn, healthUrl) {
  const data = await readJson(fetchFn, checkedRenderHealthUrl(healthUrl));
  if (data?.chain !== "solana" || data?.mode !== "READ_ONLY")
    throw Error("INVALID_SOLANA_HEALTH_RESPONSE");
  return {
    reachable: true,
    status: data.status ?? "UNKNOWN",
    websocketConnected: data.metrics?.gauges?.websocket_connected === true,
    coverage: data.coverage ?? "UNKNOWN",
  };
}

// A summary archive, NOT a complete event ledger or backup of Render SQLite.
export async function archiveRadar(env, fetchFn = fetch, now = Date.now) {
  if (!env.RADAR_DB?.prepare || !env.RADAR_DB?.batch)
    throw Error("RADAR_DB_BINDING_MISSING");

  // Derive /radar ONLY from the strictly validated /health URL.
  const url = new URL(checkedRenderHealthUrl(env.RENDER_RADAR_HEALTH_URL));
  url.pathname = "/radar";
  url.search = "?limit=50";
  const radar = await readJson(fetchFn, url.href);
  const at = now();

  if (
    radar?.kind !== "SOLANA_PUMP_RADAR_MVP" ||
    radar?.mode !== "READ_ONLY" ||
    radar?.coverage !== "PARTIAL" ||
    !Array.isArray(radar.candidates) ||
    !Number.isFinite(Date.parse(radar.generatedAt)) ||
    Math.abs(at - Date.parse(radar.generatedAt)) > 120000
  ) throw Error("INVALID_OR_STALE_RADAR_SNAPSHOT");

  const bucket = Math.floor(at / FIVE_MINUTES) * FIVE_MINUTES;
  const insert = env.RADAR_DB.prepare(
    "INSERT OR IGNORE INTO radar_token_samples " +
    "(bucket_at, mint, last_observed_at, observed_events, buys_60s, " +
    "sells_60s, estimated_fdv_usd, fdv_status, coverage) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const statements = [];
  const seenMints = new Set();

  for (const token of radar.candidates.slice(0, MAX_CANDIDATES)) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token?.mint ?? "") ||
        seenMints.has(token.mint))
      continue;
    const buys = token.activity?.["60s"]?.buys;
    const sells = token.activity?.["60s"]?.sells;
    if (
      !validCount(token.observedEvents) ||
      !validCount(buys) || !validCount(sells) ||
      !Number.isFinite(Date.parse(token.lastObservedAt))
    ) continue;

    const validFdv = typeof token.estimatedFdvUsd === "number" &&
      Number.isFinite(token.estimatedFdvUsd) && token.estimatedFdvUsd >= 0;
    const fdv = validFdv ? token.estimatedFdvUsd : null;
    const statuses = ["ABOVE_FLOOR", "NEAR_FLOOR", "BELOW_FLOOR"];
    const fdvStatus = fdv !== null && statuses.includes(token.fdvStatus)
      ? token.fdvStatus : "FDV_UNKNOWN";

    seenMints.add(token.mint);
    statements.push(insert.bind(
      bucket, token.mint, token.lastObservedAt,
      token.observedEvents, buys, sells, fdv, fdvStatus, "PARTIAL",
    ));
  }

  let inserted = 0;
  let results = [];
  if (statements.length) {
    results = await env.RADAR_DB.batch(statements);
    inserted = results.reduce(
      (sum, result) => sum + (result.meta?.changes ?? 0), 0,
    );
  }

  // Bounded rolling history; idempotent even when a Cron is retried.
  const cleanup = await env.RADAR_DB.prepare(
    "DELETE FROM radar_token_samples WHERE bucket_at < ?",
  ).bind(at - SEVEN_DAYS).run();

  // D1 already returns per-query metering. Include INSERT + DELETE (indexes
  // count as writes), with NO extra SQL queries and no new credentials.
  // Missing metadata is UNKNOWN, not zero. size_after is allocated DB bytes.
  const responses = [...results, cleanup];
  const sumMeta = name => {
    const values = responses.map(x => x?.meta?.[name]);
    return values.every(v => Number.isSafeInteger(v) && v >= 0)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  };
  const bytes = cleanup?.meta?.size_after;
  return {
    bucket, candidates: statements.length, inserted,
    metering: {
      rowsWritten: sumMeta("rows_written"),
      rowsRead: sumMeta("rows_read"),
      databaseBytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
    },
  };
}

// Exported to exercise both success and error isolation in deterministic tests.
export async function runScheduled(fetchFn, env, logger = console, now = Date.now) {
  let health;
  try {
    health = await checkRadar(fetchFn, env.RENDER_RADAR_HEALTH_URL);
    logger.log("RADAR_KEEPALIVE", JSON.stringify(health));
  } catch (error) {
    logger.error("RADAR_KEEPALIVE_FAILED", error.message);
    return;
  }

  if (!health.websocketConnected) {
    logger.log("RADAR_ARCHIVE_SKIPPED", "WEBSOCKET_DISCONNECTED");
    return;
  }

  // D1 failure must never hide a successful heartbeat.
  try {
    const result = await archiveRadar(env, fetchFn, now);
    logger.log("RADAR_ARCHIVE", JSON.stringify(result));
  } catch (error) {
    logger.error("RADAR_ARCHIVE_FAILED", error.message);
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduled(fetch, env));
  },

  async fetch(request, env) {
    if (request.method !== "GET")
      return new Response("READ_ONLY", { status: 405 });
    if (new URL(request.url).pathname !== "/")
      return new Response("NOT_FOUND", { status: 404 });
    return Response.json({
      kind: "SOLANA_RADAR_KEEPALIVE",
      configured: Boolean(env.RENDER_RADAR_HEALTH_URL),
      cron: "EVERY_FIVE_MINUTES",
      archiveConfigured: Boolean(env.RADAR_DB),
    }, { headers: { "cache-control": "no-store" } });
  },
};
