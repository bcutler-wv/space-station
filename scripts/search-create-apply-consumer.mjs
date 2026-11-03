#!/usr/bin/env node
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { mkdir, lstat } from 'node:fs/promises';
import { withSearchAdminDatabase, readSearchAdminRegistrySnapshot,
  recheckSearchAdminRegistrySnapshot } from '../packages/db/dist/search-admin-connection.js';
import { advanceSearchGeneration, armSearchGenerationDispatch,
  updateSearchGenerationDispatch } from '../packages/db/dist/search-generation-admin.js';
import { readBootstrapState } from '../packages/search/dist/opensearch-bootstrap-state.js';
import { openSearchAdminObserver, openSearchAdminCreateClient } from
  '../packages/search/dist/opensearch-runtime.js';
import { createLiteralV2IndexOnce } from '../packages/search/dist/opensearch-create-index.js';
import { openCreateApplyInput } from './search-create-apply-input.mjs';
import { captureCreateIntentAdminVolume } from './search-create-intent-admin-volume.mjs';
import { runCreateApplyConsumer } from './search-create-apply-consumer-core.mjs';

const role = 'station_search_transition';
const database = { role, host: 'postgres', port: 5432, database: 'station',
  passwordFile: '/run/search-create-apply/transition.password' };
// The bounded observer and DB calls repeat at each finite stage. This is a
// whole-job ceiling, not a retry deadline; an expiry leaves the send unknown.
const timer = setTimeout(() => {
  process.stderr.write('Private create apply failed.\n');
  process.exit(1);
}, 300_000);
try {
  if (process.argv.length !== 2 || process.getuid?.() !== 1000 || process.getgid?.() !== 1000)
    throw Error('fixed command');
  await mkdir('/tmp/.cache', { mode: 0o700 });
  await mkdir('/tmp/.cache/search-create-apply', { mode: 0o700 });
  for (const name of ['/tmp/.cache', '/tmp/.cache/search-create-apply']) {
    const stat = await lstat(name);
    if (!stat.isDirectory() || stat.uid !== 1000 || stat.gid !== 1000 ||
        (stat.mode & 0o777) !== 0o700) throw Error('scratch directory');
  }
  const input = await openCreateApplyInput();
  const dbCall = work => withSearchAdminDatabase(database, work);
  const mutate = work => dbCall(db => db.transaction(tx => work(tx)));
  const result = await runCreateApplyConsumer({
    ...input,
    readSnapshot: () => dbCall(db => readSearchAdminRegistrySnapshot(db, role)),
    recheck: snapshot => dbCall(db => recheckSearchAdminRegistrySnapshot(db, snapshot, role)),
    readState: () => readBootstrapState('/run/station-state'),
    captureAdmin: () => captureCreateIntentAdminVolume(),
    observe: async () => {
      const observer = await openSearchAdminObserver({ endpoint: 'https://opensearch:9200',
        identityDir: '/run/station-admin' });
      try { return await observer.observe(); } finally { await observer.close(); }
    },
    advance: (control, stage, uuid) => mutate(tx =>
      advanceSearchGeneration(tx, control, stage, uuid)),
    arm: (control, dispatch) => mutate(tx =>
      armSearchGenerationDispatch(tx, control, dispatch)),
    dispatch: (control, dispatch) => mutate(tx =>
      updateSearchGenerationDispatch(tx, control, dispatch)),
    createOnce: async (index, recheckAdmin) => {
      const client = await openSearchAdminCreateClient({ endpoint: 'https://opensearch:9200',
        identityDir: '/run/station-admin' });
      try {
        if (!(await recheckAdmin())) throw Error('admin identity changed');
        return await createLiteralV2IndexOnce(client.indices, index);
      } finally { await client.close(); }
    },
  });
  if (result.status !== 'uuid_bound' || result.ready !== false) throw Error('invalid result');
  process.stdout.write('Private create apply reached uuid_bound; search remains disabled.\n');
} catch {
  process.stderr.write('Private create apply failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
