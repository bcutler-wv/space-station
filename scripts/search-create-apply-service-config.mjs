import path from 'node:path';
import { keys, list, mountsByTarget, bind, volume } from
  './search-attestor-service-config.mjs';

const fail = () => { throw Error('Fixed create apply Compose render failed.'); };
function service(value, repository, command, user, transfer, profile) {
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
      !list(value.profiles, [profile]) ||
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

// Shared fixed shape, without granting the existing create/prepare validators a new mode.
export { service as verifyFixedApplyServiceShape };

function verifyFixedServiceConfig(config, expected, rolePrepare) {
  try {
    const { repository, project, invocationId, publicRoot, volumeName, invocationRoot } = expected;
    const profile = rolePrepare ? 'search-writer-role-prepare' : 'search-create-apply';
    const inputVolume = rolePrepare ? 'search_writer_role_prepare_input' : 'search_create_apply_input';
    const transferName = rolePrepare ? 'search-writer-role-prepare-transfer' : 'search-create-apply-transfer';
    const readName = rolePrepare ? 'search-writer-role-prepare' : 'search-create-index';
    if (!keys(expected, rolePrepare ? ['repository', 'project', 'invocationId',
      'publicRoot', 'volumeName', 'invocationRoot'] :
      ['repository', 'project', 'invocationId', 'publicRoot', 'volumeName']) ||
        path.resolve(repository) !== repository ||
        !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project) ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(invocationId) ||
        publicRoot !== path.join(repository, '.cache/search-create-apply-public', invocationId) ||
        rolePrepare && invocationRoot !== path.join(repository,
          '.cache/search-writer-role-invocations', invocationId) ||
        volumeName !== `${project}_${rolePrepare ? 'search_writer_prepare' :
          'search_create_apply'}_${invocationId.replaceAll('-', '')}` ||
        !keys(config, ['name', 'services', 'networks', 'volumes']) || config.name !== project ||
        !keys(config.services, [transferName, readName]) ||
        !keys(config.networks, ['search_admin_db', 'search_internal']) ||
        !keys(config.volumes, [inputVolume, 'search_admin_certs',
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
    if (!keys(config.volumes[inputVolume], ['name', 'external']) ||
        config.volumes[inputVolume].name !== volumeName ||
        config.volumes[inputVolume].external !== true) fail();
    for (const name of ['search_admin_certs', 'search_security_state']) {
      const item = config.volumes[name];
      if (!keys(item, ['name']) && !keys(item, ['name', 'external']) ||
          item.name !== `${project}_${name}` ||
          item.external !== undefined && item.external !== false) fail();
    }
    const transfer = config.services[transferName];
    service(transfer, repository, transferName, '0:0', true, profile);
    const prefix = rolePrepare ? '/run/writer-prepare' : '/run/create-apply';
    const volumeTarget = rolePrepare ? '/run/search-writer-role-prepare' : '/run/search-create-apply';
    const mounts = mountsByTarget(transfer.volumes, [`${prefix}-password/password`,
      rolePrepare ? `${prefix}-intent/create-intent.json` : `${prefix}-intent/intent.json`,
      rolePrepare ? `${prefix}-binding/create-binding.json` : `${prefix}-binding/binding.json`,
      ...(rolePrepare ? [`${prefix}-invocation/invocation.json`] : []),
      `${prefix}-public`, volumeTarget]);
    bind(mounts.get(`${prefix}-password/password`),
      path.join(repository, '.cache/search-db/initial-v1/transition.password'),
      `${prefix}-password/password`, true);
    bind(mounts.get(rolePrepare ? `${prefix}-intent/create-intent.json` : `${prefix}-intent/intent.json`),
      path.join(repository, '.cache/search-create-intent/pending.json'),
      rolePrepare ? `${prefix}-intent/create-intent.json` : `${prefix}-intent/intent.json`, true);
    bind(mounts.get(rolePrepare ? `${prefix}-binding/create-binding.json` : `${prefix}-binding/binding.json`),
      path.join(repository, '.cache/search-create-apply/binding.json'),
      rolePrepare ? `${prefix}-binding/create-binding.json` : `${prefix}-binding/binding.json`, true);
    if (rolePrepare) bind(mounts.get(`${prefix}-invocation/invocation.json`),
      path.join(invocationRoot, 'invocation.json'), `${prefix}-invocation/invocation.json`, true);
    bind(mounts.get(`${prefix}-public`), publicRoot, `${prefix}-public`, true);
    volume(mounts.get(volumeTarget), inputVolume, volumeTarget, false, true);
    const consumer = config.services[readName];
    service(consumer, repository, rolePrepare ? readName : 'search-create-apply-consumer',
      '1000:1000', false, profile);
    const inputs = mountsByTarget(consumer.volumes,
      [volumeTarget, '/run/station-admin', '/run/station-state']);
    volume(inputs.get(volumeTarget), inputVolume, volumeTarget, true, true);
    volume(inputs.get('/run/station-admin'), 'search_admin_certs', '/run/station-admin', true, true);
    volume(inputs.get('/run/station-state'), 'search_security_state',
      '/run/station-state', true, true);
    return true;
  } catch { fail(); }
}

export function verifyCreateApplyServiceConfig(config, expected) {
  return verifyFixedServiceConfig(config, expected, false);
}

/** Fixed writer-role read-only preparation services; no operation selector. */
export function verifyWriterRolePrepareServiceConfig(config, expected) {
  return verifyFixedServiceConfig(config, expected, true);
}
