#!/usr/bin/env bash
set -euo pipefail

container_id=$(docker compose --profile search ps -q meilisearch)
test -n "$container_id"
test "$(stat -c %a .cache/meilisearch.env)" = 600
docker inspect "$container_id" | node -e '
  const assert = require("node:assert/strict");
  const { execFileSync } = require("node:child_process");
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const [container] = JSON.parse(input);
    assert.equal(container.Config.Image, "getmeili/meilisearch:v1.55.0@sha256:ff546679970126f8822e15d1b6a06bfbff1f2ce2e43f810cfb5258012f92de5c");
    assert.equal(container.Config.User, "1000:1000");
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    const networks = Object.keys(container.NetworkSettings.Networks);
    assert.equal(networks.length, 1);
    assert.equal(networks[0].endsWith("search_internal"), true);
    const [network] = JSON.parse(execFileSync("docker", ["network", "inspect", networks[0]], { encoding:"utf8" }));
    assert.equal(network.Internal, true);
    assert.deepEqual(container.HostConfig.PortBindings ?? {}, {});
    assert.ok(container.HostConfig.CapDrop.includes("ALL"));
    assert.ok(container.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
    assert.equal(container.HostConfig.Memory, 1073741824);
    assert.equal(container.HostConfig.NanoCpus, 1000000000);
    assert.equal(container.HostConfig.PidsLimit, 128);
    assert.ok(container.Config.Env.includes("MEILI_NO_ANALYTICS=true"));
    assert.equal(container.State.Health.Status, "healthy");
  });
'
test "$(docker compose --profile search exec -T meilisearch id -u)" = 1000
docker compose --profile search exec -T meilisearch sh -ec 'test -w /meili_data'
echo 'Pinned private search container isolation verified.'
