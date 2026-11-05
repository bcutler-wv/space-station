#!/usr/bin/env bash
set -euo pipefail
repo_root="$(pwd)"
mkdir -p .cache/results
test_root="$(mktemp -d "$repo_root/.cache/results/search-writer-mapping-apply-render-XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
cp compose.yaml compose.search-writer-mapping-apply.yaml "$test_root/"
mkdir -p "$test_root/.cache"
printf 'GOCAMO_HMAC=fixture-only\n' > "$test_root/.cache/go-camo.env"
cd "$test_root"
if [[ -n "${STATION_COMPOSE_BINARY:-}" ]]; then compose=("$STATION_COMPOSE_BINARY");
else compose=(docker compose); fi
invocation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
project='mapping_apply_fixture'
export POSTGRES_PASSWORD='fixture-only-password' STATION_MASTER_KEY='fixture-only-master-key'
export APP_ORIGIN='https://example.com'
export STATION_WRITER_MAPPING_APPLY_PUBLIC_ROOT="$test_root/.cache/search-writer-mapping-apply-public/$invocation_id"
export STATION_WRITER_MAPPING_APPLY_VOLUME_NAME="${project}_search_writer_mapping_apply_${invocation_id//-/}"
for test_id in 1000 1001; do
  export APP_UID="$test_id" APP_GID="$test_id"
  "${compose[@]}" -p "$project" -f compose.yaml -f compose.search-writer-mapping-apply.yaml \
    --profile search-writer-mapping-apply config --format json \
    search-writer-mapping-apply-transfer search-writer-mapping-apply |
    node "$repo_root/tests/support/search-writer-mapping-apply-render-check.mjs" base "$test_id" "$test_root"
  override="$test_root/override-$test_id.json"
  node -e 'const fs=require("fs");const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",s=id.replaceAll("-","");const project="mapping_apply_fixture";const a=["a".repeat(64),"7","22222222-2222-4222-8222-222222222222","legacy-v1","station-mail-v1","legacy_uuid","11111111-1111-4111-8111-111111111111","station-mail-v2-g11111111111141118111111111111111","created_uuid",id,project,"16384","123"];fs.writeFileSync(process.argv[1],JSON.stringify({services:{"search-writer-mapping-apply-transfer":{container_name:`station_mapping_apply_transfer_${s}`},"search-writer-mapping-apply":{container_name:`station_mapping_apply_${s}`,command:["node","scripts/search-writer-mapping-consumer.mjs",...a]}}}));' "$override"
  "${compose[@]}" -p "$project" -f compose.yaml -f compose.search-writer-mapping-apply.yaml \
    -f "$override" --profile search-writer-mapping-apply config --format json \
    search-writer-mapping-apply-transfer search-writer-mapping-apply |
    node "$repo_root/tests/support/search-writer-mapping-apply-render-check.mjs" merged "$test_id" "$test_root"
done
