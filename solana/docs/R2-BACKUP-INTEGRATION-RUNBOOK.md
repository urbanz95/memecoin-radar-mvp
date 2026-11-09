# Solana scanner — R2 durable backup deployment runbook

**Status:** opt-in code integrated ONLY in
`feat/solana-r2-backup-bootstrap-20261109`, NOT live. Source branch for
future PR: `feat/solana-cloud-hosting-20261106`, never `main`.
Follow [issue #17](https://github.com/urbanz95/memecoin-radar-mvp/issues/17).

## Critical: deployment safety

**Do not manually deploy or enable R2 in Render now.** The existing
`solana-pump-radar-mvp` service uses a **free, ephemeral SQLite disk**.
The current approximately 256 MiB storage budget is not a persistent
volume. A Render deploy/restart may replace the live local SQLite,
and the existing Cloudflare D1 Worker stores only sampled candidates,
**not** a full backup. No account connection currently permits a
safe export of the running SQLite. Its pre-deployment historical contents
cannot be reconstructed from D1.

Creating an R2 bucket and merely merging this PR does **not** preserve
the current live database. A first external copy (or explicit user
acceptance of losing that local history) is a separate migration gate.

## What is integrated in code

- `src/cli.mjs` calls `bootstrapR2Backup` **before** constructing the
  `Scanner` / `Store`; restore is validated via SHA-256, SQL integrity,
  schema/table counts and published as a *new* SQLite file. Existing
  local SQLite is never replaced. Inaccessible/missing/corrupt R2
  prevents a silent empty replacement.
- Once the scanner is running, `R2BackupAgent` executes a delayed first
  snapshot then an in-process timer (default every 180 minutes).
  No GitHub/ChatGPT automation, external cron, API endpoint or RPC
  calls added. One backup at a time; failure is logged as a bounded
  error code and does not interrupt the WS scanner.
- A backup is published as immutable archive + manifest, verified
  by downloading/restoring a copy before CAS-updating the remote
  `latest.json`. The latest valid three copies remain in the index.
- `/health` contains only sanitized backup status, success/failure
  counters and last-success time; no account ID, bucket name, keys,
  SQL payloads or wallet addresses.
- The R2 S3 SDK is isolated under `backup-r2/`, installed by the
  staged `render.yaml` build command using a dedicated lockfile.
  This code is NEVER loaded if `SOLANA_R2_BACKUP_ENABLED` is unset
  or false.

## Required setup after the safety gate

The Cloudflare bucket must be **private**, R2 Standard, with
purpose-limited S3 credentials allowed only to read/write/list/delete
the backup bucket. No R2 credentials in source, PR comments, workflows
or public dashboard. The account and credentials are NOT created by
this repository.

Environment variables (configure only after the migration plan is ready):

| Variable | Role / example without secret |
| --- | --- |
| `SOLANA_R2_BACKUP_ENABLED` | `true`; false or missing = no R2 changes |
| `SOLANA_R2_ACCOUNT_ID` | 32 hex digits, from Cloudflare |
| `SOLANA_R2_ACCESS_KEY_ID` | secret, bucket-scoped S3 access key |
| `SOLANA_R2_SECRET_ACCESS_KEY` | secret, bucket-scoped S3 secret |
| `SOLANA_R2_BUCKET` | private bucket name (e.g. `solana-radar-backups`) |
| `SOLANA_R2_INTERVAL_MINUTES` | default 180; allowed 30–1440 |
| `SOLANA_R2_FIRST_DELAY_SECONDS` | default 120; allowed 5–3600 |
| `SOLANA_R2_MAX_OBJECT_BYTES` | default 536870912 (512 MiB) |
| `SOLANA_R2_MAX_REMOTE_BYTES` | default 6442450944 (6 GiB cap) |
| `SOLANA_R2_MAX_REMOTE_OBJECTS` | default 64 |
| `SOLANA_R2_MIN_SPARE_BYTES` | default 134217728 (128 MiB) |
| `SOLANA_R2_AUTO_PRUNE` | default false; do not enable before testing cleanup on real bucket |

There is **no implicit create-empty-database mode**. If a private
bucket is empty and a fresh start is explicitly acceptable, the
operator must set BOTH:

- `SOLANA_R2_ALLOW_FRESH_START=true`
- `SOLANA_R2_FRESH_START_NOT_AFTER=<UTC ISO8601 timestamp>` (up to
  24h in the future, then the permission automatically expires).

**Never leave these two migration variables enabled permanently.**
No automatic fresh start on an R2 network outage, partial manifest,
invalid hash or corrupt remote snapshot, even when a migration flag
is present. The scanner will fail startup instead.

Changing Render environment settings or deploying may itself
replace ephemeral SQLite; do not treat setting credentials as
harmless read-only work. Do not trigger it without separate
data-preservation evidence.

## Resource and retention limits

Before any snapshot the agent checks actual SQLite size, filesystem
space, remote object count and total R2 bytes. It reserves roughly
three extra database copies plus spare space for working files.
When there is insufficient disk or projected remote billable storage
exceeds a configured bound, the backup **fails closed** and the
scanner continues. A quota/space refusal is visible via sanitized
`/health.backup`; it is *not* proof that a recent backup exists.

`latest.json` tracks at most 3 versions, but **unreferenced objects
still physically exist**. Auto-pruning is optional and disabled by
default pending tests of real-world listing/concurrent writers.
When explicitly enabled, old unreferenced objects are pruned **before**
each remote quota check (and after success), so the quota limit does
not permanently block eligible cleanup. The default 6 GiB hard
budget leaves headroom under R2 Standard's 10 GB-month free allowance,
but external account usage and operations can still incur charges.
If disabled, orphan snapshots accumulate and eventually stop backups
at the hard object/byte limit.
R2 Standard free tier is subject to usage/billing limitations;
application limits are not a substitute for provider-side billing
controls. Backup RPO = time since last *successful* snapshot; any
data ingested since that time may be lost after a restart.

## Verification / release checklist

1. Confirm source branch and last Render deploy, and never mix
   with PR #33 Cloudflare Worker changes.
2. Node 22/24 full scanner suite + integration tests must be green.
3. Confirm a **private R2 test bucket** and cheap bounded smoke
   snapshot/restore from *synthetic* SQLite with actual S3 calls.
4. Validate R2 retention, provider storage/operation quotas, bucket
   permissions and interrupted uploads; turn on budget alerts.
5. Confirm safe preservation of the currently running Render SQLite,
   **or an explicitly accepted data-loss/migration plan**. D1 cannot
   replace this proof.
6. Confirm available ephemeral disk/RAM in the actual Render Free
   instance and fail-closed behavior. GitHub Actions benchmarks
   are not evidence of Render capacity.
7. Deploy only with controlled AutoDeploy OFF and confirm
   `/health.backup.lastSuccessfulAt` is populated, remote manifest
   hash verified and restore of a *new test instance* works.
8. After restoring from a real backup, verify counts/checkpoints and
   WS reconnect behavior; never claim full Solana trade coverage.

## Current blockers

- No Cloudflare R2 management plugin, linked bucket or S3 credentials
  is available to this ChatGPT session; no actual R2 API call made.
- No full read access to the live Render Free SQLite.
- The code is tested locally/CI, not deployed; enabling it with an
  empty R2 bucket and no migration plan would risk losing recent data.
- PR #33 still requires independent reconciliation with a Worker
  edited manually in Cloudflare.
