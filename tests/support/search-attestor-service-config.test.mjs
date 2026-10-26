import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { verifyAttestorServiceConfig } from '../../scripts/search-attestor-service-config.mjs';

const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const project = 'attestor_fixture';
const repository = resolve('.');
const invocationRoot = join(repository, '.cache/search-attestor-invocations', invocationId);
const publicRoot = join(repository, '.cache/search-attestor-public', invocationId);
const volumeName = `${project}_search_attestor_${invocationId.replaceAll('-', '')}`;
const expected = (uid = 1000, gid = 1000) => ({ project, uid, gid, repository, invocationId,
  invocationRoot, publicRoot, volumeName });
const bind = (source, target, readOnly = true) => ({ type: 'bind', source, target,
  ...(readOnly ? { read_only: true } : {}), bind: { create_host_path: false } });
const volume = (source, target, readOnly = true, nocopy = false) => ({ type: 'volume',
  source, target, ...(readOnly ? { read_only: true } : {}),
  ...(nocopy ? { volume: { nocopy: true } } : {}) });
const common = (name, user, command, memory, pids, cpus, tmpfs) => ({
  profiles: ['search-attestor'], build: { context: repository, target: 'search-attestor' },
  command: ['node', `scripts/${command}.mjs`], user, read_only: true,
  tmpfs: [tmpfs], cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
  pids_limit: pids, mem_limit: String(memory), cpus, restart: 'no',
  ...name === 'search-attestor-transfer' ? { network_mode: 'none',
    cap_add: ['CHOWN', 'DAC_OVERRIDE'] } : { networks: name === 'search-attestor-prepare'
      ? { search_admin_db: null } : { search_admin_db: null, search_internal: null } },
});

function config(uid = 1000, gid = 1000) {
  const password = join(repository, '.cache/search-db/initial-v1/verifier.password');
  const prepare = { ...common('search-attestor-prepare', `${uid}:${gid}`,
    'search-attestor-prepare', 268435456, 64, 0.5,
    `/tmp:rw,noexec,nosuid,size=8m,uid=${uid},gid=${gid},mode=0700`),
  volumes: [bind(password, '/run/search-db/password'),
    bind(invocationRoot, '/run/search-attestor'),
    bind(join(invocationRoot, 'manifest'), '/run/search-attestor/manifest', false)] };
  const transfer = { ...common('search-attestor-transfer', '0:0',
    'search-attestor-transfer', 268435456, 64, 0.5,
    '/tmp:rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0700'),
  volumes: [bind(password, '/run/search-transfer-password/password'),
    bind(join(invocationRoot, 'invocation'), '/run/search-transfer-invocation/invocation'),
    bind(join(invocationRoot, 'manifest/manifest.json'),
      '/run/search-transfer-manifest/manifest.json'),
    bind(publicRoot, '/run/search-transfer-public'),
    volume('search_attestor_input', '/run/search-attestor', false, true)] };
  const combined = { ...common('search-engine-attestor', '1000:1000',
    'search-attestor-combined', 536870912, 128, 1,
    '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700'),
  volumes: [volume('search_attestor_input', '/run/search-attestor', true, true),
    volume('search_admin_certs', '/run/station-admin'),
    volume('search_security_state', '/run/station-state')] };
  return { name: project, services: { 'search-attestor-prepare': prepare,
    'search-attestor-transfer': transfer, 'search-engine-attestor': combined },
  networks: { search_admin_db: { name: `${project}_search_admin_db`, internal: true },
    search_internal: { name: `${project}_search_internal`, internal: true } },
  volumes: { search_attestor_input: { name: volumeName, external: true },
    search_admin_certs: { name: `${project}_search_admin_certs` },
    search_security_state: { name: `${project}_search_security_state` } } };
}

const denied = (value, want = expected()) => assert.throws(() => verifyAttestorServiceConfig(value, want),
  { message: 'Search attestor service configuration is invalid.' });

