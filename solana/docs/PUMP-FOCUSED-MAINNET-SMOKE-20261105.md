# Pump.fun / PumpSwap — short real Mainnet smoke (2026-11-05)

This report documents a **90.008-second live read-only trial** on a GitHub-hosted Ubuntu runner (Node 24.22.1). It is not a simulation, a claim of comprehensive token coverage or a production benchmark. The workflow's initial job-level configuration was rejected without running a scanner; the corrected job completed successfully.

## Verifiable provenance

- [Successful GitHub Actions run](https://github.com/urbanz95/memecoin-radar-mvp/actions/runs/42084224779)
- [Run artifacts](https://github.com/urbanz95/memecoin-radar-mvp/actions/runs/42084224779/artifacts/13440439981)
- [Machine-readable 90s report](../reports/pump-focused-smoke-20261105.json)
- Workflow source: `.github/workflows/solana-pump-smoke.yml`
- Original tested commit: `def20bf9b3ebb4c8459235bcb5f9174db31e3bc9`
- Time sampled: `2026-11-05T18:26:30.239Z` through `2026-11-05T18:28:00.247Z`
- `SOLANA_PROGRAMS=pump_fun,pump_swap`
- RPC budget: 12 HTTP attempts/min, 1 concurrent request. Security enrichment disabled. No private RPC key, trade, paid API or LLM invoked.

## Measured values

| Metric | Observed |
|---|---:|
| Notifications received in sample | 54,712 |
| Log observations decoded | 22,372 |
| Log observation insertions | 21,656 |
| Notifications skipped for HTTP context | 54,573 |
| Transactions enriched | 16 |
| Canonical events processed | 20 |
| HTTP RPC requests | 18 |
| RPC requests/min | 11.999 |
| Enriched transactions/min | 10.666 |
| Reconnection count delta | 1 |
| Recovery gap counter delta | 2 |
| Log decoder failures counter delta | 5 |
| Health status across samples | DEGRADED (19/19) |
| Pending inbox at end | 66 |
| Durable backlog gauge at end | 66 |
| Coverage overloaded at end | true |
| Log observations retained at end | 10,000 |
| Gap rows retained at end | 49 |
| Storage bytes at end | 95,716,328 |

### Measured latency distribution

These are **end-of-run process reservoir percentiles**, **not exact percentiles restricted to the 90-second sample**:

| Metric | p50 | p95 | p99 | Samples from process start (retained) |
|---|---:|---:|---:|---:|
| Log-observation commit | 164 ms | 268 ms | 279 ms | 17,296 (4,096) |
| Fully enriched event commit from live notification | 47,235 ms | 86,722 ms | 86,722 ms | 12 (12) |
| HTTP transaction enrichment, including budget and transport | 4,985 ms | 9,549 ms | 9,549 ms | 16 (16) |

`contextEnrichmentSkipped` counts notifications, not valid market events. `events_processed`, `transactionsProcessed`, and log observation counts represent distinct units. None can be directly divided to estimate full coverage.

This 90-second **two-protocol** run cannot be used to claim a speedup over the previous **four-protocol one-hour** run; both duration and observed universe differ, as do queue conditions. Long-term stability and total coverage remain unproven.

## Diagnosis and next small step

The fast log path is responsive, but the limited HTTP budget cannot enrich most incoming notifications. At the end the inbox exceeded the configured maximum and the scanner was degraded. The 12-sample enriched-event p95 remains much too slow for high-frequency trading decisions. Do not increase HTTP rate indiscriminately or claim that every unprocessed notification represents a valid trade.

Prioritize a **narrow, testable enrichment-selection strategy**, with new token creation, pool creation and migration prioritized where transaction-log evidence is sufficient. Keep a durable audit of skipped context and ensure no starvation/recovery regression. Measure the *same protocol scope and same RPC budget* before making claims of improvement. A provenance-checked pool/mint cache is a follow-up, not part of this measurement.

The short live smoke was performed in a GitHub Actions ephemeral runner. It does not mean that the scanner is deployed or operating continuously.
