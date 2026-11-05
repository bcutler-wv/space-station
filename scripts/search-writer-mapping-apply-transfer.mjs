#!/usr/bin/env node
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { transferWriterMappingApplyInputs, productionWriterMappingApplyTransferPaths } from
  './search-writer-mapping-apply-transfer-core.mjs';

const timer = setTimeout(() => {
  process.stderr.write('Private writer mapping apply transfer failed.\n');
  process.exit(1);
}, 45_000);
try {
  if (process.argv.length !== 2 || process.getuid?.() !== 0 || process.getgid?.() !== 0)
    throw Error('fixed command');
  await transferWriterMappingApplyInputs(productionWriterMappingApplyTransferPaths);
  process.stdout.write('Private writer mapping apply transfer completed.\n');
} catch {
  process.stderr.write('Private writer mapping apply transfer failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
