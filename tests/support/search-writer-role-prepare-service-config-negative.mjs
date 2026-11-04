/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { verifyWriterRolePrepareServiceConfig } from '../../scripts/search-create-apply-service-config.mjs';

try {
  assert.equal(process.argv.length, 3);
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    assert.ok(size <= 256 * 1024);
    chunks.push(chunk);
  }
  const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const repository = path.resolve(process.argv[2]);
  const project = 'writer_prepare_fixture';
  const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const expected = { repository, project, invocationId,
    publicRoot: path.join(repository, '.cache/search-create-apply-public', invocationId),
    invocationRoot: path.join(repository, '.cache/search-writer-role-invocations', invocationId),
    volumeName: `${project}_search_writer_prepare_${invocationId.replaceAll('-', '')}` };
  assert.equal(verifyWriterRolePrepareServiceConfig(config, expected), true);
  for (const mutate of [
    value => { value.networks.search_admin_db.ipam = { config: [{ subnet: '0.0.0.0/0' }] }; },
    value => { value.services['search-writer-role-prepare'].networks.default = null; },
    value => { value.services['search-writer-role-prepare'].command.push('send'); },
    value => { value.services['search-writer-role-prepare'].environment = { OTHER: 'bad' }; },
    value => { value.services['search-writer-role-prepare'].volumes[0].read_only = false; },
    value => { value.services['search-writer-role-prepare'].volumes[0].volume.nocopy = false; },
    value => { value.services['search-writer-role-prepare-transfer'].cap_add.push('SYS_ADMIN'); },
    value => { value.services['search-writer-role-prepare-transfer'].network_mode = 'bridge'; },
    value => { value.services['search-writer-role-prepare-transfer'].volumes.push({ type: 'bind',
      source: '/tmp/ca.key', target: '/run/ca.key', read_only: true }); },
  ]) {
    const changed = structuredClone(config);
    mutate(changed);
    assert.throws(() => verifyWriterRolePrepareServiceConfig(changed, expected));
  }
  process.stdout.write('Fixed writer preparation config fault matrix passed.\n');
} catch {
  process.stderr.write('Fixed writer preparation config fault matrix failed.\n');
  process.exitCode = 1;
}
