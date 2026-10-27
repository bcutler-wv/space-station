#!/usr/bin/env node
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { withSearchAdminDatabase, readSearchAdminRegistrySnapshot,
  recheckSearchAdminRegistrySnapshot } from '../packages/db/dist/search-admin-connection.js';
import { readBootstrapState } from '../packages/search/dist/opensearch-bootstrap-state.js';
import { openSearchAdminObserver } from '../packages/search/dist/opensearch-runtime.js';
import { readCreateBoundaryInvocation, runReadOnlyCreateBoundary } from './search-create-boundary-core.mjs';

const role = 'station_search_transition';
const database = { role, host: 'postgres', port: 5432, database: 'station',
  passwordFile: '/run/create-boundary/transition.password' };
const timer = setTimeout(() => {
  process.stderr.write('Private create boundary evidence failed.\n');
  process.exit(1);
}, 70_000);
try {
  if (process.argv.length !== 2 || process.getuid?.() !== 1000 || process.getgid?.() !== 1000)
    throw new Error('fixed command');
  await runReadOnlyCreateBoundary({
    readInvocation: () => readCreateBoundaryInvocation('/run/create-boundary'),
    readState: () => readBootstrapState('/run/station-state'),
    readSnapshot: () => withSearchAdminDatabase(database,
      db => readSearchAdminRegistrySnapshot(db, role)),
    recheck: snapshot => withSearchAdminDatabase(database,
      db => recheckSearchAdminRegistrySnapshot(db, snapshot, role)),
    observe: async () => {
      const observer = await openSearchAdminObserver({ endpoint: 'https://opensearch:9200',
        identityDir: '/run/station-admin' });
      try { return await observer.observe(); } finally { await observer.close(); }
    },
  });
  process.stdout.write('Private create boundary evidence completed.\n');
} catch {
  process.stderr.write('Private create boundary evidence failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
