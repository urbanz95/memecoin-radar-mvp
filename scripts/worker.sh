#!/usr/bin/env bash
set -euo pipefail
umask 077
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
export RADAR_DATA_DIR="${RADAR_DATA_DIR:-$project_dir/runtime/worker}"
mkdir -p -- "$RADAR_DATA_DIR"
if ! command -v flock >/dev/null; then
  echo 'O worker requer Linux com flock (util-linux).' >&2
  exit 1
fi
# O kernel liberta este lock após SIGKILL/reboot. Nunca remover um lock por PID.
exec flock --exclusive --nonblock --no-fork "$RADAR_DATA_DIR/worker.lock" node src/worker/cli.mjs "$@"
