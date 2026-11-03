import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { verifyCreateApplyServiceConfig } from '../../scripts/search-create-apply-service-config.mjs';

try {
  assert.equal(process.argv.length, 4);
  assert.ok(['1000', '1001'].includes(process.argv[2]));
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    assert.ok(length <= 256 * 1024);
    chunks.push(chunk);
  }
  const repository = path.resolve(process.argv[3]);
  const project = 'create_apply_fixture';
  const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  verifyCreateApplyServiceConfig(JSON.parse(Buffer.concat(chunks).toString('utf8')),
    { repository, project, invocationId,
      publicRoot: path.join(repository, '.cache/search-create-apply-public', invocationId),
      volumeName: `${project}_search_create_apply_${invocationId.replaceAll('-', '')}` });
  process.stdout.write(`Fixed create apply render ${process.argv[2]} passed.\n`);
} catch {
  process.stderr.write('Fixed create apply Compose render failed.\n');
  process.exitCode = 1;
}
