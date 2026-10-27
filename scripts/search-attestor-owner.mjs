#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runAttestorOwner } from './search-attestor-owner-core.mjs';
import { createAttestorDockerAdapter } from './search-attestor-owner-docker.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => {
  process.stderr.write('Private search attestor owner operation failed; inspect private retained evidence.\n');
  process.exit(1);
}, 240_000);
try {
  if (process.argv.length !== 2 || !/^[1-9][0-9]*$/.test(process.env.APP_UID ?? '') ||
      !/^[1-9][0-9]*$/.test(process.env.APP_GID ?? '') ||
      Number(process.env.APP_UID) !== process.getuid?.() ||
      Number(process.env.APP_GID) !== process.getgid?.()) throw new Error('owner identity');
  await runAttestorOwner({ repository, uid: process.getuid(), gid: process.getgid(),
    adapterFactory: createAttestorDockerAdapter });
  process.stdout.write('Private search attestor owner verification completed.\n');
} catch {
  process.stderr.write('Private search attestor owner operation failed; inspect private retained evidence.\n');
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
