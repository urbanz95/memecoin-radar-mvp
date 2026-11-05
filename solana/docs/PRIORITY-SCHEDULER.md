# P0–P3 HTTP enrichment scheduler — first experimental slice

This work is **only** for the opt-in Pump.fun/PumpSwap focused profile. It changes which **already observed** transaction signatures enter and leave the durable HTTP enrichment inbox. It is **not** a trading score, a coverage guarantee or a deployment. The scanner's default `npm start` remains FIFO unless the mode is enabled.

## Ranking

| Priority | Evidence in decoded real `logsSubscribe` observations | Purpose |
|---|---|---|
| P0 | Mint/pool identified and lifecycle event `TOKEN_CREATED`, `POOL_CREATED`, `TOKEN_MIGRATED`, `TOKEN_GRADUATED` | Context for newly created token, pool or migration |
| P1 | Verified Pump.fun buy/sell/curve event with FDV gate marking it `ENRICH` | Context for higher-interest, sufficiently evidenced token |
| P2 | Verified buy/sell, curve-progress or liquidity event without proven P1 FDV evidence | Ordinary context |
| P3 | No supported real log event, unknown/failing context, or legacy persisted entry | Exploratory sample; no unsupported upgrade |

Verification requires `evidenceStatus=VERIFIED_RPC_LOG_EVENT` and `evidenceSource.kind=rpc:logsSubscribe` plus token mint identity for P0/P1/P2. This does **not** prove that every other field is complete.

The **FDV filter runs first**. When a Pump.fun event has sufficiently supported FDV below the configured floor, its logs still persist, but HTTP enrichment is skipped. That event does not enter any P0–P3 inbox. Thus, P0 means P0 among *admitted* observations, not a guarantee that every created token is enriched.

## Admission / dispatch

- The durable inbox remains capped by `SOLANA_MAX_DURABLE_BACKLOG=64` in the focused mode.
- `SOLANA_PRIORITY_RESERVED_P0_SLOTS=8` reserves eight of those existing slots for P0 arrivals. Non-P0 admissions stop at 56 combined pending+unflushed entries; P0 may use up to the full 64. No extra slots, RPC budget or memory-intensive parallel jobs are created.
- With pending entries in all tiers, queue selection rotates with weights **4:2:1:1**, using the interleaved cycle `[P0,P0,P1,P0,P2,P0,P1,P3]`. This is a bounded fair **dispatch policy** and cannot guarantee 4:2:1:1 actual RPC calls (failed RPC requests, backoff, finality and recovery share the limiter). P3 is not starved merely because P0 is always populated.
- All admitted signatures remain stored in the same SQLite `inbox` table. The priority is encoded in its existing JSON payload. No database schema migration; old entries naturally fall into P3. The old FIFO `Store.pending()` is unchanged and used when the feature flag is disabled.
- `Store.pendingByPriority()` selects bounded queries from durable SQLite inbox; asynchronous work still uses the existing bounded queue, retry logic, reconciliation and global request limiter. SQLite durability does not imply that requests never fail or that the market event stream is exhaustive.
- **Logs are independent**: the `event_observations` and raw log evidence are still buffered and persisted before admission. When HTTP admission is skipped because of capacity, an explicit counter records the priority. At the configured retention cap, older log observations are pruned as before; this is not unlimited archival.
- Recovery RPC is **not reserved** in this first slice. The existing recovery gating remains, and recovery can still be delayed during continuous overload. Do not claim otherwise.

## Diagnostics

Use `GET http://127.0.0.1:8791/health` and the focused smoke report. New process counters:

- `contextPrioritySeenP0..P3`: incoming notifications after low-FDV filtering, classified by rank (even when later rejected for capacity).
- `contextPriorityAdmittedP0..P3`: notifications placed into the in-memory ingress buffer.
- `contextPrioritySkippedP0..P3`: notifications denied by durable backlog/reserved admission limit.
- `contextPriorityScheduledP0..P3`: signatures submitted from the durable SQLite inbox to the bounded async queue.
- `contextPriorityCompletedP0..P3`: signatures whose decoded transaction and events were successfully persisted; retries and already-completed signatures do not increment these counters.
- `contextPriorityCompletionLatencyP0Ms..P3Ms`: elapsed wall-clock milliseconds from initial receipt to successful persistence, measured only on successful context enrichment. Histograms use process lifetime/reservoir, not the short smoke interval.
- `contextPriorityReservedAdmissionSkip`: non-P0 notifications denied by the P0 reservation when the full limit has not yet been reached.

These counters have **different stages and denominators**. `seen` is not a count of successful or supported market trades, `scheduled` is not a count of completed HTTP calls, and `completed` is not a count of all observed trades, and `observations` are not enriched transactions.

The health report includes `contextPriorityScheduler.enabled`, the policy string and P0 reservation. The smoke utility already captures all counter deltas, so it will expose P0–P3 counters without creating new HTTP/RPC calls.

## Opt-in and rollback

```bash
cd solana
npm ci --ignore-scripts
npm test
bash scripts/run-pump-focused.sh
```

The focused launcher enables this experimental scheduler and the existing $5k FDV filter. To restore the previous first-in-first-out behavior without touching the rest of the focused profile:

```bash
SOLANA_CONTEXT_PRIORITIES_ENABLED=false bash scripts/run-pump-focused.sh
```

To restore both the old admission strategy and no FDV gate:

```bash
SOLANA_CONTEXT_PRIORITIES_ENABLED=false SOLANA_FDV_MINIMUM_USD=0 bash scripts/run-pump-focused.sh
```

No keys, trades, paid RPC, Codex credits, merge or deployment.

## Evidence and measurement

- Deterministic tests in `solana/test/enrichment-priority.test.mjs` cover P0 proof requirements, P1/P2/P3 fallback, older SQLite rows, bounded fair scheduling, cache-visible outcomes, P0 admission reservation, and retention of raw observed logs.
- This branch builds upon [the FDV PR #12](https://github.com/urbanz95/memecoin-radar-mvp/pull/12), which is itself stacked upon the [focused profile PR #10](https://github.com/urbanz95/memecoin-radar-mvp/pull/10).
- The previous short Mainnet FDV test [is here](../reports/fdv-filter-5k-mainnet-90s-20261105.json) and ran **before** the priority scheduler.
- The 90-second live priority-scheduler run has its own GitHub Actions record; compare only protocol scope and limit-normalized deltas. Different market windows and data distributions cannot prove an actual causal speed improvement. The 90-second run is too short to prove starvation prevention in production.

## Follow-up

Next small piece: safely measure **time to first complete event by priority**, and separate live RPC from finality/recovery budgets. Prioritize not losing critical creation/migration facts when the 64-row backlog is at maximum; the present reservation reduces pressure but does not eliminate the possibility of missing HTTP context when completely full.
