/* global structuredClone */
import assert from 'node:assert/strict';
import process from 'node:process';
import path from 'node:path';
import { verifyWriterMappingPrepareServiceConfig,
  verifyWriterMappingPrepareEffectiveContainer,
  verifyWriterMappingPrepareNamedConfig,
  verifyWriterMappingPrepareNamedEffectiveContainer,
  verifyWriterMappingPrepareCreatedContainer,
  fixedWriterMappingPrepareNames } from
  '../../scripts/search-writer-mapping-prepare-service-config.mjs';

const [uid, repository] = process.argv.slice(2);
assert.ok(['1000', '1001'].includes(uid));
assert.equal(path.resolve(repository), repository);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const context = { repository, project: 'writer_mapping_fixture', invocationId,
  invocationRoot: path.join(repository, '.cache/search-writer-mapping-invocations', invocationId),
  publicRoot: path.join(repository, '.cache/search-writer-mapping-prepare-public', invocationId),
  volumeName: `writer_mapping_fixture_search_writer_mapping_prepare_${invocationId.replaceAll('-', '')}` };
const names = fixedWriterMappingPrepareNames(invocationId);
const base = verifyWriterMappingPrepareNamedConfig(config, context);
assert.equal(verifyWriterMappingPrepareServiceConfig(base, context), true);
const denied = value => assert.throws(() =>
  verifyWriterMappingPrepareNamedConfig(value, context),
{ message: 'Fixed writer mapping preparation Compose render failed.' });
const mutate = fn => { const copy = structuredClone(config); fn(copy); denied(copy); };
mutate(copy => { copy.services['search-writer-mapping-prepare-transfer'].network_mode = 'bridge'; });
mutate(copy => { copy.services['search-writer-mapping-prepare-transfer'].cap_add = ['ALL']; });
mutate(copy => { copy.services['search-writer-mapping-prepare'].networks.search_internal = null;
  delete copy.services['search-writer-mapping-prepare'].networks.search_admin_db; });
mutate(copy => { copy.services['search-writer-mapping-prepare'].command[1] =
  'scripts/search-writer-role-prepare.mjs'; });
mutate(copy => { copy.services['search-writer-mapping-prepare-transfer'].volumes[6].source =
  path.join(repository, '.cache/search-writer-mapping-public'); });
mutate(copy => { copy.services['search-writer-mapping-prepare-transfer'].volumes[4].bind
  .create_host_path = true; });
mutate(copy => { copy.services['search-writer-mapping-prepare-transfer'].volumes.push({
  type: 'bind', source: path.join(repository, '.cache/search-security/ca.key'),
  target: '/run/ca.key', read_only: true }); });
mutate(copy => { copy.volumes.search_writer_mapping_prepare_input.name = 'another-volume'; });
mutate(copy => { copy.services['search-writer-mapping-prepare'].user =
  `${Number(uid) + 1}:${Number(uid) + 1}`; });
mutate(copy => { copy.services['search-writer-mapping-prepare'].volumes[0].read_only = false; });
mutate(copy => { copy.networks.search_admin_db.ipam = { config: [] }; });
mutate(copy => { copy.name = 'another_project';
  copy.volumes.search_writer_mapping_prepare_input.name =
    `another_project_search_writer_mapping_prepare_${invocationId.replaceAll('-', '')}`; });
