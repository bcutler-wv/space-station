import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { createWriterMappingPrepareDockerAdapter } from
  '../../scripts/search-create-boundary-owner-docker.mjs';

const repository = path.resolve(process.argv[2]);
const parts = [];
for await (const chunk of process.stdin) parts.push(chunk);
const config = JSON.parse(Buffer.concat(parts).toString('utf8'));
const project = 'writer_mapping_fixture';
const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const suffix = invocationId.replaceAll('-', '');
const services = { transfer: 'search-writer-mapping-prepare-transfer',
  prepare: 'search-writer-mapping-prepare' };
const names = { transfer: `station_mapping_prepare_transfer_${suffix}`,
  prepare: `station_mapping_prepare_read_${suffix}` };
const ids = { transfer: 'a'.repeat(64), prepare: 'b'.repeat(64) };
const images = { transfer: `sha256:${'1'.repeat(64)}`,
  prepare: `sha256:${'2'.repeat(64)}` };
const networks = { search_admin_db: '3'.repeat(64), search_internal: '4'.repeat(64),
  none: '5'.repeat(64) };
const volumeName = `${project}_search_writer_mapping_prepare_${suffix}`;
const createdAt = '2026-11-04T00:00:00Z';
const startedAt = '2026-11-04T00:00:01Z';
const finishedAt = '2026-11-04T00:00:02Z';
const zero = '0001-01-01T00:00:00Z';
const reply = (stdout = '', stderr = '') => ({ code: 0, signal: null, stdout, stderr });
for (const key of Object.keys(process.env))
  if (key.startsWith('STATION_WRITER_MAPPING_PREPARE_')) delete process.env[key];
for (const key of ['STATION_WRITER_MAPPING_PREPARE_READ_NAME', 'COMPOSE_PROJECT_NAME',
  'DOCKER_HOST']) {
  process.env[key] = 'foreign';
  assert.throws(() => createWriterMappingPrepareDockerAdapter({ repository,
    uid: process.getuid(), gid: process.getgid(), jobLock: {}, invocationId,
    deadline: Number.MAX_SAFE_INTEGER, tick: () => {} }, { command: () => {
    throw Error('unexpected Docker I/O');
  } }));
  delete process.env[key];
}

function inspectItem(phase, state, fault, afterWait = false) {
  const service = services[phase], spec = config.services[service];
  const transfer = phase === 'transfer', created = state === 'created';
  const mount = row => ({ Type: row.type, Destination: row.target,
    Source: row.type === 'bind' ? row.source : config.volumes[row.source].name,
    Name: row.type === 'volume' ? config.volumes[row.source].name : undefined,
    RW: !row.read_only });
  const networksMap = created ? transfer ? { none: {} } : {
    [`${project}_search_admin_db`]: {}, [`${project}_search_internal`]: {} } :
    transfer ? { none: { NetworkID: networks.none } } : {
      [`${project}_search_admin_db`]: { NetworkID: networks.search_admin_db },
      [`${project}_search_internal`]: { NetworkID: networks.search_internal } };
  const item = { Id: ids[phase], Name: `/${names[phase]}`, Image: images[phase],
    Created: createdAt, RestartCount: 0,
    Config: { User: spec.user, Cmd: spec.command,
      Entrypoint: ['docker-entrypoint.sh'], Env: ['NODE_VERSION=22.23.2'],
      Labels: { 'com.docker.compose.project': project,
        'com.docker.compose.service': service } },
    HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'],
      CapAdd: transfer ? ['CAP_CHOWN', 'CAP_DAC_OVERRIDE'] : [],
      PidsLimit: spec.pids_limit, Memory: Number(spec.mem_limit),
      NanoCpus: spec.cpus * 1e9, RestartPolicy: { Name: 'no' },
      SecurityOpt: ['no-new-privileges:true'], Devices: [], GroupAdd: [],
      PidMode: '', IpcMode: 'private', PortBindings: {},
      Tmpfs: { '/tmp': spec.tmpfs[0].slice('/tmp:'.length) },
      NetworkMode: transfer ? 'none' : `${project}_search_admin_db`,
      Mounts: spec.volumes.map(row => ({ Type: row.type,
        Source: row.type === 'bind' ? row.source : config.volumes[row.source].name,
        Target: row.target, ReadOnly: !!row.read_only,
        ...(row.type === 'bind' ? { BindOptions: { CreateMountpoint: false } } :
          { VolumeOptions: { NoCopy: true } }) })) },
    NetworkSettings: { Ports: {}, Networks: networksMap },
    Mounts: spec.volumes.map(mount),
    State: { Status: state, Running: state === 'running', Paused: false,
      Restarting: false, OOMKilled: false, Dead: false, Error: '', ExitCode: 0,
      StartedAt: created ? zero : startedAt,
      FinishedAt: state === 'exited' ? finishedAt : zero } };
  if (fault === 'created-endpoint' && created && phase === 'prepare')
    item.NetworkSettings.Networks[`${project}_search_admin_db`].EndpointID = 'f'.repeat(64);
  if (fault === 'created-reader-empty' && created && phase === 'prepare')
    item.NetworkSettings.Networks = {};
  if (fault === 'created-name' && created && phase === 'prepare') item.Name = '/foreign';
  if (fault === 'created-command' && created && phase === 'prepare')
    item.Config.Cmd = ['node', 'foreign.mjs'];
  if (fault === 'created-image' && created && phase === 'prepare')
    item.Image = `sha256:${'f'.repeat(64)}`;
  if (fault === 'post-start-identity' && !created) item.Created = 'changed';
  if (fault === 'post-start-name' && !created && phase === 'prepare')
    item.Name = '/foreign';
  if (fault === 'post-start-network' && !created && phase === 'prepare')
    item.NetworkSettings.Networks[`${project}_search_internal`].NetworkID = 'f'.repeat(64);
  if (fault === 'zero-finished-at' && state === 'exited') item.State.FinishedAt = zero;
  if (phase === 'prepare' && afterWait) {
    if (fault === 'started-at-drift') item.State.StartedAt = '2027-11-04T00:00:01Z';
    if (fault === 'fast-finished-drift') item.State.FinishedAt = '2027-11-04T00:00:02Z';
    if (fault === 'terminal-paused') item.State.Paused = true;
    if (fault === 'terminal-restarting') item.State.Restarting = true;
  }
  return item;
}

