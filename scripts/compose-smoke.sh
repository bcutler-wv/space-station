#!/usr/bin/env bash
set -euo pipefail

docker compose up -d --build postgres migrate
docker compose up -d --build --wait app worker

curl --fail --silent http://127.0.0.1:8080/health >/dev/null
curl --fail --silent http://127.0.0.1:8080/ready >/dev/null
curl --fail --silent http://127.0.0.1:8080/ | rg -q '<div id="root"'
asset_path=$(curl --fail --silent http://127.0.0.1:8080/ | rg -o '/assets/[^" ]+\.js' | head -n 1)
curl --fail --silent "http://127.0.0.1:8080${asset_path}" >/dev/null

test "$(docker compose exec -T postgres psql -U station -d station -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_name='settings'")" = "1"
test "$(docker compose exec -T postgres psql -U station -d station -Atqc "SELECT count(*) FROM pg_extension WHERE extname='vector'")" = "1"
test "$(docker compose exec -T postgres psql -U station -d station -Atqc "SELECT count(*) FROM drizzle.__drizzle_migrations")" = "1"

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

docker compose stop app worker
docker compose restart postgres
docker compose up -d --force-recreate migrate
docker compose up -d --wait app worker
test "$(docker compose exec -T postgres psql -U station -d station -Atqc "SELECT count(*) FROM drizzle.__drizzle_migrations")" = "1"
test "$(docker compose run --rm -T worker node apps/worker/dist/probe.js status "$job_id" | tail -n 1)" = "completed"
curl --fail --silent http://127.0.0.1:8080/ready >/dev/null
