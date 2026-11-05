#!/usr/bin/env bash
set -euo pipefail
umask 077

# Disposable Ubuntu gate. Never run from an installation checkout.
if [[ ! -d .git || -e .env || -e .cache/search-db || -e .cache/search-security ]]; then
  echo 'Create boundary delivery gate requires a clean CI checkout.' >&2
  exit 1
fi
writer_variant=${STATION_WRITER_PREPARE_GATE_VARIANT:-}
delivery_case=${STATION_WRITER_DELIVERY_GATE_CASE:-}
delivery_pair=${STATION_WRITER_DELIVERY_GATE_PAIR:-}
mapping_case=${STATION_WRITER_MAPPING_PREPARE_GATE_CASE:-}
mapping_pair=${STATION_WRITER_MAPPING_PREPARE_GATE_PAIR:-}
source "$PWD/tests/support/search-create-ordinary-pairs.sh"
if [[ -n $mapping_case || -n $mapping_pair ]]; then
  if ! select_writer_mapping_prepare_pair "$mapping_case" "$mapping_pair" \
      "${STATION_CREATE_GATE_PAIR:-}" "$writer_variant" "$delivery_case" "$delivery_pair"; then
    echo 'Create boundary delivery gate has an invalid mapping-preparation selection.' >&2
    exit 1
  fi
  ordinary_pairs=("${mapping_pairs[@]}")
  writer_variant=$mapping_pair
  delivery_case=positive
  delivery_pair=$mapping_pair
elif ! select_create_ordinary_pairs "${STATION_CREATE_GATE_PAIR:-}" \
    "$writer_variant" "$delivery_case" "$delivery_pair"; then
  echo 'Create boundary delivery gate has an invalid ordinary pair selection.' >&2
  exit 1
fi
if [[ -n $delivery_case && -z $mapping_case ]]; then
  if [[ -n $writer_variant || ! $delivery_case =~ ^(positive|prestart|lost-return|false-ack|held-timeout)$ ||
        ! $delivery_pair =~ ^(default|runner)$ ]]; then
    echo 'Create boundary delivery gate has an invalid writer-delivery case.' >&2
    exit 1
  fi
  writer_variant=$delivery_pair
elif [[ -n $delivery_pair && -z $mapping_case ]]; then
  echo 'Create boundary delivery gate has an invalid writer-delivery pair.' >&2
  exit 1
fi
if [[ -n $writer_variant && ! $writer_variant =~ ^(default|runner|runner-volume|runner-missing-o)$ ]]; then
  echo 'Create boundary delivery gate has an invalid disposable variant.' >&2
  exit 1
fi
runner_root=$PWD
source "$runner_root/tests/support/search-create-private-log-scan.sh"
runner_uid=$(id -u)
runner_gid=$(id -g)
docker_gid=$(stat -c '%g' /var/run/docker.sock)
if [[ $runner_uid == 0 || $runner_uid == 1000 || $runner_gid == 0 ]]; then
  echo 'Create boundary delivery gate requires a non-root non-default runner.' >&2
  exit 1
