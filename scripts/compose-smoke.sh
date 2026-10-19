#!/usr/bin/env bash
set -euo pipefail

phase='Compose startup'
trap 'status=$?; echo "Smoke failed during: $phase (exit $status)" >&2; docker compose ps --all >&2 || true; exit "$status"' ERR
echo "Smoke phase: $phase"
docker compose up -d --build postgres migrate
docker compose up -d --build --wait app worker

phase='HTTP and built asset'
echo "Smoke phase: $phase"
curl --insecure --fail --silent https://localhost:8080/health >/dev/null
curl --insecure --fail --silent https://localhost:8080/ready >/dev/null
page_html=$(curl --insecure --fail --silent https://localhost:8080/)
grep -Fq '<div id="root"' <<< "$page_html"
asset_path=$(sed -n 's/.*src="\(\/assets\/[^"[:space:]]*\.js\)".*/\1/p' <<< "$page_html")
test -n "$asset_path"
curl --insecure --fail --silent "https://localhost:8080${asset_path}" >/dev/null

phase='database migration'
echo "Smoke phase: $phase"
test "$(docker compose exec -T postgres psql -U station -d station -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_name='settings'")" = "1"
test "$(docker compose exec -T postgres psql -U station -d station -Atqc "SELECT count(*) FROM pg_extension WHERE extname='vector'")" = "1"
test "$(docker compose exec -T postgres psql -U station -d station -Atqc "SELECT count(*) FROM drizzle.__drizzle_migrations")" = "2"
test "$(curl --insecure --silent --output /dev/null --write-out '%{http_code}' https://localhost:8080/api/appearance)" = "401"

phase='private owner setup token'
echo "Smoke phase: $phase"
mkdir -p -m 700 .cache/bootstrap
docker compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$PWD/.cache/bootstrap:/run/bootstrap" app node apps/server/dist/bootstrap-cli.js /run/bootstrap/token
test "$(stat -c %a .cache/bootstrap/token)" = "600"

phase='worker stop and resume'
echo "Smoke phase: $phase"
docker compose stop worker
if docker compose run --rm -T worker node apps/worker/dist/health.js; then
  echo 'Worker health incorrectly passed without a consumer.' >&2
  exit 1
fi
job_id=$(docker compose run --rm -T worker node apps/worker/dist/probe.js send | tail -n 1)
test "$(docker compose run --rm -T worker node apps/worker/dist/probe.js status "$job_id" | tail -n 1)" = "created"
docker compose up -d --wait worker
docker compose exec -T worker node apps/worker/dist/health.js
test "$(docker compose run --rm -T worker node apps/worker/dist/probe.js wait "$job_id" | tail -n 1)" = "completed"

phase='Postgres restart and migration rerun'
echo "Smoke phase: $phase"
docker compose stop app worker
docker compose restart postgres
docker compose up -d --force-recreate migrate
docker compose up -d --wait app worker
test "$(docker compose exec -T postgres psql -U station -d station -Atqc "SELECT count(*) FROM drizzle.__drizzle_migrations")" = "2"
test "$(docker compose run --rm -T worker node apps/worker/dist/probe.js status "$job_id" | tail -n 1)" = "completed"
curl --insecure --fail --silent https://localhost:8080/ready >/dev/null
