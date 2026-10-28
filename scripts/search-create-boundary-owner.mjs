#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runCreateBoundaryOwner } from './search-create-boundary-owner-core.mjs';
import { createBoundaryDockerAdapter } from './search-create-boundary-owner-docker.mjs';
import { createBoundaryDiagnosticLine } from './search-create-boundary-owner-diagnostic.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timer = setTimeout(() => {
  process.stderr.write('Private create boundary owner operation failed.\n');
  process.stderr.write('Private create boundary owner diagnostic stage=deadline reason=deadline.\n');
  process.exit(1);
}, 240_000);
try {
  if (process.argv.length !== 2 || !/^[1-9][0-9]*$/.test(process.env.APP_UID ?? '') ||
      !/^[1-9][0-9]*$/.test(process.env.APP_GID ?? '') ||
      Number(process.env.APP_UID) !== process.getuid?.() ||
      Number(process.env.APP_GID) !== process.getgid?.()) throw new Error('owner identity');
  await runCreateBoundaryOwner({ repository, uid: process.getuid(), gid: process.getgid(),
    adapterFactory: createBoundaryDockerAdapter });
  process.stdout.write('Private create boundary owner observation completed.\n');
} catch (error) {
  process.stderr.write('Private create boundary owner operation failed.\n');
  process.stderr.write(createBoundaryDiagnosticLine(error));
  process.exitCode = 1;
} finally { clearTimeout(timer); }
