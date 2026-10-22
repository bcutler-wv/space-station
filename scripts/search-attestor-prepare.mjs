import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { withSearchAdminDatabase, readSearchAdminRegistrySnapshot } from
  '../packages/db/dist/search-admin-connection.js';
import { prepareAttestor, productionAttestorPaths } from './search-attestor-command-core.mjs';

const role = 'station_search_verifier';
const database = { role, host: 'postgres', port: 5432, database: 'station',
  passwordFile: '/run/search-db/password' };
const deadline = setTimeout(() => {
  process.stderr.write('Private search attestor preparation failed.\n');
  process.exit(1);
}, 70_000);
try {
  if (process.argv.length !== 2 || typeof process.getuid !== 'function' ||
      typeof process.getgid !== 'function' || process.getuid() === 0) throw new Error('fixed command');
  await prepareAttestor({ ...productionAttestorPaths, uid: process.getuid(), gid: process.getgid() }, {
    readSnapshot: () => withSearchAdminDatabase(database,
      db => readSearchAdminRegistrySnapshot(db, role)),
  });
  process.stdout.write('Private search attestor preparation completed.\n');
} catch {
  process.stderr.write('Private search attestor preparation failed.\n');
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
