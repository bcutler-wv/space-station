import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { withSearchAdminDatabase, readSearchAdminRegistrySnapshot,
  recheckSearchAdminRegistrySnapshot } from
  '../packages/db/dist/search-admin-connection.js';
import { readBootstrapState } from '../packages/search/dist/opensearch-bootstrap-state.js';
import { openSearchAdminObserver } from '../packages/search/dist/opensearch-runtime.js';
import { runCombinedAttestor, productionAttestorPaths } from './search-attestor-command-core.mjs';

const role = 'station_search_verifier';
const database = { role, host: 'postgres', port: 5432, database: 'station',
  passwordFile: '/run/search-attestor/password' };
const deadline = setTimeout(() => {
  process.stderr.write('Private search attestor verification failed.\n');
  process.exit(1);
}, 70_000);
try {
  if (process.argv.length !== 2 || typeof process.getuid !== 'function' ||
      typeof process.getgid !== 'function' || process.getuid() !== 1000 ||
      process.getgid() !== 1000) throw new Error('fixed command');
  let firstSnapshot;
  await runCombinedAttestor({ ...productionAttestorPaths, uid: 1000, gid: 1000 }, {
    readSnapshot: () => withSearchAdminDatabase(database, async db => {
      if (firstSnapshot && !(await recheckSearchAdminRegistrySnapshot(db, firstSnapshot, role)))
        throw new Error('snapshot drift');
      const snapshot = await readSearchAdminRegistrySnapshot(db, role);
      firstSnapshot ??= snapshot;
      return snapshot;
    }),
    readState: readBootstrapState,
    now: () => new Date(),
    observe: async () => {
      const observer = await openSearchAdminObserver({ endpoint: 'https://opensearch:9200',
        identityDir: '/run/station-admin' });
      try { return await observer.observe(); } finally { await observer.close(); }
    },
  });
  process.stdout.write('Private search attestor verification completed.\n');
} catch {
  process.stderr.write('Private search attestor verification failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
