import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { createBoundaryDockerAdapter,
  createIntentPrepareDockerAdapter } from '../../scripts/search-create-boundary-owner-docker.mjs';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';

const repository = path.resolve('.'), uid = process.getuid(), gid = process.getgid();
const project = 'create_fixture', id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const invocationRoot = path.join(repository, '.cache/search-create-invocations', id);
const volumeName = `${project}_search_create_${id.replaceAll('-', '')}`;
const service = { transfer: 'search-create-transfer', inspect: 'search-create-boundary' };
const intentService = { transfer: 'search-create-transfer', prepare: 'search-create-intent-prepare' };
const containerIds = { transfer: 'a'.repeat(64), inspect: 'b'.repeat(64) };
const imageIds = { transfer: `sha256:${'1'.repeat(64)}`, inspect: `sha256:${'2'.repeat(64)}` };
const networkIds = { search_admin_db: '3'.repeat(64), search_internal: '4'.repeat(64),
  none: '5'.repeat(64) };
const identity = { project, service: 'postgres', database: 'station', databaseOid: '16384',
  systemIdentifier: '12345678901234567890', owner: 'station', uid, gid };
const stat = { dev: 1, ino: 2, uid, gid, mode: 0o100600, size: 43,
  nlink: 1, mtimeMs: 1, ctimeMs: 1 };
const metadata = Buffer.from(JSON.stringify(identity));
const credential = () => ({ rootStat: stat,
  metadata: { stat: { ...stat, size: metadata.length }, bytes: metadata },
  transition: { stat, bytes: Buffer.from('x'.repeat(43)) } });
const bind = (source, target) => ({ type: 'bind', source, target, read_only: true,
  bind: { create_host_path: false } });
const mount = (source, target, readOnly = true) => ({ type: 'volume', source, target,
  ...(readOnly ? { read_only: true } : {}), volume: { nocopy: true } });
function config(intent = false) {
  const common = (command, user, transfer) => ({
    profiles: ['search-create-boundary'], build: { context: repository, target: 'search-attestor' },
    command: ['node', `scripts/${command}.mjs`], user, read_only: true,
    tmpfs: [transfer ? '/tmp:rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0700' :
      '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700'],
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], pids_limit: transfer ? 64 : 128,
    mem_limit: String(transfer ? 268435456 : 536870912), cpus: transfer ? 0.5 : 1,
    restart: 'no', ...(transfer ? { network_mode: 'none', cap_add: ['CHOWN', 'DAC_OVERRIDE'] } :
      { networks: { search_admin_db: null, search_internal: null } }) });
  return { name: project, services: {
    'search-create-transfer': { ...common('search-create-boundary-transfer', '0:0', true),
      volumes: [bind(path.join(repository, '.cache/search-db/initial-v1/transition.password'),
        '/run/create-transfer-password/password'),
      bind(path.join(invocationRoot, 'invocation'), '/run/create-transfer-invocation/invocation'),
      mount('search_create_input', '/run/create-boundary', false)] },
    [intent ? 'search-create-intent-prepare' : 'search-create-boundary']:
      { ...common(intent ? 'search-create-intent-prepare' : 'search-create-boundary', '1000:1000', false),
      volumes: [mount('search_create_input', '/run/create-boundary'),
        mount('search_admin_certs', '/run/station-admin'),
        mount('search_security_state', '/run/station-state')] },
  }, networks: {
    search_admin_db: { name: `${project}_search_admin_db`, internal: true },
    search_internal: { name: `${project}_search_internal`, internal: true },
  }, volumes: { search_create_input: { name: volumeName, external: true },
    search_admin_certs: { name: `${project}_search_admin_certs` },
    search_security_state: { name: `${project}_search_security_state` } } };
}
const volume = name => ({ Name: name, Driver: 'local', Scope: 'local',
  CreatedAt: '2026-10-27T00:00:00Z', Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  Options: null, Labels: name === volumeName ?
    { 'station.create.project': project, 'station.create.invocation': id } :
    { 'com.docker.compose.project': project,
      'com.docker.compose.volume': name.replace(`${project}_`, '') } });
