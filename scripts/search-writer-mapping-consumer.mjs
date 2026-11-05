#!/usr/bin/env node
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { parseWriterMappingConsumerArgs, initializeWriterMappingScratch,
  runFixedWriterMappingConsumer } from './search-writer-mapping-consumer-wrapper.mjs';

const timer = setTimeout(() => {
  process.stderr.write('Private writer mapping apply failed.\n');
  process.exit(1);
}, 300_000);
try {
  if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000)
    throw Error('fixed user');
  const context = parseWriterMappingConsumerArgs(process.argv.slice(2));
  await initializeWriterMappingScratch();
  await runFixedWriterMappingConsumer(context);
  process.stdout.write('Private writer mapping apply reached writer_attested; search remains disabled.\n');
} catch {
  process.stderr.write('Private writer mapping apply failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
