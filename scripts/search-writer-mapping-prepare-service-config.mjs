/* global structuredClone */
import path from 'node:path';
import { keys, mountsByTarget, bind, volume } from './search-attestor-service-config.mjs';
import { verifyFixedApplyServiceShape } from './search-create-apply-service-config.mjs';
import { equal, verifyOwnerContainerPolicy } from './search-owner-docker-policy.mjs';

const fail = () => { throw Error('Fixed writer mapping preparation Compose render failed.'); };
const profile = 'search-writer-mapping-prepare';
const transfer = `${profile}-transfer`;
const inputVolume = 'search_writer_mapping_prepare_input';
const inputRoot = '/run/search-writer-mapping-prepare';
const prefix = '/run/writer-mapping-prepare-';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function fixedWriterMappingPrepareNames(invocationId) {
  if (typeof invocationId !== 'string' || !uuid.test(invocationId)) fail();
  const suffix = invocationId.replaceAll('-', '');
  return Object.freeze({ transfer: `station_mapping_prepare_transfer_${suffix}`,
    prepare: `station_mapping_prepare_read_${suffix}` });
}

/** Validate the two trusted names, then reuse the unchanged strict base policy. */
export function verifyWriterMappingPrepareNamedConfig(config, context) {
  try {
    const names = fixedWriterMappingPrepareNames(context.invocationId);
    if (config.services?.[transfer]?.container_name !== names.transfer ||
        config.services?.[profile]?.container_name !== names.prepare) fail();
    const base = structuredClone(config);
    delete base.services[transfer].container_name;
    delete base.services[profile].container_name;
    verifyWriterMappingPrepareServiceConfig(base, context);
    return base;
  } catch { fail(); }
}

/** Mapping-only fixed render policy; expected authority is supplied independently. */
export function verifyWriterMappingPrepareServiceConfig(config, expected) {
  try {
    if (!keys(expected, ['repository', 'project', 'invocationId', 'invocationRoot',
      'publicRoot', 'volumeName']) || path.resolve(expected.repository) !== expected.repository ||
        !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(expected.project) ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(expected.invocationId) ||
        expected.invocationRoot !== path.join(expected.repository,
          '.cache/search-writer-mapping-invocations', expected.invocationId) ||
        expected.publicRoot !== path.join(expected.repository,
          '.cache/search-writer-mapping-prepare-public', expected.invocationId) ||
        expected.volumeName !== `${expected.project}_search_writer_mapping_prepare_${expected.invocationId.replaceAll('-', '')}` ||
        !keys(config, ['name', 'services', 'networks', 'volumes']) ||
        config.name !== expected.project || !keys(config.services, [transfer, profile]) ||
        !keys(config.networks, ['search_admin_db', 'search_internal']) ||
        !keys(config.volumes, [inputVolume, 'search_admin_certs',
          'search_security_state'])) fail();
    for (const name of ['search_admin_db', 'search_internal']) {
      const network = config.networks[name];
      if (!keys(network, ['name', 'internal']) &&
          !keys(network, ['name', 'internal', 'external']) &&
          !keys(network, ['name', 'internal', 'ipam']) &&
          !keys(network, ['name', 'internal', 'external', 'ipam']) ||
          network.name !== `${expected.project}_${name}` || network.internal !== true ||
          network.external !== undefined && network.external !== false ||
          network.ipam !== undefined && !keys(network.ipam, [])) fail();
    }
    if (!keys(config.volumes[inputVolume], ['name', 'external']) ||
        config.volumes[inputVolume].name !== expected.volumeName ||
        config.volumes[inputVolume].external !== true) fail();
    for (const name of ['search_admin_certs', 'search_security_state']) {
      const item = config.volumes[name];
      if (!keys(item, ['name']) && !keys(item, ['name', 'external']) ||
          item.name !== `${expected.project}_${name}` ||
          item.external !== undefined && item.external !== false) fail();
    }
    verifyFixedApplyServiceShape(config.services[transfer], expected.repository,
      transfer, '0:0', true, profile);
    verifyFixedApplyServiceShape(config.services[profile], expected.repository,
      profile, '1000:1000', false, profile);
    const mounts = mountsByTarget(config.services[transfer].volumes, [
      `${prefix}create-intent/create-intent.json`,
      `${prefix}create-binding/create-binding.json`,
      `${prefix}role-intent/role-intent.json`,
      `${prefix}role-binding/role-binding.json`,
      `${prefix}invocation/invocation.json`, `${prefix}password/password`,
      `${prefix}public`, inputRoot]);
    const sources = [
      ['create-intent/create-intent.json', '.cache/search-create-intent/pending.json'],
      ['create-binding/create-binding.json', '.cache/search-create-apply/binding.json'],
      ['role-intent/role-intent.json', '.cache/search-writer-role-intent/pending.json'],
      ['role-binding/role-binding.json', '.cache/search-writer-role-apply/binding.json'],
      ['password/password', '.cache/search-db/initial-v1/transition.password']];
    for (const [target, source] of sources) bind(mounts.get(`${prefix}${target}`),
      path.join(expected.repository, source), `${prefix}${target}`, true);
    bind(mounts.get(`${prefix}invocation/invocation.json`),
      path.join(expected.invocationRoot, 'invocation.json'),
      `${prefix}invocation/invocation.json`, true);
    bind(mounts.get(`${prefix}public`), expected.publicRoot, `${prefix}public`, true);
    volume(mounts.get(inputRoot), inputVolume, inputRoot, false, true);
    const reader = mountsByTarget(config.services[profile].volumes,
      [inputRoot, '/run/station-admin', '/run/station-state']);
    volume(reader.get(inputRoot), inputVolume, inputRoot, true, true);
    volume(reader.get('/run/station-admin'), 'search_admin_certs', '/run/station-admin', true, true);
    volume(reader.get('/run/station-state'), 'search_security_state', '/run/station-state', true, true);
    return true;
  } catch { fail(); }
}

