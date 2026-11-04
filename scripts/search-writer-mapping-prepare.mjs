#!/usr/bin/env node
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { withSearchAdminDatabase, readSearchAdminRegistrySnapshot,
  recheckSearchAdminRegistrySnapshot } from '../packages/db/dist/search-admin-connection.js';
import { readBootstrapState } from '../packages/search/dist/opensearch-bootstrap-state.js';
import { openSearchAdminObserver } from '../packages/search/dist/opensearch-runtime.js';
import { captureCreateIntentAdminVolume } from './search-create-intent-admin-volume.mjs';
import { openWriterMappingPrepareInput } from './search-writer-mapping-prepare-reader.mjs';
import { runFixedWriterMappingPrepareJob,
  fixedWriterMappingPrepareCore, readFixedWriterMappingObservation } from
  './search-writer-mapping-prepare-job.mjs';

const role = 'station_search_transition';
const database = { role, host: 'postgres', port: 5432, database: 'station',
  passwordFile: '/run/search-writer-mapping-prepare/transition.password' };
const timer = setTimeout(() => {
  process.stderr.write('Private writer mapping preparation failed.\n');
  process.exit(1);
}, 180_000);
try {
  if (process.argv.length !== 2 || process.getuid?.() !== 1000 ||
      process.getgid?.() !== 1000) throw Error('fixed command');
  const output = await runFixedWriterMappingPrepareJob({
    openInput: openWriterMappingPrepareInput,
    runCore: fixedWriterMappingPrepareCore,
    readSnapshot: () => withSearchAdminDatabase(database,
      db => readSearchAdminRegistrySnapshot(db, role)),
    recheckSnapshot: snapshot => withSearchAdminDatabase(database,
      db => recheckSearchAdminRegistrySnapshot(db, snapshot, role)),
    readState: () => readBootstrapState('/run/station-state'),
    captureAdminPublic: () => captureCreateIntentAdminVolume(),
    observe: () => readFixedWriterMappingObservation(() => openSearchAdminObserver({
      endpoint: 'https://opensearch:9200', identityDir: '/run/station-admin' })),
  });
  process.stdout.write(output);
} catch {
  process.stderr.write('Private writer mapping preparation failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
