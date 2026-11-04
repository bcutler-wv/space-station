/* global structuredClone */
import path from 'node:path';
import { keys, mountsByTarget, bind, volume } from './search-attestor-service-config.mjs';
import { verifyFixedApplyServiceShape } from './search-create-apply-service-config.mjs';
import { parseWriterRoleConsumerArgs } from './search-writer-role-consumer-wrapper.mjs';
import { verifyOwnerContainerPolicy } from './search-owner-docker-policy.mjs';

const fail = () => { throw Error('Fixed writer role apply policy failed.'); };
const transferName = 'search-writer-role-apply-transfer';
const consumerName = 'search-writer-role-apply';
const inputVolume = 'search_writer_role_apply_input';
const profile = 'search-writer-role-apply';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const dockerId = /^[0-9a-f]{64}$/;

function checked(expected) {
  if (!keys(expected, ['repository', 'project', 'invocationId', 'publicRoot', 'volumeName']) ||
      path.resolve(expected.repository) !== expected.repository ||
      !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(expected.project) ||
      !uuid.test(expected.invocationId) ||
      expected.publicRoot !== path.join(expected.repository,
        '.cache/search-create-apply-public', expected.invocationId) ||
      expected.volumeName !== `${expected.project}_search_writer_apply_${expected.invocationId.replaceAll('-', '')}`)
    fail();
}

/** Base Compose render has no approval authority; it must fail if directly run. */
export function verifyWriterRoleApplyServiceConfig(config, expected) {
  try {
    checked(expected);
    const { repository, project, publicRoot, volumeName } = expected;
    if (!keys(config, ['name', 'services', 'networks', 'volumes']) ||
        config.name !== project || !keys(config.services, [transferName, consumerName]) ||
        !keys(config.networks, ['search_admin_db', 'search_internal']) ||
        !keys(config.volumes, [inputVolume, 'search_admin_certs', 'search_security_state'])) fail();
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
    verifyFixedApplyServiceShape(transfer, repository, transferName, '0:0', true, profile);
    const files = [
      ['intent/intent.json', '.cache/search-writer-role-intent/pending.json'],
      ['binding/binding.json', '.cache/search-writer-role-apply/binding.json'],
      ['create-intent/create-intent.json', '.cache/search-create-intent/pending.json'],
      ['create-binding/create-binding.json', '.cache/search-create-apply/binding.json'],
      ['password/password', '.cache/search-db/initial-v1/transition.password'],
    ];
    const prefix = '/run/writer-apply-';
    const targets = [...files.map(([name]) => `${prefix}${name}`),
      `${prefix}public`, '/run/search-writer-role-apply'];
    const mounts = mountsByTarget(transfer.volumes, targets);
    for (const [target, source] of files) bind(mounts.get(`${prefix}${target}`),
      path.join(repository, source), `${prefix}${target}`, true);
    bind(mounts.get(`${prefix}public`), publicRoot, `${prefix}public`, true);
    volume(mounts.get('/run/search-writer-role-apply'), inputVolume,
      '/run/search-writer-role-apply', false, true);
    const consumer = config.services[consumerName];
    verifyFixedApplyServiceShape(consumer, repository, 'search-writer-role-consumer',
      '1000:1000', false, profile);
    const inputs = mountsByTarget(consumer.volumes,
      ['/run/search-writer-role-apply', '/run/station-admin', '/run/station-state']);
    volume(inputs.get('/run/search-writer-role-apply'), inputVolume,
      '/run/search-writer-role-apply', true, true);
    volume(inputs.get('/run/station-admin'), 'search_admin_certs', '/run/station-admin', true, true);
    volume(inputs.get('/run/station-state'), 'search_security_state', '/run/station-state', true, true);
    return true;
  } catch { fail(); }
}

/** The future owner supplies these thirteen independently approved fields. */
export function fixedWriterRoleApplyCommand(fields) {
  try {
    const context = parseWriterRoleConsumerArgs(fields);
    const a = context.approval;
    return Object.freeze(['node', 'scripts/search-writer-role-consumer.mjs',
      a.approvedSha256, String(a.revision), a.transitionToken, a.sourceToken,
      a.sourceIndex, a.sourceUuid, a.candidateToken, a.candidateIndex, a.candidateUuid,
      context.invocationId, context.project, String(context.databaseOid),
      context.systemIdentifier]);
  } catch { fail(); }
}

