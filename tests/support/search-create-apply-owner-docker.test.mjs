import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { createApplyDockerAdapter, createWriterRolePrepareDockerAdapter } from
  '../../scripts/search-create-boundary-owner-docker.mjs';

const repository = path.resolve('.'), uid = process.getuid(), gid = process.getgid();
const project = 'create_fixture', id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const publicRoot = path.join(repository, '.cache/search-create-apply-public', id);
const volumeName = `${project}_search_create_apply_${id.replaceAll('-', '')}`;
const writerVolumeName = `${project}_search_writer_prepare_${id.replaceAll('-', '')}`;
const invocationRoot = path.join(repository, '.cache/search-writer-role-invocations', id);
const applyServices = { transfer: 'search-create-apply-transfer', create: 'search-create-index' };
const writerServices = { transfer: 'search-writer-role-prepare-transfer',
  prepare: 'search-writer-role-prepare' };
const ids = { transfer: 'a'.repeat(64), create: 'b'.repeat(64), prepare: 'b'.repeat(64) };
const images = { transfer: `sha256:${'1'.repeat(64)}`,
  create: `sha256:${'2'.repeat(64)}`, prepare: `sha256:${'2'.repeat(64)}` };
const networks = { search_admin_db: '3'.repeat(64), search_internal: '4'.repeat(64),
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
function config(writer = false) {
  const services = writer ? writerServices : applyServices;
  const activeVolumeName = writer ? writerVolumeName : volumeName;
  const inputVolume = writer ? 'search_writer_role_prepare_input' : 'search_create_apply_input';
  const inputTarget = writer ? '/run/search-writer-role-prepare' : '/run/search-create-apply';
  const prefix = writer ? '/run/writer-prepare' : '/run/create-apply';
  const consumer = writer ? 'prepare' : 'create';
  const common = (command, user, transfer) => ({
    profiles: [writer ? 'search-writer-role-prepare' : 'search-create-apply'],
    build: { context: repository, target: 'search-attestor' },
    command: ['node', `scripts/${command}.mjs`], user, read_only: true,
    tmpfs: [transfer ? '/tmp:rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0700' :
      '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700'],
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    pids_limit: transfer ? 64 : 128,
    mem_limit: String(transfer ? 268435456 : 536870912), cpus: transfer ? 0.5 : 1,
    restart: 'no', ...(transfer ? { network_mode: 'none', cap_add: ['CHOWN', 'DAC_OVERRIDE'] } :
      { networks: { search_admin_db: null, search_internal: null } }) });
  return { name: project, services: {
    [services.transfer]: { ...common(services.transfer, '0:0', true), volumes: [
      bind(path.join(repository, '.cache/search-db/initial-v1/transition.password'),
        `${prefix}-password/password`),
      bind(path.join(repository, '.cache/search-create-intent/pending.json'),
        writer ? `${prefix}-intent/create-intent.json` : `${prefix}-intent/intent.json`),
      bind(path.join(repository, '.cache/search-create-apply/binding.json'),
        writer ? `${prefix}-binding/create-binding.json` : `${prefix}-binding/binding.json`),
      ...(writer ? [bind(path.join(invocationRoot, 'invocation.json'),
        `${prefix}-invocation/invocation.json`)] : []),
      bind(publicRoot, `${prefix}-public`),
      mount(inputVolume, inputTarget, false)] },
    [services[consumer]]: { ...common(writer ? services.prepare :
      'search-create-apply-consumer', '1000:1000', false),
      volumes: [mount(inputVolume, inputTarget),
        mount('search_admin_certs', '/run/station-admin'),
        mount('search_security_state', '/run/station-state')] },
  }, networks: {
    search_admin_db: { name: `${project}_search_admin_db`, internal: true },
    search_internal: { name: `${project}_search_internal`, internal: true },
  }, volumes: { [inputVolume]: { name: activeVolumeName, external: true },
    search_admin_certs: { name: `${project}_search_admin_certs` },
    search_security_state: { name: `${project}_search_security_state` } } };
}
const volume = (name, activeVolumeName = volumeName) => ({ Name: name, Driver: 'local', Scope: 'local',
  CreatedAt: '2026-10-27T00:00:00Z', Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  Options: null, Labels: name === activeVolumeName ?
    { 'station.create.project': project, 'station.create.invocation': id } :
    { 'com.docker.compose.project': project,
      'com.docker.compose.volume': name.replace(`${project}_`, '') } });
function container(phase, fault, writer = false) {
  const services = writer ? writerServices : applyServices;
  const spec = config(writer).services[services[phase]], cfg = config(writer);
  const connected = phase === 'transfer' ? { none: { NetworkID: networks.none } } :
    Object.fromEntries(['search_admin_db', 'search_internal'].map(name =>
      [name, { NetworkID: networks[name] }]));
  const item = { Id: ids[phase], Image: images[phase], Created: '2026-10-27T00:00:00Z',
    RestartCount: 0,
    Config: { User: phase === 'transfer' ? '0:0' : '1000:1000', Cmd: spec.command,
      Entrypoint: ['docker-entrypoint.sh'], Env: ['NODE_VERSION=22.23.2'],
      Labels: { 'com.docker.compose.project': project,
        'com.docker.compose.service': services[phase] } },
    HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'],
      CapAdd: phase === 'transfer' ? ['CAP_CHOWN', 'CAP_DAC_OVERRIDE'] : [],
      PidsLimit: spec.pids_limit, Memory: Number(spec.mem_limit), NanoCpus: spec.cpus * 1e9,
      RestartPolicy: { Name: 'no' }, SecurityOpt: ['no-new-privileges:true'],
      Devices: [], GroupAdd: [], PidMode: '', IpcMode: 'private', PortBindings: {},
      Tmpfs: { '/tmp': spec.tmpfs[0].slice('/tmp:'.length) },
      NetworkMode: phase === 'transfer' ? 'none' : `${project}_search_admin_db`,
      Mounts: spec.volumes.map(value => ({ Type: value.type,
        Source: value.type === 'bind' ? value.source : cfg.volumes[value.source].name,
        Target: value.target, ReadOnly: !!value.read_only,
        ...(value.type === 'bind' ? { BindOptions: { CreateMountpoint: false } } :
          { VolumeOptions: { NoCopy: true } }) })) },
    NetworkSettings: { Ports: {}, Networks: connected },
    Mounts: spec.volumes.map(value => ({ Type: value.type, Destination: value.target,
      Source: value.type === 'bind' ? value.source : cfg.volumes[value.source].name,
      Name: value.type === 'volume' ? cfg.volumes[value.source].name : undefined,
      RW: !value.read_only })),
    State: { Status: 'exited', ExitCode: 0, StartedAt: '2026-10-27T00:00:01Z',
      FinishedAt: '2026-10-27T00:00:02Z', Running: false, OOMKilled: false,
      Dead: false, Error: '' } };
  if (fault === 'extra-cap') item.HostConfig.CapAdd.push('CAP_SYS_ADMIN');
  if (fault === 'wrong-network' && phase !== 'transfer')
    item.NetworkSettings.Networks.default = { NetworkID: '9'.repeat(64) };
  if (fault === 'missing-nocopy' && phase !== 'transfer')
    item.HostConfig.Mounts[0].VolumeOptions.NoCopy = false;
  if (fault === 'extra-mount' && phase !== 'transfer')
    item.Mounts.push({ Type: 'bind', Destination: '/tmp/extra', Source: '/tmp/extra', RW: true });
  return item;
}
function rig(fault, writer = false) {
  const services = writer ? writerServices : applyServices;
  const activeVolumeName = writer ? writerVolumeName : volumeName;
  const activeConsumer = writer ? 'prepare' : 'create';
  const calls = [], seen = new Set(), waitTimeouts = [];
  let created = false, removed = false, ownerCalls = 0, volumeInspects = 0;
  const reply = stdout => ({ code: 0, signal: null, stdout, stderr: '' });
  const command = async (args, env, timeoutMs) => {
    const line = args.join(' '); calls.push(line);
    if (args[0] === 'compose') {
      assert.equal(line.includes(writer ? 'compose.search-writer-role-prepare.yaml' :
        'compose.search-create-apply.yaml'), true);
      assert.equal(env[writer ? 'STATION_WRITER_PREPARE_PUBLIC_ROOT' :
        'STATION_CREATE_APPLY_PUBLIC_ROOT'], publicRoot);
      assert.equal(env[writer ? 'STATION_WRITER_PREPARE_VOLUME_NAME' :
        'STATION_CREATE_APPLY_VOLUME_NAME'], activeVolumeName);
      if (writer) assert.equal(env.STATION_WRITER_PREPARE_INVOCATION_ROOT, invocationRoot);
      assert.equal(env.COMPOSE_IGNORE_ORPHANS,
        line.includes(' run --detach --no-deps --pull never ') ? 'true' : undefined);
    }
    if (line.includes(' config --format json ')) {
      const value = config(writer);
      if (fault === 'config-drift' && seen.size) value.services[services[activeConsumer]].command.push('retry');
      return reply(`${JSON.stringify(value)}\n`);
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      const name = args[2].replace(`${project}_`, '');
      const id = fault === 'network-replaced' && seen.size ? 'f'.repeat(64) : networks[name];
      return reply(`${JSON.stringify([{ Id: id, Name: name === 'none' ? 'none' : args[2],
        Internal: name !== 'none', Labels: { 'com.docker.compose.project': project,
          'com.docker.compose.network': name } }])}\n`);
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const phase = Object.keys(services).find(key => args[2] === `${project}-${services[key]}`);
      return reply(`${JSON.stringify([{ Id: images[phase], Config: {
        Cmd: ['node', 'apps/server/dist/main.js'], Entrypoint: ['docker-entrypoint.sh'],
        Env: ['NODE_VERSION=22.23.2'] } }])}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const item = volume(args[2], activeVolumeName);
      if (args[2] === activeVolumeName) volumeInspects++;
      if (fault === 'volume-replaced' && args[2] === activeVolumeName && volumeInspects > 1)
        item.CreatedAt = 'changed';
      return reply(`${JSON.stringify([item])}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'ls')
      return reply(created && !removed ? `${activeVolumeName}\n` : '');
    if (args[0] === 'volume' && args[1] === 'create') { created = true; return reply(`${activeVolumeName}\n`); }
    if (line.includes(' run --detach --no-deps --pull never ')) {
      const phase = Object.keys(services).find(key => services[key] === args.at(-1));
      seen.add(phase);
      if (fault === `lost-${phase}`) throw Error('lost command response');
      return reply(`${ids[phase]}\n`);
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const phase = Object.keys(services).find(key => ids[key] === args[2]);
      return reply(`${JSON.stringify([container(phase, fault, writer)])}\n`);
    }
    if (args[0] === 'container' && args[1] === 'wait') {
      waitTimeouts.push(timeoutMs);
      return reply('0\n');
    }
    if (args[0] === 'container' && args[1] === 'logs') {
      const phase = Object.keys(services).find(key => ids[key] === args[2]);
      return reply(phase === 'transfer' ? writer ?
        'Private writer role preparation transfer completed.\n' :
        'Private create apply transfer completed.\n' :
        fault === 'false-create-log' ? 'Private create apply failed.\n' :
          writer ? '{"fixture":"canonical-output"}\n' :
            'Private create apply reached uuid_bound; search remains disabled.\n');
    }
    if (args[0] === 'ps') {
      const serviceFilter = args.find(value => value.startsWith('label=com.docker.compose.service='));
      if (serviceFilter) {
        const phase = Object.keys(services).find(key => serviceFilter.endsWith(services[key]));
        if (removed || !seen.has(phase)) return reply('');
        return reply(fault === 'extra-stopped' && phase === activeConsumer ?
          `${ids[phase]}\n${'c'.repeat(64)}\n` : `${ids[phase]}\n`);
      }
      return reply(fault === 'extra-reference' ?
        `${ids.transfer}\n${ids[activeConsumer]}\n${'c'.repeat(64)}\n` :
        removed ? '' : `${ids.transfer}\n${ids[activeConsumer]}\n`);
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      if (args[2] === ids.transfer) removed = true;
      return reply(`${args[2]}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'rm') { removed = true; return reply(`${activeVolumeName}\n`); }
    throw Error('unexpected command');
  };
  const adapter = (writer ? createWriterRolePrepareDockerAdapter : createApplyDockerAdapter)({ repository, uid, gid, jobLock: {},
    invocationId: id, deadline: Number.MAX_SAFE_INTEGER, tick: () => {} }, {
    command, ownerFactory: async () => ({
      identity: async () => identity,
      containerId: async () => (++ownerCalls > 1 && fault === 'postgres-replaced' ?
        'f' : 'e').repeat(64),
      adminNetwork: async () => ({ id: networks.search_admin_db, ip: '172.30.0.2' }) }),
    verifyCredentials: async () => true, credentialCapture: async () => credential(),
  });
  const run = async () => {
    await adapter.verifyOwner();
    const owner = await adapter.captureOwner();
    await adapter.recheckOwner(owner);
    await adapter.preflight({ publicRoot, volumeName: activeVolumeName,
      ...(writer ? { invocationRoot } : {}) });
    await adapter.volumeAbsent(activeVolumeName);
    const volumeItem = await adapter.createVolume(activeVolumeName);
    await adapter.checkVolume(volumeItem);
    const transfer = await adapter.runPhase('transfer');
    const createdItem = await adapter.runPhase(activeConsumer);
    if (writer) assert.equal(createdItem.rawOutput, '{"fixture":"canonical-output"}\n');
    await adapter.cleanupRemote([transfer, createdItem], volumeItem);
  };
  return { run, calls, waitTimeouts };
}

test('fixed apply adapter uses only two reviewed services and a 330-second create wait', async () => {
  const item = rig(); await item.run();
  assert.equal(item.calls.filter(line => line.includes(' run --detach ')).length, 2);
  assert.deepEqual(item.waitTimeouts, [80_000, 330_000]);
  assert.equal(item.calls.filter(line => line.startsWith('volume create ')).length, 1);
});

test('ambiguous command, stale infrastructure and effective policy drift never succeed', async () => {
  for (const fault of ['lost-transfer', 'lost-create', 'false-create-log',
    'config-drift', 'network-replaced', 'volume-replaced', 'postgres-replaced',
    'extra-cap', 'wrong-network', 'missing-nocopy', 'extra-mount',
    'extra-reference', 'extra-stopped'])
    await assert.rejects(rig(fault).run(), fault);
});

test('Docker and caller Compose overrides are denied before any dispatch', () => {
  for (const key of ['COMPOSE_IGNORE_ORPHANS', 'DOCKER_HOST', 'PGHOST',
    'STATION_CREATE_APPLY_VOLUME_NAME']) {
    const original = process.env[key]; process.env[key] = 'injected';
    try { assert.throws(() => rig()); }
    finally { if (original === undefined) delete process.env[key];
      else process.env[key] = original; }
  }
});

test('fixed writer preparation adapter keeps checked read output and cleans only its original resources', async () => {
  const item = rig(undefined, true); await item.run();
  assert.equal(item.calls.filter(line => line.includes(' run --detach ')).length, 2);
  assert.deepEqual(item.waitTimeouts, [80_000, 210_000]);
  assert.equal(item.calls.filter(line => line.startsWith('volume create ')).length, 1);
});

test('writer preparation adapter denies ambiguous command and effective policy drift', async () => {
  for (const fault of ['lost-transfer', 'lost-prepare', 'config-drift', 'network-replaced',
    'volume-replaced', 'postgres-replaced', 'extra-cap', 'wrong-network',
    'missing-nocopy', 'extra-mount', 'extra-reference', 'extra-stopped'])
    await assert.rejects(rig(fault, true).run(), fault);
});
