#!/usr/bin/env bash
# Container hosting profile (e.g. Render Free). No local computer required.
# Runtime disk is ephemeral: do not claim that historical SQLite is durable.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PORT:=10000}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "INVALID_CLOUD_PORT" >&2
  exit 1
fi
export SOLANA_HEALTH_HOST="0.0.0.0"
export SOLANA_HEALTH_PORT="$PORT"
export SOLANA_PUBLIC_DASHBOARD_ONLY="true"
# Free public RPC: only verified P0 lifecycle context is eligible for costly
# transaction enrichment. Trades remain available as PARTIAL log observations.
export SOLANA_CONTEXT_MAX_PRIORITY="${SOLANA_CONTEXT_MAX_PRIORITY:-0}"
# Drop queued live context after 90 seconds rather than enriching stale trades.
# No effect on the separate event log projection or recovery entries.
export SOLANA_CONTEXT_MAX_AGE_MS="${SOLANA_CONTEXT_MAX_AGE_MS:-90000}"
export SOLANA_DB_PATH="${SOLANA_DB_PATH:-runtime/cloud-pump/scanner.sqlite}"
# Keep the exact same Pump.fun/PumpSwap protocol, RPC and FDV policies.
exec bash scripts/run-pump-focused.sh
