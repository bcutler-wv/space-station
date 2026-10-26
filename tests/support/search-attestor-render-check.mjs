import { Buffer } from 'node:buffer';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { verifyAttestorServiceConfig } from '../../scripts/search-attestor-service-config.mjs';

const fail = () => { throw new Error('Search attestor config render proof failed.'); };
try {
  const id = process.argv[2];
  if (process.argv.length !== 3 || !['1000', '1001'].includes(id)) fail();
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 256 * 1024) fail();
    chunks.push(chunk);
  }
  const repository = resolve('.');
  const project = 'attestor_fixture';
  const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  verifyAttestorServiceConfig(config, { project, uid: Number(id), gid: Number(id),
    repository, invocationId,
    invocationRoot: join(repository, '.cache/search-attestor-invocations', invocationId),
    publicRoot: join(repository, '.cache/search-attestor-public', invocationId),
    volumeName: `${project}_search_attestor_${invocationId.replaceAll('-', '')}` });
  process.stdout.write(`Search attestor config render ${id}:${id} passed.\n`);
} catch {
  process.stderr.write('Search attestor config render proof failed.\n');
  process.exitCode = 1;
}
