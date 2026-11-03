#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runCreateApplyOwner } from './search-create-apply-owner-core.mjs';
import { createApplyDockerAdapter } from './search-create-boundary-owner-docker.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timer = setTimeout(() => {
  process.stderr.write('Private create apply owner failed.\n');
  process.exit(1);
}, 480_000);
try {
  if (process.argv.length !== 10 ||
      !/^[1-9][0-9]*$/.test(process.env.APP_UID ?? '') ||
      !/^[1-9][0-9]*$/.test(process.env.APP_GID ?? '') ||
      Number(process.env.APP_UID) !== process.getuid?.() ||
      Number(process.env.APP_GID) !== process.getgid?.()) throw Error('owner identity');
  const result = await runCreateApplyOwner({ repository,
    uid: process.getuid(), gid: process.getgid(), args: process.argv.slice(2),
    adapterFactory: createApplyDockerAdapter });
  if (result.state !== 'uuid_bound' || result.ready !== false) throw Error('invalid result');
  process.stdout.write('Private create apply completed; search remains disabled.\n');
} catch {
  process.stderr.write('Private create apply owner failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
