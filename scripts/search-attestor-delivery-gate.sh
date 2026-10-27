#!/usr/bin/env bash
set -euo pipefail
umask 077

# Disposable Ubuntu gate. Never run from an installation checkout.
if [[ ! -d .git || -e .env || -e .cache/search-db || -e .cache/search-security ]]; then
  echo 'Attestor delivery gate requires a clean CI checkout.' >&2
  exit 1
fi
runner_root=$PWD
runner_uid=$(id -u)
runner_gid=$(id -g)
docker_gid=$(stat -c '%g' /var/run/docker.sock)
if [[ $runner_uid == 0 || $runner_uid == 1000 || $runner_gid == 0 ]]; then
  echo 'Attestor delivery gate requires a non-root non-default runner.' >&2
  exit 1
fi
mkdir -p .cache/results
gate_root=$(mktemp -d "$PWD/.cache/results/search-attestor-delivery.XXXXXXXX")
phase=setup
pair=none
checkout=''
pair_home=''
pair_uid=''
pair_gid=''
private_log="$gate_root/gate.log"
: > "$private_log"
teardown_failed=0
ancestor_paths=()
ancestor_modes=()
make_traversable() {
  local target=$1 current='' part owner mode
  local -a parts
  IFS=/ read -r -a parts <<< "${target#/}"
  for part in "${parts[@]}"; do
    [[ -n $part ]] || continue
    current="$current/$part"
    if sudo setpriv --reuid=1000 --regid=1000 --groups="$docker_gid" test -x "$current"; then continue; fi
    owner=$(stat -c '%u' -- "$current")
    mode=$(stat -c '%a' -- "$current")
    [[ $owner == "$runner_uid" && -d $current && ! -L $current ]] || {
      echo 'UID 1000 checkout traversal is outside disposable runner ownership.' >&2; exit 1;
    }
    ancestor_paths+=("$current")
    ancestor_modes+=("$mode")
    chmod o+x -- "$current"
  done
}
run_pair() {
  if [[ $pair_uid == 1000 ]]; then
    sudo setpriv --reuid=1000 --regid=1000 --groups="$docker_gid" \
      env -i PATH="$PATH" HOME="$pair_home" APP_UID="$pair_uid" APP_GID="$pair_gid" "$@"
  else
    env -i PATH="$PATH" HOME="$pair_home" APP_UID="$pair_uid" APP_GID="$pair_gid" "$@"
  fi
}
run_step() {
  phase=$1
  shift
  echo "Attestor delivery checkpoint pair=$pair step=$phase started."
  if "$@" >> "$private_log" 2>&1; then
    echo "Attestor delivery checkpoint pair=$pair step=$phase passed."
  else
    local code=$?
    echo "Attestor delivery checkpoint pair=$pair step=$phase failed exit=$code." >&2
    exit "$code"
  fi
}
cleanup_pair() {
  if [[ -n $checkout && -f $checkout/.env && -d $pair_home ]]; then
    (cd "$checkout" && run_pair env STATION_ATTESTOR_INVOCATION_ROOT="$checkout/.cache" \
      STATION_ATTESTOR_PUBLIC_ROOT="$checkout/.cache" \
      STATION_ATTESTOR_VOLUME_NAME="$(basename "$checkout")_search_attestor_buildplaceholder" \
      docker compose -f compose.yaml -f compose.search-attestor.yaml \
      --profile search --profile search-attestor down -v --remove-orphans) >> "$private_log" 2>&1 || teardown_failed=1
    local volume project_name listing
    project_name=$(basename "$checkout")
    local reference
    if ! listing=$(docker ps -a --no-trunc --filter "label=station.attestor.gate=$project_name" --format '{{.ID}}' 2>> "$private_log"); then
      teardown_failed=1; listing=''
    fi
    [[ ${#listing} -le 8192 ]] || teardown_failed=1
    while IFS= read -r reference; do
      [[ -n $reference ]] || continue
      if [[ $reference =~ ^[0-9a-f]{64}$ ]]; then
        docker container rm -f "$reference" >> "$private_log" 2>&1 || teardown_failed=1
      else
        teardown_failed=1
      fi
    done <<< "$listing"
    for service in search-attestor-prepare search-attestor-transfer search-engine-attestor; do
      if ! listing=$(docker ps -a --no-trunc --filter "label=com.docker.compose.project=$project_name" \
        --filter "label=com.docker.compose.service=$service" --format '{{.ID}}' 2>> "$private_log"); then
        teardown_failed=1; listing=''
      fi
      [[ ${#listing} -le 8192 ]] || teardown_failed=1
      while IFS= read -r reference; do
        [[ -n $reference ]] || continue
        if [[ $reference =~ ^[0-9a-f]{64}$ ]]; then
          docker container rm -f "$reference" >> "$private_log" 2>&1 || teardown_failed=1
        else
          teardown_failed=1
        fi
      done <<< "$listing"
    done
    if ! listing=$(docker volume ls --filter "label=station.attestor.project=$project_name" --format '{{.Name}}' 2>> "$private_log"); then
      teardown_failed=1; listing=''
    fi
    [[ ${#listing} -le 8192 ]] || teardown_failed=1
    while IFS= read -r volume; do
      [[ -n $volume ]] || continue
      if [[ $volume =~ ^${project_name}_search_attestor_[0-9a-f]{32}$ ]]; then
        docker volume rm "$volume" >> "$private_log" 2>&1 || teardown_failed=1
      else
        teardown_failed=1
      fi
    done <<< "$listing"
  fi
  if [[ -n $checkout ]]; then sudo rm -rf -- "$checkout" || teardown_failed=1; fi
  if [[ -n $pair_home ]]; then sudo rm -rf -- "$pair_home" || teardown_failed=1; fi
  checkout=''
  pair_home=''
}
cleanup() {
  local status=$?
  cleanup_pair
  [[ $teardown_failed == 0 ]] || status=1
  for ((i=${#ancestor_paths[@]}-1; i>=0; i--)); do
    chmod "${ancestor_modes[i]}" -- "${ancestor_paths[i]}" || status=1
  done
  if [[ $status != 0 ]]; then
    grep '^Attestor delivery fixture failed at ' "$private_log" | tail -n 1 >&2 || true
    rm -rf -- "$gate_root" || status=1
    echo "Attestor delivery gate failed at pair=$pair phase=$phase; private log removed." >&2
  else
    rm -rf -- "$gate_root" || status=1
  fi
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT
make_traversable "$runner_root"
make_traversable "$gate_root"

# The runner's CLI plugins can live in a user directory. Private copies let
# UID 1000 use the same Compose and Buildx executables without DOCKER_CONFIG.
phase=plugin-discovery
plugin_json="$gate_root/plugins.json"
docker info --format '{{json .ClientInfo.Plugins}}' > "$plugin_json"
plugin_path() { node -e '
  const fs=require("node:fs");
  const all=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const selected=all.filter(x=>x.Name===process.argv[2] && typeof x.Path==="string" && x.Path.startsWith("/"));
  if(selected.length!==1)process.exit(1);
  process.stdout.write(selected[0].Path);
' "$plugin_json" "$1"; }
compose_plugin=$(realpath -e -- "$(plugin_path compose)")
buildx_plugin=$(realpath -e -- "$(plugin_path buildx)")
test -f "$compose_plugin" && test -x "$compose_plugin"
test -f "$buildx_plugin" && test -x "$buildx_plugin"

for pair in default runner; do
  phase=clone
  if [[ $pair == default ]]; then pair_uid=1000; pair_gid=1000;
  else pair_uid=$runner_uid; pair_gid=$runner_gid; fi
  name="stationattestor${pair}$(openssl rand -hex 6)"
  checkout="$gate_root/$name"
  mkdir -m 700 -- "$checkout"
  tar -C "$runner_root" --exclude=.git --exclude=.cache --exclude=node_modules \
    --exclude=LOCAL.md --exclude=.env --exclude=results --exclude=test-results \
    --exclude=playwright-report -cf - . | tar -C "$checkout" -xf -
  ln -s "$runner_root/node_modules" "$checkout/node_modules"
  while IFS= read -r -d '' module_dir; do
    relative=${module_dir#"$runner_root"/}
    ln -s "$module_dir" "$checkout/$relative"
  done < <(find "$runner_root/apps" "$runner_root/packages" -mindepth 2 -maxdepth 2 \
    -type d -name node_modules -print0)
  sudo chown -R "$pair_uid:$pair_gid" "$checkout"
  sudo chmod 755 "$checkout"
  pair_home="$gate_root/home-$pair"
  run_step private-home-root sudo install -d -m 0700 -o "$pair_uid" -g "$pair_gid" "$pair_home"
  run_step private-home-docker sudo install -d -m 0700 -o "$pair_uid" -g "$pair_gid" "$pair_home/.docker"
  run_step private-home-plugins sudo install -d -m 0700 -o "$pair_uid" -g "$pair_gid" "$pair_home/.docker/cli-plugins"
  run_step compose-plugin-copy sudo install -m 0700 -o "$pair_uid" -g "$pair_gid" \
    "$compose_plugin" "$pair_home/.docker/cli-plugins/docker-compose"
  run_step buildx-plugin-copy sudo install -m 0700 -o "$pair_uid" -g "$pair_gid" \
    "$buildx_plugin" "$pair_home/.docker/cli-plugins/docker-buildx"
  for private_directory in "$pair_home" "$pair_home/.docker" "$pair_home/.docker/cli-plugins"; do
    phase=private-home-owner
    if [[ $(stat -c '%u:%g' -- "$private_directory") != "$pair_uid:$pair_gid" ]]; then
      echo "Attestor delivery checkpoint pair=$pair step=$phase failed class=ownership." >&2
      exit 1
    fi
    run_step private-home-write run_pair test -w "$private_directory"
  done
  cd "$checkout"
  run_step compose-plugin run_pair docker compose version
  run_step buildx-plugin run_pair docker buildx version
  run_step init-env run_pair node scripts/init-env.mjs
  run_step init-search-security run_pair node scripts/init-search-security.mjs
  run_step image-build run_pair env STATION_ATTESTOR_INVOCATION_ROOT="$checkout/.cache" \
    STATION_ATTESTOR_PUBLIC_ROOT="$checkout/.cache" \
    STATION_ATTESTOR_VOLUME_NAME="${name}_search_attestor_buildplaceholder" \
    docker compose -f compose.yaml -f compose.search-attestor.yaml \
    --profile search --profile search-attestor build \
    search-init search-profile-introduce search-profile-bootstrap \
    search-attestor-prepare search-attestor-transfer search-engine-attestor
  run_step postgres-start run_pair docker compose up -d --wait postgres
  phase=postgres-id
  if postgres_id=$(run_pair docker compose ps -q postgres 2>> "$private_log"); then
    if [[ $postgres_id =~ ^[0-9a-f]{64}$ ]]; then
      echo "Attestor delivery checkpoint pair=$pair step=$phase passed."
    else
      echo "Attestor delivery checkpoint pair=$pair step=$phase failed class=identity." >&2
      exit 1
    fi
  else
    code=$?
    echo "Attestor delivery checkpoint pair=$pair step=$phase failed exit=$code." >&2
    exit "$code"
  fi
  migration_count=0
  for migration in packages/db/drizzle/[0-9]*.sql; do
    migration_count=$((migration_count + 1))
    run_step "migration-$migration_count" run_pair docker exec -i "$postgres_id" \
      psql -X -U station -d station -v ON_ERROR_STOP=1 < "$migration"
  done
  run_step credentials-create run_pair node scripts/search-admin-credentials.mjs create \
    --uid "$pair_uid" --gid "$pair_gid"
  # E0b stays root:1000 for the fixed consumer under either owner pair.
  run_step search-init run_pair env APP_GID=1000 docker compose --profile search run --rm -T --no-deps search-init
  run_step opensearch-start run_pair docker compose --profile search up -d --no-deps opensearch
  run_step security-bootstrap run_pair docker compose --profile search run --rm -T --no-deps search-security-bootstrap
  run_step profile-introduce run_pair docker compose --profile search --profile search-introduce run --rm -T --no-deps \
    search-profile-introduce
  run_step profile-bootstrap run_pair docker compose --profile search run --rm -T --no-deps search-profile-bootstrap
  phase=legacy-marker
  if marker=$(run_pair docker compose --profile search run --rm -T --no-deps \
    --entrypoint cat search-profile-bootstrap /run/station-state/v1-profile-complete 2>> "$private_log"); then
    echo "Attestor delivery checkpoint pair=$pair step=$phase passed."
  else
    code=$?
    echo "Attestor delivery checkpoint pair=$pair step=$phase failed exit=$code." >&2
    exit "$code"
  fi
  phase=legacy-marker-identity
  index_uuid=$(tail -n 1 <<< "$marker")
  if [[ ! $index_uuid =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
    echo "Attestor delivery checkpoint pair=$pair step=$phase failed class=identity." >&2
    exit 1
  fi
  run_step legacy-enrollment run_pair docker exec "$postgres_id" psql -X -U station -d station -v ON_ERROR_STOP=1 -q \
    -c "BEGIN; INSERT INTO search_generation_history (generation_token,physical_index,profile_id,index_uuid,lifecycle) VALUES ('legacy-v1','station-mail-v1','station-mail-v1','$index_uuid','roles_attested'); UPDATE search_generation_control SET source_generation_token='legacy-v1',revision=revision+1 WHERE singleton=1 AND stage='disabled' AND source_generation_token IS NULL; COMMIT;"
  run_step delivery run_pair node tests/integration/search-attestor-delivery.mjs
  run_step secret-scan sudo "$(command -v node)" tests/support/search-attestor-delivery-log-scan.mjs "$private_log"
  phase=teardown
  cleanup_pair
  [[ $teardown_failed == 0 ]]
  echo "PASS: disposable PG16/OpenSearch TLS attestor delivery for $pair owner pair."
  cd "$runner_root"
done
