#!/bin/sh
set -eu

cd /directus
node cli.js bootstrap

HOST=127.0.0.1 PORT=8056 node cli.js start &
server_pid=$!

cleanup() {
  if kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid"
    wait "$server_pid" || true
  fi
}

trap cleanup EXIT
trap 'exit 1' INT TERM

node /opt/schema-loader/scripts/apply-schemas.js
cleanup
trap - EXIT INT TERM

exec pm2-runtime start ecosystem.config.cjs
