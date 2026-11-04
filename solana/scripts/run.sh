#!/usr/bin/env bash
set -euo pipefail
# The kernel owns this new scanner's lock; no old Robinhood locks are accessed.
db_path="${SOLANA_DB_PATH:-runtime/solana/scanner.sqlite}"
mkdir -p "$(dirname "$db_path")"
exec flock -n "$db_path.process.lock" node "$@"