/** The private override may change only two commands and container names. */
export function verifyWriterRoleApplyMergedConfig(config, expected) {
  try {
    checked({ repository: expected.repository, project: expected.project,
      invocationId: expected.invocationId, publicRoot: expected.publicRoot,
      volumeName: expected.volumeName });
    const transfer = config.services?.[transferName], apply = config.services?.[consumerName];
    if (transfer?.container_name !== expected.transferName ||
        apply?.container_name !== expected.applyName ||
        JSON.stringify(transfer.command) !== JSON.stringify(['node',
          'scripts/search-writer-role-apply-transfer.mjs']) ||
        JSON.stringify(apply.command) !== JSON.stringify(fixedWriterRoleApplyCommand(expected.approvedFields))) fail();
    const base = structuredClone(config);
    delete base.services[transferName].container_name;
    delete base.services[consumerName].container_name;
    base.services[consumerName].command = ['node', 'scripts/search-writer-role-consumer.mjs'];
    return verifyWriterRoleApplyServiceConfig(base, { repository: expected.repository,
      project: expected.project, invocationId: expected.invocationId,
      publicRoot: expected.publicRoot, volumeName: expected.volumeName });
  } catch { fail(); }
}

/** Created-state check: requested names are evidence, not attached network IDs. */
export function verifyWriterRoleApplyCreatedContainer(item, expected) {
  try {
    if (item.State?.Status !== 'created' || item.State?.Running !== false ||
        item.State?.Restarting === true || item.RestartCount !== 0 ||
        item.State?.Paused !== false || item.State?.OOMKilled !== false ||
        item.State?.Dead !== false || item.State?.Error !== '' ||
        item.State?.ExitCode !== 0 ||
        item.State?.StartedAt !== '0001-01-01T00:00:00Z' ||
        item.State?.FinishedAt !== '0001-01-01T00:00:00Z' ||
        item.Name !== `/${expected.containerName}`) fail();
    const transfer = expected.service === transferName;
    const map = item.NetworkSettings?.Networks;
    const wanted = transfer ? Object.keys(map).length === 0 ? [] : ['none'] : [`${expected.project}_search_admin_db`,
      `${expected.project}_search_internal`];
    if (!map || JSON.stringify(Object.keys(map).sort()) !== JSON.stringify(wanted.sort()) ||
        item.HostConfig?.NetworkMode !== (transfer ? 'none' :
          `${expected.project}_search_admin_db`)) fail();
    for (const [name, endpoint] of Object.entries(map)) {
      if (!endpoint || typeof endpoint !== 'object' ||
          Object.keys(endpoint).some(key => !['Aliases', 'NetworkID', 'EndpointID',
            'Gateway', 'IPAddress', 'IPPrefixLen', 'IPv6Gateway', 'GlobalIPv6Address',
            'GlobalIPv6PrefixLen', 'MacAddress', 'Links', 'IPAMConfig', 'DriverOpts',
            'GwPriority', 'DNSNames'].includes(key)) ||
          endpoint.NetworkID && endpoint.NetworkID !== expected.networkByName[name] ||
          endpoint.EndpointID || endpoint.Gateway || endpoint.IPAddress ||
          endpoint.IPPrefixLen || endpoint.IPv6Gateway || endpoint.GlobalIPv6Address ||
          endpoint.GlobalIPv6PrefixLen || endpoint.MacAddress || endpoint.Links?.length ||
          endpoint.IPAMConfig && !keys(endpoint.IPAMConfig, []) ||
          endpoint.DriverOpts || endpoint.GwPriority ||
          endpoint.DNSNames?.length ||
          endpoint.Aliases && (!Array.isArray(endpoint.Aliases) ||
            endpoint.Aliases.some(alias => ![expected.containerName, expected.service].includes(alias)))) fail();
    }
    // Reuse the complete non-network policy only after checking the created map above.
    const projected = { ...item, NetworkSettings: { ...item.NetworkSettings,
      Networks: transfer ? {} : Object.fromEntries(wanted.map((name, index) =>
        [name, { NetworkID: expected.networkIds[index] }])) } };
    const runningExpected = { service: expected.service, id: expected.id,
      image: expected.image, env: expected.env, entrypoint: expected.entrypoint,
      repository: expected.repository, project: expected.project,
      invocationId: expected.invocationId, publicRoot: expected.publicRoot,
      volumeName: expected.volumeName, networkIds: expected.networkIds,
      noneNetworkId: expected.noneNetworkId, approvedFields: expected.approvedFields };
    verifyWriterRoleApplyEffectiveContainer(projected, runningExpected);
    return true;
  } catch { fail(); }
}

