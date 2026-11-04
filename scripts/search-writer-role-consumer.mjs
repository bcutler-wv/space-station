#!/usr/bin/env node
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { parseWriterRoleConsumerArgs, initializeWriterRoleScratch,
  runFixedWriterRoleConsumer } from './search-writer-role-consumer-wrapper.mjs';

const timer = setTimeout(() => {
  process.stderr.write('Private writer role apply failed.\n');
  process.exit(1);
}, 300_000);
try {
  if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000)
    throw Error('fixed user');
  const context = parseWriterRoleConsumerArgs(process.argv.slice(2));
  await initializeWriterRoleScratch();
  await runFixedWriterRoleConsumer(context);
  process.stdout.write('Private writer role apply reached writer_role_attested; search remains disabled.\n');
} catch {
  process.stderr.write('Private writer role apply failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
