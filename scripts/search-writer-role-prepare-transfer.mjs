#!/usr/bin/env node
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { transferWriterRolePrepareInputs, productionWriterRolePrepareTransferPaths } from
  './search-create-apply-transfer-core.mjs';

const timer = setTimeout(() => {
  process.stderr.write('Private writer role preparation transfer failed.\n');
  process.exit(1);
}, 45_000);
try {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || process.getgid?.() !== 0)
    throw Error('fixed command');
  await transferWriterRolePrepareInputs(productionWriterRolePrepareTransferPaths);
  process.stdout.write('Private writer role preparation transfer completed.\n');
} catch {
  process.stderr.write('Private writer role preparation transfer failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