function container(phase, mutation, intent = false) {
  const services = intent ? intentService : service;
  const spec = config(intent).services[services[phase]];
  const c = config(intent);
  const networks = phase === 'transfer' ? { none: { NetworkID: networkIds.none } } :
    Object.fromEntries(['search_admin_db', 'search_internal'].map(name =>
      [name, { NetworkID: networkIds[name] }]));
  const result = { Id: phase === 'prepare' ? containerIds.inspect : containerIds[phase],
    Image: phase === 'prepare' ? imageIds.inspect : imageIds[phase],
    Created: '2026-10-27T00:00:00Z', RestartCount: 0,
    Config: { User: phase === 'transfer' ? '0:0' : '1000:1000', Cmd: spec.command,
      Entrypoint: ['docker-entrypoint.sh'], Env: ['NODE_VERSION=22.23.2'],
      Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': services[phase] } },
    HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'],
      CapAdd: phase === 'transfer' ? ['CAP_CHOWN', 'CAP_DAC_OVERRIDE'] : [],
      PidsLimit: spec.pids_limit, Memory: Number(spec.mem_limit), NanoCpus: spec.cpus * 1e9,
      RestartPolicy: { Name: 'no' }, SecurityOpt: ['no-new-privileges:true'],
      Devices: [], GroupAdd: [], PidMode: '', IpcMode: 'private', PortBindings: {},
      Tmpfs: { '/tmp': spec.tmpfs[0].slice('/tmp:'.length) },
      NetworkMode: phase === 'transfer' ? 'none' : `${project}_search_admin_db`,
      Mounts: spec.volumes.map(item => ({ Type: item.type,
        Source: item.type === 'bind' ? item.source : c.volumes[item.source].name,
        Target: item.target, ReadOnly: !!item.read_only,
        ...item.type === 'bind' ? { BindOptions: { CreateMountpoint: false } } :
          { VolumeOptions: { NoCopy: true } } })) },
    NetworkSettings: { Ports: {}, Networks: networks },
    Mounts: spec.volumes.map(item => ({ Type: item.type, Destination: item.target,
      Source: item.type === 'bind' ? item.source : c.volumes[item.source].name,
      Name: item.type === 'volume' ? c.volumes[item.source].name : undefined,
      RW: !item.read_only })),
    State: { Status: 'exited', ExitCode: 0, StartedAt: '2026-10-27T00:00:01Z',
      FinishedAt: '2026-10-27T00:00:02Z', Running: false, OOMKilled: false,
      Dead: false, Error: '' } };
  if (mutation === 'missing-nocopy' && phase === 'inspect')
    result.HostConfig.Mounts[1].VolumeOptions.NoCopy = false;
  if (mutation === 'extra-cap' && phase === 'transfer') result.HostConfig.CapAdd.push('CAP_SYS_ADMIN');
  if (mutation === 'wrong-network' && phase === 'inspect')
    result.NetworkSettings.Networks.extra = { NetworkID: '9'.repeat(64) };
  if (mutation === 'extra-mount' && phase === 'inspect')
    result.Mounts.push({ Type: 'bind', Destination: '/tmp', Source: '/tmp/other', RW: true });
  return result;
}
function fixture(fault, intent = false) {
  const services = intent ? intentService : service;
  const ids = intent ? { transfer: containerIds.transfer, prepare: containerIds.inspect } : containerIds;
  const calls = [], scopes = [], seen = new Set();
  let created = false, removed = false, ownerCalls = 0, configCalls = 0, volumeInspects = 0;
  const reply = stdout => ({ code: 0, signal: null, stdout, stderr: '' });
  const command = async (args, env) => {
    const line = args.join(' ');
    calls.push(line);
    if (args[0] === 'compose') {
      const isRun = line.includes(' run --detach --no-deps --pull never ');
      scopes.push({ isRun, ignore: env.COMPOSE_IGNORE_ORPHANS });
      assert.equal(env.COMPOSE_IGNORE_ORPHANS, isRun ? 'true' : undefined);
    }
    if (line.includes(' config --format json ')) {
      configCalls++;
      const value = config(intent);
      if (fault === 'config-drift' && configCalls > 1)
        value.services['search-create-boundary'].command.push('--unsafe');
      return reply(`${JSON.stringify(value)}\n`);
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      const name = args[2].replace(`${project}_`, '');
      const response = reply(`${JSON.stringify([{ Id: networkIds[name], Name: name === 'none' ? 'none' : args[2],
        Internal: name !== 'none', Labels: { 'com.docker.compose.project': project,
          'com.docker.compose.network': name } }])}\n`);
      if (fault === 'network-stderr') response.stderr = 'secret injected output';
      return response;
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const phase = Object.keys(services).find(key => args[2] === `${project}-${services[key]}`);
      return reply(`${JSON.stringify([{ Id: phase === 'prepare' ? imageIds.inspect : imageIds[phase], Config: {
        Cmd: ['node', 'apps/server/dist/main.js'], Entrypoint: ['docker-entrypoint.sh'],
        Env: ['NODE_VERSION=22.23.2'] } }])}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const item = volume(args[2]);
      if (args[2] === volumeName) volumeInspects++;
      if (fault === 'volume-replaced' && args[2] === volumeName && volumeInspects > 1)
        item.CreatedAt = 'changed';
      return reply(`${JSON.stringify([item])}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'ls')
      return reply(created && !removed ? `${volumeName}\n` : '');
    if (args[0] === 'volume' && args[1] === 'create') { created = true; return reply(`${volumeName}\n`); }
    if (line.includes(' run --detach --no-deps --pull never ')) {
      const phase = Object.keys(services).find(key => services[key] === args.at(-1));
      seen.add(phase);
      if (fault === `lost-${phase}`) throw Error('secret injected output');
      return reply(`${ids[phase]}\n`);
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const phase = Object.keys(ids).find(key => ids[key] === args[2]);
      return reply(`${JSON.stringify([container(phase, fault, intent)])}\n`);
    }
    if (args[0] === 'container' && args[1] === 'wait') return reply('0\n');
    if (args[0] === 'container' && args[1] === 'logs') {
      const phase = Object.keys(ids).find(key => ids[key] === args[2]);
      return reply(phase === 'transfer' ? 'Private create boundary transfer completed.\n' :
        intent ? `${canonicalAttestorValue({ adminPublic: { caSha256: 'a'.repeat(64),
          adminSha256: 'b'.repeat(64) }, projection: { version: 1 } }).bytes.toString('utf8')}\n` :
          'Private create boundary evidence completed.\n');
    }
    if (args[0] === 'ps') {
      if (fault === 'cleanup-enumeration-stderr' && seen.size === 2)
        return { ...reply(''), stderr: 'secret injected output' };
      const filter = args.find(x => x.startsWith('label=com.docker.compose.service='));
      if (filter) {
        const phase = Object.keys(services).find(key => filter.endsWith(services[key]));
        if (removed || !seen.has(phase)) return reply('');
        return reply(fault === 'extra-stopped' && phase === (intent ? 'prepare' : 'inspect') ?
          `${ids[phase]}\n${'c'.repeat(64)}\n` : `${ids[phase]}\n`);
      }
      return reply(fault === 'extra-reference' ?
        `${ids.transfer}\n${ids[intent ? 'prepare' : 'inspect']}\n${'c'.repeat(64)}\n` :
        removed ? '' : `${ids.transfer}\n${ids[intent ? 'prepare' : 'inspect']}\n`);
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      if (args[2] === ids.transfer) removed = true;
      return reply(`${args[2]}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'rm') { removed = true; return reply(`${volumeName}\n`); }
    throw Error('unexpected command');
  };
  const adapter = (intent ? createIntentPrepareDockerAdapter : createBoundaryDockerAdapter)({ repository, uid, gid, jobLock: {},
    invocationId: id, deadline: Number.MAX_SAFE_INTEGER, tick: () => {} }, {
    command, ownerFactory: async () => ({
      identity: async () => identity,
      containerId: async () => (++ownerCalls > 1 && fault === 'postgres-replaced' ?
        'f' : 'e').repeat(64),
      adminNetwork: async () => ({ id: networkIds.search_admin_db, ip: '172.30.0.2' }) }),
    verifyCredentials: async () => true, credentialCapture: async () => credential(),
  });
  const run = async () => {
    await adapter.verifyOwner();
    const owner = await adapter.captureOwner();
    await adapter.recheckOwner(owner);
    await adapter.preflight({ invocationRoot, volumeName });
    await adapter.volumeAbsent(volumeName);
    const made = await adapter.createVolume(volumeName);
    await adapter.checkVolume(made);
    const transfer = await adapter.runPhase('transfer');
    const second = await adapter.runPhase(intent ? 'prepare' : 'inspect');
    await adapter.cleanupRemote([transfer, second], made);
  };
  return { run, calls, scopes };
}

test('fixed Docker path accepts exact two phases and internal orphan suppression only on run', async () => {
  const item = fixture(); await item.run();
  assert.equal(item.calls.filter(x => x.includes(' run --detach ')).length, 2);
  assert.equal(item.calls.filter(x => x.startsWith('volume create ')).length, 1);
  assert.deepEqual(item.scopes.filter(x => x.isRun), [
    { isRun: true, ignore: 'true' }, { isRun: true, ignore: 'true' }]);
});

test('wrong resource, command or identity never passes', async () => {
  for (const fault of ['config-drift', 'volume-replaced', 'missing-nocopy', 'extra-cap',
    'wrong-network', 'extra-mount', 'postgres-replaced', 'lost-transfer',
    'lost-inspect', 'extra-reference', 'extra-stopped', 'network-stderr',
    'cleanup-enumeration-stderr'])
    await assert.rejects(fixture(fault).run(), { message: 'Private create boundary owner operation failed.' }, fault);
});

test('fixed intent adapter reuses exact two-phase policy and canonical public output only', async () => {
  const item = fixture(undefined, true);
  await item.run();
  assert.equal(item.calls.filter(x => x.includes(' run --detach ')).length, 2);
  assert.equal(item.calls.some(x => x.includes('search-create-intent-prepare')), true);
  for (const fault of ['network-stderr', 'lost-prepare', 'cleanup-enumeration-stderr'])
    await assert.rejects(fixture(fault, true).run(),
      { message: 'Private create boundary owner operation failed.' }, fault);
});

test('ancillary stderr fails before send or cleanup instead of becoming success', async () => {
  const early = fixture('network-stderr');
  await assert.rejects(early.run());
  assert.equal(early.calls.some(x => x.includes(' run --detach ')), false);
  const late = fixture('cleanup-enumeration-stderr');
  await assert.rejects(late.run());
  assert.equal(late.calls.some(x => x.startsWith('volume rm ')), false);
});

test('caller Compose and Docker overrides remain rejected', () => {
  for (const key of ['COMPOSE_IGNORE_ORPHANS', 'DOCKER_HOST', 'PGHOST',
    'STATION_CREATE_VOLUME_NAME']) {
    const previous = process.env[key]; process.env[key] = 'injected';
    try { assert.throws(() => fixture()); }
    finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  }
});