/** Fixed post-start inspection; created-state inspection remains a later owner gate. */
export function verifyWriterMappingPrepareEffectiveContainer(item, expected) {
  try {
    if (!keys(expected, ['config', 'context', 'phase', 'id', 'image', 'env',
      'entrypoint', 'networkIds', 'noneNetworkId', 'terminal']) ||
        ![transfer, profile].includes(expected.phase) ||
        !keys(expected.networkIds, ['search_admin_db', 'search_internal']) ||
        !Object.values(expected.networkIds).every(id =>
          typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) ||
        typeof expected.noneNetworkId !== 'string' ||
        !/^[0-9a-f]{64}$/.test(expected.noneNetworkId) ||
        typeof expected.terminal !== 'boolean' ||
        new Set([...Object.values(expected.networkIds), expected.noneNetworkId]).size !== 3 ||
        verifyWriterMappingPrepareServiceConfig(expected.config, expected.context) !== true) fail();
    const phase = expected.phase, transferPhase = phase === transfer;
    const service = expected.config.services[phase];
    verifyOwnerContainerPolicy(item, { id: expected.id, image: expected.image,
      env: expected.env, entrypoint: expected.entrypoint,
      command: ['node', `scripts/${phase}.mjs`],
      user: transferPhase ? '0:0' : '1000:1000',
      project: expected.context.project, service: phase,
      capAdd: transferPhase ? ['CHOWN', 'DAC_OVERRIDE'] : [],
      pids: transferPhase ? 64 : 128,
      memory: transferPhase ? 268435456 : 536870912,
      nanoCpus: transferPhase ? 5e8 : 1e9,
      tmpfs: service.tmpfs[0].slice('/tmp:'.length),
      mounts: service.volumes, volumes: expected.config.volumes,
      networks: transferPhase ? [expected.noneNetworkId] :
        Object.values(expected.networkIds), none: transferPhase,
      terminal: expected.terminal }, fail);
    const names = Object.keys(item.NetworkSettings?.Networks ?? {}).sort();
    if (!equal(names, transferPhase ? [] :
      [`${expected.context.project}_search_admin_db`,
        `${expected.context.project}_search_internal`].sort()) &&
        !(transferPhase && equal(names, ['none']))) fail();
    if (!transferPhase) for (const [name, id] of Object.entries(expected.networkIds))
      if (item.NetworkSettings.Networks[`${expected.context.project}_${name}`]?.NetworkID !== id)
        fail();
    return true;
  } catch { fail(); }
}

