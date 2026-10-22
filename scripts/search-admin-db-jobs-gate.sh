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
original_cache_mode=$(stat -c '%a' .cache)
phase=setup
pair=none
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
  sudo chown "$runner_uid:$runner_gid" .env .cache/go-camo.env >/dev/null 2>&1 || true
  chmod "$original_cache_mode" .cache >/dev/null 2>&1 || true
  rm -f -- .env || true
  rm -f -- .cache/go-camo.env || true
  rm -rf -- .cache/tls || true
  if [[ "$result" != 0 ]]; then
    echo "DB inspector fixture failed in $phase for $pair pair; private bounded log retained." >&2
  fi
}
trap cleanup EXIT
node scripts/init-env.mjs >> "$log" 2>&1
# Only traversal is shared during the UID 1000 fixture; the bundle stays private 0700.
chmod 711 .cache

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
  project="$candidate"
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
  run_as_pair docker compose version >> "$log" 2>&1
  phase=docker-daemon
  run_as_pair docker version --format '{{.Server.Version}}' >> "$log" 2>&1
  phase=compose-config
  run_as_pair docker compose --profile search-admin-db config --quiet >> "$log" 2>&1
  phase=setup
  run_as_pair docker compose up -d postgres >> "$log" 2>&1
  id=$(run_as_pair docker compose ps -q postgres)
  [[ "$id" =~ ^[0-9a-f]{12,64}$ ]]
  ready=0
  for attempt in {1..30}; do
    if run_as_pair docker exec "$id" pg_isready -U station -d station >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [[ "$ready" == 1 ]]
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
  phase=ownership
  sudo chown "$runner_uid:$runner_gid" .env .cache/go-camo.env
done

phase=complete
echo 'PASS: disposable PG16 fixed DB inspectors, dual identity pairs, and actual restricted-role denials.'
