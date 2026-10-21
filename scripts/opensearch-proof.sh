#!/usr/bin/env bash
set -euo pipefail

image='opensearchproject/opensearch:3.9.0@sha256:adfa61f85025d06b4aeb562e7e74fde7e31c437039c93c3862c17e9acebd6c7c'
client_image='node:22.23.2-bookworm-slim'
run_id="${GITHUB_RUN_ID:-local}"
attempt="${GITHUB_RUN_ATTEMPT:-1}"
[[ "$run_id" =~ ^[0-9]+$|^local$ ]] && [[ "$attempt" =~ ^[0-9]+$ ]]
name="station-os-proof-${run_id}-${attempt}"
client_name="${name}-client"
network="${name}-net"
volume="${name}-data"
artifact="$PWD/.cache/results/opensearch-proof"
mkdir -p "$artifact"
chmod 700 "$artifact"

network_created=0
volume_created=0
monitor_pid=''
owned() {
  test "$(docker inspect --format '{{index .Config.Labels "station-proof"}}' "$1" 2>/dev/null)" = "$name"
}
cleanup() {
  status=$?
  trap - EXIT
  set +e
  if owned "$client_name"; then docker rm --force "$client_name" >/dev/null 2>&1; fi
  if owned "$name"; then
    docker inspect --format '{{json .State}}' "$name" > "$artifact/engine-state.json" 2>/dev/null
    docker logs --tail 100 "$name" 2>&1 | head -c 65536 > "$artifact/engine-tail.log"
    docker rm --force "$name" >/dev/null 2>&1
  fi
  if [[ -n "$monitor_pid" ]]; then kill "$monitor_pid" 2>/dev/null; wait "$monitor_pid" 2>/dev/null; fi
  if ! node scripts/opensearch-proof-summarize.mjs "$artifact" >/dev/null 2>&1; then
    if [[ "$status" == 0 ]]; then status=1; fi
  fi
  if [[ "$volume_created" == 1 ]]; then docker volume rm "$volume" >/dev/null 2>&1; fi
  if [[ "$network_created" == 1 ]]; then docker network rm "$network" >/dev/null 2>&1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

timeout --signal=TERM --kill-after=10s 6m docker pull "$image"
timeout --signal=TERM --kill-after=10s 2m docker pull "$client_image"
docker image inspect --format '{{.Size}}' "$image" > "$artifact/image-size-bytes.txt"
timeout --signal=TERM --kill-after=10s 1m docker buildx imagetools inspect --raw "$image" > "$artifact/image-index.json"
child_digest="$(node -e 'const m=require(process.argv[1]); const e=m.manifests?.find(x=>x.platform?.os==="linux"&&x.platform?.architecture==="amd64"); if(!e?.digest)process.exit(1); console.log(e.digest)' "$artifact/image-index.json")"
timeout --signal=TERM --kill-after=10s 1m docker buildx imagetools inspect --raw "opensearchproject/opensearch@$child_digest" > "$artifact/image-amd64-manifest.json"
node -e 'const m=require(process.argv[1]); const n=m.layers?.reduce((s,x)=>s+x.size,0); if(!Number.isSafeInteger(n)||n<=0)process.exit(1); console.log(n)' "$artifact/image-amd64-manifest.json" > "$artifact/image-pull-bytes.txt"
docker network create --internal "$network" >/dev/null
network_created=1
docker volume create "$volume" >/dev/null
volume_created=1

# A writable ephemeral image layer is required for the pinned image's
# keystore/config startup path. Only fake data is persisted in this owned volume.
docker run --detach --name "$name" --network "$network" --network-alias station-opensearch \
  --label "station-proof=$name" \
  --user 1000:1000 --memory 2g --memory-swap 2g --cpus 2 --pids-limit 512 \
  --cap-drop ALL --security-opt no-new-privileges \
  --ulimit nofile=65536:65536 --tmpfs /tmp:rw,exec,nosuid,size=128m \
  --volume "$volume:/usr/share/opensearch/data" \
  --env 'discovery.type=single-node' \
  --env 'DISABLE_INSTALL_DEMO_CONFIG=true' \
  --env 'DISABLE_SECURITY_PLUGIN=true' \
  --env 'DISABLE_PERFORMANCE_ANALYZER_AGENT_CLI=true' \
  --env 'OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g' \
  "$image" >/dev/null

docker inspect --format '{{json .HostConfig}}' "$name" > "$artifact/host-config.json"
docker inspect --format '{{json .NetworkSettings.Ports}}' "$name" > "$artifact/ports.json"
test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$name")" = "$network"
test "$(docker inspect --format '{{.HostConfig.Memory}}' "$name")" = 2147483648
test "$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$name")" = 2000000000
test "$(docker inspect --format '{{index .HostConfig.Tmpfs "/tmp"}}' "$name")" = 'rw,exec,nosuid,size=128m'
test "$(docker network inspect --format '{{.Internal}}' "$network")" = true
test "$(docker inspect --format '{{.Config.User}}' "$name")" = '1000:1000'
test "$(docker port "$name" | wc -l)" -eq 0
engine_started_at="$(date -u -d "$(docker inspect --format '{{.State.StartedAt}}' "$name")" +%s%3N)"
printf '%s\n' "$engine_started_at" > "$artifact/engine-started-at-ms.txt"

# Catch immediate JVM bootstrap failures before the client spends the full
# readiness window retrying a DNS name whose container has already exited.
for _ in $(seq 1 8); do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]]; then
    printf 'OpenSearch proof engine exited during bootstrap; see bounded engine state/log artifacts.\n' >&2
    exit 1
  fi
  sleep 1
done

(
  for _ in $(seq 1 600); do
    docker stats --no-stream --format '{{json .}}' "$name" 2>/dev/null || break
    rss="$(docker exec "$name" /bin/sh -ec '
      for file in /proc/[0-9]*/status; do
        if grep -q "^Name:[[:space:]]*java$" "$file"; then
          awk "/^VmRSS:/ { printf \"%.0f\\n\", \$2 * 1024; exit }" "$file"
          exit
        fi
      done
      exit 1
    ' 2>/dev/null || true)"
    if [[ "$rss" =~ ^[0-9]+$ ]]; then
      printf '{"atMs":%s,"rssBytes":%s}\n' "$(date +%s%3N)" "$rss" >> "$artifact/process-rss.jsonl"
    fi
    sleep 2
  done
) > "$artifact/stats.jsonl" &
monitor_pid=$!

timeout --signal=TERM --kill-after=10s 18m docker run --rm --network "$network" \
  --name "$client_name" --label "station-proof=$name" \
  --user "$(id -u):$(id -g)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 64 --memory 768m --cpus 1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --volume "$PWD/tests/integration/opensearch-proof.mjs:/work/tests/integration/opensearch-proof.mjs:ro" \
  --volume "$PWD/packages/search/dist:/work/packages/search/dist:ro" \
  --volume "$PWD/node_modules:/work/node_modules:ro" \
  --volume "$artifact:/out" \
  --workdir /work \
  --env 'OPENSEARCH_URL=http://station-opensearch:9200' \
  --env 'OPENSEARCH_PROOF_OUT=/out/results.json' \
  --env "OPENSEARCH_ENGINE_STARTED_AT=$engine_started_at" \
  "$client_image" node tests/integration/opensearch-proof.mjs
