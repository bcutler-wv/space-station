#!/usr/bin/env bash
set -euo pipefail

container_id="$(docker compose --profile search ps -q opensearch)"
test -n "$container_id"
test "$(stat -c %a .cache/search-security)" = 700
test "$(docker compose --profile search port opensearch 9200 | wc -l)" -eq 0

docker inspect "$container_id" | node --input-type=module -e '
  import assert from "node:assert/strict";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const [container] = JSON.parse(input);
  assert.equal(container.Config.Image,
    "opensearchproject/opensearch:3.9.0@sha256:adfa61f85025d06b4aeb562e7e74fde7e31c437039c93c3862c17e9acebd6c7c");
  assert.equal(container.Config.User, "1000:1000");
  assert.equal(container.HostConfig.Memory, 2147483648);
  assert.equal(container.HostConfig.NanoCpus, 2000000000);
  assert.equal(container.HostConfig.PidsLimit, 512);
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.HostConfig.Tmpfs["/tmp"], "rw,exec,nosuid,size=128m");
  assert.equal(container.HostConfig.Tmpfs["/usr/share/opensearch/logs"],
    "rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700");
  assert.deepEqual(container.HostConfig.CapDrop, ["ALL"]);
  assert.ok(container.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(Object.keys(container.NetworkSettings.Networks).length, 1);
  const [network] = Object.values(container.NetworkSettings.Networks);
  assert.ok(network.NetworkID);
  const mounts = container.Mounts;
  assert.ok(mounts.some(m => m.Destination === "/usr/share/opensearch/data" && m.Type === "volume" && m.RW));
  assert.ok(mounts.some(m => m.Destination === "/usr/share/opensearch/config" && m.Type === "volume" && m.RW));
  assert.ok(mounts.some(m => m.Destination === "/usr/share/opensearch/config/station-certs" && !m.RW));
  assert.ok(!mounts.some(m => /admin|query|indexer|outsider|ca\.key/.test(m.Destination)));
  assert.equal(container.Config.Env.some(value => /PASSWORD|PRIVATE_KEY|MASTER_KEY/.test(value)), false);
  process.stdout.write(network.NetworkID);
' > .cache/results/opensearch-network-id

network_id="$(cat .cache/results/opensearch-network-id)"
test "$(docker network inspect --format '{{.Internal}}' "$network_id")" = true
test "$(docker compose --profile search exec -T opensearch id -u)" = 1000
docker compose --profile search exec -T opensearch sh -ec '
  test -r /usr/share/opensearch/config/station-certs/node.key
  test -w /usr/share/opensearch/data
  test "$(stat -c %u:%g:%a /usr/share/opensearch/logs)" = 1000:1000:700
  test -w /usr/share/opensearch/logs
  : > /usr/share/opensearch/logs/.station-permission-probe
  rm /usr/share/opensearch/logs/.station-permission-probe
'
