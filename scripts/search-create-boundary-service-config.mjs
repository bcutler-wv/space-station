import { join, resolve } from 'node:path';
import { keys, list, mountsByTarget, bind, volume } from './search-attestor-service-config.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = () => { throw new Error('Search create boundary service configuration is invalid.'); };

function service(value, repository, command, user, transfer) {
  const expected = ['build', 'command', 'user', 'volumes', 'read_only', 'tmpfs', 'cap_drop',
    'security_opt', 'pids_limit', 'mem_limit', 'cpus', 'restart', 'profiles',
    transfer ? 'network_mode' : 'networks', ...(transfer ? ['cap_add'] : [])];
  if (!keys(value, expected) && !keys(value, [...expected, 'entrypoint']) ||
      value.entrypoint !== undefined && value.entrypoint !== null ||
      !keys(value.build, ['context', 'target']) &&
        !keys(value.build, ['context', 'target', 'dockerfile']) ||
      value.build.context !== repository || value.build.target !== 'search-attestor' ||
      value.build.dockerfile !== undefined && value.build.dockerfile !== 'Dockerfile' ||
      !list(value.command, ['node', `scripts/${command}.mjs`]) ||
      value.user !== user || value.read_only !== true ||
      !list(value.profiles, ['search-create-boundary']) ||
      !list(value.cap_drop, ['ALL']) ||
      !list(value.security_opt, ['no-new-privileges:true']) ||
      value.pids_limit !== (transfer ? 64 : 128) ||
      value.mem_limit !== String(transfer ? 268435456 : 536870912) ||
      value.cpus !== (transfer ? 0.5 : 1) || value.restart !== 'no' ||
      !list(value.tmpfs, [transfer ? '/tmp:rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0700' :
        '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700'])) fail();
  if (transfer) {
    if (value.network_mode !== 'none' || !list(value.cap_add, ['CHOWN', 'DAC_OVERRIDE'])) fail();
  } else if (!keys(value.networks, ['search_admin_db', 'search_internal']) ||
      Object.values(value.networks).some(network => network !== null && !keys(network, []))) fail();
  if (!Array.isArray(value.volumes)) fail();
}

/** Exact normalized, two-service Compose configuration; no owner dispatch here. */
export function verifyCreateBoundaryServiceConfig(config, expected) {
  try {
    const { project, repository, invocationId, invocationRoot, volumeName } = expected;
    if (!keys(expected, ['project', 'repository', 'invocationId', 'invocationRoot', 'volumeName']) ||
        !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project) || resolve(repository) !== repository ||
        !uuid.test(invocationId) ||
        invocationRoot !== join(repository, '.cache/search-create-invocations', invocationId) ||
        volumeName !== `${project}_search_create_${invocationId.replaceAll('-', '')}` ||
        !keys(config, ['name', 'services', 'networks', 'volumes']) || config.name !== project ||
        !keys(config.services, ['search-create-transfer', 'search-create-boundary']) ||
        !keys(config.networks, ['search_admin_db', 'search_internal']) ||
        !keys(config.volumes, ['search_create_input', 'search_admin_certs', 'search_security_state'])) fail();
    for (const name of ['search_admin_db', 'search_internal']) {
      const network = config.networks[name];
      if (!keys(network, ['name', 'internal']) &&
          !keys(network, ['name', 'internal', 'external']) &&
          !keys(network, ['name', 'internal', 'ipam']) &&
          !keys(network, ['name', 'internal', 'external', 'ipam']) ||
          network.name !== `${project}_${name}` || network.internal !== true ||
          network.external !== undefined && network.external !== false ||
          network.ipam !== undefined && !keys(network.ipam, [])) fail();
    }
    for (const name of ['search_admin_certs', 'search_security_state']) {
      const item = config.volumes[name];
      if (!keys(item, ['name']) && !keys(item, ['name', 'external']) ||
          item.name !== `${project}_${name}` ||
          item.external !== undefined && item.external !== false) fail();
    }
    if (!keys(config.volumes.search_create_input, ['name', 'external']) ||
        config.volumes.search_create_input.name !== volumeName ||
        config.volumes.search_create_input.external !== true) fail();

    const transfer = config.services['search-create-transfer'];
    service(transfer, repository, 'search-create-boundary-transfer', '0:0', true);
    const password = join(repository, '.cache/search-db/initial-v1/transition.password');
    const mounts = mountsByTarget(transfer.volumes, ['/run/create-transfer-password/password',
      '/run/create-transfer-invocation/invocation', '/run/create-boundary']);
    bind(mounts.get('/run/create-transfer-password/password'), password,
      '/run/create-transfer-password/password', true);
    bind(mounts.get('/run/create-transfer-invocation/invocation'),
      join(invocationRoot, 'invocation'), '/run/create-transfer-invocation/invocation', true);
    volume(mounts.get('/run/create-boundary'), 'search_create_input', '/run/create-boundary', false, true);

    const combined = config.services['search-create-boundary'];
    service(combined, repository, 'search-create-boundary', '1000:1000', false);
    const combinedMounts = mountsByTarget(combined.volumes,
      ['/run/create-boundary', '/run/station-admin', '/run/station-state']);
    volume(combinedMounts.get('/run/create-boundary'), 'search_create_input',
      '/run/create-boundary', true, true);
    volume(combinedMounts.get('/run/station-admin'), 'search_admin_certs',
      '/run/station-admin', true, true);
    volume(combinedMounts.get('/run/station-state'), 'search_security_state',
      '/run/station-state', true, true);
    return true;
  } catch { fail(); }
}
