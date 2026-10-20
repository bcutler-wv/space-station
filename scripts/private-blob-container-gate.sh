#!/usr/bin/env bash
set -euo pipefail

test "${APP_UID:-1000}" = 1001
test "${APP_GID:-1000}" = 1001
test "$(docker compose exec -T app id -u)" = 1001
test "$(docker compose exec -T worker id -u)" = 1000
docker compose exec -T worker id -G | tr ' ' '\n' | grep -qx 1001

app_key=$(docker compose exec -T app node tests/integration/private-blob-volume.mjs write app-content | tr -d '\r')
docker compose exec -T worker node tests/integration/private-blob-volume.mjs read "$app_key" app-content
worker_key=$(docker compose exec -T worker node tests/integration/private-blob-volume.mjs write worker-content | tr -d '\r')
docker compose exec -T app node tests/integration/private-blob-volume.mjs read "$worker_key" worker-content

parser_id=$(docker compose ps -q mime-parser)
test -n "$parser_id"
if docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "$parser_id" | grep -Fq '/var/lib/station/blobs'; then
  echo 'Parser must not mount the private blob volume' >&2
  exit 1
fi

docker compose restart app worker
docker compose exec -T app node tests/integration/private-blob-volume.mjs read "$worker_key" worker-content
docker compose exec -T worker node tests/integration/private-blob-volume.mjs read "$app_key" app-content
docker compose exec -T app node tests/integration/private-blob-volume.mjs delete "$app_key"
docker compose exec -T worker node tests/integration/private-blob-volume.mjs delete "$worker_key"
