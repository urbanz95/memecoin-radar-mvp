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

## D1 Free retention and capacity budget

The 50-candidate cap is a maximum, not 50 guaranteed unique tokens per run.
At one run per five minutes there are 288 buckets per day:

| Condition | Approximate volume |
| --- | ---: |
| 50 inserted candidates every Cron | 14,400 table rows/day |
| Seven-day rolling window at steady state | ~100,800 table rows |
| Expiry at steady state | up to ~14,400 table rows deleted/day |

Cloudflare D1 Workers Free currently includes 100,000 rows written/day
across the account, 5,000,000 rows read/day and 500 MB per database.
**Index maintenance counts as additional D1 rows written.** The production
schema has both a primary-key index and idx_radar_mint_history. Thus,
the real daily write consumption may be much higher than 14,400 and becomes
higher still once seven-day-old rows start being deleted. The 100,000/day
quota cannot be certified from archive row counts alone. On Free, exceeding
limits yields D1 errors instead of automatic extra paid charges.

Check Cloudflare Dashboard > D1 > solana-radar-archive > Metrics > Row Metrics
for rows_written, rows_read and database storage. Check account-wide usage.
An illustrative ~3 index/table row writes per insert and per deletion would
amount to ~86,400 rows written/day once retention reaches steady state;
this is NOT an actual D1 measurement or a guaranteed ceiling.

If actual writes approach the daily quota, first consider archiving fewer
candidate mints per Cron (e.g. 25-30) or sampling less often. Coordinate
any change with the manually deployed Worker and regression tests. Do not
drop the secondary index or rebuild the live production table without
a deliberate migration. This PR changes no production configuration.

Read-only D1 Console queries for occasional checks:

    SELECT COUNT(*) AS rows_archived,
           COUNT(DISTINCT bucket_at) AS buckets,
           datetime(MIN(bucket_at)/1000, 'unixepoch') AS oldest_utc,
           datetime(MAX(bucket_at)/1000, 'unixepoch') AS newest_utc
    FROM radar_token_samples;

    SELECT COUNT(*) AS expired_rows
    FROM radar_token_samples
    WHERE bucket_at < CAST(strftime('%s','now') AS INTEGER) * 1000
                      - (7 * 86400000);

These counts scan the table and consume some rows-read quota, so run them
sparingly rather than on every Cron.
## Safety

- The Render scanner and Cloudflare Worker must stay independent.
- Keep the current external URL variable configured in the Cloudflare UI.
- The production D1 binding is versioned in wrangler.toml so a future
  CLI deploy cannot accidentally omit it.
- Do not copy tokens, wallet keys or Cloudflare API credentials to GitHub.
- Do not turn on automatic Cloudflare deploys while production code has
  not been directly inspected and compared with this version.
