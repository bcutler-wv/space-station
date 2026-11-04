#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd)"
mkdir -p .cache/results
test_root="$(mktemp -d "$repo_root/.cache/results/search-writer-role-apply-render-XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
cp compose.yaml compose.search-writer-role-apply.yaml "$test_root/"
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
export STATION_WRITER_APPLY_PUBLIC_ROOT="$test_root/.cache/search-create-apply-public/$invocation_id"
export STATION_WRITER_APPLY_VOLUME_NAME="writer_apply_fixture_search_writer_apply_${invocation_id//-/}"
override_file="$(node "$repo_root/tests/support/search-writer-role-apply-merged-render-check.mjs" write "$test_root")"
for test_id in 1000 1001; do
  export APP_UID="$test_id" APP_GID="$test_id"
  "${compose[@]}" -p writer_apply_fixture -f compose.yaml -f compose.search-writer-role-apply.yaml \
    --profile search-writer-role-apply config --format json \
    search-writer-role-apply-transfer search-writer-role-apply |
    node "$repo_root/tests/support/search-writer-role-apply-render-check.mjs" "$test_id" "$test_root"
  "${compose[@]}" -p writer_apply_fixture -f compose.yaml -f compose.search-writer-role-apply.yaml \
    --profile search-writer-role-apply config --format json \
    search-writer-role-apply-transfer search-writer-role-apply |
    node "$repo_root/tests/support/search-writer-role-apply-service-config-negative.mjs" "$test_root"
  "${compose[@]}" -p writer_apply_fixture -f compose.yaml -f compose.search-writer-role-apply.yaml \
    --profile search-writer-role-apply config --format json \
    search-writer-role-apply-transfer search-writer-role-apply |
    node "$repo_root/tests/support/search-writer-role-apply-owner-docker-scripted.mjs" "$test_root"
  "${compose[@]}" -p writer_apply_fixture -f compose.yaml -f compose.search-writer-role-apply.yaml \
    -f "$override_file" --profile search-writer-role-apply config --format json \
    search-writer-role-apply-transfer search-writer-role-apply |
    node "$repo_root/tests/support/search-writer-role-apply-merged-render-check.mjs" check "$test_root"
  "${compose[@]}" -p writer_apply_fixture -f compose.yaml config --format json app worker |
    node "$repo_root/tests/support/search-create-boundary-app-worker-config.mjs" "$test_root"
done
