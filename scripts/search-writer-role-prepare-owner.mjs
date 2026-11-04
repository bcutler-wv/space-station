#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runWriterRolePrepareOwner } from './search-writer-role-prepare-owner-core.mjs';
import { createWriterRolePrepareDockerAdapter } from './search-create-boundary-owner-docker.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timer = setTimeout(() => {
  process.stderr.write('Private writer role preparation owner failed.\n');
  process.exit(1);
}, 400_000);
try {
  if (process.argv.length !== 2 ||
      !/^[1-9][0-9]*$/.test(process.env.APP_UID ?? '') ||
      !/^[1-9][0-9]*$/.test(process.env.APP_GID ?? '') ||
      Number(process.env.APP_UID) !== process.getuid?.() ||
      Number(process.env.APP_GID) !== process.getgid?.()) throw Error('owner identity');
  const result = await runWriterRolePrepareOwner({ repository,
    uid: process.getuid(), gid: process.getgid(),
    adapterFactory: createWriterRolePrepareDockerAdapter });
  if (result.state !== 'prepared' || !/^[0-9a-f]{64}$/.test(result.sha256))
    throw Error('invalid result');
  process.stdout.write(`Private writer role proposal prepared: ${result.sha256}\n`);
} catch {
  process.stderr.write('Private writer role preparation owner failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
