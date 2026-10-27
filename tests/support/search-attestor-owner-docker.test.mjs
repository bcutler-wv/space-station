/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { createAttestorDockerAdapter } from '../../scripts/search-attestor-owner-docker.mjs';
import { attestorConfig } from './search-attestor-config-fixture.mjs';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const project = 'attestor_fixture';
const repository = path.resolve('.');
const uid = process.getuid(), gid = process.getgid();
const config = attestorConfig({ repository, project, invocationId: id, uid, gid });
const volumeName = config.volumes.search_attestor_input.name;
const service = { prepare: 'search-attestor-prepare', transfer: 'search-attestor-transfer',
  attestor: 'search-engine-attestor' };
const containerIds = { prepare: 'a'.repeat(64), transfer: 'b'.repeat(64), attestor: 'c'.repeat(64) };
const imageIds = { prepare: `sha256:${'1'.repeat(64)}`,
  transfer: `sha256:${'2'.repeat(64)}`, attestor: `sha256:${'3'.repeat(64)}` };
const networkIds = { search_admin_db: '4'.repeat(64), search_internal: '5'.repeat(64), none: '6'.repeat(64) };
const ack = { prepare: 'Private search attestor preparation completed.\n',
  transfer: 'Private search attestor transfer completed.\n',
  attestor: 'Private search attestor verification completed.\n' };
const fakeStat = { dev: 1, ino: 2, uid, gid, mode: 0o100600, size: 43,
  nlink: 1, mtimeMs: 1, ctimeMs: 1 };
const identity = { project, databaseOid: '16384', systemIdentifier: '1234567890123456789',
  service: 'postgres', database: 'station', owner: 'station', uid, gid };
const metadata = Buffer.from(JSON.stringify(identity));
const capturedCredential = () => ({ rootStat: fakeStat,
  metadata: { stat: { ...fakeStat, size: metadata.length }, bytes: metadata },
  verifier: { stat: fakeStat, bytes: Buffer.from('x'.repeat(43)) } });
const volume = name => ({ Name: name, Driver: 'local', Scope: 'local', CreatedAt: '2026-10-26T00:00:00Z',
  Mountpoint: `/var/lib/docker/volumes/${name}/_data`, Options: null,
  Labels: name === volumeName ? { 'station.attestor.project': project,
    'station.attestor.invocation': id } : { 'com.docker.compose.project': project,
    'com.docker.compose.volume': name.replace(`${project}_`, '') } });

