import { join, resolve } from 'node:path';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const fail = () => { throw new Error('Search attestor service configuration is invalid.'); };
const sorted = value => Object.keys(value ?? {}).sort().join('|');
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  sorted(value) === [...names].sort().join('|');
const list = (value, values) => Array.isArray(value) &&
  JSON.stringify(value) === JSON.stringify(values);
const mountsByTarget = (mounts, targets) => {
  if (!Array.isArray(mounts) || mounts.length !== targets.length) fail();
  const found = new Map();
  for (const mount of mounts) {
    if (!mount || typeof mount.target !== 'string' || found.has(mount.target) ||
        !targets.includes(mount.target)) fail();
    found.set(mount.target, mount);
  }
  return found;
};

function bind(mount, source, target, readOnly) {
  const names = ['type', 'source', 'target', 'bind', ...(readOnly ? ['read_only'] : [])];
  if (!keys(mount, names) && !(!readOnly && keys(mount, [...names, 'read_only']))) fail();
  if (mount.type !== 'bind' || mount.source !== source || mount.target !== target ||
      (readOnly ? mount.read_only !== true :
        mount.read_only !== undefined && mount.read_only !== false) ||
      (!keys(mount.bind, []) && !keys(mount.bind, ['create_host_path'])) ||
      mount.bind.create_host_path !== undefined && mount.bind.create_host_path !== false) fail();
}

function volume(mount, source, target, readOnly, nocopy) {
  const names = ['type', 'source', 'target', ...(readOnly ? ['read_only'] : []),
    ...(nocopy ? ['volume'] : [])];
  if (!keys(mount, names) && !(!readOnly && keys(mount, [...names, 'read_only'])) &&
      !( !nocopy && keys(mount, [...names, 'volume'])) &&
      !(!readOnly && !nocopy && keys(mount, [...names, 'read_only', 'volume']))) fail();
  if (mount.type !== 'volume' || mount.source !== source || mount.target !== target ||
      (readOnly ? mount.read_only !== true :
        mount.read_only !== undefined && mount.read_only !== false) ||
      (nocopy ? !keys(mount.volume, ['nocopy']) || mount.volume.nocopy !== true :
        mount.volume !== undefined && !keys(mount.volume, []))) fail();
}

// Fixed create-boundary configuration reuses these exact mount primitives.
export { keys, list, mountsByTarget, bind, volume };

function common(service, name, user, command, memory, pids, cpus, tmpfs, repository,
  transfer = false) {
  const expected = ['build', 'command', 'user', 'volumes', 'read_only', 'tmpfs', 'cap_drop',
    'security_opt', 'pids_limit', 'mem_limit', 'cpus', 'restart', 'profiles',
    transfer ? 'network_mode' : 'networks', ...(transfer ? ['cap_add'] : [])];
  if ((!keys(service, expected) && !keys(service, [...expected, 'entrypoint'])) ||
      (service.entrypoint !== undefined && service.entrypoint !== null) ||
      (!keys(service.build, ['context', 'target']) &&
        !keys(service.build, ['context', 'target', 'dockerfile'])) ||
      service.build.context !== repository || service.build.target !== 'search-attestor' ||
      (service.build.dockerfile !== undefined && service.build.dockerfile !== 'Dockerfile') ||
      !list(service.command, ['node', `scripts/${command}.mjs`]) ||
      service.user !== user || service.read_only !== true ||
      !list(service.profiles, ['search-attestor']) || !list(service.cap_drop, ['ALL']) ||
      !list(service.security_opt, ['no-new-privileges:true']) ||
      service.pids_limit !== pids || service.mem_limit !== String(memory) ||
      service.cpus !== cpus || service.restart !== 'no' ||
      !list(service.tmpfs, [tmpfs]) || !Array.isArray(service.volumes)) fail();
  if (transfer) {
    if (service.network_mode !== 'none' || !list(service.cap_add, ['CHOWN', 'DAC_OVERRIDE'])) fail();
  } else {
    const names = name === 'search-attestor-prepare' ? ['search_admin_db'] :
      ['search_admin_db', 'search_internal'];
    if (!keys(service.networks, names) ||
        names.some(network => service.networks[network] !== null &&
          !keys(service.networks[network], []))) fail();
  }
}

