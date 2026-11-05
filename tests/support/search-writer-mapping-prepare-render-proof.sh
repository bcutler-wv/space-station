#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd)"
mkdir -p .cache/results
test_root="$(mktemp -d "$repo_root/.cache/results/search-writer-mapping-render-XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
cp compose.yaml compose.search-writer-mapping-prepare.yaml "$test_root/"
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
export STATION_WRITER_MAPPING_PREPARE_PUBLIC_ROOT="$test_root/.cache/search-writer-mapping-prepare-public/$invocation_id"
export STATION_WRITER_MAPPING_PREPARE_INVOCATION_ROOT="$test_root/.cache/search-writer-mapping-invocations/$invocation_id"
export STATION_WRITER_MAPPING_PREPARE_VOLUME_NAME="writer_mapping_fixture_search_writer_mapping_prepare_${invocation_id//-/}"
for test_id in 1000 1001; do
  export APP_UID="$test_id" APP_GID="$test_id"
  "${compose[@]}" -p writer_mapping_fixture -f compose.yaml -f compose.search-writer-mapping-prepare.yaml \
    --profile search-writer-mapping-prepare config --format json \
    search-writer-mapping-prepare-transfer search-writer-mapping-prepare |
    node "$repo_root/tests/support/search-writer-mapping-prepare-render-check.mjs" "$test_id" "$test_root"
  "${compose[@]}" -p writer_mapping_fixture -f compose.yaml config --format json app worker |
    node "$repo_root/tests/support/search-create-boundary-app-worker-config.mjs" "$test_root"
done
