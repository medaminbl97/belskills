#!/bin/sh
# Bootstraps Directus, then on a private loopback server applies the baked-in
# revisions (schema and data), access policies and seeds, then starts the public
# server. The public port stays closed until all of that has succeeded.
set -eu

internal_port="${SYNC_PORT:-8057}"
temporary_pid=""

stop_temporary() {
  if [ -n "$temporary_pid" ]; then
    kill "$temporary_pid" 2>/dev/null || true
    wait "$temporary_pid" 2>/dev/null || true
    temporary_pid=""
  fi
}
trap 'stop_temporary; exit 143' TERM INT
trap stop_temporary EXIT

# Wait until PostgreSQL accepts connections. After a host reboot the database
# container can come up after this one, and depends_on does not order restarts.
# Without DB_HOST (an external database URL, say) nothing is awaited.
if [ -n "${DB_HOST:-}" ]; then
  deadline=$(($(date +%s) + ${DB_WAIT_SECONDS:-300}))
  until node -e "const s = require('node:net').connect({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), timeout: 3000 }); s.on('connect', () => process.exit(0)); s.on('timeout', () => process.exit(1)); s.on('error', () => process.exit(1))"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "PostgreSQL at $DB_HOST:${DB_PORT:-5432} did not answer within ${DB_WAIT_SECONDS:-300}s" >&2
      exit 1
    fi
    echo "Waiting for PostgreSQL at $DB_HOST:${DB_PORT:-5432}..."
    sleep 3
  done
fi

node cli.js bootstrap

HOST=127.0.0.1 PORT="$internal_port" node cli.js start >/dev/null 2>&1 &
temporary_pid=$!

DIRECTUS_URL="http://127.0.0.1:$internal_port" \
  node /opt/schema-loader/scripts/sync.js

stop_temporary
trap - EXIT TERM INT
exec pm2-runtime start ecosystem.config.cjs
