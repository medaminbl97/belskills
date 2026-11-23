#!/bin/sh
# Smoke test against a running CMS.
# Usage: ADMIN_TOKEN=... SMOKE_COLLECTIONS="a b" SMOKE_SEEDED_COLLECTIONS="a" scripts/smoke-test.sh [base_url]
#   SMOKE_COLLECTIONS         collections that must be readable
#   SMOKE_SEEDED_COLLECTIONS  collections that must also contain seeded rows (CMS_ENV=dev)
set -eu

BASE_URL="${1:-http://127.0.0.1:${DIRECTUS_PORT:-8055}}"
: "${ADMIN_TOKEN:?ADMIN_TOKEN is required}"
SMOKE_COLLECTIONS="${SMOKE_COLLECTIONS:-}"
SMOKE_SEEDED_COLLECTIONS="${SMOKE_SEEDED_COLLECTIONS:-}"

fail() { echo "FAIL: $*" >&2; exit 1; }

health=$(curl -fsS "$BASE_URL/server/health") || fail "/server/health unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "unhealthy: $health"
echo "OK /server/health"

for collection in $SMOKE_COLLECTIONS; do
  body=$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_URL/items/$collection?limit=1&fields=*") \
    || fail "GET /items/$collection failed"
  echo "$body" | grep -q '"data"' || fail "/items/$collection returned no data key: $body"
  echo "OK /items/$collection"
done

for collection in $SMOKE_SEEDED_COLLECTIONS; do
  body=$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE_URL/items/$collection?limit=1&fields=*")
  echo "$body" | grep -q '"data":\[\]' && fail "$collection has no seeded items (CMS_ENV=dev required)"
  echo "OK seeded $collection"
done

# An invalid token must be rejected. Probe the first listed collection, if any.
probe="${SMOKE_COLLECTIONS%% *}"
if [ -n "$probe" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer invalid-token" "$BASE_URL/items/$probe")
  [ "$code" = "401" ] || fail "invalid token returned $code, expected 401"
  echo "OK auth rejection"
fi
