#!/usr/bin/env bash
set -euo pipefail
umask 077

# Disposable PG16 only. Never run the role policy against the runtime database.
container=station-search-admin-pg16
container_id=
secret_root=
fixture_log="$PWD/.cache/results/search-admin-roles-gate.log"
cleanup() {
  if [[ -n "$container_id" ]]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$secret_root" ]]; then rm -rf -- "$secret_root"; fi
}
trap cleanup EXIT
mkdir -p .cache/results
secret_root=$(mktemp -d "$PWD/.cache/results/search-admin-role-secrets.XXXXXXXX")
: > "$fixture_log"
container_id=$(docker run --rm -d --name "$container" \
  -p 127.0.0.1:55433:5432 \
  -e POSTGRES_USER=station -e POSTGRES_DB=station \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  pgvector/pgvector:0.8.7-pg16-bookworm)

for attempt in {1..30}; do
  if docker exec "$container" pg_isready -U station -d station >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 30 ]]; then echo 'Disposable PG16 did not become ready.' >&2; exit 1; fi
  sleep 1
done
for migration in packages/db/drizzle/[0-9]*.sql; do
  docker exec -i "$container" psql -X -U station -d station -v ON_ERROR_STOP=1 \
    < "$migration" >/dev/null
done
docker exec -i "$container" psql -X -U station -d station -v ON_ERROR_STOP=1 \
  < ops/postgres/search-admin-roles.sql >/dev/null
fixture_status=0
SEARCH_ADMIN_TEST_SECRET_ROOT="$secret_root" node tests/support/search-admin-provision.mjs container > "$fixture_log" 2>&1 || fixture_status=$?
if [[ "$fixture_status" == 0 ]]; then
  SEARCH_ADMIN_TEST_HOST=127.0.0.1 SEARCH_ADMIN_TEST_OWNER_HOST=127.0.0.1 \
  SEARCH_ADMIN_TEST_PORT=55433 SEARCH_ADMIN_TEST_SECRET_ROOT="$secret_root" \
    node tests/integration/search-admin-roles-db.mjs >> "$fixture_log" 2>&1 || fixture_status=$?
fi
for password_file in "$secret_root/verifier.password" "$secret_root/transition.password"; do
  if [[ -f "$password_file" ]] && grep -F -f "$password_file" "$fixture_log" >/dev/null; then
    rm -f -- "$fixture_log"
    echo 'Disposable restricted-role secret appeared in fixture output.' >&2
    exit 1
  fi
done
if [[ "$fixture_status" != 0 ]]; then
  echo 'Disposable restricted-role fixture failed; retained bounded log is private.' >&2
  exit "$fixture_status"
fi
cat "$fixture_log"
