#!/usr/bin/env bash
set -euo pipefail

network=station_camo_fixture_$$
fixture=station-camo-fixture-$$
phase='container inspection'
cleanup() {
  docker rm -f "$fixture" >/dev/null 2>&1 || true
  docker network disconnect "$network" "$(docker compose ps -q go-camo)" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
on_exit() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    printf 'go-camo gate failed during %s (exit %d)\n' "$phase" "$status" >&2
  fi
  cleanup
  exit "$status"
}
trap on_exit EXIT

container=$(docker compose ps -q go-camo)
if [[ -z "$container" ]]; then
  echo 'go-camo container is not running' >&2
  exit 1
fi
docker inspect "$container" | node -e '
  let input="";process.stdin.on("data",x=>input+=x).on("end",()=>{
    const c=JSON.parse(input)[0];
    const e=Object.fromEntries(c.Config.Env.map(x=>x.split(/=(.*)/s).slice(0,2)));
    const checks=[
      ["non-root configured UID/GID",c.Config.User===process.argv[1]],
      ["read-only root filesystem",c.HostConfig.ReadonlyRootfs===true],
      ["no published host ports",Object.values(c.HostConfig.PortBindings??{}).every(x=>x==null || x.length===0)],
      ["dedicated HMAC present",Boolean(e.GOCAMO_HMAC)],
      ["no application credentials",!Object.keys(e).some(k=>/POSTGRES|MASTER|DB_|TOKEN|SECRET/.test(k))],
      ["proxy variables cleared",["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY"].every(k=>e[k]==="")],
      ["process limit",c.HostConfig.PidsLimit===64],
      ["memory limit",c.HostConfig.Memory===134217728],
      ["unprivileged container",c.HostConfig.Privileged===false],
      ["redirects disabled",c.Config.Cmd?.includes("--max-redirects=0")===true],
      ["debug and forwarding options disabled",!c.Config.Cmd?.some(x=>/verbose|enable-xfwd4|allow-credential/.test(x))]
    ];
    for(const [name,valid] of checks) if(!valid) console.error(`go-camo configuration check failed: ${name}`);
    if(checks.some(([,valid])=>!valid)) process.exitCode=1;
  });' "${APP_UID:-1000}:${APP_GID:-1000}"
phase='fixture network setup'
docker network create --internal --subnet 11.203.0.0/24 "$network" >/dev/null
docker network connect "$network" "$container"
docker run -d --name "$fixture" --network "$network" --ip 11.203.0.10 --network-alias raster.example.com --user 0:0 \
  --entrypoint node "$(docker compose images -q app)" tests/support/camo-fixture.mjs >/dev/null
if [[ "$(docker inspect -f '{{len .NetworkSettings.Networks}}' "$fixture")" != 1 ||
      "$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$fixture")" != "$network" ]]; then
  echo 'fixture container has unexpected network access' >&2
  exit 1
fi
phase='fixture readiness'
ready=false
for attempt in $(seq 1 30); do
  if docker exec "$fixture" node -e "fetch('http://127.0.0.1/calls').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'fixture container did not become ready' >&2
  exit 1
fi
phase='go-camo request tests'
docker compose run --rm -T --no-deps app node tests/integration/go-camo.mjs
phase='mail reader image tests'
docker compose run --rm -T --no-deps -e DB_NAME=station_mail_reader_test \
  -e MAIL_READER_FIXTURE_DIR=/var/lib/station/blobs -e CAMO_FIXTURE_URL=http://raster.example.com/raster \
  app node tests/integration/mail-reader-db.mjs
phase='fixture request accounting'
counts=$(docker exec "$fixture" node -e "fetch('http://127.0.0.1/calls').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))")
node -e "const c=JSON.parse(process.argv[1]); if(c['/redirect-target'] || c['/raster']!==3 || c['/avif']!==1) { console.error('fixture request counts did not match expectations'); process.exit(1) }" "$counts"
