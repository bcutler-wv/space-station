#!/usr/bin/env bash
set -euo pipefail
umask 077

# Disposable PG16 rotation proof. No runtime volume or host port is touched.
mkdir -p .cache/results
if [[ -e .cache/search-db || -L .cache/search-db ]]; then
  echo 'Rotation fixture requires an absent private root.' >&2
  exit 1
fi
scratch=$(mktemp -d "$PWD/.cache/results/search-admin-rotation.XXXXXXXX")
project="stationrot$(openssl rand -hex 8)"
export COMPOSE_FILE="$scratch/compose.yaml" COMPOSE_PROJECT_NAME="$project"
uid=$(id -u)
gid=$(id -g)
test "$uid" -gt 0 && test "$gid" -gt 0
export SEARCH_DB_FIXTURE_UID="$uid" SEARCH_DB_FIXTURE_GID="$gid"
export SEARCH_DB_FIXTURE_ROOT="$PWD/.cache/search-db"
fixture_log="$scratch/fixture.log"
created=0
owned_root=0
phase=setup
owned_containers=()
cleanup() {
  local status=$?
  if [[ "$status" != 0 ]]; then echo "FAIL: disposable rotation proof phase=$phase" >&2; fi
  if (( ${#owned_containers[@]} )); then docker rm -f "${owned_containers[@]}" >/dev/null 2>&1 || true; fi
  if [[ "$created" == 1 ]]; then docker compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  if [[ "$owned_root" == 1 ]]; then rm -rf -- .cache/search-db; fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
mkdir -m 700 .cache/search-db
owned_root=1
cat > "$COMPOSE_FILE" <<'YAML'
services:
  postgres:
    image: pgvector/pgvector:0.8.7-pg16-bookworm
    environment:
      POSTGRES_USER: station
      POSTGRES_DB: station
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?fixture owner secret required}
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - default
      - search_admin_db
  search-db-verifier:
    profiles: [fixture]
    image: pgvector/pgvector:0.8.7-pg16-bookworm
    user: ${SEARCH_DB_FIXTURE_UID:?}:${SEARCH_DB_FIXTURE_GID:?}
    command: [sleep, "600"]
    volumes:
      - ${SEARCH_DB_FIXTURE_ROOT:?}/initial-v1/verifier.password:/run/password:ro
  search-db-transition:
    profiles: [fixture]
    image: pgvector/pgvector:0.8.7-pg16-bookworm
    user: ${SEARCH_DB_FIXTURE_UID:?}:${SEARCH_DB_FIXTURE_GID:?}
    command: [sleep, "600"]
    volumes:
      - ${SEARCH_DB_FIXTURE_ROOT:?}/initial-v1/transition.password:/run/password:ro
  inode-witness:
    profiles: [fixture]
    image: pgvector/pgvector:0.8.7-pg16-bookworm
    user: ${SEARCH_DB_FIXTURE_UID:?}:${SEARCH_DB_FIXTURE_GID:?}
    command: [sleep, "600"]
    volumes:
      - ${SEARCH_DB_FIXTURE_ROOT:?}/initial-v1/verifier.password:/run/password:ro
networks:
  search_admin_db:
    internal: true
volumes:
  pgdata: {}
YAML
existing=$(docker compose ps -a -q)
test -z "$existing"
if docker volume inspect "${project}_pgdata" >/dev/null 2>&1 ||
   docker network inspect "${project}_default" >/dev/null 2>&1 ||
   docker network inspect "${project}_search_admin_db" >/dev/null 2>&1; then
  echo 'Disposable Compose project already owns resources.' >&2
  exit 1
fi
created=1
phase=postgres-start
docker compose up -d postgres > "$fixture_log" 2>&1
id=$(docker compose ps -q postgres)
test -n "$id"
for attempt in {1..30}; do
  if docker exec "$id" pg_isready -U station -d station >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 30 ]]; then echo 'Disposable credential PG16 did not become ready.' >&2; exit 1; fi
  sleep 1
done
for migration in packages/db/drizzle/[0-9]*.sql; do
  phase=migrations
  docker exec -i "$id" psql -X -U station -d station -v ON_ERROR_STOP=1 < "$migration" >> "$fixture_log" 2>&1
done
phase=initial-credentials
node scripts/search-admin-credentials.mjs create --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
node scripts/search-admin-credentials.mjs verify --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
old_verifier="$scratch/old-verifier.password"
cp .cache/search-db/initial-v1/verifier.password "$old_verifier"
old_transition="$scratch/old-transition.password"
cp .cache/search-db/initial-v1/transition.password "$old_transition"
other_before=$(docker exec "$id" psql -X -U station -d station -Atqc \
  "SELECT rolcanlogin::text || '|' || rolpassword FROM pg_authid WHERE rolname='station_search_transition'")
other_file_before=$(sha256sum .cache/search-db/initial-v1/transition.password | cut -d' ' -f1)
phase=stopped-holder-denial
holder=$(docker compose --profile fixture run -d --no-deps search-db-verifier 2>> "$fixture_log")
test -n "$holder"
docker stop "$holder" >> "$fixture_log" 2>&1
if node scripts/search-admin-credentials.mjs rotate verifier --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1; then
  echo 'Stopped target-role bind holder was ignored.' >&2
  exit 1
fi
docker rm "$holder" >> "$fixture_log" 2>&1
phase=premutation-abort
live_count=0
live_result=''
run_live() {
  local mode=$1 selected=$2 op=$3 reference=$4 expected=$5
  live_count=$((live_count + 1))
  live_result="$scratch/live-$live_count.json"
  if node tests/integration/search-admin-rotation-live.mjs "$mode" "$selected" "$op" "$live_result" "$reference" >> "$fixture_log" 2>&1; then
    test "$expected" = success
  else
    test "$expected" = failure
  fi
  test -f "$live_result"
}
assert_counts() {
  node -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
    const names=["nologin","terminate","password","login"];
    if(x.version!==1||x.failed!==(process.argv[6]==="failure")||
      names.some((n,i)=>x.counts[n]!==Number(process.argv[i+2])))process.exit(1)' \
    "$live_result" "$1" "$2" "$3" "$4" "$5"
}
rotation_id() {
  local entries=(.cache/search-db/.rotation-*)
  test "${#entries[@]}" = 1
  local candidate=${entries[0]##*/.rotation-}
  [[ "$candidate" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
  printf '%s' "$candidate"
}
assert_marker() {
  node -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
    if(x.version!==1||x.action!=="password"||x.containerId!==process.argv[2]||
      x.role!==process.argv[3]||x.operationId!==process.argv[4])process.exit(1)' \
    ".cache/search-db/.rotation-$1/.owner-operation-inflight" "$2" "$3" "$1"
}
role_row() {
  docker exec "$id" psql -X -U station -d station -Atqc \
    "SELECT rolcanlogin::text || '|' || rolpassword FROM pg_authid WHERE rolname='station_search_$1'"
}
run_live rotate-stage verifier - - failure
assert_counts 0 0 0 0 failure
premutation_id=$(rotation_id)
aborted_verifier="$scratch/aborted-verifier.password"
cp ".cache/search-db/.rotation-$premutation_id/new.password" "$aborted_verifier"
test ! -e ".cache/search-db/.rotation-$premutation_id/started"
test ! -e ".cache/search-db/.rotation-$premutation_id/.owner-operation-inflight"
node scripts/search-admin-credentials.mjs abort-pending-rotation verifier "$premutation_id" --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
test ! -e ".cache/search-db/.rotation-$premutation_id"
node scripts/search-admin-credentials.mjs verify --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
phase=normal-rotation-held-sessions
phase=other-role-policy-drift
docker exec "$id" psql -X -U station -d station -v ON_ERROR_STOP=1 \
  -c 'ALTER ROLE station_search_transition CREATEDB;' >> "$fixture_log" 2>&1
verifier_before_drift=$(role_row verifier)
run_live rotate-observe verifier - - failure
assert_counts 0 0 0 0 failure
test "$(role_row verifier)" = "$verifier_before_drift"
test "$(find .cache/search-db -mindepth 1 -maxdepth 1 -name '.rotation-*' | wc -l)" = 0
docker exec "$id" psql -X -U station -d station -v ON_ERROR_STOP=1 \
  -c 'ALTER ROLE station_search_transition NOCREATEDB;' >> "$fixture_log" 2>&1
phase=normal-rotation-held-sessions
witness_old=$(docker compose --profile fixture run -d --no-deps inode-witness 2>> "$fixture_log")
test -n "$witness_old"
old_inode=$(docker exec "$witness_old" stat -c %i /run/password)
run_live rotate-with-sessions verifier - - success
assert_counts 1 1 1 1 success
witness_new=$(docker compose --profile fixture run -d --no-deps inode-witness 2>> "$fixture_log")
test -n "$witness_new"
new_inode=$(docker exec "$witness_new" stat -c %i /run/password)
test "$old_inode" != "$new_inode"
docker rm -f "$witness_old" "$witness_new" >> "$fixture_log" 2>&1
test "$(sha256sum .cache/search-db/initial-v1/transition.password | cut -d' ' -f1)" = "$other_file_before"
test "$(docker exec "$id" psql -X -U station -d station -Atqc \
  "SELECT rolcanlogin::text || '|' || rolpassword FROM pg_authid WHERE rolname='station_search_transition'")" = "$other_before"
node scripts/search-admin-credentials.mjs verify --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
intermediate_verifier="$scratch/intermediate-verifier.password"
cp .cache/search-db/initial-v1/verifier.password "$intermediate_verifier"
phase=postpublication-finish
run_live rotate-after-publication transition - - failure
assert_counts 1 1 1 1 failure
postpublish_id=$(rotation_id)
test -e ".cache/search-db/.rotation-$postpublish_id/started"
test ! -e ".cache/search-db/.rotation-$postpublish_id/new.publish"
node scripts/search-admin-credentials.mjs finish-pending-rotation transition "$postpublish_id" --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
test ! -e ".cache/search-db/.rotation-$postpublish_id"
node scripts/search-admin-credentials.mjs verify --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
phase=lost-response-A
other_reference="$scratch/current-transition.password"
cp .cache/search-db/initial-v1/transition.password "$other_reference"
other_current=$(role_row transition)
target_before_a=$(role_row verifier)
run_live rotate-after-password verifier - - failure
assert_counts 1 1 1 0 failure
uncertain_id=$(rotation_id)
container_a=$id
assert_marker "$uncertain_id" "$container_a" verifier
test "$(role_row transition)" = "$other_current"
target_after_a=$(role_row verifier)
[[ "$target_after_a" == false\|SCRAM-SHA-256\$* ]]
test "$target_after_a" != "$target_before_a"
phase=recovery-audit-reset
{
  printf "BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='750ms'; SET LOCAL station.search_admin_rotation_target='station_search_verifier';\n"
  cat ops/postgres/search-admin-roles-audit.sql
  printf "\nCOMMIT; SELECT 'RECOVERY_PASSED';\nBEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='750ms'; SET LOCAL station.search_admin_rotation_target='none';\n"
  cat ops/postgres/search-admin-roles-audit.sql
  printf '\nCOMMIT;\n'
} > "$scratch/recovery-reset.sql"
if docker exec -i "$id" psql -X -A -t -q -U station -d station -v ON_ERROR_STOP=1 \
  < "$scratch/recovery-reset.sql" > "$scratch/recovery-reset.log" 2>&1; then exit 1; fi
grep -Fxq RECOVERY_PASSED "$scratch/recovery-reset.log"
phase=lost-response-A
cp ".cache/search-db/.rotation-$uncertain_id/.owner-operation-inflight" "$scratch/marker-A.json"
if node scripts/search-admin-credentials.mjs finish-pending-rotation verifier "$uncertain_id" --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1; then exit 1; fi
cmp -s "$scratch/marker-A.json" ".cache/search-db/.rotation-$uncertain_id/.owner-operation-inflight"
test "$(role_row verifier)" = "$target_after_a"
run_live finish-observe verifier "$uncertain_id" - failure
assert_counts 0 0 0 0 failure
phase=stopped-A-denial
docker stop "$container_a" >> "$fixture_log" 2>&1
owned_containers+=("$container_a")
config_hash=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container_a" 2>> "$fixture_log")
[[ "$config_hash" =~ ^[0-9a-f]{64}$ ]]
image=$(docker inspect --format '{{.Config.Image}}' "$container_a" 2>> "$fixture_log")
test "$image" = pgvector/pgvector:0.8.7-pg16-bookworm
recreated_id=''
recreate_postgres() {
  local number=$1
  # Compose ps deliberately excludes one-off `compose run` containers. A
  # service-labelled disposable Docker container keeps stopped A/B available
  # for exact-ID denial while the production adapter selects only live B/C.
  recreated_id=$(docker run -d --name "${project}-postgres-recovery-$number" \
    --label "com.docker.compose.project=$project" \
    --label 'com.docker.compose.service=postgres' \
    --label 'com.docker.compose.oneoff=False' \
    --label "com.docker.compose.config-hash=$config_hash" \
    --label "com.docker.compose.container-number=$number" \
    --env POSTGRES_USER=station --env POSTGRES_DB=station --env POSTGRES_PASSWORD \
    --mount "type=volume,source=${project}_pgdata,target=/var/lib/postgresql/data" \
    --network "${project}_default" "$image" 2>> "$fixture_log")
  [[ "$recreated_id" =~ ^[0-9a-f]{64}$ ]]
  owned_containers+=("$recreated_id")
  docker network connect "${project}_search_admin_db" "$recreated_id" >> "$fixture_log" 2>&1
  local labels
  labels=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{index .Config.Labels "com.docker.compose.config-hash"}}' "$recreated_id" 2>> "$fixture_log")
  test "$labels" = "$project|postgres|False|$config_hash"
}
recreate_postgres 2
container_b=$recreated_id
id=$(docker compose ps -q postgres)
test "$id" = "$container_b" && test "$id" != "$container_a"
for attempt in {1..30}; do
  if docker exec "$id" pg_isready -U station -d station >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 30 ]]; then exit 1; fi
  sleep 1
done
if node scripts/search-admin-credentials.mjs finish-pending-rotation verifier "$uncertain_id" --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1; then exit 1; fi
cmp -s "$scratch/marker-A.json" ".cache/search-db/.rotation-$uncertain_id/.owner-operation-inflight"
test "$(role_row verifier)" = "$target_after_a"
run_live finish-observe verifier "$uncertain_id" - failure
assert_counts 0 0 0 0 failure
phase=recreate-B-uncertainty
docker rm "$container_a" >> "$fixture_log" 2>&1
run_live probe-other transition - "$other_reference" success
assert_counts 0 0 0 0 success
test "$(role_row transition)" = "$other_current"
run_live finish-after-password verifier "$uncertain_id" - failure
assert_counts 1 1 1 0 failure
assert_marker "$uncertain_id" "$container_b" verifier
cp ".cache/search-db/.rotation-$uncertain_id/.owner-operation-inflight" "$scratch/marker-B.json"
target_after_b=$(role_row verifier)
if node scripts/search-admin-credentials.mjs finish-pending-rotation verifier "$uncertain_id" --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1; then exit 1; fi
cmp -s "$scratch/marker-B.json" ".cache/search-db/.rotation-$uncertain_id/.owner-operation-inflight"
test "$(role_row verifier)" = "$target_after_b"
phase=stopped-B-denial
docker stop "$container_b" >> "$fixture_log" 2>&1
recreate_postgres 3
container_c=$recreated_id
id=$(docker compose ps -q postgres)
test "$id" = "$container_c" && test "$id" != "$container_b"
for attempt in {1..30}; do
  if docker exec "$id" pg_isready -U station -d station >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 30 ]]; then exit 1; fi
  sleep 1
