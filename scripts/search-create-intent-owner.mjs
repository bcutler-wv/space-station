#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runCreateIntentPrepareOwner } from './search-create-intent-owner-core.mjs';
import { createIntentPrepareDockerAdapter } from './search-create-boundary-owner-docker.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timer = setTimeout(() => {
  process.stderr.write('Private create intent owner preparation failed.\n');
  process.exit(1);
}, 240_000);
try {
  if (process.argv.length !== 2 || !/^[1-9][0-9]*$/.test(process.env.APP_UID ?? '') ||
      !/^[1-9][0-9]*$/.test(process.env.APP_GID ?? '') ||
      Number(process.env.APP_UID) !== process.getuid?.() ||
      Number(process.env.APP_GID) !== process.getgid?.()) throw new Error('owner identity');
  const result = await runCreateIntentPrepareOwner({ repository, uid: process.getuid(),
    gid: process.getgid(), adapterFactory: createIntentPrepareDockerAdapter });
  process.stdout.write(`Private create intent prepared sha256=${result.sha256}.\n`);
} catch {
  process.stderr.write('Private create intent owner preparation failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