function container(phase, mutation) {
  const spec = config.services[service[phase]];
  const mounts = spec.volumes.map(mount => ({ Type: mount.type, Destination: mount.target,
    Source: mount.type === 'bind' ? mount.source :
      config.volumes[mount.source].name,
    Name: mount.type === 'volume' ? config.volumes[mount.source].name : undefined,
    RW: !mount.read_only }));
  const networks = phase === 'transfer' ? { none: { NetworkID: networkIds.none } } :
    Object.fromEntries((phase === 'prepare' ? ['search_admin_db'] :
      ['search_admin_db', 'search_internal']).map(name => [name,
      { NetworkID: networkIds[name] }]));
  const result = { Id: containerIds[phase], Image: imageIds[phase],
    Created: '2026-10-26T00:00:00Z', RestartCount: 0,
    Config: { User: phase === 'prepare' ? `${uid}:${gid}` : phase === 'transfer' ? '0:0' : '1000:1000',
      Cmd: spec.command, Entrypoint: ['docker-entrypoint.sh'], Env: ['NODE_VERSION=22.23.2'],
      Labels: { 'com.docker.compose.project': project,
        'com.docker.compose.service': service[phase] } },
    HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'],
      CapAdd: phase === 'transfer' ? ['CAP_CHOWN', 'CAP_DAC_OVERRIDE'] : [],
      PidsLimit: spec.pids_limit, Memory: Number(spec.mem_limit), NanoCpus: spec.cpus * 1e9,
      RestartPolicy: { Name: 'no' }, SecurityOpt: ['no-new-privileges:true'],
      Devices: [], GroupAdd: [], PidMode: '', IpcMode: 'private', PortBindings: {},
      Mounts: spec.volumes.map(mount => ({ Type: mount.type,
        Source: mount.type === 'bind' ? mount.source : config.volumes[mount.source].name,
        Target: mount.target, ReadOnly: !!mount.read_only,
        ...mount.type === 'bind' ? { BindOptions: { CreateMountpoint: false } } :
          { VolumeOptions: mount.volume?.nocopy ? { NoCopy: true } : {} } })),
      Tmpfs: { '/tmp': spec.tmpfs[0].slice('/tmp:'.length) },
      NetworkMode: phase === 'transfer' ? 'none' : `${project}_default` },
    NetworkSettings: { Ports: { '8080/tcp': null }, Networks: networks },
    Mounts: mounts,
    State: { Status: 'exited', ExitCode: 0, StartedAt: '2026-10-26T00:00:01Z',
      FinishedAt: '2026-10-26T00:00:02Z', Running: false, OOMKilled: false,
      Dead: false, Error: '' } };
  if (mutation === 'mount' && phase === 'prepare') result.Mounts[0].Source = '/tmp/other';
  if (mutation === 'nocopy' && phase === 'transfer')
    result.HostConfig.Mounts.find(mount => mount.Target === '/run/search-attestor')
      .VolumeOptions.NoCopy = false;
  if (mutation === 'volume-subpath' && phase === 'transfer')
    result.HostConfig.Mounts.find(mount => mount.Target === '/run/search-attestor')
      .VolumeOptions.Subpath = 'other';
  if (phase === 'transfer' && mutation === 'legacy-capability-spelling')
    result.HostConfig.CapAdd = ['CHOWN', 'DAC_OVERRIDE'];
  if (phase === 'transfer' && mutation === 'missing-capability')
    result.HostConfig.CapAdd = ['CAP_CHOWN'];
  if (phase === 'transfer' && mutation === 'extra-capability')
    result.HostConfig.CapAdd.push('CAP_SYS_ADMIN');
  if (phase === 'transfer' && mutation === 'duplicate-capability')
    result.HostConfig.CapAdd = ['CAP_CHOWN', 'CHOWN'];
  if (phase === 'transfer' && mutation === 'wrong-capability')
    result.HostConfig.CapAdd = ['CAP_CHOWN', 'CAP_DAC_READ_SEARCH'];
  if (phase === 'prepare' && mutation === 'extra-prepare-capability')
    result.HostConfig.CapAdd = ['CAP_CHOWN'];
  if (mutation === 'create-mountpoint' && phase === 'prepare')
    result.HostConfig.Mounts[0].BindOptions.CreateMountpoint = true;
  if (mutation === 'bind-propagation' && phase === 'prepare')
    result.HostConfig.Mounts[0].BindOptions.Propagation = 'rshared';
  if (mutation === 'bind-nonrecursive' && phase === 'prepare')
    result.HostConfig.Mounts[0].BindOptions.NonRecursive = true;
  if (mutation === 'extra-host-mount' && phase === 'prepare')
    result.HostConfig.Mounts.push({ Type: 'bind', Source: '/tmp/other', Target: '/run/extra' });
  if (phase === 'prepare' && mutation === 'bind-tmp') {
    result.HostConfig.Mounts.push({ Type: 'bind', Source: '/tmp/other', Target: '/tmp' });
    result.Mounts.push({ Type: 'bind', Source: '/tmp/other', Destination: '/tmp', RW: true });
  }
  if (phase === 'prepare' && mutation === 'duplicate-inspect-mount')
    result.Mounts.push({ ...result.Mounts[0] });
  if (phase === 'prepare' && mutation === 'fabricated-tmpfs-inspect-mount')
    result.Mounts.push({ Type: 'tmpfs', Destination: '/tmp', RW: true });
  if (phase === 'prepare' && mutation === 'missing-tmpfs') delete result.HostConfig.Tmpfs['/tmp'];
  if (phase === 'prepare' && mutation === 'extra-tmpfs') result.HostConfig.Tmpfs['/other'] = 'rw';
  if (phase === 'prepare' && mutation === 'wrong-tmpfs-options')
    result.HostConfig.Tmpfs['/tmp'] = 'rw,exec,nosuid,size=8m';
  if (mutation === 'extra-binds' && phase === 'prepare')
    result.HostConfig.Binds = ['/tmp/other:/run/extra:rw'];
  if (mutation === 'safe-defaults') for (const hostMount of result.HostConfig.Mounts) {
    if (hostMount.Type === 'bind') hostMount.BindOptions = null;
    if (hostMount.Type === 'volume' && hostMount.VolumeOptions?.NoCopy !== true)
      hostMount.VolumeOptions = null;
    if (hostMount.ReadOnly === false) delete hostMount.ReadOnly;
  }
  if (mutation === 'network' && phase === 'prepare')
    result.NetworkSettings.Networks.default = { NetworkID: '7'.repeat(64) };
  if (mutation === 'terminal' && phase === 'prepare') result.State.OOMKilled = true;
  return result;
}