/** Pure effective inspect check; an owner must separately pin its expected originals. */
export function verifyWriterRoleApplyEffectiveContainer(item, expected) {
  try {
    if (!keys(expected, ['service', 'id', 'image', 'env', 'entrypoint', 'repository',
      'project', 'invocationId', 'publicRoot', 'volumeName', 'networkIds',
      'noneNetworkId', 'approvedFields'])) fail();
    checked({ repository: expected.repository, project: expected.project,
      invocationId: expected.invocationId, publicRoot: expected.publicRoot,
      volumeName: expected.volumeName });
    if (!dockerId.test(expected.noneNetworkId) ||
        !Array.isArray(expected.networkIds) || expected.networkIds.length !== 2 ||
        new Set([expected.noneNetworkId, ...expected.networkIds]).size !== 3 ||
        expected.networkIds.some(id => !dockerId.test(id))) fail();
    const commandContext = parseWriterRoleConsumerArgs(expected.approvedFields);
    if (commandContext.project !== expected.project ||
        commandContext.invocationId !== expected.invocationId) fail();
    const transfer = expected.service === transferName;
    if (!transfer && expected.service !== consumerName) fail();
    const volumeNames = { [inputVolume]: { name: expected.volumeName },
      search_admin_certs: { name: `${expected.project}_search_admin_certs` },
      search_security_state: { name: `${expected.project}_search_security_state` } };
    const bindMounts = [
      ['.cache/search-writer-role-intent/pending.json', '/run/writer-apply-intent/intent.json'],
      ['.cache/search-writer-role-apply/binding.json', '/run/writer-apply-binding/binding.json'],
      ['.cache/search-create-intent/pending.json', '/run/writer-apply-create-intent/create-intent.json'],
      ['.cache/search-create-apply/binding.json', '/run/writer-apply-create-binding/create-binding.json'],
      ['.cache/search-db/initial-v1/transition.password', '/run/writer-apply-password/password'],
    ].map(([source, target]) => ({ type: 'bind', source: path.join(expected.repository, source),
      target, read_only: true }));
    const input = { type: 'volume', source: inputVolume, target: '/run/search-writer-role-apply',
      read_only: !transfer, volume: { nocopy: true } };
    const mounts = transfer ? [...bindMounts,
      { type: 'bind', source: expected.publicRoot, target: '/run/writer-apply-public', read_only: true },
      input] : [input,
      { type: 'volume', source: 'search_admin_certs', target: '/run/station-admin',
        read_only: true, volume: { nocopy: true } },
      { type: 'volume', source: 'search_security_state', target: '/run/station-state',
        read_only: true, volume: { nocopy: true } }];
    const command = transfer ? ['node', 'scripts/search-writer-role-apply-transfer.mjs'] :
      fixedWriterRoleApplyCommand(expected.approvedFields);
    verifyOwnerContainerPolicy(item, { id: expected.id, image: expected.image,
      env: expected.env, entrypoint: expected.entrypoint, command,
      user: transfer ? '0:0' : '1000:1000', project: expected.project,
      service: expected.service, capAdd: transfer ? ['CHOWN', 'DAC_OVERRIDE'] : [],
      pids: transfer ? 64 : 128, memory: transfer ? 268435456 : 536870912,
      nanoCpus: transfer ? 500000000 : 1000000000,
      tmpfs: transfer ? 'rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0700' :
        'rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700',
      mounts, volumes: volumeNames, networks: transfer ? [expected.noneNetworkId] : expected.networkIds,
      none: transfer, terminal: false }, fail);
    return true;
  } catch { fail(); }
}
