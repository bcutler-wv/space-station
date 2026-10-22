import assert from 'node:assert/strict';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function assertGenerationProofContainer(container, uid, gid) {
  assert.match(uid ?? '', /^[1-9]\d{0,4}$/);
  assert.match(gid ?? '', /^[1-9]\d{0,4}$/);
  assert.equal(container.Config.User, `${uid}:${gid}`);
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
  assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(container.HostConfig.PidsLimit, 64);
  assert.equal(container.HostConfig.Memory, 268_435_456);
  assert.equal(container.HostConfig.NanoCpus, 1_000_000_000);
  assert.ok(container.HostConfig.GroupAdd.includes('1000'));
  assert.equal(Object.keys(container.NetworkSettings.Networks).length, 1);
  assert.ok(Object.values(container.NetworkSettings.Ports ?? {}).every(port => port === null),
    'no published host port');
  const destinations = [
    '/run/station-admin', '/run/station-query', '/run/station-indexer',
    '/run/generation-a', '/run/generation-b',
  ];
  assert.deepEqual(container.Mounts.map(mount => mount.Destination).sort(), destinations.sort());
  assert.ok(container.Mounts.every(mount => !mount.RW));
  for (const [destination, suffix] of [
    ['/run/station-admin', 'search_admin_certs'],
    ['/run/station-query', 'search_query_certs'],
    ['/run/station-indexer', 'search_indexer_certs'],
  ]) {
    const mount = container.Mounts.find(item => item.Destination === destination);
    assert.equal(mount.Type, 'volume');
    assert.ok(mount.Name.endsWith(`_${suffix}`), 'exact private role volume');
  }
  for (const [destination, suffix] of [
    ['/run/generation-a', '11111111111141118111111111111111'],
    ['/run/generation-b', '22222222222242228222222222222222'],
  ]) {
    const mount = container.Mounts.find(item => item.Destination === destination);
    assert.equal(mount.Type, 'bind');
    assert.equal(mount.Source, `${process.cwd()}/.cache/search-generations/${suffix}`);
  }
  assert.ok(!container.Config.Env.some(value => /PASSWORD|PRIVATE_KEY|MASTER_KEY/.test(value)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    assert.ok(input.length <= 131_072, 'bounded container metadata');
  }
  const [container] = JSON.parse(input);
  assertGenerationProofContainer(container, ...process.argv.slice(2));
  console.info('Disposable generation proof container boundary passed.');
}
