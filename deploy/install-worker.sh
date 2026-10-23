#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $EUID -ne 0 ]]; then echo 'Executar com sudo num servidor Linux dedicado ao worker.' >&2; exit 1; fi
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
for bin in /usr/bin/flock /usr/bin/systemctl; do
  if [[ ! -x "$bin" ]]; then echo "Requisito em falta: $bin" >&2; exit 1; fi
done
export PATH=/usr/local/bin:/usr/bin:/bin
command -v npm >/dev/null || { echo 'Instalar Node.js >=22 e npm para todos os utilizadores.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo 'Instalar Node.js >=22 para todos os utilizadores antes de continuar.' >&2; exit 1; }
if ! getent passwd memecoin-radar >/dev/null; then
  useradd --system --user-group --home-dir /var/lib/memecoin-radar --shell /usr/sbin/nologin memecoin-radar
fi
install -d -m 0755 /opt/memecoin-radar
if systemctl is-active --quiet memecoin-radar; then systemctl stop memecoin-radar; fi
if [[ "$source_dir" != /opt/memecoin-radar ]]; then
  tar -C "$source_dir" --exclude='./node_modules' --exclude='./runtime' --exclude='./.git' --exclude='./.env' --exclude='./.env.*' -cf - . | tar -C /opt/memecoin-radar -xf -
fi
cd /opt/memecoin-radar
npm ci --ignore-scripts
npm run validate
chown -R root:root /opt/memecoin-radar
find /opt/memecoin-radar -type d -exec chmod a+rx {} +
find /opt/memecoin-radar -type f ! -name '.env*' -exec chmod a+r {} +
install -d -m 0700 -o memecoin-radar -g memecoin-radar /var/lib/memecoin-radar
if [[ ! -f /etc/memecoin-radar.env ]]; then
  install -m 0600 /dev/null /etc/memecoin-radar.env
  cat > /etc/memecoin-radar.env <<'ENV'
RADAR_DATA_DIR=/var/lib/memecoin-radar
RADAR_POLL_SECONDS=60
RADAR_RETENTION_DAYS=7
RADAR_MAX_ARCHIVE_BYTES=8589934592
# ROBINHOOD_RPC_URL=https://endpoint-privado-opcional
ENV
fi
install -m 0644 deploy/memecoin-radar.service /etc/systemd/system/memecoin-radar.service
systemctl daemon-reload
systemctl enable --now memecoin-radar
systemctl --no-pager --full status memecoin-radar