function fixture(fault) {
  const calls = [], seen = new Set();
  let created = false, removed = false, invocationVolumeInspects = 0;
  let ownerCalls = 0, configCalls = 0;
  const reply = stdout => ({ code: 0, signal: null, stdout, stderr: '' });
  const command = async args => {
    calls.push(args.join(' '));
    const joined = args.join(' ');
    if (joined.includes(' config --format json ')) {
      configCalls++;
      const rendered = structuredClone(config);
      if (fault === 'config-drift' && configCalls > 1)
        rendered.services['search-attestor-prepare'].command.push('--unsafe');
      if (fault === 'config-default-drift' && configCalls > 1)
        rendered.services['search-attestor-prepare'].entrypoint = null;
      return reply(`${JSON.stringify(rendered)}\n`);
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      const name = args[2].replace(`${project}_`, '');
      return reply(`${JSON.stringify([{ Id: networkIds[name], Name: name === 'none' ? 'none' : args[2],
        Internal: name !== 'none', Labels: { 'com.docker.compose.project': project,
          'com.docker.compose.network': name } }])}\n`);
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const phase = Object.keys(service).find(key => args[2] === `${project}-${service[key]}`);
      const image = { Id: fault === 'image' && phase === 'prepare' ? `sha256:${'9'.repeat(64)}` :
        imageIds[phase], Config: { Cmd: ['node', 'apps/server/dist/main.js'],
        Entrypoint: ['docker-entrypoint.sh'], Env: ['NODE_VERSION=22.23.2'] } };
      return reply(`${JSON.stringify([image])}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const value = volume(args[2]);
      if (args[2] === volumeName) invocationVolumeInspects++;
      if (fault === 'volume' && args[2] === volumeName &&
          invocationVolumeInspects > 1) value.CreatedAt = 'changed';
      return reply(`${JSON.stringify([value])}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'ls') return reply(created && !removed ? `${volumeName}\n` : '');
    if (args[0] === 'volume' && args[1] === 'create') {
      created = true;
      if (fault === 'lost-volume-create') throw Error('lost response');
      return reply(`${volumeName}\n`);
    }
    if (joined.includes(' run --detach --no-deps --pull never ')) {
      const phase = Object.keys(service).find(key => args.at(-1) === service[key]);
      seen.add(phase);
      if (fault === `lost-${phase}`) throw Error('lost response');
      return reply(`${containerIds[phase]}\n`);
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const phase = Object.keys(containerIds).find(key => args[2] === containerIds[key]);
      return reply(`${JSON.stringify([container(phase, fault)])}\n`);
    }
    if (args[0] === 'container' && args[1] === 'wait') return reply('0\n');
    if (args[0] === 'container' && args[1] === 'logs') {
      const phase = Object.keys(containerIds).find(key => args[2] === containerIds[key]);
      return reply(fault === 'logs' && phase === 'prepare' ? 'wrong\n' : ack[phase]);
    }
    if (args[0] === 'ps') return reply(fault === 'references' ?
      `${containerIds.transfer}\n${containerIds.attestor}\n${'d'.repeat(64)}\n` :
      removed ? '' : `${containerIds.transfer}\n${containerIds.attestor}\n`);
    if (args[0] === 'container' && args[1] === 'rm') {
      if (args[2] === containerIds.prepare) removed = true;
      return reply(`${args[2]}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'rm') { removed = true; return reply(`${volumeName}\n`); }
    throw Error(`Unexpected scripted command: ${joined}`);
  };
  const adapter = createAttestorDockerAdapter({ repository, uid, gid, jobLock: {},
    invocationId: id, deadline: Number.MAX_SAFE_INTEGER, tick: () => {} },
  { command, ownerFactory: async () => ({ containerId: async () =>
    ((fault === 'container-id' && ++ownerCalls > 1) ? 'f' : 'e').repeat(64),
    identity: async () => identity,
    adminNetwork: async () => ({ id: networkIds.search_admin_db, ip: '172.30.0.2' }) }),
    verifyCredentials: async () => true, credentialCapture: async () => capturedCredential() });
  const run = async () => {
    await adapter.verifyOwner();
    const owner = await adapter.captureOwner();
    await adapter.recheckOwner(owner);
    await adapter.preflight({ invocationRoot: path.join(repository,
      '.cache/search-attestor-invocations', id), publicRoot: path.join(repository,
      '.cache/search-attestor-public', id), volumeName });
    await adapter.volumeAbsent(volumeName);
    const made = await adapter.createVolume(volumeName);
    await adapter.checkVolume(made);
    const prepare = await adapter.runPhase('prepare');
    const transfer = await adapter.runPhase('transfer');
    const final = await adapter.runPhase('attestor');
    await adapter.cleanupRemote([prepare, transfer, final], made);
  };
  return { run, calls, seen };
}

test('scripted Docker evidence accepts only exact fixed phases and captured cleanup', async () => {
  const item = fixture();
  await item.run();
  assert.deepEqual([...item.seen], ['prepare', 'transfer', 'attestor']);
  assert.equal(item.calls.filter(x => x.includes(' volume create ')).length, 0);
  assert.equal(item.calls.filter(x => x.startsWith('volume create ')).length, 1);
  assert.equal(item.calls.filter(x => x.includes(' run --detach ')).length, 3);
});

test('documented safe Docker mount defaults remain accepted', async () => {
  await fixture('safe-defaults').run();
});

test('only the exact transfer capability set accepts canonical and Compose spellings', async () => {
  await fixture('legacy-capability-spelling').run();
  for (const fault of ['missing-capability', 'extra-capability',
    'duplicate-capability', 'wrong-capability', 'extra-prepare-capability']) {
    await assert.rejects(fixture(fault).run(), undefined, fault);
  }
});

test('scripted Docker evidence rejects changed image, mount, network, terminal, logs, volume and references', async () => {
  for (const fault of ['container-id', 'config-drift', 'config-default-drift',
    'image', 'mount', 'nocopy', 'volume-subpath', 'create-mountpoint',
    'bind-propagation', 'bind-nonrecursive', 'extra-host-mount', 'extra-binds',
    'bind-tmp', 'duplicate-inspect-mount', 'fabricated-tmpfs-inspect-mount',
    'missing-tmpfs', 'extra-tmpfs', 'wrong-tmpfs-options',
    'network', 'terminal', 'logs', 'volume',
    'references', 'lost-volume-create', 'lost-prepare']) {
    const item = fixture(fault);
    await assert.rejects(item.run(), undefined, fault);
    assert.ok(item.calls.filter(x => x.startsWith('volume create ')).length <= 1, fault);
    assert.ok(item.calls.filter(x => x.includes(' run --detach ')).length <= 3, fault);
  }
});
