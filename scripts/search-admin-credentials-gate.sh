#!/usr/bin/env bash
set -euo pipefail
umask 077

# Disposable Compose project only. No runtime volume or host port is touched.
mkdir -p .cache/results
if [[ -e .cache/search-db || -L .cache/search-db ]]; then
  echo 'Credential fixture requires an absent private root.' >&2
  exit 1
fi
scratch=$(mktemp -d "$PWD/.cache/results/search-admin-credentials.XXXXXXXX")
project="stationcred$(openssl rand -hex 8)"
export COMPOSE_FILE="$scratch/compose.yaml" COMPOSE_PROJECT_NAME="$project"
fixture_log="$scratch/fixture.log"
created=0
owned_root=0
cleanup() {
  if [[ "$created" == 1 ]]; then docker compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  if [[ "$owned_root" == 1 ]]; then rm -rf -- .cache/search-db; fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
mkdir -m 700 .cache/search-db
owned_root=1
cat > "$COMPOSE_FILE" <<'YAML'
services:
  postgres:
    image: pgvector/pgvector:0.8.7-pg16-bookworm
    environment:
      POSTGRES_USER: station
      POSTGRES_DB: station
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?fixture owner secret required}
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - default
      - search_admin_db
networks:
  search_admin_db:
    internal: true
volumes:
  pgdata: {}
YAML
test -z "$(docker compose ps -a -q)"
if docker volume inspect "${project}_pgdata" >/dev/null 2>&1 ||
   docker network inspect "${project}_default" >/dev/null 2>&1 ||
   docker network inspect "${project}_search_admin_db" >/dev/null 2>&1; then
  echo 'Disposable Compose project already owns resources.' >&2
  exit 1
fi
created=1
docker compose up -d postgres > "$fixture_log" 2>&1
id=$(docker compose ps -q postgres)
test -n "$id"
for attempt in {1..30}; do
  if docker exec "$id" pg_isready -U station -d station >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 30 ]]; then echo 'Disposable credential PG16 did not become ready.' >&2; exit 1; fi
  sleep 1
done
for migration in packages/db/drizzle/[0-9]*.sql; do
  docker exec -i "$id" psql -X -U station -d station -v ON_ERROR_STOP=1 < "$migration" >> "$fixture_log" 2>&1
done
uid=$(id -u)
gid=$(id -g)
test "$uid" -gt 0 && test "$gid" -gt 0
node scripts/search-admin-credentials.mjs create --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
node scripts/search-admin-credentials.mjs verify --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
docker compose up -d --force-recreate postgres >> "$fixture_log" 2>&1
id=$(docker compose ps -q postgres)
test -n "$id"
for attempt in {1..30}; do
  if docker exec "$id" pg_isready -U station -d station >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 30 ]]; then echo 'Recreated credential PG16 did not become ready.' >&2; exit 1; fi
  sleep 1
done
node scripts/search-admin-credentials.mjs verify --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
docker exec -i "$id" psql -X -U station -d station -v ON_ERROR_STOP=1 \
  -c 'REVOKE SELECT ON search_generation_control FROM station_search_verifier' >> "$fixture_log" 2>&1
if node scripts/search-admin-credentials.mjs verify --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1; then
  echo 'Read-only credential verification repaired a missing grant.' >&2
  exit 1
fi
test "$(docker exec "$id" psql -X -U station -d station -Atqc \
  "SELECT has_table_privilege('station_search_verifier','search_generation_control','SELECT')")" = f
docker exec -i "$id" psql -X -U station -d station -v ON_ERROR_STOP=1 \
  -c 'GRANT SELECT ON search_generation_control TO station_search_verifier' >> "$fixture_log" 2>&1
node scripts/search-admin-credentials.mjs verify --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
if node scripts/search-admin-credentials.mjs abort-pending-create --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1; then
  echo 'Published bundle was aborted.' >&2
  exit 1
fi
for role in verifier transition; do
  if grep -F -f ".cache/search-db/initial-v1/$role.password" "$fixture_log" >/dev/null; then
    rm -f -- "$fixture_log"
    echo 'Credential fixture output contained a password.' >&2
    exit 1
  fi
done
echo 'PASS: disposable PG16 owner-local create, SCRAM login/wrong-password, retained read-only verify, and abort denial.'