done
if node scripts/search-admin-credentials.mjs finish-pending-rotation verifier "$uncertain_id" --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1; then exit 1; fi
cmp -s "$scratch/marker-B.json" ".cache/search-db/.rotation-$uncertain_id/.owner-operation-inflight"
test "$(role_row verifier)" = "$target_after_b"
docker rm "$container_b" >> "$fixture_log" 2>&1
run_live probe-other transition - "$other_reference" success
assert_counts 0 0 0 0 success
test "$(role_row transition)" = "$other_current"
phase=finish-C
node scripts/search-admin-credentials.mjs finish-pending-rotation verifier "$uncertain_id" --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
test ! -e ".cache/search-db/.rotation-$uncertain_id"
node scripts/search-admin-credentials.mjs verify --uid "$uid" --gid "$gid" >> "$fixture_log" 2>&1
for secret in "$old_verifier" "$old_transition" "$aborted_verifier" "$intermediate_verifier" \
  .cache/search-db/initial-v1/verifier.password .cache/search-db/initial-v1/transition.password; do
  for log in "$scratch"/*.log; do
    if grep -F -f "$secret" "$log" >/dev/null; then
      echo 'Credential fixture output contained a password.' >&2
      exit 1
    fi
  done
done
echo 'PASS: disposable PG16 held sessions, pre-abort, postpublish finish, two uncertain attempts, stopped-ID denial, same-volume recovery.'
