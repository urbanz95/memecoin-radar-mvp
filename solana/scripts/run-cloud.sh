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
export SOLANA_DB_PATH="${SOLANA_DB_PATH:-runtime/cloud-pump/scanner.sqlite}"
# Keep the exact same Pump.fun/PumpSwap protocol, RPC and FDV policies.
exec bash scripts/run-pump-focused.sh
