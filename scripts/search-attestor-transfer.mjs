#!/usr/bin/env node
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { transferAttestorInputs, productionTransferPaths } from './search-attestor-transfer-core.mjs';

const deadline = setTimeout(() => {
  process.stderr.write('Private search attestor transfer failed.\n');
  process.exit(1);
}, 30_000);
try {
  if (process.argv.length !== 2 || typeof process.getuid !== 'function' ||
      typeof process.getgid !== 'function' || process.getuid() !== 0 || process.getgid() !== 0)
    throw new Error('fixed command');
  await transferAttestorInputs(productionTransferPaths);
  process.stdout.write('Private search attestor transfer completed.\n');
} catch {
  process.stderr.write('Private search attestor transfer failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
