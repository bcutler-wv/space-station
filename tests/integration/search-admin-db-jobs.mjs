import assert from 'node:assert/strict';
import console from 'node:console';
import { verifyJobConfig } from '../../scripts/search-admin-db-run.mjs';

const sources = { verifier: '/fixture/verifier.password', transition: '/fixture/transition.password' };
const service = role => ({
  user: '1001:1001', profiles: ['search-admin-db'],
  command: ['node', 'scripts/search-admin-db-inspector.mjs', role],
  read_only: true, networks: { search_admin_db: null },
  volumes: [{ type: 'bind', source: sources[role], target: '/run/search-db/password',
    read_only: true, bind: { create_host_path: false } }],
  cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], restart: 'no',
  pids_limit: 64, mem_limit: '268435456', cpus: 0.5,
});
const valid = () => ({ name: 'fixture', services: {
  'search-db-verifier': service('verifier'), 'search-db-transition': service('transition'),
}, networks: { search_admin_db: { name: 'fixture_search_admin_db', internal: true } } });
assert.doesNotThrow(() => verifyJobConfig(valid(), 1001, 1001, sources));
const normalized = valid();
normalized.services['search-db-verifier'].volumes[0].bind = {};
assert.doesNotThrow(() => verifyJobConfig(normalized, 1001, 1001, sources));
for (const mutation of [
  c => { c.services.app = {}; },
  c => { c.services['search-db-verifier'].user = '1000:1000'; },
  c => { c.services['search-db-transition'].volumes[0].source = sources.verifier; },
  c => { c.services['search-db-verifier'].volumes[0].bind.create_host_path = true; },
  c => { c.services['search-db-verifier'].environment = { POSTGRES_PASSWORD: 'fake' }; },
  c => { c.services['search-db-verifier'].networks.default = null; },
  c => { c.services['search-db-verifier'].depends_on = ['postgres']; },
  c => { c.services['search-db-verifier'].command.push('extra'); },
  c => { c.services['search-db-verifier'].read_only = false; },
]) {
  const candidate = valid(); mutation(candidate);
  assert.throws(() => verifyJobConfig(candidate, 1001, 1001, sources), /preflight/);
}
console.log('PASS: fixed DB inspector Compose config boundary and denial variants.');