/** Post-start mapping policy additionally binds the original fixed name. */
export function verifyWriterMappingPrepareNamedEffectiveContainer(item, expected) {
  try {
    const base = verifyWriterMappingPrepareNamedConfig(expected.config, expected.context);
    const names = fixedWriterMappingPrepareNames(expected.context.invocationId);
    if (item.Name !== `/${expected.phase === transfer ? names.transfer : names.prepare}`) fail();
    return verifyWriterMappingPrepareEffectiveContainer(item,
      { ...expected, config: base });
  } catch { fail(); }
}

/** Created inspection is separate from actual post-start network-ID proof. */
export function verifyWriterMappingPrepareCreatedContainer(item, expected) {
  try {
    const transferPhase = expected.phase === transfer;
    if (!transferPhase && expected.phase !== profile ||
        item.State?.Status !== 'created' || item.State.Running !== false ||
        item.State.Paused !== false || item.State.Restarting !== false ||
        item.State.OOMKilled !== false || item.State.Dead !== false ||
        item.State.Error !== '' || item.State.ExitCode !== 0 ||
        item.RestartCount !== 0 ||
        item.State.StartedAt !== '0001-01-01T00:00:00Z' ||
        item.State.FinishedAt !== '0001-01-01T00:00:00Z' ||
        item.HostConfig?.NetworkMode !== (transferPhase ? 'none' :
          `${expected.context.project}_search_admin_db`)) fail();
    const map = item.NetworkSettings?.Networks;
    const required = transferPhase ? Object.keys(map ?? {}).length === 0 ? [] : ['none'] :
      [`${expected.context.project}_search_admin_db`,
        `${expected.context.project}_search_internal`];
    if (!map || !equal(Object.keys(map).sort(), required.sort())) fail();
    const byName = { none: expected.noneNetworkId,
      [`${expected.context.project}_search_admin_db`]: expected.networkIds.search_admin_db,
      [`${expected.context.project}_search_internal`]: expected.networkIds.search_internal };
    for (const [name, endpoint] of Object.entries(map)) {
      if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint) ||
          Object.keys(endpoint).some(key => !['Aliases', 'NetworkID', 'EndpointID',
            'Gateway', 'IPAddress', 'IPPrefixLen', 'IPv6Gateway', 'GlobalIPv6Address',
            'GlobalIPv6PrefixLen', 'MacAddress', 'Links', 'IPAMConfig', 'DriverOpts',
            'GwPriority', 'DNSNames'].includes(key)) ||
          endpoint.NetworkID && endpoint.NetworkID !== byName[name] ||
          endpoint.EndpointID || endpoint.Gateway || endpoint.IPAddress ||
          endpoint.IPPrefixLen || endpoint.IPv6Gateway || endpoint.GlobalIPv6Address ||
          endpoint.GlobalIPv6PrefixLen || endpoint.MacAddress || endpoint.Links?.length ||
          endpoint.IPAMConfig && !keys(endpoint.IPAMConfig, []) ||
          endpoint.DriverOpts || endpoint.GwPriority || endpoint.DNSNames?.length ||
          endpoint.Aliases && (!Array.isArray(endpoint.Aliases) ||
            endpoint.Aliases.some(alias => ![
              expected.phase, fixedWriterMappingPrepareNames(expected.context.invocationId)[
                transferPhase ? 'transfer' : 'prepare']].includes(alias)))) fail();
    }
    const projected = { ...item, NetworkSettings: { ...item.NetworkSettings,
      Networks: transferPhase ? {} : Object.fromEntries(required.map(name =>
        [name, { NetworkID: byName[name] }])) } };
    return verifyWriterMappingPrepareNamedEffectiveContainer(projected,
      { ...expected, terminal: false });
  } catch { fail(); }
}
