#!/usr/bin/env node
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { transferCreateBoundaryPassword, productionCreateTransferPaths } from './search-create-boundary-transfer-core.mjs';

const timer = setTimeout(() => {
  process.stderr.write('Private create boundary transfer failed.\n');
  process.exit(1);
}, 30_000);
try {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || process.getgid?.() !== 0)
    throw new Error('fixed command');
  await transferCreateBoundaryPassword(productionCreateTransferPaths);
  process.stdout.write('Private create boundary transfer completed.\n');
} catch {
  process.stderr.write('Private create boundary transfer failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
