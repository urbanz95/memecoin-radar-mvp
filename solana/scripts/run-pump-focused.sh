#!/usr/bin/env bash
# Low-cost, read-only Pump.fun / PumpSwap profile. No paid RPC or trading required.
set -euo pipefail
cd "$(dirname "$0")/.."

# This profile intentionally observes only the two Pump protocols.
export SOLANA_PROGRAMS="pump_fun,pump_swap"
export SOLANA_LOG_OBSERVATIONS_ENABLED="true"

# Keep the experiment isolated from the main scanner and EVM databases.
export SOLANA_DB_PATH="${SOLANA_DB_PATH:-runtime/pump-focused/scanner.sqlite}"
export SOLANA_HEALTH_PORT="${SOLANA_HEALTH_PORT:-8791}"
export SOLANA_HEALTH_HOST="${SOLANA_HEALTH_HOST:-127.0.0.1}"

# Conservative public-RPC budget; override explicitly for a provider whose quota is known.
export SOLANA_RPC_REQUESTS_PER_MINUTE="${SOLANA_RPC_REQUESTS_PER_MINUTE:-12}"
export SOLANA_RPC_CONCURRENCY="${SOLANA_RPC_CONCURRENCY:-1}"
export SOLANA_QUEUE_CONCURRENCY="${SOLANA_QUEUE_CONCURRENCY:-1}"
export SOLANA_QUEUE_CAPACITY="${SOLANA_QUEUE_CAPACITY:-8}"
export SOLANA_MAX_DURABLE_BACKLOG="${SOLANA_MAX_DURABLE_BACKLOG:-64}"
export SOLANA_MAX_OBSERVATION_ROWS="${SOLANA_MAX_OBSERVATION_ROWS:-10000}"
export SOLANA_RECOVERY_PAGE_SIZE="${SOLANA_RECOVERY_PAGE_SIZE:-2}"
export SOLANA_RECOVERY_MAX_PAGES="${SOLANA_RECOVERY_MAX_PAGES:-1}"
export SOLANA_RECOVERY_BACKLOG_THRESHOLD="${SOLANA_RECOVERY_BACKLOG_THRESHOLD:-10}"
export SOLANA_SECURITY_ENABLED="${SOLANA_SECURITY_ENABLED:-false}"

# Experimental conservative FDV proxy gate for HTTP enrichment. Not circulating
# market cap: only fully evidenced, SOL-quoted Pump.fun log events can be skipped.
# A free public SOL/USD quote is requested at most once per two minutes; on
# failure/staleness/uncertainty the notification is NOT excluded.
export SOLANA_FDV_MINIMUM_USD="${SOLANA_FDV_MINIMUM_USD:-5000}"
export SOLANA_SOL_USD_FEED="${SOLANA_SOL_USD_FEED:-coingecko}"

printf '%s\n' '[pump-focused] Read-only: pump_fun,pump_swap; RPC budget 12 requests/min unless overridden.'
printf '%s\n' '[pump-focused] Log observations are intentionally incomplete; no trade signals or coverage guarantee.'
printf '%s\n' '[pump-focused] Experimental FDV gate: thresholds apply only with fresh quote, verified Pump supply and reserves; never assume unknown is below threshold.'
exec npm start
