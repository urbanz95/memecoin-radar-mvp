// Cloudflare Worker: *only* a low-cost heartbeat for a separate Render web
// service. This Worker neither trades nor scrapes the blockchain.
// Cron frequency configured in wrangler.toml: every five minutes.
export function checkedRenderHealthUrl(value) {
  if (typeof value !== "string" || !value.length || value.length > 230)
    throw Error("MISSING_RENDER_HEALTH_URL");
  let u;
  try { u = new URL(value); } catch { throw Error("INVALID_RENDER_HEALTH_URL"); }
  if (u.protocol !== "https:" ||
      !/^[a-z0-9-]+\.onrender\.com$/i.test(u.hostname) ||
      u.pathname !== "/health" || u.search || u.hash ||
      u.username || u.password || u.port)
    throw Error("RENDER_HEALTH_URL_MUST_BE_HTTPS_ONRENDER_HEALTH");
  return u.href;
}
export async function checkRadar(fetchFn, value) {
  const url = checkedRenderHealthUrl(value);
  const response = await fetchFn(url, {
    method: "GET", redirect: "error",
    signal: AbortSignal.timeout(35000),
    headers: { "accept": "application/json" },
  });
  if (!response.ok) throw Error("RENDER_HTTP_" + response.status);
  const health = await response.json();
  if (health?.chain !== "solana" || health?.mode !== "READ_ONLY")
    throw Error("INVALID_SOLANA_HEALTH_RESPONSE");
  return {
    reachable: true,
    status: health.status ?? "UNKNOWN",
    websocketConnected: health.metrics?.gauges?.websocket_connected === true,
    coverage: health.coverage ?? "UNKNOWN",
  };
}
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const health = await checkRadar(fetch, env.RENDER_RADAR_HEALTH_URL);
        console.log("RADAR_KEEPALIVE", JSON.stringify(health));
      } catch (error) {
        console.error("RADAR_KEEPALIVE_FAILED", error.message);
      }
    })());
  },
  async fetch(request, env) {
    if (request.method !== "GET") return new Response("READ_ONLY", { status: 405 });
    if (new URL(request.url).pathname !== "/") return new Response("NOT_FOUND", { status: 404 });
    // Public status is configuration-only; no unrestricted URL fetch endpoint.
    return Response.json({
      kind: "SOLANA_RADAR_KEEPALIVE",
      configured: Boolean(env.RENDER_RADAR_HEALTH_URL),
      cron: "EVERY_FIVE_MINUTES",
      note: "Actual scanner status is served by the Render radar /health endpoint.",
    }, { headers: { "cache-control": "no-store" } });
  },
};