test('fixed normalized services accept both owner pairs with a fixed consumer', () => {
  assert.equal(verifyAttestorServiceConfig(config(), expected()), true);
  assert.equal(verifyAttestorServiceConfig(config(1001, 1001), expected(1001, 1001)), true);
  const normalized = config();
  for (const service of Object.values(normalized.services)) {
    service.build.dockerfile = 'Dockerfile';
    service.entrypoint = null;
    service.volumes.reverse();
    for (const mount of service.volumes) if (mount.type === 'bind') mount.bind = {};
  }
  normalized.services['search-attestor-prepare'].volumes.find(
    mount => mount.target === '/run/search-attestor/manifest').read_only = false;
  normalized.networks.search_internal.external = false;
  normalized.networks.search_admin_db.ipam = {};
  normalized.volumes.search_admin_certs.external = false;
  assert.equal(verifyAttestorServiceConfig(normalized, expected()), true);
});

test('service additions and override surfaces fail closed', () => {
  for (const mutate of [
    value => { value.secrets = { alternate: {} }; },
    value => { value.services.extra = {}; },
    value => { value.services['search-engine-attestor'].environment = { SECRET: 'x' }; },
    value => { value.services['search-engine-attestor'].entrypoint = ['/bin/sh']; },
    value => { value.services['search-engine-attestor'].ports = ['9200:9200']; },
    value => { value.services['search-engine-attestor'].devices = ['/dev/null']; },
    value => { value.services['search-engine-attestor'].privileged = true; },
    value => { value.services['search-engine-attestor'].depends_on = { postgres: {} }; },
    value => { value.services['search-engine-attestor'].networks.default = null; },
    value => { value.services['search-attestor-transfer'].cap_add.push('SYS_ADMIN'); },
    value => { value.services['search-attestor-transfer'].network_mode = 'host'; },
    value => { value.services['search-attestor-prepare'].command.push('--extra'); },
    value => { value.services['search-attestor-prepare'].user = '0:0'; },
    value => { value.services['search-engine-attestor'].mem_limit = '0'; },
    value => { value.services['search-attestor-transfer'].restart = 'always'; },
    value => { value.services['search-engine-attestor'].tmpfs = ['/tmp:rw,exec,size=64m']; },
  ]) { const value = config(); mutate(value); denied(value); }
});

test('bind, volume and external identity mutations fail closed', () => {
  for (const mutate of [
    value => { value.services['search-attestor-prepare'].volumes[0].source = '/tmp/other'; },
    value => { value.services['search-attestor-prepare'].volumes[2].read_only = true; },
    value => { value.services['search-attestor-transfer'].volumes[1].bind.create_host_path = true; },
    value => { value.services['search-attestor-transfer'].volumes[1].bind.create_host_path = null; },
    value => { value.services['search-attestor-prepare'].volumes[2].read_only = null; },
    value => { value.services['search-attestor-transfer'].volumes[4].read_only = 'false'; },
    value => { value.services['search-attestor-transfer'].volumes[3].source = '/tmp/private'; },
    value => { value.services['search-attestor-transfer'].volumes[4].volume.nocopy = false; },
    value => { value.services['search-engine-attestor'].volumes[0].read_only = false; },
    value => { value.services['search-engine-attestor'].volumes[0].volume.driver_opts = {}; },
    value => { value.services['search-engine-attestor'].volumes.push(volume('other', '/run/extra')); },
    value => { value.services['search-engine-attestor'].volumes[1].target = '/run/search-attestor'; },
    value => { value.volumes.search_attestor_input.external = false; },
    value => { value.volumes.search_attestor_input.name = 'other'; },
    value => { value.volumes.search_attestor_input.driver_opts = {}; },
    value => { value.networks.search_admin_db.internal = false; },
    value => { value.networks.search_admin_db.external = null; },
    value => { value.networks.search_admin_db.ipam = { driver: 'other' }; },
    value => { value.networks.search_internal.name = 'other'; },
  ]) { const value = config(); mutate(value); denied(value); }
  denied(config(), { ...expected(), volumeName: 'other' });
  denied(config(), { ...expected(), publicRoot: '/tmp/other' });
});
