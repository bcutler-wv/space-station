#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runWriterMappingPrepareOwner } from './search-writer-mapping-prepare-owner-core.mjs';
import { createWriterMappingPrepareDockerAdapter } from './search-create-boundary-owner-docker.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timer = setTimeout(() => {
  process.stderr.write('Private writer mapping preparation owner failed.\n');
  process.exit(1);
}, 510_000);
try {
  if (process.argv.length !== 9 ||
      !/^[1-9][0-9]*$/.test(process.env.APP_UID ?? '') ||
      !/^[1-9][0-9]*$/.test(process.env.APP_GID ?? '') ||
      Number(process.env.APP_UID) !== process.getuid?.() ||
      Number(process.env.APP_GID) !== process.getgid?.()) throw Error('owner identity');
  const result = await runWriterMappingPrepareOwner({ repository,
    uid: process.getuid(), gid: process.getgid(), args: process.argv.slice(2),
    adapterFactory: createWriterMappingPrepareDockerAdapter });
  if (result.state !== 'prepared' || typeof result.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(result.sha256)) throw Error('invalid result');
  process.stdout.write(`Private writer mapping proposal prepared: ${result.sha256}\n`);
} catch {
  process.stderr.write('Private writer mapping preparation owner failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
