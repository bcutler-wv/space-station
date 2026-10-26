#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd)"
mkdir -p .cache/results
test_root="$(mktemp -d "$repo_root/.cache/results/search-attestor-render-XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
cp compose.yaml compose.search-attestor.yaml "$test_root/"
mkdir -p "$test_root/.cache"
printf 'GOCAMO_HMAC=fixture-only\n' > "$test_root/.cache/go-camo.env"
cd "$test_root"
if [[ -n "${STATION_COMPOSE_BINARY:-}" ]]; then
  compose=("$STATION_COMPOSE_BINARY")
else
  compose=(docker compose)
fi
test_invocation='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export POSTGRES_PASSWORD='fixture-only-password'
export STATION_MASTER_KEY='fixture-only-master-key'
export APP_ORIGIN='https://example.com'
export STATION_ATTESTOR_INVOCATION_ROOT="$test_root/.cache/search-attestor-invocations/$test_invocation"
export STATION_ATTESTOR_PUBLIC_ROOT="$test_root/.cache/search-attestor-public/$test_invocation"
export STATION_ATTESTOR_VOLUME_NAME='attestor_fixture_search_attestor_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa'
for test_id in 1000 1001; do
  export APP_UID="$test_id" APP_GID="$test_id"
  "${compose[@]}" -p attestor_fixture -f compose.yaml -f compose.search-attestor.yaml \
    --profile search-attestor config --format json \
    search-attestor-prepare search-attestor-transfer search-engine-attestor |
    node "$repo_root/tests/support/search-attestor-render-check.mjs" "$test_id"
done

unset STATION_ATTESTOR_INVOCATION_ROOT STATION_ATTESTOR_PUBLIC_ROOT STATION_ATTESTOR_VOLUME_NAME
"${compose[@]}" -p attestor_fixture -f compose.yaml config --quiet
