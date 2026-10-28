import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertAppWorkerWithoutCreateAuthority } from './search-create-boundary-app-worker-config.mjs';

const repository = '/fixture';
const service = (networks, volumes) => ({ networks: Object.fromEntries(networks.map(name => [name, null])),
  volumes, environment: { DB_HOST: 'postgres' } });
const blob = { type: 'volume', source: 'private_blobs', target: '/var/lib/station/blobs' };
const tls = { type: 'bind', source: path.join(repository, '.cache/tls'), target: '/run/tls',
  read_only: true };
const base = () => ({ services: {
  app: service(['default', 'camo_egress'], [tls, blob]),
  worker: service(['default', 'mail_parser'], [blob]),
} });

test('normalized app and worker authority is exact', () => {
  assert.doesNotThrow(() => assertAppWorkerWithoutCreateAuthority(base(), repository));
  for (const mutate of [
    config => { config.services.app.networks.search_internal = null; },
    config => { config.services.worker.networks.search_admin_db = null; },
    config => { config.services.app.volumes.push({ type: 'volume', source: 'search_admin_certs', target: '/run/station-admin' }); },
    config => { config.services.worker.volumes.push({ type: 'volume', source: 'search_security_state', target: '/run/station-state' }); },
    config => { config.services.app.volumes[0].source = '/fixture/.cache/search-db/initial-v1/transition.password'; },
    config => { config.services.worker.environment.STATION_CREATE_INVOCATION_ROOT = '/private'; },
    config => { config.services.app.environment.PGPASSWORD = 'private'; },
  ]) {
    const config = JSON.parse(JSON.stringify(base()));
    mutate(config);
    assert.throws(() => assertAppWorkerWithoutCreateAuthority(config, repository));
  }
});
