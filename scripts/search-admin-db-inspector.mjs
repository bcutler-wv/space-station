#!/usr/bin/env node
import { withSearchAdminDatabase, readSearchAdminSnapshot } from '../packages/db/dist/search-admin-connection.js';

const roles = Object.freeze({ verifier: 'station_search_verifier', transition: 'station_search_transition' });
async function main() {
  const [name] = process.argv.slice(2);
  if (process.argv.length !== 3 || !Object.hasOwn(roles, name)) throw new Error('usage');
  const snapshot = await withSearchAdminDatabase({
    role: roles[name], host: 'postgres', port: 5432, database: 'station',
    passwordFile: '/run/search-db/password',
  }, readSearchAdminSnapshot);
  if (snapshot.control.publicationEnabled !== false || snapshot.control.servingReady !== false)
    throw new Error('gate state');
  process.stdout.write(`Search DB ${name} snapshot verified.\n`);
}

main().catch(() => {
  process.stderr.write('Search DB inspector failed; inspect private installation state.\n');
  process.exitCode = 1;
});
