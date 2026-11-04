import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { verifyWriterRoleApplyServiceConfig } from
  '../../scripts/search-writer-role-apply-service-config.mjs';

try {
  assert.equal(process.argv.length, 4);
  assert.ok(['1000', '1001'].includes(process.argv[2]));
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length; assert.ok(size <= 256 * 1024); chunks.push(chunk);
  }
  const repository = path.resolve(process.argv[3]);
  const project = 'writer_apply_fixture';
  const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(verifyWriterRoleApplyServiceConfig(JSON.parse(Buffer.concat(chunks).toString('utf8')),
    { repository, project, invocationId,
      publicRoot: path.join(repository, '.cache/search-create-apply-public', invocationId),
      volumeName: `${project}_search_writer_apply_${invocationId.replaceAll('-', '')}` }), true);
  process.stdout.write(`Fixed writer role apply render ${process.argv[2]} passed.\n`);
} catch {
  process.stderr.write('Fixed writer role apply Compose render failed.\n');
  process.exitCode = 1;
}
