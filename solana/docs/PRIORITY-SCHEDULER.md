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
- Tiered reservations prevent lower priorities from filling the entire inbox: with 64 total slots, P3 may fill 44; P2 may use up to 48, P1 up to 56, and P0 up to the full 64. The resulting reserved capacities are P0=8, P1=8, P2=4, configured by `SOLANA_PRIORITY_RESERVED_P0_SLOTS`, `_P1_SLOTS`, `_P2_SLOTS`. No extra total slots or RPC budget are created.
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
- `contextPriorityReservedAdmissionSkip` / `contextSkippedPriorityReservation`: lower-priority notification denied by reservation for a higher priority, separately from full durable backlog and unflushed ingress buffer. Since these are optional metrics, the smoke sampler only asserts cause completeness when all required counters were observed in the sample.

These counters have **different stages and denominators**. `seen` is not a count of successful or supported market trades, `scheduled` is not a count of completed HTTP calls, and `observations` are not enriched transactions.

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

### First live priority run (before P1/P2 reservation fix)

The [first 90-second focused priority experiment](https://github.com/urbanz95/memecoin-radar-mvp/actions/runs/42122178889) is retained in [this exact JSON](../reports/p0-p3-mainnet-90s-20261105.json). It had 56,997 notifications, 23 P0 seen/admitted, 13 P0 dispatched, 75 P1 seen/**zero P1 admitted**, 18 HTTP RPC and 15 enriched transactions. The P1 admission failure was a genuine problem: P3 traffic filled its shared allotment before P1 arrivals. The tiered reserve is the response to this measured issue; the *first* report predates the second revision and must not be presented as its proof. This same early run incorrectly categorized reservation-based skips as ingress buffer pressure. The scanner and sampler have been fixed to distinguish those causes, requiring a new measurement to validate the corrected accounting.

The p95 enriched event time in the first run was not a meaningful proof of speed improvement (short 90s, mixed events and limited completed samples).

### Second live Mainnet run (tiered reservations and corrected attribution)

The [second live run](https://github.com/urbanz95/memecoin-radar-mvp/actions/runs/42123286038) sampled **90.035 seconds**, with both Pump.fun and PumpSwap and the same 12 HTTP RPC requests/min ceiling. Its [machine-readable report](../reports/priority-scheduler-tiered-mainnet-90s-20261105.json) records:

| Metric during sampled interval | Value |
|---|---:|
| Observed notifications | 53,963 |
| P0 seen / admitted / selected for async queue | 23 / **23** / 11 |
| P1 seen / admitted / selected for async queue | 97 / **13** / 6 |
| P2 seen / admitted / selected for async queue | 3,623 / **1** / 3 |
| P3 seen / admitted / selected for async queue | 49,651 / 0 / 3 |
| P0 / P1 / P2 HTTP context transactions processed (counter deltas) | 7 / **4** / 5 |
| HTTP RPC requests / enriched transactions | **18 / 16** |
| Skips due specifically to reserved admission capacity | 53,357 |
| Admission skip cause reconciliation | **Complete**, 0 unexplained |
| Degraded status samples | 16 / 19 |
| Pending inbox at end | 59 |
| Log-observation process-reservoir p95 | 298 ms |

The P3 scheduled work was admitted before the first sample, explaining nonzero P3 scheduling despite zero **new** P3 admissions in this interval. Likewise, completed transaction counts can correspond to HTTP requests started before the sample. The 90-second sample is *not* a controlled comparison of processing speed or market coverage.

**Finding:** the revised reservation policy successfully admitted some P1 and P2 notifications that would otherwise compete with a continuously populated P3 inbox. This shows changed selection, **not** an increase in throughput: RPC is still saturated, the status is mostly degraded, and complete trade coverage is unproven. We must still implement explicit recovery-budget sharing and better token-level selection before trading alert logic.

## Follow-up

Next small piece: safely measure **time to first complete event by priority**, and separate live RPC from finality/recovery budgets. Prioritize not losing critical creation/migration facts when the 64-row backlog is at maximum; the present reservation reduces pressure but does not eliminate the possibility of missing HTTP context when completely full.
