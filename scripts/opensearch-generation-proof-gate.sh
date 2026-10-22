#!/usr/bin/env bash
set -euo pipefail

proof_container="station-generation-proof"
expected_uid="$(id -u)"
expected_gid="$(id -g)"
test "$expected_uid" -ne 0 || expected_uid=1000
test "$expected_gid" -ne 0 || expected_gid=1000
cleanup() { docker rm -f "$proof_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker compose --profile search --profile fixture run -d --name "$proof_container" --no-deps search-generation-proof >/dev/null
docker inspect "$proof_container" | node scripts/check-generation-proof-container.mjs "$expected_uid" "$expected_gid"
network_id="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.NetworkID}}{{end}}' "$proof_container")"
test -n "$network_id"
test "$(docker network inspect --format '{{.Internal}}' "$network_id")" = true
status="$(timeout 240s docker wait "$proof_container")"
docker logs --tail=20 "$proof_container"
test "$status" = 0