async function scenario(fault = '') {
  const calls = [], events = [];
  const phaseState = { transfer: 'absent', prepare: 'absent' };
  const waitedPhases = new Set();
  let volumeExists = false, removedVolume = false;
  const uid = process.getuid(), gid = process.getgid();
  const identity = { project, service: 'postgres', database: 'station', databaseOid: '16384',
    systemIdentifier: '123', owner: 'station', uid, gid };
  const stat = { dev: 1, ino: 2, uid, gid, mode: 0o100600, size: 43,
    nlink: 1, mtimeMs: 1, ctimeMs: 1 };
  const metadata = Buffer.from(JSON.stringify(identity));
  const credential = () => ({ rootStat: stat,
    metadata: { stat: { ...stat, size: metadata.length }, bytes: metadata },
    transition: { stat, bytes: Buffer.from('x'.repeat(43)) } });
  const volume = name => ({ Name: name, Driver: 'local', Scope: 'local',
    CreatedAt: createdAt, Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    Options: null, Labels: name === volumeName ?
      { 'station.create.project': project, 'station.create.invocation': invocationId } :
      { 'com.docker.compose.project': project,
        'com.docker.compose.volume': name.replace(`${project}_`, '') } });
  const command = async (args, env, timeoutMs) => {
    calls.push(args.join(' '));
    assert.equal(env.APP_UID, String(uid));
    assert.equal(env.APP_GID, String(gid));
    assert.equal(env.COMPOSE_IGNORE_ORPHANS,
      args[0] === 'compose' && args.includes('create') ? 'true' : undefined);
    if (args[0] === 'compose' && args.includes('config')) {
      assert.equal(env.STATION_WRITER_MAPPING_PREPARE_TRANSFER_NAME, names.transfer);
      assert.equal(env.STATION_WRITER_MAPPING_PREPARE_READ_NAME, names.prepare);
      return reply(`${JSON.stringify(config)}\n`);
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      const name = args[2].replace(`${project}_`, '');
      return reply(`${JSON.stringify([{ Id: networks[name], Name: args[2],
        Internal: name !== 'none', Labels: { 'com.docker.compose.project': project,
          'com.docker.compose.network': name } }])}\n`);
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const phase = Object.keys(services).find(p => args[2] === `${project}-${services[p]}`);
      return reply(`${JSON.stringify([{ Id: images[phase], Config: {
        Cmd: ['node', 'apps/server/dist/main.js'], Entrypoint: ['docker-entrypoint.sh'],
        Env: ['NODE_VERSION=22.23.2'] } }])}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'inspect')
      return reply(`${JSON.stringify([volume(args[2])])}\n`);
    if (args[0] === 'volume' && args[1] === 'ls')
      return reply(volumeExists && !removedVolume ? `${volumeName}\n` : '');
    if (args[0] === 'volume' && args[1] === 'create') {
      volumeExists = true; return reply(`${volumeName}\n`);
    }
    if (args[0] === 'compose' && args.includes('create')) {
      const phase = Object.keys(services).find(p => args.at(-1) === services[p]);
      assert.ok(args.join(' ').includes(' create --no-build --pull never --no-recreate '));
      phaseState[phase] = 'created'; events.push(`${phase}-created`);
      if (fault === 'lost-create') throw Error('lost create response');
      if (fault === 'unknown-create-stderr')
        return reply('', `private warning\n Container ${names[phase]} Created\n`);
      return reply('', ` Container ${names[phase]}  Creating\n` +
        ` Container ${names[phase]}  Created\n`);
    }
    if (args[0] === 'ps') {
      const named = args.find(x => x.startsWith('name=^/'));
      if (named) {
        const phase = Object.keys(services).find(p => named === `name=^/${names[p]}$`);
        if (fault === 'preexisting-name' && phase === 'transfer' &&
            phaseState.transfer === 'absent') return reply(`${'f'.repeat(64)}\n`);
        if (fault === 'extra-name' && phase === 'prepare' &&
            phaseState.prepare === 'created')
          return reply(`${ids.prepare}\n${'f'.repeat(64)}\n`);
        return reply(['absent', 'removed'].includes(phaseState[phase]) ? '' : `${ids[phase]}\n`);
      }
      const service = args.find(x => x.startsWith('label=com.docker.compose.service='));
      if (service) {
        const phase = Object.keys(services).find(p => service.endsWith(services[p]));
        if (fault === 'preexisting-service' && phase === 'transfer' &&
            phaseState.transfer === 'absent') return reply(`${'f'.repeat(64)}\n`);
        if (fault === 'extra-service' && phase === 'prepare' &&
            phaseState.prepare === 'exited') return reply(`${ids.prepare}\n${'f'.repeat(64)}\n`);
        return reply(['absent', 'removed'].includes(phaseState[phase]) ? '' :
          `${ids[phase]}\n`);
      }
      const active = Object.keys(services).filter(p => !['absent', 'removed']
        .includes(phaseState[p]));
      return reply(active.map(p => ids[p]).join('\n') + (active.length ? '\n' : ''));
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const phase = Object.keys(services).find(p => args[2] === ids[p]);
      return reply(`${JSON.stringify([inspectItem(phase, phaseState[phase], fault,
        waitedPhases.has(phase))])}\n`);
    }
    if (args[0] === 'container' && args[1] === 'start') {
      const phase = Object.keys(services).find(p => args[2] === ids[p]);
      phaseState[phase] = ['fast-exited', 'fast-finished-drift'].includes(fault) ?
        'exited' : 'running';
      events.push(`${phase}-started`);
      if (fault === 'lost-start') throw Error('lost start response');
      return reply(`${ids[phase]}\n`);
    }
    if (args[0] === 'container' && args[1] === 'wait') {
      assert.equal(timeoutMs, args[2] === ids.transfer ? 80_000 : 210_000);
      const phase = Object.keys(services).find(p => args[2] === ids[p]);
      phaseState[phase] = 'exited'; waitedPhases.add(phase);
      return reply(fault === 'bad-wait' ? '1\n' : '0\n');
    }
    if (args[0] === 'container' && args[1] === 'logs') {
      const phase = Object.keys(services).find(p => args[2] === ids[p]);
      return reply(phase === 'transfer' ?
        fault === 'bad-transfer-output' ? 'unexpected transfer output\n' :
          'Private writer mapping preparation transfer completed.\n' :
        fault === 'bad-read-output' ? '{"a":1} \n' : '{"a":1}\n');
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      const phase = Object.keys(services).find(p => args[2] === ids[p]);
      phaseState[phase] = 'removed';
      if (fault === 'lost-cleanup') throw Error('lost cleanup response');
      return reply(`${args[2]}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'rm') {
      removedVolume = true; return reply(`${volumeName}\n`);
    }
    throw Error('unexpected fixture command');
  };
  const adapter = createWriterMappingPrepareDockerAdapter({ repository, uid, gid,
    jobLock: {}, invocationId, deadline: Number.MAX_SAFE_INTEGER, tick: () => {} }, {
      command, ownerFactory: async () => ({ identity: async () => identity,
        containerId: async () => 'e'.repeat(64),
        adminNetwork: async () => ({ id: networks.search_admin_db, ip: '172.30.0.2' }) }),
      verifyCredentials: async () => true, credentialCapture: async () => credential() });
  let success = false;
  try {
    await adapter.verifyOwner();
    const owner = await adapter.captureOwner();
    await adapter.recheckOwner(owner);
    await adapter.preflight({ invocationRoot: path.join(repository,
      '.cache/search-writer-mapping-invocations', invocationId),
    publicRoot: path.join(repository, '.cache/search-writer-mapping-prepare-public', invocationId),
    volumeName });
    await adapter.volumeAbsent(volumeName);
    const capturedVolume = await adapter.createVolume(volumeName);
    await adapter.checkVolume(capturedVolume);
    const seen = [];
    const phase = async current => adapter.runPhase(current, async () => {
      seen.push(current); events.push(`${current}-fence`);
      if (fault === 'fence-fail' && current === 'prepare') throw Error('source drift');
    });
    const transfer = await phase('transfer');
    const prepare = await phase('prepare');
    assert.equal(prepare.rawOutput, '{"a":1}\n');
    await adapter.cleanupRemote([transfer, prepare], capturedVolume);
    await adapter.volumeAbsent(volumeName);
    await adapter.recheckOwner(owner); await adapter.recheckInfrastructure();
    success = true;
    assert.deepEqual(events, ['transfer-created', 'transfer-fence', 'transfer-started',
      'prepare-created', 'prepare-fence', 'prepare-started']);
    assert.deepEqual(seen, ['transfer', 'prepare']);
    assert.equal(calls.filter(x => x.includes(' create --no-build ')).length, 2);
    assert.equal(calls.filter(x => x.startsWith('container start ')).length, 2);
    assert.equal(calls.filter(x => x.startsWith('container rm ')).length, 2);
  } catch (error) {
    if (!fault || fault === 'fast-exited') throw error;
  }
  if (!fault || fault === 'fast-exited') assert.equal(success, true);
  else {
    assert.equal(success, false, fault);
    assert.ok(calls.filter(x => x.includes(' create --no-build ')).length <= 2);
    assert.ok(calls.filter(x => x.startsWith('container start ')).length <= 2);
    if (['preexisting-name', 'preexisting-service'].includes(fault)) {
      assert.equal(calls.filter(x => x.includes(' create --no-build ')).length, 0);
      assert.equal(calls.filter(x => x.startsWith('container start ')).length, 0);
    }
    if (fault === 'extra-name') {
      assert.equal(calls.filter(x => x.includes(' create --no-build ')).length, 2);
      assert.equal(calls.filter(x => x.startsWith('container start ')).length, 1);
    }
    if (fault === 'bad-transfer-output') {
      assert.equal(calls.filter(x => x.startsWith('container start ')).length, 1);
      assert.equal(calls.filter(x => x.includes(' create --no-build ')).length, 1);
    }
    if (fault === 'bad-read-output') {
      assert.equal(calls.filter(x => x.startsWith('container start ')).length, 2);
      assert.equal(calls.filter(x => x.includes(' create --no-build ')).length, 2);
    }
    if (['started-at-drift', 'fast-finished-drift', 'terminal-paused',
      'terminal-restarting'].includes(fault)) {
      assert.equal(calls.filter(x => x.startsWith('container wait ')).length, 2);
      assert.equal(calls.filter(x => x.startsWith('container start ')).length, 2);
      assert.equal(calls.filter(x => x.startsWith('container rm ')).length, 0);
    }
    if (['created-endpoint', 'created-reader-empty', 'created-name',
      'created-command', 'created-image', 'fence-fail'].includes(fault))
      assert.equal(events.at(-1), fault === 'fence-fail' ?
        'prepare-fence' : 'prepare-created');
  }
}

for (const fault of ['', 'fast-exited', 'created-endpoint', 'created-reader-empty',
  'created-name', 'created-command', 'created-image', 'post-start-identity',
  'post-start-name', 'post-start-network',
  'zero-finished-at', 'started-at-drift', 'fast-finished-drift',
  'terminal-paused', 'terminal-restarting', 'fence-fail', 'lost-create', 'lost-start',
  'unknown-create-stderr', 'preexisting-name', 'preexisting-service', 'extra-name', 'extra-service',
  'bad-wait', 'bad-transfer-output', 'bad-read-output', 'lost-cleanup'])
  await scenario(fault);
process.stdout.write('Fixed writer mapping preparation adapter command order passed.\n');