assert.throws(() => verifyWriterMappingPrepareNamedConfig(config,
  { ...context, invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    invocationRoot: path.join(repository, '.cache/search-writer-mapping-invocations',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    publicRoot: path.join(repository, '.cache/search-writer-mapping-prepare-public',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    volumeName: 'writer_mapping_fixture_search_writer_mapping_prepare_bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb' }),
{ message: 'Fixed writer mapping preparation Compose render failed.' });
assert.throws(() => verifyWriterMappingPrepareEffectiveContainer({}, {
  config, context, phase: 'search-writer-mapping-prepare', id: 'a'.repeat(64),
  image: `sha256:${'b'.repeat(64)}`, env: [], entrypoint: [],
  networkIds: { search_admin_db: 'c'.repeat(64), search_internal: 'd'.repeat(64) },
  noneNetworkId: 'e'.repeat(64), terminal: true }),
{ message: 'Fixed writer mapping preparation Compose render failed.' });
mutate(copy => { copy.services['search-writer-mapping-prepare-transfer'].container_name =
  names.prepare; });
mutate(copy => { copy.services['search-writer-mapping-prepare'].container_name =
  'foreign-read'; });
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const foreignInvocation = JSON.parse(JSON.stringify(config)
  .replaceAll(invocationId, otherId)
  .replaceAll(invocationId.replaceAll('-', ''), otherId.replaceAll('-', '')));
const foreignContext = { ...context, invocationId: otherId,
  invocationRoot: path.join(repository, '.cache/search-writer-mapping-invocations', otherId),
  publicRoot: path.join(repository, '.cache/search-writer-mapping-prepare-public', otherId),
  volumeName: `writer_mapping_fixture_search_writer_mapping_prepare_${otherId.replaceAll('-', '')}` };
assert.equal(verifyWriterMappingPrepareNamedConfig(foreignInvocation, foreignContext)
  .services['search-writer-mapping-prepare'].command[1],
'scripts/search-writer-mapping-prepare.mjs');
denied(foreignInvocation);
const foreignProject = JSON.parse(JSON.stringify(config)
  .replaceAll('writer_mapping_fixture', 'foreign_project'));
assert.equal(verifyWriterMappingPrepareNamedConfig(foreignProject,
  { ...context, project: 'foreign_project',
    volumeName: `foreign_project_search_writer_mapping_prepare_${invocationId.replaceAll('-', '')}` })
  .name, 'foreign_project');
denied(foreignProject);

const ids = { search_admin_db: 'c'.repeat(64), search_internal: 'd'.repeat(64) };
const noneId = 'e'.repeat(64);
function container(phase) {
  const spec = config.services[phase];
  const isTransfer = phase.endsWith('-transfer');
  const networks = isTransfer ? { none: { NetworkID: noneId } } : {
    [`${context.project}_search_admin_db`]: { NetworkID: ids.search_admin_db },
    [`${context.project}_search_internal`]: { NetworkID: ids.search_internal } };
  const image = `sha256:${'b'.repeat(64)}`;
  const mounts = spec.volumes.map(row => ({ Type: row.type, Destination: row.target,
    Source: row.type === 'bind' ? row.source : config.volumes[row.source].name,
    Name: row.type === 'volume' ? config.volumes[row.source].name : undefined,
    RW: !row.read_only }));
  const item = { Id: 'a'.repeat(64), Image: image,
    Name: `/${isTransfer ? names.transfer : names.prepare}`,
    Config: { User: spec.user, Cmd: spec.command,
      Entrypoint: ['docker-entrypoint.sh'], Env: ['NODE_VERSION=22.23.2'],
      Labels: { 'com.docker.compose.project': context.project,
        'com.docker.compose.service': phase } },
    HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'],
      CapAdd: isTransfer ? ['CAP_CHOWN', 'CAP_DAC_OVERRIDE'] : [],
      PidsLimit: spec.pids_limit, Memory: Number(spec.mem_limit),
      NanoCpus: spec.cpus * 1e9, RestartPolicy: { Name: 'no' },
      SecurityOpt: ['no-new-privileges:true'], Devices: [], GroupAdd: [],
      PidMode: '', IpcMode: 'private', PortBindings: {},
      Tmpfs: { '/tmp': spec.tmpfs[0].slice('/tmp:'.length) },
      NetworkMode: isTransfer ? 'none' : `${context.project}_search_admin_db`,
      Mounts: spec.volumes.map(row => ({ Type: row.type,
        Source: row.type === 'bind' ? row.source : config.volumes[row.source].name,
        Target: row.target, ReadOnly: !!row.read_only,
        ...row.type === 'bind' ? { BindOptions: { CreateMountpoint: false } } :
          { VolumeOptions: { NoCopy: true } } })) },
    NetworkSettings: { Ports: {}, Networks: networks }, Mounts: mounts,
    State: { Status: 'exited', ExitCode: 0, StartedAt: '2026-11-04T00:00:01Z',
      FinishedAt: '2026-11-04T00:00:02Z', Running: false,
      OOMKilled: false, Dead: false, Error: '' }, RestartCount: 0 };
  const expected = { config, context, phase, id: item.Id, image,
    env: item.Config.Env, entrypoint: item.Config.Entrypoint,
    networkIds: ids, noneNetworkId: noneId, terminal: true };
  return { item, expected };
}
for (const phase of ['search-writer-mapping-prepare-transfer',
  'search-writer-mapping-prepare']) {
  const { item, expected } = container(phase);
  assert.equal(verifyWriterMappingPrepareNamedEffectiveContainer(item, expected), true);
  const wrong = structuredClone(item);
  if (phase.endsWith('-transfer')) wrong.HostConfig.CapAdd.push('CAP_SYS_ADMIN');
  else wrong.NetworkSettings.Networks[`${context.project}_search_internal`].NetworkID = 'f'.repeat(64);
  assert.throws(() => verifyWriterMappingPrepareNamedEffectiveContainer(wrong, expected),
    { message: 'Fixed writer mapping preparation Compose render failed.' });
  const created = structuredClone(item);
  const isTransfer = phase.endsWith('-transfer');
  created.State = { Status: 'created', Running: false, Paused: false,
    Restarting: false, OOMKilled: false, Dead: false, Error: '', ExitCode: 0,
    StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' };
  created.NetworkSettings.Networks = isTransfer ? { none: {} } : {
    [`${context.project}_search_admin_db`]: {},
    [`${context.project}_search_internal`]: {} };
  assert.equal(verifyWriterMappingPrepareCreatedContainer(created, expected), true);
  const wrongEndpoint = structuredClone(created);
  wrongEndpoint.NetworkSettings.Networks[isTransfer ? 'none' :
    `${context.project}_search_admin_db`].EndpointID = 'f'.repeat(64);
  assert.throws(() => verifyWriterMappingPrepareCreatedContainer(wrongEndpoint, expected),
    { message: 'Fixed writer mapping preparation Compose render failed.' });
  if (!isTransfer) {
    const emptyReader = structuredClone(created);
    emptyReader.NetworkSettings.Networks = {};
    assert.throws(() => verifyWriterMappingPrepareCreatedContainer(emptyReader, expected),
      { message: 'Fixed writer mapping preparation Compose render failed.' });
  }
}
