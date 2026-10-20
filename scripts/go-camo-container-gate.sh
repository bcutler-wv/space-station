#!/usr/bin/env bash
set -euo pipefail

network=station_camo_fixture_$$
fixture=station-camo-fixture-$$
cleanup() {
  docker rm -f "$fixture" >/dev/null 2>&1 || true
  docker network disconnect "$network" "$(docker compose ps -q go-camo)" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

test -z "$(docker compose port go-camo 8080 2>/dev/null)"
test "$(docker inspect -f '{{.Config.User}}' "$(docker compose ps -q go-camo)")" = "${APP_UID:-1000}:${APP_GID:-1000}"
test "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$(docker compose ps -q go-camo)")" = true
docker inspect "$(docker compose ps -q go-camo)" | node -e '
  let input="";process.stdin.on("data",x=>input+=x).on("end",()=>{
    const c=JSON.parse(input)[0]; const e=Object.fromEntries(c.Config.Env.map(x=>x.split(/=(.*)/s).slice(0,2)));
    if(!e.GOCAMO_HMAC || Object.keys(e).some(k=>/POSTGRES|MASTER|DB_|TOKEN|SECRET/.test(k)) ||
      ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY"].some(k=>e[k]!=="") ||
      c.HostConfig.PidsLimit!==64 || c.HostConfig.Memory!==134217728 || c.HostConfig.Privileged ||
      !c.Config.Cmd.includes("--max-redirects=0") || c.Config.Cmd.some(x=>/verbose|enable-xfwd4|allow-credential/.test(x)))process.exit(1);
  });'
docker network create --internal --subnet 11.203.0.0/24 "$network" >/dev/null
docker network connect "$network" "$(docker compose ps -q go-camo)"
docker run -d --name "$fixture" --network "$network" --ip 11.203.0.10 --network-alias raster.example.com --user 0:0 \
  --entrypoint node "$(docker compose images -q app)" tests/support/camo-fixture.mjs >/dev/null
test "$(docker inspect -f '{{len .NetworkSettings.Networks}}' "$fixture")" = 1
test "$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$fixture")" = "$network"
ready=false
for attempt in $(seq 1 30); do
  if docker exec "$fixture" node -e "fetch('http://127.0.0.1/calls').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
test "$ready" = true
docker compose run --rm -T --no-deps app node tests/integration/go-camo.mjs
docker compose run --rm -T --no-deps -e DB_NAME=station_mail_reader_test \
  -e MAIL_READER_FIXTURE_DIR=/var/lib/station/blobs -e CAMO_FIXTURE_URL=http://raster.example.com/raster \
  app node tests/integration/mail-reader-db.mjs
counts=$(docker exec "$fixture" node -e "fetch('http://127.0.0.1/calls').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))")
node -e "const c=JSON.parse(process.argv[1]); if(c['/redirect-target'] || c['/raster']!==3 || c['/avif']!==1) process.exit(1)" "$counts"
