# Solana Cloudflare keepalive + D1 archive (production source sync)

This folder versions the Worker already deployed manually in the Cloudflare UI:
solana-radar-keepalive. Do **not** create a new Worker or database.

## Current production resources (verified 2026-11-08)

- Service variable: RENDER_RADAR_HEALTH_URL
  (https://solana-pump-radar-mvp.onrender.com/health).
- Cron: every five minutes, */5 * * * *
- D1 binding: RADAR_DB to existing solana-radar-archive.
  The matching database ID is stored in wrangler.toml.
- Schema: migrations/0001_radar_token_samples.sql. The production table and
  index were created manually already, and must NOT be dropped or recreated.
- Direct D1 console evidence at 02:30 UTC on 2026-11-08: 100 rows,
  91 distinct mints, two five-minute time buckets.

**CRITICAL:** the code is synchronized from the version the user manually
pasted in Cloudflare, not from a direct download of the live Worker.
No connector is available to independently diff production source.
**Do not deploy or enable automated Cloudflare deployment on the strength
of this PR alone.** Inspect the live Worker before any future deployment.

## Data path

1. Cloudflare Cron probes the strictly validated HTTPS /health endpoint on
   Render and logs RADAR_KEEPALIVE or RADAR_KEEPALIVE_FAILED.
   Redirect policy must be manual, NOT error (unsupported by Workers).
2. If the scanner reports WebSocket connected, the same checked Render
   origin is used for GET /radar?limit=50.
3. The Worker checks a fresh, partial radar response and inserts up to 50
   candidates per five-minute bucket into RADAR_DB using INSERT OR IGNORE.
   The primary key (bucket_at,mint) makes retries idempotent.
4. Logs RADAR_ARCHIVE with candidates and inserted counts, or separately
   RADAR_ARCHIVE_FAILED. Failure in the archive does not hide a successful
   heartbeat.
5. Deletes sample rows older than seven days to control free-tier usage.

This archive contains only a bounded candidate sample. It is not a full
Solana event ledger and does not restore the ephemeral Render SQLite file.
Counts and buy/sell windows are partial. FDV is a virtual-reserve-based
estimate, not circulating market cap, and may be UNKNOWN.

## Validation without production changes

At the repository root (Node 22 or 24):

    node --test cloud/keepalive/test/*.test.mjs

These tests use deterministic mock HTTP and D1 implementations; they do not
connect to Cloudflare or spend Solana RPC quota.

In the Cloudflare D1 console, read-only verification:

    SELECT COUNT(*) AS rows,
           COUNT(DISTINCT mint) AS distinct_mints,
           COUNT(DISTINCT bucket_at) AS time_buckets,
           datetime(MAX(bucket_at)/1000, 'unixepoch') AS latest_utc
    FROM radar_token_samples;

Check that buckets grow in subsequent successful Cron runs. Monitor D1
storage and write quotas before raising the 50-token limit or retention.

## Safety

- The Render scanner and Cloudflare Worker must stay independent.
- Keep the current external URL variable configured in the Cloudflare UI.
- The production D1 binding is versioned in wrangler.toml so a future
  CLI deploy cannot accidentally omit it.
- Do not copy tokens, wallet keys or Cloudflare API credentials to GitHub.
- Do not turn on automatic Cloudflare deploys while production code has
  not been directly inspected and compared with this version.
