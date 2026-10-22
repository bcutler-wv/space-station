#!/usr/bin/env bash
set -euo pipefail
umask 077

# Disposable CI checkout and Compose projects only. Refuse retained installation material.
if [[ -e .cache/search-db || -L .cache/search-db || -e .env || -L .env ||
      -e .cache/go-camo.env || -L .cache/go-camo.env ||
      -e .cache/tls || -L .cache/tls ]]; then
  echo 'DB inspector fixture needs an unused checkout.' >&2; exit 1
fi
mkdir -p .cache/results
scratch=$(mktemp -d "$PWD/.cache/results/search-db-jobs.XXXXXXXX")
log="$scratch/gate.log"
: > "$log"
runner_uid=$(id -u)
runner_gid=$(id -g)
docker_gid=$(stat -c '%g' /var/run/docker.sock)
if [[ "$runner_uid" -eq 0 || "$runner_uid" -eq 1000 || "$runner_gid" -eq 0 ]]; then
  echo 'Fixture requires a non-default non-root runner identity.' >&2; exit 1
fi
project=''
owned_bundle=0
backupdir=''
pair_home=''
pair_uid="$runner_uid"
pair_gid="$runner_gid"
ancestor_paths=()
ancestor_modes=()
original_cache_mode=$(stat -c '%a' .cache)
phase=setup
pair=none
restore_ancestor_modes() {
  local index failed=0
  for ((index=${#ancestor_paths[@]}-1; index>=0; index--)); do
    if ! sudo chmod "${ancestor_modes[index]}" -- "${ancestor_paths[index]}" >/dev/null 2>&1; then
      failed=1
    fi
  done
  if [[ "$failed" != 0 ]]; then
    echo 'Compose probe: runner-owned ancestor mode restoration failed.' >&2
    return 1
  fi
  ancestor_paths=()
  ancestor_modes=()
}
cleanup() {
  local result=$?
  if [[ -n "$project" ]]; then
    if [[ "$pair_uid" == 1000 ]]; then
      sudo setpriv --reuid=1000 --regid=1000 --groups="$docker_gid" \
        env HOME="$pair_home" DOCKER_CONFIG="$pair_home/.docker" \
        COMPOSE_PROJECT_NAME="$project" APP_UID=1000 APP_GID=1000 docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    else
      HOME="$pair_home" DOCKER_CONFIG="$pair_home/.docker" \
        COMPOSE_PROJECT_NAME="$project" APP_UID="$pair_uid" APP_GID="$pair_gid" \
        docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$owned_bundle" == 1 ]]; then sudo rm -rf -- .cache/search-db; fi
  if [[ -n "$backupdir" ]]; then sudo rm -rf -- "$backupdir"; fi
  if [[ -n "$pair_home" ]]; then sudo rm -rf -- "$pair_home"; fi
  if ! restore_ancestor_modes; then result=1; fi
  sudo chown "$runner_uid:$runner_gid" .env .cache/go-camo.env >/dev/null 2>&1 || true
  chmod "$original_cache_mode" .cache >/dev/null 2>&1 || true
  rm -f -- .env || true
  rm -f -- .cache/go-camo.env || true
  rm -rf -- .cache/tls || true
  if [[ "$result" != 0 ]]; then
    echo "DB inspector fixture failed in $phase for $pair pair; private bounded log retained." >&2
    trap - EXIT
    exit "$result"
  fi
}
trap cleanup EXIT
node scripts/init-env.mjs >> "$log" 2>&1
# Only traversal is shared during the UID 1000 fixture; the bundle stays private 0700.
chmod 711 .cache

# Docker reports the Compose executable it selected for this runner. Keep the
# pair's Docker configuration empty except for a private copy of that plugin.
phase=runner-compose-plugin
compose_plugins_file="$scratch/compose-plugins.json"
docker info --format '{{json .ClientInfo.Plugins}}' > "$compose_plugins_file" 2>> "$log"
if ! compose_path=$(node -e '
  const plugins = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(plugins)) process.exit(1);
  const matches = plugins.filter(plugin => plugin?.Name === "compose");
  if (matches.length !== 1 || typeof matches[0].Path !== "string" ||
      !matches[0].Path.startsWith("/") || /[\x00-\x1f\x7f]/.test(matches[0].Path)) process.exit(1);
  process.stdout.write(matches[0].Path);
' "$compose_plugins_file" 2>> "$log"); then
  echo 'Runner Compose plugin metadata is missing or ambiguous.' >&2; exit 1
fi
if ! compose_plugin=$(realpath -e -- "$compose_path" 2>> "$log"); then
  echo 'Runner Compose plugin path does not resolve.' >&2; exit 1
fi
if [[ ! -f "$compose_plugin" || ! -x "$compose_plugin" ]]; then
  echo 'Runner Compose plugin is not a regular executable.' >&2; exit 1
fi
runner_compose_version=$(docker compose version --short 2>> "$log")
if [[ -z "$runner_compose_version" ]]; then
  echo 'Runner Compose version is empty.' >&2; exit 1
fi

run_as_pair() {
  if [[ "$pair_uid" == 1000 ]]; then
    timeout "${RUN_PAIR_TIMEOUT:-120}s" sudo setpriv --reuid=1000 --regid=1000 --groups="$docker_gid" \
      env HOME="$pair_home" DOCKER_CONFIG="$pair_home/.docker" \
      COMPOSE_PROJECT_NAME="$project" APP_UID=1000 APP_GID=1000 "$@"
  else
    timeout "${RUN_PAIR_TIMEOUT:-120}s" env HOME="$pair_home" DOCKER_CONFIG="$pair_home/.docker" \
      COMPOSE_PROJECT_NAME="$project" APP_UID="$pair_uid" APP_GID="$pair_gid" "$@"
  fi
}

numeric_mode_owner() {
  local value
  if value=$(sudo stat -c '%u:%g:%a' -- "$1" 2>> "$log") &&
     [[ "$value" =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ ]]; then
    printf '%s' "$value"
  else
    printf 'unavailable'
  fi
}

repair_checkout_traversal() {
  local physical_root current part depth=0 owner mode
  physical_root=$(pwd -P)
  [[ "$physical_root" == "$PWD" && "${GITHUB_ACTIONS:-}" == true ]] || {
    echo 'Compose probe: checkout traversal repair is outside disposable CI.' >&2; return 1;
  }
  current=''
  local -a parts
  IFS=/ read -r -a parts <<< "${physical_root#/}"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    current="$current/$part"
    depth=$((depth + 1))
    if run_as_pair test -x "$current" >/dev/null 2>&1; then continue; fi
    owner=$(stat -c '%u' -- "$current")
    mode=$(stat -c '%a' -- "$current")
    if [[ "$owner" != "$runner_uid" || ! "$mode" =~ ^[0-7]{3,4}$ ||
          ! -d "$current" || -L "$current" || "$(realpath -e -- "$current")" != "$current" ]]; then
      echo "Compose probe: denied ancestor depth=$depth owner-mode=$(numeric_mode_owner "$current"); repair refused." >&2
      return 1
    fi
    ancestor_paths+=("$current")
    ancestor_modes+=("$mode")
    sudo chmod o+x -- "$current" >> "$log" 2>&1
    if ! run_as_pair test -x "$current" >/dev/null 2>&1; then
      echo "Compose probe: denied ancestor depth=$depth owner-mode=$(numeric_mode_owner "$current"); repair failed." >&2
      return 1
    fi
    echo "Compose probe: runner-owned ancestor depth=$depth traversal repaired from mode=$mode." >&2
  done
}

compose_error_class() {
  local error_file=$1
  if grep -Eiq 'permission denied|operation not permitted|EACCES' "$error_file"; then
    echo permission
  elif grep -Eiq 'exec format error|cannot execute binary file|wrong architecture' "$error_file"; then
    echo exec-format
  elif grep -Eiq 'config\.json|docker context|current context|docker host|docker endpoint' "$error_file"; then
    echo config-context
  elif grep -Eiq 'not a docker command|invalid plugin|plugin metadata|cli-plugin' "$error_file"; then
    echo plugin-metadata
  else
    echo other
  fi
}

public_version() {
  if [[ "$1" =~ ^v?[0-9]+\.[0-9]+(\.[0-9]+)?([.+-][A-Za-z0-9.+-]+)?$ ]]; then
    printf '%s' "$1"
  else
    printf 'unrecognized'
  fi
}

for pair in default runner; do
  if [[ "$pair" == default ]]; then pair_uid=1000; pair_gid=1000;
  else pair_uid="$runner_uid"; pair_gid="$runner_gid"; fi
  phase=collision
  candidate="stationdbjobs$(openssl rand -hex 7)"
  if ! collision_rows=$(COMPOSE_PROJECT_NAME="$candidate" docker compose ps -a -q 2>> "$log"); then
    echo 'Disposable Compose collision check failed.' >&2; exit 1
  fi
  if [[ -n "$collision_rows" ]]; then
    echo 'Disposable Compose project already has containers.' >&2; exit 1
  fi
  if docker volume inspect "${candidate}_postgres_data" >/dev/null 2>&1 ||
     docker network inspect "${candidate}_default" >/dev/null 2>&1 ||
     docker network inspect "${candidate}_search_admin_db" >/dev/null 2>&1; then
    echo 'Disposable project collision.' >&2; exit 1
  fi
  phase=setup
  pair_home=$(mktemp -d "$PWD/.cache/search-db-jobs-home.XXXXXXXX")
  sudo chown "$pair_uid:$pair_gid" "$pair_home"
  sudo install -d -m 0700 -o "$pair_uid" -g "$pair_gid" "$pair_home/.docker"
  sudo install -d -m 0700 -o "$pair_uid" -g "$pair_gid" "$pair_home/.docker/cli-plugins"
  sudo install -m 0700 -o "$pair_uid" -g "$pair_gid" \
    "$compose_plugin" "$pair_home/.docker/cli-plugins/docker-compose"
  project="$candidate"
  if [[ "$pair" == default ]] && ! run_as_pair test -x "$PWD" >/dev/null 2>&1; then
    repair_checkout_traversal
  fi
  # Image construction is outside the UID/password-delivery proof. Build
  # before handing fixture files to the pair; all credential and job commands
  # below still use the pair's separate private HOME and Docker configuration.
  phase=runner-compose-plugin
  docker compose version >> "$log" 2>&1
  phase=runner-buildx-plugin
  docker buildx version >> "$log" 2>&1
  phase=runner-docker-daemon
  docker version --format '{{.Server.Version}}' >> "$log" 2>&1
  phase=build
  build_log="$scratch/build-$pair.log"
  if timeout 600s env COMPOSE_PROJECT_NAME="$project" APP_UID="$pair_uid" APP_GID="$pair_gid" \
      docker compose --profile search-admin-db build search-db-verifier search-db-transition > "$build_log" 2>&1; then
    cat "$build_log" >> "$log"
  else
    result=$?
    cat "$build_log" >> "$log"
    if grep -Eiq 'buildx.*(missing|not found|not installed)|requires buildx' "$build_log"; then
      phase=build-buildx
    elif grep -Eiq 'permission denied|operation not permitted' "$build_log"; then
      phase=build-permission
    elif grep -Eiq 'cannot connect to the docker daemon|error during connect' "$build_log"; then
      phase=build-daemon
    fi
    exit "$result"
  fi
  phase=setup
  sudo chown "$pair_uid:$pair_gid" .env .cache/go-camo.env
  if [[ -e .cache/search-db || -L .cache/search-db ]]; then
    echo 'Unexpected credential root before pair.' >&2; exit 1
  fi
  sudo install -d -m 0700 -o "$pair_uid" -g "$pair_gid" .cache/search-db
  owned_bundle=1
  # Report only fixed phases. The private Docker output may contain expanded
  # Compose values and must never be printed by this gate.
  phase=checkout-access
  run_as_pair test -r Dockerfile
  run_as_pair test -r .dockerignore
  run_as_pair test -r compose.yaml
  phase=compose-plugin
  pair_plugin="$pair_home/.docker/cli-plugins/docker-compose"
  if [[ "$compose_path" == "$compose_plugin" ]]; then source_link=no; else source_link=yes; fi
  if [[ "$compose_path" == "$HOME/"* ]]; then source_location=runner-home
  elif [[ "$compose_path" == /usr/* ]]; then source_location=system
  else source_location=other; fi
  if ! pair_docker_path=$(run_as_pair sh -c 'command -v docker' 2>> "$log"); then
    echo 'Compose probe: pair Docker command is unavailable.' >&2; exit 1
  fi
  runner_docker_path=$(command -v docker)
  if ! pair_docker_real=$(realpath -e -- "$pair_docker_path" 2>> "$log") ||
     ! runner_docker_real=$(realpath -e -- "$runner_docker_path" 2>> "$log"); then
    echo 'Compose probe: Docker command path does not resolve.' >&2; exit 1
  fi
  if [[ "$pair_docker_real" == "$runner_docker_real" ]]; then
    docker_path_match=yes
  else
    docker_path_match=no
  fi
  echo "Compose probe: source=$source_location symlink=$source_link runner-version=$(public_version "$runner_compose_version") docker-path-match=$docker_path_match." >&2
  for pair_label in home config plugins; do
    case "$pair_label" in
      home) pair_path="$pair_home" ;;
      config) pair_path="$pair_home/.docker" ;;
      plugins) pair_path="$pair_home/.docker/cli-plugins" ;;
    esac
    if ! run_as_pair test -r "$pair_path" >/dev/null 2>&1 ||
       ! run_as_pair test -x "$pair_path" >/dev/null 2>&1; then
      echo "Compose probe: pair directory $pair_label read/execute denied; owner-mode=$(numeric_mode_owner "$pair_path") cache-owner-mode=$(numeric_mode_owner .cache)." >&2
      exit 1
    fi
  done
  if ! run_as_pair test -r "$pair_plugin" >/dev/null 2>&1 ||
     ! run_as_pair test -x "$pair_plugin" >/dev/null 2>&1; then
    echo "Compose probe: pair plugin read/execute denied; owner-mode=$(numeric_mode_owner "$pair_plugin") cache-owner-mode=$(numeric_mode_owner .cache)." >&2
    exit 1
  fi
  plugin_metadata="$scratch/compose-metadata-$pair.json"
  plugin_metadata_error="$scratch/compose-metadata-$pair.err"
  if ! run_as_pair "$pair_plugin" docker-cli-plugin-metadata > "$plugin_metadata" 2> "$plugin_metadata_error"; then
    echo "Compose probe: direct metadata failed class=$(compose_error_class "$plugin_metadata_error")." >&2
    exit 1
  fi
  if ! metadata_version=$(node -e '
    const metadata = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (typeof metadata.SchemaVersion !== "string" ||
        typeof metadata.Vendor !== "string" ||
        typeof metadata.Version !== "string") process.exit(1);
    process.stdout.write(metadata.Version);
  ' "$plugin_metadata" 2>> "$log"); then
    echo 'Compose probe: direct metadata was invalid.' >&2; exit 1
  fi
  echo "Compose probe: direct metadata passed version=$(public_version "$metadata_version")." >&2
  pair_compose_output="$scratch/compose-version-$pair.out"
  pair_compose_error="$scratch/compose-version-$pair.err"
  if ! run_as_pair docker compose version --short > "$pair_compose_output" 2> "$pair_compose_error"; then
    echo "Compose probe: Docker version failed class=$(compose_error_class "$pair_compose_error")." >&2
    exit 1
  fi
  pair_compose_version=$(cat "$pair_compose_output")
  echo "Compose probe: pair-version=$(public_version "$pair_compose_version")." >&2
  if [[ "$pair_compose_version" != "$runner_compose_version" ]]; then
    echo 'Pair Compose version differs from runner.' >&2; exit 1
  fi
  phase=docker-daemon
  run_as_pair docker version --format '{{.Server.Version}}' >> "$log" 2>&1
  phase=compose-config
  run_as_pair docker compose --profile search-admin-db config --quiet >> "$log" 2>&1
  phase=postgres-start
  run_as_pair docker compose up -d postgres >> "$log" 2>&1
  phase=container-id
  id=$(run_as_pair docker compose ps -q postgres)
  [[ "$id" =~ ^[0-9a-f]{12,64}$ ]]
  phase=readiness
  ready=0
  for attempt in {1..30}; do
    # The image's init server accepts Unix sockets before the final server
    # listens on TCP. Only the latter is safe for the first migration.
    if run_as_pair docker exec "$id" pg_isready -h 127.0.0.1 -U station -d station >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [[ "$ready" == 1 ]]
  phase=migration
  for migration in packages/db/drizzle/[0-9]*.sql; do
    run_as_pair docker exec -i "$id" psql -X -U station -d station -v ON_ERROR_STOP=1 < "$migration" >> "$log" 2>&1
  done
  phase=create
  run_as_pair node scripts/search-admin-credentials.mjs create --uid "$pair_uid" --gid "$pair_gid" >> "$log" 2>&1
  phase=launcher
  run_as_pair node scripts/search-admin-db-run.mjs verifier >> "$log" 2>&1
  run_as_pair node scripts/search-admin-db-run.mjs transition >> "$log" 2>&1
  phase=container
  RUN_PAIR_TIMEOUT=300 run_as_pair node tests/integration/search-admin-db-jobs-container.mjs >> "$log" 2>&1
  phase=denials
  for role in verifier transition; do
    service="search-db-$role"
    run_as_pair docker compose --profile search-admin-db run --rm -T --no-deps \
      --entrypoint node "$service" tests/integration/search-admin-db-jobs-live.mjs "$role" >> "$log" 2>&1
  done
  phase=secret-case
  verifier=.cache/search-db/initial-v1/verifier.password
  backupdir=$(mktemp -d "$PWD/.cache/search-db-jobs-backup.XXXXXXXX")
  sudo chown "$pair_uid:$pair_gid" "$backupdir"
  backup="$backupdir/verifier.password"
  run_as_pair cp "$verifier" "$backup"
  run_as_pair node scripts/search-admin-db-run.mjs verifier >> "$log" 2>&1
  run_as_pair mv "$verifier" "$verifier.absent"
  if run_as_pair node scripts/search-admin-db-run.mjs verifier >> "$log" 2>&1; then
    echo 'Absent verifier credential was accepted.' >&2; exit 1
  fi
  if run_as_pair docker compose --profile search-admin-db run --rm -T --no-deps search-db-verifier >> "$log" 2>&1; then
    echo 'Missing bind source was created or accepted.' >&2; exit 1
  fi
  run_as_pair test ! -e "$verifier"
  run_as_pair test ! -L "$verifier"
  run_as_pair mv "$verifier.absent" "$verifier"
  run_as_pair node -e 'require("fs").writeFileSync(process.argv[1],"malformed")' "$verifier"
  if run_as_pair node scripts/search-admin-db-run.mjs verifier >> "$log" 2>&1; then
    echo 'Malformed credential was accepted.' >&2; exit 1
  fi
  run_as_pair cp "$backup" "$verifier"
  run_as_pair chmod 644 "$verifier"
  if run_as_pair node scripts/search-admin-db-run.mjs verifier >> "$log" 2>&1; then
    echo 'Public credential mode was accepted.' >&2; exit 1
  fi
  run_as_pair chmod 600 "$verifier"
  run_as_pair rm "$verifier"
  run_as_pair ln -s "$backup" "$verifier"
  if run_as_pair node scripts/search-admin-db-run.mjs verifier >> "$log" 2>&1; then
    echo 'Symlinked credential was accepted.' >&2; exit 1
  fi
  run_as_pair rm "$verifier"
  run_as_pair cp .cache/search-db/initial-v1/transition.password "$verifier"
  if run_as_pair node scripts/search-admin-db-run.mjs verifier >> "$log" 2>&1; then
    echo 'Other-role credential was accepted.' >&2; exit 1
  fi
  run_as_pair node -e 'require("fs").writeFileSync(process.argv[1],require("crypto").randomBytes(32).toString("base64url"))' "$verifier"
  if run_as_pair node scripts/search-admin-db-run.mjs verifier >> "$log" 2>&1; then
    echo 'Wrong well-formed credential was accepted.' >&2; exit 1
  fi
  run_as_pair cp "$backup" "$verifier"
  sudo rm -rf -- "$backupdir"
  backupdir=''
  run_as_pair node scripts/search-admin-db-run.mjs verifier >> "$log" 2>&1
  for role in verifier transition; do
    if sudo grep -F -f ".cache/search-db/initial-v1/$role.password" "$log" >/dev/null; then
      echo 'DB inspector fixture output contained a credential.' >&2; exit 1
    fi
  done
  phase=cleanup
  run_as_pair docker compose down -v --remove-orphans >> "$log" 2>&1
  project=''
  sudo rm -rf -- .cache/search-db
  owned_bundle=0
  sudo rm -rf -- "$pair_home"
  pair_home=''
  restore_ancestor_modes
  phase=ownership
  sudo chown "$runner_uid:$runner_gid" .env .cache/go-camo.env
done

phase=complete
echo 'PASS: disposable PG16 fixed DB inspectors, dual identity pairs, and actual restricted-role denials.'
