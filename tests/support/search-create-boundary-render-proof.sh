#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd)"
mkdir -p .cache/results
test_root="$(mktemp -d "$repo_root/.cache/results/search-create-render-XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
cp compose.yaml compose.search-create-boundary.yaml "$test_root/"
mkdir -p "$test_root/.cache"
printf 'GOCAMO_HMAC=fixture-only\n' > "$test_root/.cache/go-camo.env"
cd "$test_root"
if [[ -n "${STATION_COMPOSE_BINARY:-}" ]]; then
  compose=("$STATION_COMPOSE_BINARY")
else
  compose=(docker compose)
fi
invocation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export POSTGRES_PASSWORD='fixture-only-password'
export STATION_MASTER_KEY='fixture-only-master-key'
export APP_ORIGIN='https://example.com'
export STATION_CREATE_INVOCATION_ROOT="$test_root/.cache/search-create-invocations/$invocation_id"
export STATION_CREATE_VOLUME_NAME='create_fixture_search_create_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa'
for test_id in 1000 1001; do
  export APP_UID="$test_id" APP_GID="$test_id"
  "${compose[@]}" -p create_fixture -f compose.yaml -f compose.search-create-boundary.yaml \
    --profile search-create-boundary config --format json \
    search-create-transfer search-create-boundary |
    node "$repo_root/tests/support/search-create-boundary-render-check.mjs" "$test_id"
  "${compose[@]}" -p create_fixture -f compose.yaml config --format json app worker |
    node "$repo_root/tests/support/search-create-boundary-app-worker-config.mjs" "$test_root"
done
unset STATION_CREATE_INVOCATION_ROOT STATION_CREATE_VOLUME_NAME
"${compose[@]}" -p create_fixture -f compose.yaml config --quiet
