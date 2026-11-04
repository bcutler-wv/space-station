#!/usr/bin/env node
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { mkdir, lstat } from 'node:fs/promises';
import { withSearchAdminDatabase, readSearchAdminRegistrySnapshot,
  recheckSearchAdminRegistrySnapshot } from '../packages/db/dist/search-admin-connection.js';
import { readBootstrapState } from '../packages/search/dist/opensearch-bootstrap-state.js';
import { openSearchAdminObserver } from '../packages/search/dist/opensearch-runtime.js';
import { openWriterRolePrepareInput } from './search-writer-role-prepare-input.mjs';
import { runWriterRolePrepare } from './search-writer-role-prepare-core.mjs';
import { captureCreateIntentAdminVolume } from './search-create-intent-admin-volume.mjs';

const role = 'station_search_transition';
const database = { role, host: 'postgres', port: 5432, database: 'station',
  passwordFile: '/run/search-writer-role-prepare/transition.password' };
const timer = setTimeout(() => {
  process.stderr.write('Private writer role preparation failed.\n');
  process.exit(1);
}, 180_000);
try {
  if (process.argv.length !== 2 || process.getuid?.() !== 1000 || process.getgid?.() !== 1000)
    throw Error('fixed command');
  await mkdir('/tmp/.cache', { mode: 0o700 });
  await mkdir('/tmp/.cache/search-writer-role-prepare', { mode: 0o700 });
  for (const name of ['/tmp/.cache', '/tmp/.cache/search-writer-role-prepare']) {
    const stat = await lstat(name);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 1000 ||
        stat.gid !== 1000 || (stat.mode & 0o777) !== 0o700)
      throw Error('scratch directory');
  }
  const input = await openWriterRolePrepareInput();
  const output = await runWriterRolePrepare({
    readInput: input.readInput,
    readSnapshot: () => withSearchAdminDatabase(database,
      db => readSearchAdminRegistrySnapshot(db, role)),
    recheckSnapshot: snapshot => withSearchAdminDatabase(database,
      db => recheckSearchAdminRegistrySnapshot(db, snapshot, role)),
    readState: () => readBootstrapState('/run/station-state'),
    captureAdminPublic: () => captureCreateIntentAdminVolume(),
    observe: async () => {
      const observer = await openSearchAdminObserver({ endpoint: 'https://opensearch:9200',
        identityDir: '/run/station-admin' });
      try { return await observer.observe(); } finally { await observer.close(); }
    },
  });
  process.stdout.write(output);
} catch {
  process.stderr.write('Private writer role preparation failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
