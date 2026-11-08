import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, {
  archiveRadar, checkedRenderHealthUrl, runScheduled,
} from "../src/index.mjs";

const NOW = Date.parse("2026-11-08T02:30:09Z");
const HEALTH = "https://solana-pump-radar-mvp.onrender.com/health";
const RADAR = "https://solana-pump-radar-mvp.onrender.com/radar?limit=50";
const base58 = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const token = (char = "2", patch = {}) => ({
  mint: char.repeat(32),
  lastObservedAt: new Date(NOW - 9000).toISOString(),
  observedEvents: 12,
  activity: { "60s": { buys: 3, sells: 2 } },
  estimatedFdvUsd: 7500,
  fdvStatus: "ABOVE_FLOOR",
  ...patch,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const health = (connected = true) => ({
  chain: "solana", mode: "READ_ONLY", status: "OBSERVING",
  coverage: "PARTIAL", metrics: { gauges: { websocket_connected: connected } },
});
const radar = (tokens = [token()]) => ({
  kind: "SOLANA_PUMP_RADAR_MVP", mode: "READ_ONLY",
  coverage: "PARTIAL", generatedAt: new Date(NOW).toISOString(),
  candidates: tokens,
});
function fakeD1() {
  const rows = new Map();
  const prepared = [];
  let deletedBefore = null;
  const api = {
    rows, prepared,
    prepare(sql) {
      prepared.push(sql);
      if (sql.startsWith("INSERT OR IGNORE")) {
        return { bind(...args) { return { sql, args }; } };
      }
      if (sql.startsWith("DELETE FROM radar_token_samples")) {
        return { bind(cutoff) { return {
          async run() {
            deletedBefore = cutoff;
            for (const [key, row] of rows)
              if (row[0] < cutoff) rows.delete(key);
          },
        }; } };
      }
      throw Error("UNEXPECTED_D1_STATEMENT");
    },
    async batch(statements) {
      return statements.map(({ args }) => {
        const key = args[0] + ":" + args[1];
        if (rows.has(key)) return { meta: { changes: 0 } };
        rows.set(key, args);
        return { meta: { changes: 1 } };
      });
    },
    get deletedBefore() { return deletedBefore; },
  };
  return api;
}
function mockFetch({ healthResponse = health(), radarResponse = radar(), status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "manual");
    assert.equal(init.method, "GET");
    if (url === HEALTH) return json(healthResponse);
    if (url === RADAR) return json(radarResponse, status);
    throw Error("UNEXPECTED_REMOTE_URL_" + url);
  };
  return { fn, calls };
}
function env(db) { return {
  RENDER_RADAR_HEALTH_URL: HEALTH,
  RADAR_DB: db,
}; }
function logSink() {
  const lines = [];
  return { lines,
    log(...args) { lines.push(["info", ...args]); },
    error(...args) { lines.push(["error", ...args]); },
  };
}

test("remote URLs are constrained to a Render HTTPS /health sibling", async () => {
  assert.equal(checkedRenderHealthUrl(HEALTH), HEALTH);
  const db = fakeD1();
  const { fn, calls } = mockFetch();
  assert.deepEqual(await archiveRadar(env(db), fn, () => NOW), {
    bucket: Math.floor(NOW / 300000) * 300000, candidates: 1, inserted: 1,
  });
  assert.deepEqual(calls.map(x => x.url), [RADAR]);
  assert.equal(db.rows.size, 1);
  assert.equal(db.rows.values().next().value[1], token().mint);
  assert.ok(db.prepared.some(x => x.startsWith("INSERT OR IGNORE")));
  assert.equal(db.deletedBefore, NOW - 7 * 86400000);
});

test("same five-minute bucket is idempotent; next bucket retains historical rows", async () => {
  const db = fakeD1();
  const { fn } = mockFetch();
  const first = await archiveRadar(env(db), fn, () => NOW);
  const repeated = await archiveRadar(env(db), fn, () => NOW + 10000);
  const newerFetch = mockFetch({ radarResponse: {
    ...radar(), generatedAt: new Date(NOW + 5 * 60000).toISOString(),
  } });
  const nextBucket = await archiveRadar(env(db), newerFetch.fn, () => NOW + 5 * 60000);
  assert.equal(first.inserted, 1);
  assert.equal(repeated.inserted, 0);
  assert.equal(nextBucket.inserted, 1);
  assert.equal(db.rows.size, 2);
  assert.notEqual(first.bucket, nextBucket.bucket);
});

test("archive is bounded to 50 tokens and preserves UNKNOWN FDV honestly", async () => {
  const db = fakeD1();
  const candidates = base58.slice(0, 52).split("").map(c => token(c));
  candidates[0] = token(base58[0], { estimatedFdvUsd: null, fdvStatus: "ABOVE_FLOOR" });
  candidates[1] = token(base58[1], { estimatedFdvUsd: -200, fdvStatus: "ABOVE_FLOOR" });
  candidates[2] = token(base58[2], { mint: "not-a-base58-mint" });
  candidates[3] = token(base58[3], { activity: { "60s": { buys: -1, sells: 1 } } });
  const { fn } = mockFetch({ radarResponse: radar(candidates) });
  const result = await archiveRadar(env(db), fn, () => NOW);
  assert.equal(result.candidates, 48);
  assert.equal(result.inserted, 48);
  assert.equal(db.rows.size, 48);
  assert.equal(db.rows.get(result.bucket + ":" + base58[0].repeat(32))[6], null);
  assert.equal(db.rows.get(result.bucket + ":" + base58[0].repeat(32))[7], "FDV_UNKNOWN");
  assert.equal(db.rows.get(result.bucket + ":" + base58[1].repeat(32))[7], "FDV_UNKNOWN");
  assert.ok([...db.rows.values()].every(row => row[8] === "PARTIAL"));
});

test("unknown/malformed/stale radar and missing D1 fail without inserting", async () => {
  const db = fakeD1();
  for (const override of [
    { kind: "OTHER" },
    { coverage: "COMPLETE" },
    { mode: "TRADING" },
    { generatedAt: "2020-01-01T00:00:00Z" },
    { candidates: null },
  ]) {
    const { fn } = mockFetch({ radarResponse: { ...radar(), ...override } });
    await assert.rejects(() => archiveRadar(env(db), fn, () => NOW),
      /INVALID_OR_STALE_RADAR_SNAPSHOT/);
  }
  const badFetch = async () => ({ ok:false, status:302 });
  await assert.rejects(() => archiveRadar(env(db), badFetch, () => NOW), /RENDER_HTTP_302/);
  await assert.rejects(() => archiveRadar({ RENDER_RADAR_HEALTH_URL: HEALTH }, () => {}, () => NOW),
    /RADAR_DB_BINDING_MISSING/);
  assert.equal(db.rows.size, 0);
});

test("scheduled handler keeps successful heartbeat separate from D1 failure", async () => {
  const logger = logSink();
  const { fn } = mockFetch();
  await runScheduled(fn, { RENDER_RADAR_HEALTH_URL: HEALTH,
    RADAR_DB: {
      prepare(sql) { if (sql.startsWith("INSERT")) return { bind: (...args) => ({args}) }; },
      async batch() { throw Error("D1_IS_UNAVAILABLE"); },
    },
  }, logger, () => NOW);
  assert.equal(logger.lines[0][1], "RADAR_KEEPALIVE");
  assert.equal(logger.lines[1][1], "RADAR_ARCHIVE_FAILED");
  assert.equal(logger.lines[1][2], "D1_IS_UNAVAILABLE");
  assert.equal(logger.lines.some(x => x[1] === "RADAR_KEEPALIVE_FAILED"), false);
});

test("no WebSocket skips archive; failed health never calls /radar", async () => {
  const db = fakeD1(), logger = logSink();
  const withoutWs = mockFetch({ healthResponse: health(false) });
  await runScheduled(withoutWs.fn, env(db), logger, () => NOW);
  assert.deepEqual(withoutWs.calls.map(x => x.url), [HEALTH]);
  assert.equal(logger.lines[1][1], "RADAR_ARCHIVE_SKIPPED");
  const unhealthy = mockFetch({ healthResponse: {chain:"other",mode:"WRONG"} });
  await runScheduled(unhealthy.fn, env(db), logger, () => NOW);
  assert.deepEqual(unhealthy.calls.map(x => x.url), [HEALTH]);
  assert.equal(logger.lines.at(-1)[1], "RADAR_KEEPALIVE_FAILED");
  assert.equal(db.rows.size, 0);
});

test("public GET never exposes database contents or arbitrary remote proxy", async () => {
  const db = fakeD1();
  const ok = await worker.fetch(new Request("https://example.workers.dev/"),
    env(db));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.archiveConfigured, true);
  assert.equal(body.kind, "SOLANA_RADAR_KEEPALIVE");
  assert.equal(body.cron, "EVERY_FIVE_MINUTES");
  assert.equal(body.configured, true);
  assert.equal(await (await worker.fetch(new Request(
    "https://example.workers.dev/health"), env(db))).status, 404);
  assert.equal(await (await worker.fetch(new Request(
    "https://example.workers.dev/", { method:"POST" }), env(db))).status, 405);
});

test("repository versions existing production D1 binding and idempotent schema", () => {
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/0001_radar_token_samples.sql", import.meta.url), "utf8");
  assert.match(wrangler, /binding = "RADAR_DB"/);
  assert.match(wrangler, /database_name = "solana-radar-archive"/);
  assert.match(wrangler, /database_id = "fa193e87-526d-42b3-bb27-64fe63e588a1"/);
  assert.match(wrangler, /crons = \["\*\/5 \* \* \* \*"\]/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS radar_token_samples/);
  assert.match(migration, /PRIMARY KEY \(bucket_at, mint\)/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_radar_mint_history/);
});
