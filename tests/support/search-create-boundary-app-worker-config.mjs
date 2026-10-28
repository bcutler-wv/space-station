import assert from 'node:assert/strict';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Inspect the normalized Compose services, not their YAML spelling. These
// services are intentionally outside the private create boundary.
export function assertAppWorkerWithoutCreateAuthority(config, repository) {
  assert.ok(config && typeof config === 'object' && config.services);
  for (const [name, expectedNetworks, expectedTargets] of [
    ['app', ['camo_egress', 'default'], ['/run/tls', '/var/lib/station/blobs']],
    ['worker', ['default', 'mail_parser'], ['/var/lib/station/blobs']],
  ]) {
    const service = config.services[name];
    assert.ok(service && typeof service === 'object');
    assert.deepEqual(Object.keys(service.networks ?? {}).sort(), expectedNetworks);
    assert.equal(service.network_mode, undefined);
    assert.ok(Array.isArray(service.volumes));
    assert.deepEqual(service.volumes.map(volume => volume.target).sort(), expectedTargets);
    for (const volume of service.volumes) {
      if (volume.target === '/var/lib/station/blobs') {
        assert.equal(volume.type, 'volume');
        assert.equal(volume.source, 'private_blobs');
      } else {
        assert.equal(name, 'app');
        assert.equal(volume.type, 'bind');
        assert.equal(volume.source, path.join(repository, '.cache/tls'));
        assert.equal(volume.read_only, true);
      }
    }
    assert.ok(service.environment && typeof service.environment === 'object');
    assert.ok(Object.keys(service.environment).every(key =>
      !key.startsWith('STATION_CREATE_') && !key.startsWith('PG') &&
      !['SEARCH_ADMIN_PASSWORD', 'SEARCH_TRANSITION_PASSWORD'].includes(key)));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3);
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      assert.ok(size <= 256 * 1024);
      chunks.push(chunk);
    }
    assertAppWorkerWithoutCreateAuthority(JSON.parse(Buffer.concat(chunks).toString('utf8')),
      path.resolve(process.argv[2]));
    process.stdout.write('Normalized app/worker create-authority exclusion passed.\n');
  } catch {
    process.stderr.write('Normalized app/worker create-authority exclusion failed.\n');
    process.exitCode = 1;
  }
}
