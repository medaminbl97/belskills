#!/bin/sh
# Smoke test against a running, freshly synchronized backend.
# Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... scripts/smoke-test.sh [base_url]
#   SMOKE_COLLECTIONS          collections the admin must be able to read
#   SMOKE_SEEDED_COLLECTIONS   collections that must also hold rows (CMS_ENV=dev)
#   SMOKE_PUBLIC_COLLECTION    one collection anonymous users may read (published rows)
#   SMOKE_PRIVATE_COLLECTIONS  collections anonymous users must NOT be able to read
# The deeper checks live in tools/verify.mjs; this script only proves the stack serves.
set -eu

BASE_URL="${1:-http://127.0.0.1:${DIRECTUS_PORT:-8055}}"
: "${ADMIN_EMAIL:?ADMIN_EMAIL is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
SMOKE_COLLECTIONS="${SMOKE_COLLECTIONS:-languages articles}"
SMOKE_SEEDED_COLLECTIONS="${SMOKE_SEEDED_COLLECTIONS:-languages articles}"
SMOKE_PUBLIC_COLLECTION="${SMOKE_PUBLIC_COLLECTION:-articles}"
SMOKE_PRIVATE_COLLECTIONS="${SMOKE_PRIVATE_COLLECTIONS:-}"

fail() { echo "FAIL: $*" >&2; exit 1; }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

health=$(curl -fsS "$BASE_URL/server/health") || fail "/server/health unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "unhealthy: $health"
echo "OK /server/health"

# The credentials go in a JSON body from stdin so they never reach a process list.
login=$(printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD" |
  curl -fsS -H 'Content-Type: application/json' -d @- "$BASE_URL/auth/login") \
  || fail "admin login failed"
token=$(echo "$login" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || fail "admin login returned no access token"
echo "OK admin login"

for collection in $SMOKE_COLLECTIONS; do
  body=$(curl -fsS -H "Authorization: Bearer $token" "$BASE_URL/items/$collection?limit=1") \
    || fail "GET /items/$collection failed"
  echo "$body" | grep -q '"data"' || fail "/items/$collection returned no data key"
  echo "OK /items/$collection"
done

for collection in $SMOKE_SEEDED_COLLECTIONS; do
  body=$(curl -fsS -H "Authorization: Bearer $token" "$BASE_URL/items/$collection?limit=1")
  case "$body" in
    *'"data":[]'*) fail "$collection has no seeded rows (CMS_ENV=dev required)" ;;
  esac
  echo "OK seeded $collection"
done

# Anonymous users may read published content and nothing private.
if [ -n "$SMOKE_PUBLIC_COLLECTION" ]; then
  code=$(status "$BASE_URL/items/$SMOKE_PUBLIC_COLLECTION")
  [ "$code" = "200" ] || fail "anonymous read of $SMOKE_PUBLIC_COLLECTION returned $code, expected 200"
  echo "OK anonymous read of published content"
fi
for collection in $SMOKE_PRIVATE_COLLECTIONS; do
  code=$(status "$BASE_URL/items/$collection")
  [ "$code" = "403" ] || [ "$code" = "401" ] \
    || fail "anonymous read of $collection returned $code, expected 401 or 403"
done
[ -z "$SMOKE_PRIVATE_COLLECTIONS" ] || echo "OK anonymous access to private collections denied"

probe="${SMOKE_COLLECTIONS%% *}"
code=$(status -H "Authorization: Bearer invalid-token" "$BASE_URL/items/$probe")
[ "$code" = "401" ] || fail "invalid token returned $code, expected 401"
echo "OK invalid token rejected"
