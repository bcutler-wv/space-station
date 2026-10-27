import { join } from 'node:path';

const bind = (source, target, readOnly = true) => ({ type: 'bind', source, target,
  ...(readOnly ? { read_only: true } : {}), bind: { create_host_path: false } });
const volume = (source, target, readOnly = true, nocopy = false) => ({ type: 'volume',
  source, target, ...(readOnly ? { read_only: true } : {}),
  ...(nocopy ? { volume: { nocopy: true } } : {}) });
const common = (repository, name, user, command, memory, pids, cpus, tmpfs) => ({
  profiles: ['search-attestor'], build: { context: repository, target: 'search-attestor' },
  command: ['node', `scripts/${command}.mjs`], user, read_only: true,
  tmpfs: [tmpfs], cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
  pids_limit: pids, mem_limit: String(memory), cpus, restart: 'no',
  ...name === 'search-attestor-transfer' ? { network_mode: 'none',
    cap_add: ['CHOWN', 'DAC_OVERRIDE'] } : { networks: name === 'search-attestor-prepare'
      ? { search_admin_db: null } : { search_admin_db: null, search_internal: null } },
});

/** Fake normalized output for no-daemon adapter fixtures. */
export function attestorConfig({ repository, project, invocationId, uid, gid }) {
  const invocationRoot = join(repository, '.cache/search-attestor-invocations', invocationId);
  const publicRoot = join(repository, '.cache/search-attestor-public', invocationId);
  const volumeName = `${project}_search_attestor_${invocationId.replaceAll('-', '')}`;
  const password = join(repository, '.cache/search-db/initial-v1/verifier.password');
  const prepare = { ...common(repository, 'search-attestor-prepare', `${uid}:${gid}`,
    'search-attestor-prepare', 268435456, 64, 0.5,
    `/tmp:rw,noexec,nosuid,size=8m,uid=${uid},gid=${gid},mode=0700`),
  volumes: [bind(password, '/run/search-db/password'),
    bind(invocationRoot, '/run/search-attestor'),
    bind(join(invocationRoot, 'manifest'), '/run/search-attestor/manifest', false)] };
  const transfer = { ...common(repository, 'search-attestor-transfer', '0:0',
    'search-attestor-transfer', 268435456, 64, 0.5,
    '/tmp:rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0700'),
  volumes: [bind(password, '/run/search-transfer-password/password'),
    bind(join(invocationRoot, 'invocation'), '/run/search-transfer-invocation/invocation'),
    bind(join(invocationRoot, 'manifest/manifest.json'),
      '/run/search-transfer-manifest/manifest.json'),
    bind(publicRoot, '/run/search-transfer-public'),
    volume('search_attestor_input', '/run/search-attestor', false, true)] };
  const combined = { ...common(repository, 'search-engine-attestor', '1000:1000',
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
