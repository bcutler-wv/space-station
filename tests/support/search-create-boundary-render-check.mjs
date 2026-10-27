import { Buffer } from 'node:buffer';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { verifyCreateBoundaryServiceConfig } from '../../scripts/search-create-boundary-service-config.mjs';

try {
  if (process.argv.length !== 3 || !['1000', '1001'].includes(process.argv[2]))
    throw new Error('Unexpected fixture owner.');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Oversized render.');
    chunks.push(chunk);
  }
  const repository = resolve('.');
  const project = 'create_fixture';
  const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  verifyCreateBoundaryServiceConfig(JSON.parse(Buffer.concat(chunks).toString('utf8')),
    { project, repository, invocationId,
      invocationRoot: join(repository, '.cache/search-create-invocations', invocationId),
      volumeName: `${project}_search_create_${invocationId.replaceAll('-', '')}` });
  process.stdout.write(`Search create boundary config render ${process.argv[2]} passed.\n`);
} catch {
  process.stderr.write('Search create boundary config render proof failed.\n');
  process.exitCode = 1;
}
