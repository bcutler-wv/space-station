import path from 'node:path';
import { keys, list, mountsByTarget, bind, volume } from
  './search-attestor-service-config.mjs';

const fail = () => { throw Error('Fixed create apply Compose render failed.'); };
function service(value, repository, command, user, transfer) {
  const fields = ['build', 'command', 'user', 'volumes', 'read_only', 'tmpfs',
    'cap_drop', 'security_opt', 'pids_limit', 'mem_limit', 'cpus', 'restart',
    'profiles', transfer ? 'network_mode' : 'networks', ...(transfer ? ['cap_add'] : [])];
  if (!keys(value, fields) && !keys(value, [...fields, 'entrypoint']) ||
      value.entrypoint !== undefined && value.entrypoint !== null ||
      !keys(value.build, ['context', 'target']) &&
        !keys(value.build, ['context', 'target', 'dockerfile']) ||
      value.build.context !== repository || value.build.target !== 'search-attestor' ||
      value.build.dockerfile !== undefined && value.build.dockerfile !== 'Dockerfile' ||
      !list(value.command, ['node', `scripts/${command}.mjs`]) ||
      value.user !== user || value.read_only !== true ||
      !list(value.profiles, ['search-create-apply']) ||
      !list(value.cap_drop, ['ALL']) ||
      !list(value.security_opt, ['no-new-privileges:true']) ||
      value.pids_limit !== (transfer ? 64 : 128) ||
      value.mem_limit !== String(transfer ? 268435456 : 536870912) ||
      value.cpus !== (transfer ? 0.5 : 1) || value.restart !== 'no' ||
      !list(value.tmpfs, [transfer ? '/tmp:rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0700' :
        '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700'])) fail();
  if (transfer ? value.network_mode !== 'none' ||
      !list(value.cap_add, ['CHOWN', 'DAC_OVERRIDE']) :
    !keys(value.networks, ['search_admin_db', 'search_internal']) ||
      Object.values(value.networks).some(network => network !== null && !keys(network, []))) fail();
}

export function verifyCreateApplyServiceConfig(config, expected) {
  try {
    const { repository, project, invocationId, publicRoot, volumeName } = expected;
    if (!keys(expected, ['repository', 'project', 'invocationId', 'publicRoot', 'volumeName']) ||
        path.resolve(repository) !== repository ||
        !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project) ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(invocationId) ||
        publicRoot !== path.join(repository, '.cache/search-create-apply-public', invocationId) ||
        volumeName !== `${project}_search_create_apply_${invocationId.replaceAll('-', '')}` ||
        !keys(config, ['name', 'services', 'networks', 'volumes']) || config.name !== project ||
        !keys(config.services, ['search-create-apply-transfer', 'search-create-index']) ||
        !keys(config.networks, ['search_admin_db', 'search_internal']) ||
        !keys(config.volumes, ['search_create_apply_input', 'search_admin_certs',
          'search_security_state'])) fail();
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
    if (!keys(config.volumes.search_create_apply_input, ['name', 'external']) ||
        config.volumes.search_create_apply_input.name !== volumeName ||
        config.volumes.search_create_apply_input.external !== true) fail();
    for (const name of ['search_admin_certs', 'search_security_state']) {
      const item = config.volumes[name];
      if (!keys(item, ['name']) && !keys(item, ['name', 'external']) ||
          item.name !== `${project}_${name}` ||
          item.external !== undefined && item.external !== false) fail();
    }
    const transfer = config.services['search-create-apply-transfer'];
    service(transfer, repository, 'search-create-apply-transfer', '0:0', true);
    const mounts = mountsByTarget(transfer.volumes, ['/run/create-apply-password/password',
      '/run/create-apply-intent/intent.json', '/run/create-apply-binding/binding.json',
      '/run/create-apply-public', '/run/search-create-apply']);
    bind(mounts.get('/run/create-apply-password/password'),
      path.join(repository, '.cache/search-db/initial-v1/transition.password'),
      '/run/create-apply-password/password', true);
    bind(mounts.get('/run/create-apply-intent/intent.json'),
      path.join(repository, '.cache/search-create-intent/pending.json'),
      '/run/create-apply-intent/intent.json', true);
    bind(mounts.get('/run/create-apply-binding/binding.json'),
      path.join(repository, '.cache/search-create-apply/binding.json'),
      '/run/create-apply-binding/binding.json', true);
    bind(mounts.get('/run/create-apply-public'), publicRoot, '/run/create-apply-public', true);
    volume(mounts.get('/run/search-create-apply'), 'search_create_apply_input',
      '/run/search-create-apply', false, true);
    const consumer = config.services['search-create-index'];
    service(consumer, repository, 'search-create-apply-consumer', '1000:1000', false);
    const inputs = mountsByTarget(consumer.volumes,
      ['/run/search-create-apply', '/run/station-admin', '/run/station-state']);
    volume(inputs.get('/run/search-create-apply'), 'search_create_apply_input',
      '/run/search-create-apply', true, true);
    volume(inputs.get('/run/station-admin'), 'search_admin_certs', '/run/station-admin', true, true);
    volume(inputs.get('/run/station-state'), 'search_security_state',
      '/run/station-state', true, true);
    return true;
  } catch { fail(); }
}
