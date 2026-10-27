import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { verifyCreateBoundaryServiceConfig } from '../../scripts/search-create-boundary-service-config.mjs';

const repository = resolve('.');
const project = 'create_fixture';
const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const invocationRoot = join(repository, '.cache/search-create-invocations', invocationId);
const volumeName = `${project}_search_create_${invocationId.replaceAll('-', '')}`;
const expected = { repository, project, invocationId, invocationRoot, volumeName };
const bind = (source, target) => ({ type: 'bind', source, target, read_only: true,
  bind: { create_host_path: false } });
const volume = (source, target, readOnly = true) => ({ type: 'volume', source, target,
  ...(readOnly ? { read_only: true } : {}), volume: { nocopy: true } });
function common(command, user, transfer) {
  return { profiles: ['search-create-boundary'],
    build: { context: repository, target: 'search-attestor' },
    command: ['node', `scripts/${command}.mjs`], user, read_only: true,
    tmpfs: [transfer ? '/tmp:rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0700' :
      '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700'],
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    pids_limit: transfer ? 64 : 128, mem_limit: String(transfer ? 268435456 : 536870912),
    cpus: transfer ? 0.5 : 1, restart: 'no',
    ...(transfer ? { network_mode: 'none', cap_add: ['CHOWN', 'DAC_OVERRIDE'] } :
      { networks: { search_admin_db: null, search_internal: null } }) };
}
function config() {
  return { name: project, services: {
    'search-create-transfer': { ...common('search-create-boundary-transfer', '0:0', true),
      volumes: [bind(join(repository, '.cache/search-db/initial-v1/transition.password'),
        '/run/create-transfer-password/password'),
      bind(join(invocationRoot, 'invocation'), '/run/create-transfer-invocation/invocation'),
      volume('search_create_input', '/run/create-boundary', false)] },
    'search-create-boundary': { ...common('search-create-boundary', '1000:1000', false),
      volumes: [volume('search_create_input', '/run/create-boundary'),
        volume('search_admin_certs', '/run/station-admin'),
        volume('search_security_state', '/run/station-state')] },
  }, networks: { search_admin_db: { name: `${project}_search_admin_db`, internal: true },
    search_internal: { name: `${project}_search_internal`, internal: true } },
  volumes: { search_create_input: { name: volumeName, external: true },
    search_admin_certs: { name: `${project}_search_admin_certs` },
    search_security_state: { name: `${project}_search_security_state` } } };
}

test('exact two-service read-only boundary accepts only fixed authority', () => {
  assert.equal(verifyCreateBoundaryServiceConfig(config(), expected), true);
  const normalized = config();
  for (const service of Object.values(normalized.services)) {
    service.build.dockerfile = 'Dockerfile'; service.entrypoint = null;
    service.volumes.reverse();
    for (const mount of service.volumes) if (mount.type === 'bind') mount.bind = {};
  }
  normalized.networks.search_admin_db.ipam = {};
  assert.equal(verifyCreateBoundaryServiceConfig(normalized, expected), true);
});

test('extra network, mount, cap, changed password and missing state fail', () => {
  for (const mutate of [
    value => { value.services.extra = {}; },
    value => { value.services['search-create-boundary'].networks.default = null; },
    value => { value.services['search-create-boundary'].volumes.pop(); },
    value => { value.services['search-create-boundary'].volumes[2].volume.nocopy = false; },
    value => { value.services['search-create-boundary'].volumes[0].read_only = false; },
    value => { value.services['search-create-transfer'].volumes[0].source = '/tmp/wrong'; },
    value => { value.services['search-create-transfer'].cap_add.push('SYS_ADMIN'); },
    value => { value.services['search-create-transfer'].network_mode = 'host'; },
    value => { value.services['search-create-boundary'].ports = ['9200:9200']; },
    value => { value.services['search-create-boundary'].command.push('--create'); },
    value => { value.volumes.search_create_input.external = false; },
  ]) {
    const value = config(); mutate(value);
    assert.throws(() => verifyCreateBoundaryServiceConfig(value, expected));
  }
});