fi
mkdir -p .cache/results
gate_root=$(mktemp -d "$PWD/.cache/results/search-create-boundary-delivery.XXXXXXXX")
phase=setup
pair=none
checkout=''
pair_home=''
pair_uid=''
pair_gid=''
private_log="$gate_root/gate.log"
: > "$private_log"
teardown_failed=0
marker_files=()
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
  echo "Create boundary delivery checkpoint pair=$pair step=$phase started."
  if "$@" >> "$private_log" 2>&1; then
    echo "Create boundary delivery checkpoint pair=$pair step=$phase passed."
  else
    local code=$?
    echo "Create boundary delivery checkpoint pair=$pair step=$phase failed exit=$code." >&2
    exit "$code"
  fi
}
cleanup_pair() {
  if [[ -n $checkout && -f $checkout/.env && -d $pair_home ]]; then
    (cd "$checkout" && run_pair env STATION_CREATE_INVOCATION_ROOT="$checkout/.cache" \
      STATION_CREATE_VOLUME_NAME="$(basename "$checkout")_search_create_buildplaceholder" \
      docker compose -f compose.yaml -f compose.search-create-boundary.yaml \
      --profile search --profile search-create-boundary down -v --remove-orphans) >> "$private_log" 2>&1 || teardown_failed=1
    local volume project_name listing
    project_name=$(basename "$checkout")
    local reference
    if ! listing=$(docker ps -a --no-trunc --filter "label=station.create.gate=$project_name" --format '{{.ID}}' 2>> "$private_log"); then
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
    for service in search-create-transfer search-create-boundary search-create-intent-prepare search-profile-drift \
      search-create-apply-transfer search-create-index search-writer-role-prepare-transfer \
      search-writer-role-prepare search-writer-role-apply-transfer search-writer-role-apply \
      search-writer-mapping-prepare-transfer search-writer-mapping-prepare; do
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
    if ! listing=$(docker ps -a --no-trunc \
      --filter "label=com.docker.compose.project=$project_name" \
      --filter 'name=^/station_mapping_prepare_(transfer|read)_[0-9a-f]{32}$' \
      --format '{{.ID}}' 2>> "$private_log"); then
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
    if ! listing=$(docker volume ls --filter "label=station.create.project=$project_name" --format '{{.Name}}' 2>> "$private_log"); then
      teardown_failed=1; listing=''
    fi
    [[ ${#listing} -le 8192 ]] || teardown_failed=1
    while IFS= read -r volume; do
      [[ -n $volume ]] || continue
    if [[ $volume =~ ^${project_name}_(search_create_([0-9a-f]{32}|apply_[0-9a-f]{32})|search_writer_prepare_[0-9a-f]{32}|search_writer_apply_[0-9a-f]{32}|search_writer_mapping_prepare_[0-9a-f]{32})$ ]]; then
        docker volume rm "$volume" >> "$private_log" 2>&1 || teardown_failed=1
      else
        teardown_failed=1
      fi
    done <<< "$listing"
  fi
  if [[ -n $checkout && -d $checkout ]]; then
    local marker_file="$gate_root/markers-${pair:-none}"
    if sudo "$(command -v node)" \
      "$runner_root/tests/support/search-create-private-log-scan.mjs" \
      --capture "$checkout" "$marker_file" >> "$private_log" 2>&1; then
      marker_files+=("$marker_file")
    else
      teardown_failed=1
    fi
  fi
  if [[ -n $checkout ]]; then sudo rm -rf -- "$checkout" >> "$private_log" 2>&1 || teardown_failed=1; fi
  if [[ -n $pair_home ]]; then sudo rm -rf -- "$pair_home" >> "$private_log" 2>&1 || teardown_failed=1; fi
  if [[ -n $writer_variant && -z $delivery_case && -n $checkout ]]; then
    "$(command -v node)" \
      "$runner_root/tests/support/search-create-boundary-delivery-diagnostic-filter.mjs" \
      --writer-summary "$private_log" \
      "$runner_root/.cache/results/writer-role-prepare-${writer_variant}.txt" \
      "$writer_variant" >> "$private_log" 2>&1 || teardown_failed=1
  fi
  if (( ${#marker_files[@]} == 0 )); then
    local marker_file="$gate_root/markers-empty"
    if [[ ! -e $marker_file ]]; then printf '[]' > "$marker_file"; chmod 600 "$marker_file"; fi
    marker_files+=("$marker_file")
  fi
  for marker_file in "${marker_files[@]}"; do
    scan_create_private_log_after_teardown "$runner_root" "$marker_file" \
      "$private_log" yes \
      >> "$private_log" 2>&1 || teardown_failed=1
  done
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
    "$(command -v node)" "$runner_root/tests/support/search-create-boundary-delivery-diagnostic-filter.mjs" \
      "$private_log" >&2 2>/dev/null || echo 'Create boundary delivery diagnostics unavailable.' >&2
    rm -rf -- "$gate_root" || status=1
    echo "Create boundary delivery gate failed at pair=$pair phase=$phase; private log removed." >&2
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

for pair in "${ordinary_pairs[@]}"; do
  if [[ -n $writer_variant ]]; then
    case "$writer_variant:$pair" in
      default:default|runner:runner|runner-volume:runner|runner-missing-o:runner) ;;
      *) continue ;;
    esac
  fi
  if [[ -n $writer_variant && $pair == runner &&
      ( $runner_uid != 1001 || $runner_gid != 1001 ) ]]; then
    echo 'Writer preparation gate requires exact runner UID/GID 1001.' >&2
    exit 1
  fi
  phase=clone
  if [[ $pair == default ]]; then pair_uid=1000; pair_gid=1000;
  else pair_uid=$runner_uid; pair_gid=$runner_gid; fi
  name="stationcreate${pair}$(openssl rand -hex 6)"
  checkout="$gate_root/$name"
  mkdir -m 700 -- "$checkout"
  tar -C "$runner_root" --exclude=.git --exclude=.cache --exclude=node_modules \
    --exclude=LOCAL.md --exclude=.env --exclude=results --exclude=test-results \
    --exclude=playwright-report -cf - . | tar -C "$checkout" -xpf -
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
  private_index=0
  for private_directory in "$pair_home" "$pair_home/.docker" "$pair_home/.docker/cli-plugins"; do
    private_index=$((private_index + 1))
    phase="private-home-owner-$private_index"
    if private_metadata=$(sudo stat -c '%u:%g:%a' -- "$private_directory" 2>> "$private_log"); then
      if [[ ! $private_metadata =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ ]]; then
        echo "Create boundary delivery checkpoint pair=$pair step=$phase failed class=metadata-shape." >&2
        exit 1
      fi
      echo "Create boundary delivery checkpoint pair=$pair step=$phase observed=$private_metadata expected=$pair_uid:$pair_gid:700."
      if [[ $private_metadata != "$pair_uid:$pair_gid:700" ]]; then
        echo "Create boundary delivery checkpoint pair=$pair step=$phase failed class=ownership-or-mode." >&2
        exit 1
      fi
    else
      code=$?
      echo "Create boundary delivery checkpoint pair=$pair step=$phase failed exit=$code." >&2
      exit "$code"
    fi
    run_step "private-home-write-$private_index" run_pair test -w "$private_directory"
  done
  cd "$checkout"
  run_step compose-plugin run_pair docker compose version
  run_step buildx-plugin run_pair docker buildx version
  run_step init-env run_pair node scripts/init-env.mjs
  run_step init-search-security run_pair node scripts/init-search-security.mjs
  if [[ -n $writer_variant ]]; then
    run_step image-build run_pair env STATION_CREATE_INVOCATION_ROOT="$checkout/.cache" \
      STATION_CREATE_VOLUME_NAME="${name}_search_create_buildplaceholder" \
      STATION_CREATE_APPLY_PUBLIC_ROOT="$checkout/.cache" \
      STATION_CREATE_APPLY_VOLUME_NAME="${name}_search_create_apply_buildplaceholder" \
      STATION_WRITER_PREPARE_PUBLIC_ROOT="$checkout/.cache" \
      STATION_WRITER_PREPARE_INVOCATION_ROOT="$checkout/.cache" \
      STATION_WRITER_PREPARE_VOLUME_NAME="${name}_search_writer_prepare_buildplaceholder" \
      STATION_WRITER_APPLY_PUBLIC_ROOT="$checkout/.cache" \
      STATION_WRITER_APPLY_VOLUME_NAME="${name}_search_writer_apply_buildplaceholder" \
      STATION_WRITER_MAPPING_PREPARE_INVOCATION_ROOT="$checkout/.cache" \
      STATION_WRITER_MAPPING_PREPARE_PUBLIC_ROOT="$checkout/.cache" \
      STATION_WRITER_MAPPING_PREPARE_VOLUME_NAME="${name}_search_writer_mapping_prepare_buildplaceholder" \
      STATION_WRITER_MAPPING_PREPARE_TRANSFER_NAME=station_mapping_prepare_transfer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      STATION_WRITER_MAPPING_PREPARE_READ_NAME=station_mapping_prepare_read_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      docker compose -f compose.yaml -f compose.search-create-boundary.yaml \
      -f compose.search-create-apply.yaml -f compose.search-writer-role-prepare.yaml \
      ${delivery_case:+-f compose.search-writer-role-apply.yaml} \
      ${mapping_case:+-f compose.search-writer-mapping-prepare.yaml} \
      --profile search --profile fixture --profile search-create-boundary \
      --profile search-create-apply --profile search-writer-role-prepare \
      ${delivery_case:+--profile search-writer-role-apply} \
      ${mapping_case:+--profile search-writer-mapping-prepare} build \
      migrate search-init search-profile-introduce search-profile-bootstrap search-profile-drift \
      search-create-transfer search-create-boundary search-create-intent-prepare \
      search-create-apply-transfer search-create-index \
      search-writer-role-prepare-transfer search-writer-role-prepare \
      ${delivery_case:+search-writer-role-apply-transfer search-writer-role-apply} \
      ${mapping_case:+search-writer-mapping-prepare-transfer search-writer-mapping-prepare}
  else
    run_step image-build run_pair env STATION_CREATE_INVOCATION_ROOT="$checkout/.cache" \
      STATION_CREATE_VOLUME_NAME="${name}_search_create_buildplaceholder" \
      STATION_CREATE_APPLY_PUBLIC_ROOT="$checkout/.cache" \
      STATION_CREATE_APPLY_VOLUME_NAME="${name}_search_create_apply_buildplaceholder" \
      docker compose -f compose.yaml -f compose.search-create-boundary.yaml -f compose.search-create-apply.yaml \
      --profile search --profile fixture --profile search-create-boundary --profile search-create-apply build \
      migrate search-init search-profile-introduce search-profile-bootstrap search-profile-drift \
      search-create-transfer search-create-boundary search-create-intent-prepare \
      search-create-apply-transfer search-create-index
  fi
  run_step image-code-readability run_pair docker run --rm --pull never --network none \
    --read-only --user 1000:1000 --entrypoint node "${name}-search-create-boundary" \
    -e 'const fs=require("node:fs"); const c=fs.constants;
      for(const p of ["/app/packages","/app/packages/search","/app/packages/search/dist"])
        fs.accessSync(p,c.R_OK|c.X_OK);
      for(const p of ["/app/scripts/search-create-boundary.mjs",
        "/app/scripts/search-create-boundary-core.mjs",
        "/app/scripts/search-create-intent-prepare.mjs",
        "/app/scripts/search-create-intent-prepare-core.mjs",
        "/app/packages/search/dist/opensearch-runtime.js"])
        fs.accessSync(p,c.R_OK);
      process.stdout.write("Fixed create-boundary code is UID1000-readable.\n");'
  run_step postgres-start run_pair docker compose up -d --wait postgres
  phase=postgres-id
  if postgres_id=$(run_pair docker compose ps -q postgres 2>> "$private_log"); then
    if [[ $postgres_id =~ ^[0-9a-f]{64}$ ]]; then
      echo "Create boundary delivery checkpoint pair=$pair step=$phase passed."
    else
      echo "Create boundary delivery checkpoint pair=$pair step=$phase failed class=identity." >&2
      exit 1
    fi
  else
    code=$?
    echo "Create boundary delivery checkpoint pair=$pair step=$phase failed exit=$code." >&2
    exit "$code"
  fi
  phase=migration-enumeration
  if migration_lines=$(run_pair bash -c 'printf "%s\n" packages/db/drizzle/[0-9]*.sql' 2>> "$private_log"); then
    if [[ ${#migration_lines} -gt 8192 ]]; then
      echo "Create boundary delivery checkpoint pair=$pair step=$phase failed class=inventory-size." >&2
      exit 1
    fi
  else
    code=$?
    echo "Create boundary delivery checkpoint pair=$pair step=$phase failed exit=$code." >&2
    exit "$code"
  fi
  migration_count=0
  while IFS= read -r migration; do
    migration_count=$((migration_count + 1))
    if [[ $migration_count -gt 64 || ! $migration =~ ^packages/db/drizzle/[0-9]{4}_[a-z0-9_]+\.sql$ ]]; then
      echo "Create boundary delivery checkpoint pair=$pair step=migration-enumeration failed class=inventory-shape." >&2
      exit 1
    fi
    run_step "migration-$migration_count" run_pair bash -c \
      'exec docker exec -i "$1" psql -X -U station -d station -v ON_ERROR_STOP=1 < "$2"' \
      _ "$postgres_id" "$migration"
  done <<< "$migration_lines"
  if [[ $migration_count -lt 1 ]]; then
    echo "Create boundary delivery checkpoint pair=$pair step=migration-enumeration failed class=empty-inventory." >&2
    exit 1
  fi
  run_step credentials-create run_pair node scripts/search-admin-credentials.mjs create \
    --uid "$pair_uid" --gid "$pair_gid"
  run_step transfer-target-parent-probe run_pair docker run --rm --pull never --network none \
    --read-only --cap-drop ALL --user 0:0 --entrypoint node \
    --mount "type=bind,source=$checkout/.cache/search-db/initial-v1/transition.password,target=/run/create-transfer-password/password,readonly" \
    --mount "type=bind,source=$checkout/.cache/search-db/initial-v1/transition.password,target=/run/create-transfer-invocation/invocation,readonly" \
    "${name}-search-create-transfer" -e 'const fs=require("node:fs");
      for(const p of ["/run/create-transfer-password","/run/create-transfer-invocation"]){
        const s=fs.lstatSync(p);
        if(!s.isDirectory()||s.uid!==0||s.gid!==0||(s.mode&0o022)!==0)process.exit(1);
      } process.stdout.write("Fixed transfer target parents are root-owned.\n");'
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
    echo "Create boundary delivery checkpoint pair=$pair step=$phase passed."
  else
    code=$?
    echo "Create boundary delivery checkpoint pair=$pair step=$phase failed exit=$code." >&2
    exit "$code"
  fi
  phase=legacy-marker-identity
  index_uuid=$(tail -n 1 <<< "$marker")
  if [[ ! $index_uuid =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
    echo "Create boundary delivery checkpoint pair=$pair step=$phase failed class=identity." >&2
    exit 1
  fi
  run_step legacy-enrollment run_pair docker exec "$postgres_id" psql -X -U station -d station -v ON_ERROR_STOP=1 -q \
    -c "BEGIN; INSERT INTO search_generation_history (generation_token,physical_index,profile_id,index_uuid,lifecycle) VALUES ('legacy-v1','station-mail-v1','station-mail-v1','$index_uuid','roles_attested'); UPDATE search_generation_control SET source_generation_token='legacy-v1',revision=revision+1 WHERE singleton=1 AND stage='disabled' AND source_generation_token IS NULL; COMMIT;"
  run_step candidate-reservation run_pair docker compose --profile search run --rm -T --no-deps \
    migrate node tests/integration/search-create-boundary-reserve.mjs
  if [[ -n $writer_variant ]]; then
    if [[ -n $mapping_case ]]; then
      run_step writer-mapping-prepare-runtime run_pair env \
        STATION_WPREP_GATE_CASE="$writer_variant" STATION_WRITER_DELIVERY_CASE=positive \
        STATION_WRITER_MAPPING_GATE_CASE="$mapping_case" \
        node tests/integration/search-writer-role-prepare-delivery.mjs
    elif [[ -n $delivery_case ]]; then
      run_step writer-role-delivery-runtime run_pair env \
        STATION_WPREP_GATE_CASE="$writer_variant" STATION_WRITER_DELIVERY_CASE="$delivery_case" \
        node tests/integration/search-writer-role-prepare-delivery.mjs
    else
      run_step writer-role-prepare-runtime run_pair env \
        STATION_WPREP_GATE_CASE="$writer_variant" \
        node tests/integration/search-writer-role-prepare-delivery.mjs
    fi
  else
    run_step intent-prepare-delivery run_pair node tests/integration/search-create-intent-prepare-delivery.mjs
    run_step create-apply-runtime run_pair node tests/integration/search-create-apply-delivery.mjs
    run_step delivery run_pair node tests/integration/search-create-boundary-delivery.mjs
    run_step create-apply-terminal-missing-o run_pair node tests/integration/search-create-apply-terminal-missing-o.mjs
  fi
  run_step secret-scan sudo "$(command -v node)" tests/support/search-attestor-delivery-log-scan.mjs "$private_log"
  phase=teardown
  cleanup_pair
  [[ $teardown_failed == 0 ]]
  if [[ -n $writer_variant && -z $delivery_case ]]; then
    "$(command -v node)" \
      "$runner_root/tests/support/search-create-boundary-delivery-diagnostic-filter.mjs" \
      --writer-emit "$runner_root/.cache/results/writer-role-prepare-${writer_variant}.txt" \
      "$writer_variant" || {
        echo 'Writer role preparation sanitized summary unavailable.' >&2
        exit 1
      }
  fi
  if [[ -n $delivery_case && -z $mapping_case ]]; then
    phase=writer-delivery-summary
    if delivery_summary=$("$(command -v node)" \
      "$runner_root/tests/support/search-writer-role-delivery-summary.mjs" \
      "$private_log" "$delivery_case" "$delivery_pair" 2>> "$private_log"); then
      printf '%s\n' "$delivery_summary"
    else
      echo 'Writer role delivery sanitized summary unavailable.' >&2
      exit 1
    fi
  fi
  if [[ -n $mapping_case ]]; then
    phase=mapping-summary
    if mapping_summary=$("$(command -v node)" \
      "$runner_root/tests/support/search-create-boundary-delivery-diagnostic-filter.mjs" \
      --mapping-emit "$private_log" "$mapping_case" "$mapping_pair" 2>> "$private_log"); then
      printf '%s\n' "$mapping_summary"
    else
      echo 'Writer mapping preparation sanitized summary unavailable.' >&2
      exit 1
    fi
  fi
  echo "PASS: disposable PG16/OpenSearch TLS create boundary delivery for $pair owner pair."
  cd "$runner_root"
done