/** Strict check of three service-scoped `docker compose config --format json` results. */
export function verifyAttestorServiceConfig(config, expected) {
  try {
    const { project, uid, gid, repository, invocationId, invocationRoot, publicRoot,
      volumeName } = expected;
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project) ||
        !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1 ||
        !UUID.test(invocationId) || resolve(repository) !== repository ||
        invocationRoot !== join(repository, '.cache/search-attestor-invocations', invocationId) ||
        publicRoot !== join(repository, '.cache/search-attestor-public', invocationId) ||
        volumeName !== `${project}_search_attestor_${invocationId.replaceAll('-', '').toLowerCase()}`) fail();
    if (!keys(config, ['name', 'services', 'networks', 'volumes']) ||
        config.name !== project ||
        !keys(config.services, ['search-attestor-prepare', 'search-attestor-transfer',
          'search-engine-attestor']) ||
        !keys(config.networks, ['search_admin_db', 'search_internal']) ||
        !keys(config.volumes, ['search_attestor_input', 'search_admin_certs',
          'search_security_state'])) fail();
    for (const network of ['search_admin_db', 'search_internal']) {
      const item = config.networks[network];
      if (!keys(item, ['name', 'internal']) &&
          !keys(item, ['name', 'internal', 'external']) &&
          !keys(item, ['name', 'internal', 'ipam']) &&
          !keys(item, ['name', 'internal', 'external', 'ipam'])) fail();
      if (item.name !== `${project}_${network}` || item.internal !== true ||
          item.external !== undefined && item.external !== false ||
          item.ipam !== undefined && !keys(item.ipam, [])) fail();
    }
    for (const name of ['search_admin_certs', 'search_security_state']) {
      const item = config.volumes[name];
      if ((!keys(item, ['name']) && !keys(item, ['name', 'external'])) ||
          item.name !== `${project}_${name}` ||
          item.external !== undefined && item.external !== false) fail();
    }
    const inputVolume = config.volumes.search_attestor_input;
    if (!keys(inputVolume, ['name', 'external']) || inputVolume.name !== volumeName ||
        inputVolume.external !== true) fail();

    const password = join(repository, '.cache/search-db/initial-v1/verifier.password');
    const prepare = config.services['search-attestor-prepare'];
    common(prepare, 'search-attestor-prepare', `${uid}:${gid}`, 'search-attestor-prepare',
      268435456, 64, 0.5,
      `/tmp:rw,noexec,nosuid,size=8m,uid=${uid},gid=${gid},mode=0700`, repository);
    const prepareMounts = mountsByTarget(prepare.volumes, ['/run/search-db/password',
      '/run/search-attestor', '/run/search-attestor/manifest']);
    bind(prepareMounts.get('/run/search-db/password'), password, '/run/search-db/password', true);
    bind(prepareMounts.get('/run/search-attestor'), invocationRoot, '/run/search-attestor', true);
    bind(prepareMounts.get('/run/search-attestor/manifest'), join(invocationRoot, 'manifest'),
      '/run/search-attestor/manifest', false);

    const transfer = config.services['search-attestor-transfer'];
    common(transfer, 'search-attestor-transfer', '0:0', 'search-attestor-transfer',
      268435456, 64, 0.5, '/tmp:rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0700',
      repository, true);
    const transferMounts = mountsByTarget(transfer.volumes, ['/run/search-transfer-password/password',
      '/run/search-transfer-invocation/invocation', '/run/search-transfer-manifest/manifest.json',
      '/run/search-transfer-public', '/run/search-attestor']);
    bind(transferMounts.get('/run/search-transfer-password/password'), password,
      '/run/search-transfer-password/password', true);
    bind(transferMounts.get('/run/search-transfer-invocation/invocation'), join(invocationRoot, 'invocation'),
      '/run/search-transfer-invocation/invocation', true);
    bind(transferMounts.get('/run/search-transfer-manifest/manifest.json'),
      join(invocationRoot, 'manifest/manifest.json'),
      '/run/search-transfer-manifest/manifest.json', true);
    bind(transferMounts.get('/run/search-transfer-public'), publicRoot, '/run/search-transfer-public', true);
    volume(transferMounts.get('/run/search-attestor'), 'search_attestor_input',
      '/run/search-attestor', false, true);

    const combined = config.services['search-engine-attestor'];
    common(combined, 'search-engine-attestor', '1000:1000', 'search-attestor-combined',
      536870912, 128, 1, '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700',
      repository);
    const combinedMounts = mountsByTarget(combined.volumes,
      ['/run/search-attestor', '/run/station-admin', '/run/station-state']);
    volume(combinedMounts.get('/run/search-attestor'), 'search_attestor_input',
      '/run/search-attestor', true, true);
    volume(combinedMounts.get('/run/station-admin'), 'search_admin_certs',
      '/run/station-admin', true, true);
    volume(combinedMounts.get('/run/station-state'), 'search_security_state',
      '/run/station-state', true, true);
    return true;
  } catch { fail(); }
}
