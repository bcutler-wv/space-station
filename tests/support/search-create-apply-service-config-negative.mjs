/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { verifyCreateApplyServiceConfig } from '../../scripts/search-create-apply-service-config.mjs';

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
  const project = 'create_apply_fixture';
  const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const expected = { repository, project, invocationId,
    publicRoot: path.join(repository, '.cache/search-create-apply-public', invocationId),
    volumeName: `${project}_search_create_apply_${invocationId.replaceAll('-', '')}` };
  assert.equal(verifyCreateApplyServiceConfig(config, expected), true);
  for (const mutate of [
    value => { value.networks.search_admin_db.ipam = { config: [{ subnet: '0.0.0.0/0' }] }; },
    value => { value.services['search-create-index'].networks.default = null; },
    value => { value.services['search-create-index'].command.push('retry'); },
    value => { value.services['search-create-index'].environment = { POSTGRES_PASSWORD: 'bad' }; },
    value => { value.services['search-create-index'].volumes[0].read_only = false; },
    value => { value.services['search-create-index'].volumes[0].volume.nocopy = false; },
    value => { value.services['search-create-apply-transfer'].cap_add.push('SYS_ADMIN'); },
    value => { value.services['search-create-apply-transfer'].network_mode = 'bridge'; },
    value => { value.services['search-create-apply-transfer'].volumes.push({ type: 'bind',
      source: '/tmp/ca.key', target: '/run/ca.key', read_only: true }); },
  ]) {
    const changed = structuredClone(config);
    mutate(changed);
    assert.throws(() => verifyCreateApplyServiceConfig(changed, expected));
  }
  process.stdout.write('Fixed create apply config fault matrix passed.\n');
} catch {
  process.stderr.write('Fixed create apply config fault matrix failed.\n');
  process.exitCode = 1;
}
