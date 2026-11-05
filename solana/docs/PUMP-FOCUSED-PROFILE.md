# Pump.fun / PumpSwap focused profile

This is an **opt-in** low-RPC operating profile for the existing Solana scanner. It introduces no protocol decoder, scoring, AI agent, wallet trade, recurring background task, paid API, or deployment. Existing four-program defaults remain unchanged when using `npm start` directly.

## Why

The Mainnet 60-minute validation reported fast-but-incomplete log observations and a heavily delayed HTTP enrichment path. Reducing the subscribed universe from four programs to Pump.fun + PumpSwap does not solve the HTTP capacity limit, but makes an inexpensive, measurable first experiment possible. Do not compare the resulting rates to the four-program baseline as if the universe were identical.

## Run on a supported Linux machine

Node >=22.13, `flock` and persistent storage are required.

```bash
cd solana
npm ci --ignore-scripts
npm test
bash scripts/run-pump-focused.sh
```

Run separately, while the scanner is active:

```bash
curl http://127.0.0.1:8791/health
curl 'http://127.0.0.1:8791/observations?limit=20'
curl 'http://127.0.0.1:8791/events?limit=20'
curl http://127.0.0.1:8791/gaps
```

## Short, read-only diagnostic report

With the focused scanner **already running** in another terminal, sample its **local** health endpoint for three minutes:

```bash
cd solana
node scripts/pump-focused-smoke.mjs --seconds 180 --interval 10
```

This uses only `http://127.0.0.1:8791/health`, so the monitor adds **zero Solana RPC calls**. It writes `runtime/pump-focused-smoke.json` containing the observed-window counter deltas, HTTP RPC usage, enriched transaction rate, context skipped, final backlog, status counts, and end-of-window process latency reservoir. It does **not** claim a full-coverage index or an exact per-window p95.

A scanner restart, disappearing counter, unreachable local endpoint, or invalid response causes the monitor to fail rather than producing a misleading benchmark. The script deliberately does not start the scanner, fetch private RPC URLs, trade, send Telegram messages or use AI APIs. It does not require one-hour live tests.

Run the isolated deterministic tests using:

```bash
node --test test/pump-focused-smoke.test.mjs
```

Compare future smoke reports only if both runs have comparable settings, duration and observable program scope. Store missing or ambiguous metrics as unknown, not zero.

The profile uses a separate SQLite path (`runtime/pump-focused/scanner.sqlite`) and local API port (8791), so it does not overwrite a previous experiment. `npm start` invokes the existing `flock` lock. Stop with Ctrl-C; do not delete WAL or lock files from a running process.

## Budget and limits

- `SOLANA_PROGRAMS=pump_fun,pump_swap`, log-first observation enabled.
- Defaults to **12 HTTP RPC requests per minute**, one RPC and one worker concurrency; the provider's actual quota may differ.
- Limits durable enrichment backlog to 64 and observation retention to the last 10,000 rows.
- Uses small recovery pages, and disables optional mint security reads to preserve scarce RPC. This **does not prove a token safe**.
- `SOLANA_DB_PATH`, `SOLANA_HEALTH_PORT`, and RPC budget/concurrency variables may be overridden. Use a separate database and API port for concurrent trials.
- RPC credentials, if the operator supplies them, must remain in environment variables and never be committed.

**Important:** even with only two programs, log observations may lack pool mints, exact executable exit liquidity and verified full trade context. Some notifications will not be selected for HTTP enrichment. Record `contextEnrichmentSkipped`, `durableBacklog`, `coverageOverloaded`, reconnects, gaps, and both independent latency measurements. Never describe the output as a complete market index.

## Next validation, before optimization

Perform a short manual smoke check (e.g. 3–5 minutes), without a one-hour soak. Confirm the health endpoint, arrivals in `/observations`, any `/events`, resource usage and gap counters. If there is no full event in a short sample, report that honestly. Do not infer it is a decoder defect from absence alone.

Only after collecting a focused baseline should the next code change target selective HTTP enrichment and a provenance-checked pool/mint cache, each in its own small testable patch. Do not alter the EVM/Phase3B branches.
