/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createWriterRoleApplyDockerAdapter } from
  '../../scripts/search-create-boundary-owner-docker.mjs';
import { fixedWriterRoleApplyCommand } from
  '../../scripts/search-writer-role-apply-service-config.mjs';

const project = 'writer_apply_fixture';
const invocationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const originalInvocation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const services = { transfer: 'search-writer-role-apply-transfer',
  apply: 'search-writer-role-apply' };
const containerIds = { transfer: 'a'.repeat(64), apply: 'b'.repeat(64) };
const images = { transfer: `sha256:${'1'.repeat(64)}`,
  apply: `sha256:${'2'.repeat(64)}` };
const networks = { search_admin_db: '3'.repeat(64), search_internal: '4'.repeat(64),
  none: '5'.repeat(64) };
const suffix = invocationId.replaceAll('-', '');
const names = { transfer: `station_writer_transfer_${suffix}`,
  apply: `station_writer_apply_${suffix}` };
const approvedFields = ['a'.repeat(64), '7', '22222222-2222-4222-8222-222222222222',
  'legacy-v1', 'station-mail-v1', 'legacy_uuid',
  '11111111-1111-4111-8111-111111111111',
  'station-mail-v2-g11111111111141118111111111111111', 'created_uuid',
  invocationId, project, '16384', '123'];
const command = fixedWriterRoleApplyCommand(approvedFields);
const status = { created: '0001-01-01T00:00:00Z',
  started: '2026-11-01T00:00:01Z', finished: '2026-11-01T00:00:02Z' };
const raw = [];
for await (const chunk of process.stdin) raw.push(chunk);
const supplied = JSON.parse(Buffer.concat(raw).toString('utf8'));
for (const key of Object.keys(process.env)) if (key.startsWith('STATION_WRITER_APPLY_'))
  delete process.env[key];
const originalRoot = path.resolve(process.argv[2]);
const uid = process.getuid(), gid = process.getgid();

async function scenario(fault = '') {
  await mkdir(path.join(originalRoot, '.cache/results'), { recursive: true, mode: 0o700 });
  const repository = await mkdtemp(path.join(originalRoot, '.cache/results/role-adapter-'));
  await mkdir(path.join(repository, '.cache'), { mode: 0o700 });
  const config = JSON.parse(JSON.stringify(supplied).replaceAll(originalRoot, repository)
    .replaceAll(originalInvocation, invocationId)
    .replaceAll(originalInvocation.replaceAll('-', ''), suffix));
  const publicRoot = path.join(repository, '.cache/search-create-apply-public', invocationId);
  const volumeName = `${project}_search_writer_apply_${suffix}`;
  const identity = { project, service: 'postgres', database: 'station', databaseOid: '16384',
    systemIdentifier: '123', owner: 'station', uid, gid };
  const stat = { dev: 1, ino: 2, uid, gid, mode: 0o100600, size: 43,
    nlink: 1, mtimeMs: 1, ctimeMs: 1 };
  const metadata = Buffer.from(JSON.stringify(identity));
  const credential = () => ({ rootStat: stat,
    metadata: { stat: { ...stat, size: metadata.length }, bytes: metadata },
    transition: { stat, bytes: Buffer.from('x'.repeat(43)) } });
  const calls = [], composeCreateFlags = [], phaseState = { transfer: 'absent', apply: 'absent' };
  let volumeExists = false, removedVolume = false;
  const reply = (stdout = '', stderr = '') => ({ code: 0, signal: null, stdout, stderr });
  const volume = name => ({ Name: name, Driver: 'local', Scope: 'local',
    CreatedAt: '2026-11-01T00:00:00Z', Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    Options: null, Labels: name === volumeName ?
      { 'station.create.project': project, 'station.create.invocation': invocationId } :
      { 'com.docker.compose.project': project,
        'com.docker.compose.volume': name.replace(`${project}_`, '') } });
  const rendered = async merged => {
    if (!merged) return config;
    const file = path.join(repository, '.cache/search-writer-role-overrides', invocationId,
      'compose.json');
    const override = JSON.parse(await readFile(file, 'utf8'));
    const result = structuredClone(config);
    for (const [service, fields] of Object.entries(override.services))
      Object.assign(result.services[service], fields);
    return result;
  };
  const inspected = phase => {
    const service = services[phase], spec = config.services[service],
      state = phaseState[phase], created = state === 'created';
    const mounts = spec.volumes.map(value => ({ Type: value.type,
      Destination: value.target,
      Source: value.type === 'bind' ? value.source : config.volumes[value.source].name,
      Name: value.type === 'volume' ? config.volumes[value.source].name : undefined,
      RW: !value.read_only }));
    const item = { Id: containerIds[phase], Name: `/${names[phase]}`,
      Image: images[phase], Created: '2026-11-01T00:00:00Z', RestartCount: 0,
      Config: { User: phase === 'transfer' ? '0:0' : '1000:1000',
        Cmd: phase === 'transfer' ? config.services[service].command : command,
        Entrypoint: ['docker-entrypoint.sh'], Env: ['NODE_VERSION=22.23.2'],
        Labels: { 'com.docker.compose.project': project,
          'com.docker.compose.service': service } },
      HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'],
        CapAdd: phase === 'transfer' ? ['CAP_CHOWN', 'CAP_DAC_OVERRIDE'] : [],
        PidsLimit: spec.pids_limit, Memory: Number(spec.mem_limit),
        NanoCpus: spec.cpus * 1e9, RestartPolicy: { Name: 'no' },
        SecurityOpt: ['no-new-privileges:true'], Devices: [], GroupAdd: [],
        PidMode: '', IpcMode: 'private', PortBindings: {},
        Tmpfs: { '/tmp': spec.tmpfs[0].slice('/tmp:'.length) },
        NetworkMode: phase === 'transfer' ? 'none' : `${project}_search_admin_db`,
        Mounts: spec.volumes.map(value => ({ Type: value.type,
          Source: value.type === 'bind' ? value.source : config.volumes[value.source].name,
          Target: value.target, ReadOnly: !!value.read_only,
          ...(value.type === 'bind' ? { BindOptions: { CreateMountpoint: false } } :
            { VolumeOptions: { NoCopy: true } }) })) },
      NetworkSettings: { Ports: {}, Networks: created ? phase === 'transfer' ?
        { none: {} } : { [`${project}_search_admin_db`]: {},
          [`${project}_search_internal`]: {} } : phase === 'transfer' ?
        { none: { NetworkID: networks.none } } :
        { [`${project}_search_admin_db`]: { NetworkID: networks.search_admin_db },
          [`${project}_search_internal`]: { NetworkID: networks.search_internal } } },
      Mounts: mounts,
      State: { Status: state, Running: state === 'running', Paused: false,
        ExitCode: 0, Restarting: false,
        StartedAt: created ? status.created : status.started,
        FinishedAt: state === 'exited' ? status.finished : status.created,
        OOMKilled: false, Dead: false, Error: '' } };
    if (fault === 'created-command' && created) item.Config.Cmd = ['node', 'other.mjs'];
    if (fault === 'created-network' && created && phase === 'apply')
      item.NetworkSettings.Networks.default = {};
    if (fault === 'created-image' && created) item.Image = `sha256:${'f'.repeat(64)}`;
    if (fault === 'post-start-identity' && state !== 'created') item.Created = 'changed';
    if (fault === 'zero-finished-at' && state === 'exited')
      item.State.FinishedAt = status.created;
    return item;
  };
  const commandRunner = async (args, env, timeoutMs) => {
    const line = args.join(' '); calls.push(line);
    assert.equal(env.APP_UID, String(uid)); assert.equal(env.APP_GID, String(gid));
    const writerCreate = args[0] === 'compose' && args.includes('create');
    if (writerCreate) composeCreateFlags.push(env.COMPOSE_IGNORE_ORPHANS);
    else assert.equal(env.COMPOSE_IGNORE_ORPHANS, undefined);
    if (args[0] === 'compose' && args.includes('config')) {
      const merged = args.filter(x => x === '-f').length === 3;
      return reply(`${JSON.stringify(await rendered(merged))}\n`);
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
      assert.ok(line.includes(' create --no-build --pull never --no-recreate '));
      phaseState[phase] = 'created';
      if (fault === 'lost-create') throw Error('lost original create result');
      if (fault === 'unknown-create-stderr')
        return reply('', `unexpected warning\n Container ${names[phase]} Created\n`);
      const progress = fault === 'create-three-spaces' ? '   ' :
        fault === 'create-one-space' ? ' ' : '  ';
      const suffix = fault === 'create-tail-space' ? ' ' : '';
      const ending = fault === 'create-crlf' ? '\r\n' : '\n';
      const prefix = fault === 'create-ansi' ? '\u001b[31m' : '';
      const named = fault === 'create-wrong-name' ? 'other-container' : names[phase];
      const effectiveEnv = { ...env };
      if (fault === 'orphan-warning-unsuppressed')
        delete effectiveEnv.COMPOSE_IGNORE_ORPHANS;
      const warning = effectiveEnv.COMPOSE_IGNORE_ORPHANS === 'true' ? '' :
        'WARN[0000] Found orphan containers ([fixed-prior]) for this project.\n';
      return reply('', warning +
        `${prefix} Container ${named}${progress}Creating${suffix}${ending}` +
        ` Container ${named}${progress}Created${suffix}${ending}`);
    }
    if (args[0] === 'ps') {
      const nameFilter = args.find(x => x.startsWith('name=^/'));
      if (nameFilter) {
        const phase = Object.keys(services).find(p => nameFilter === `name=^/${names[p]}$`);
        if (fault === 'preexisting-name' && phase === 'transfer') return reply(`${'f'.repeat(64)}\n`);
        return reply(phaseState[phase] === 'absent' || phaseState[phase] === 'removed' ? '' :
          `${containerIds[phase]}\n`);
      }
      const serviceFilter = args.find(x => x.startsWith('label=com.docker.compose.service='));
      if (serviceFilter) {
        const phase = Object.keys(services).find(p => serviceFilter.endsWith(services[p]));
        if (fault === 'extra-stopped' && phase === 'apply' &&
            phaseState.apply === 'exited')
          return reply(`${containerIds.apply}\n${'f'.repeat(64)}\n`);
        return reply(phaseState[phase] === 'absent' || phaseState[phase] === 'removed' ? '' :
          `${containerIds[phase]}\n`);
      }
      const refs = Object.keys(services).filter(p => !['absent', 'removed'].includes(phaseState[p]));
      return reply(refs.map(p => containerIds[p]).join('\n') + (refs.length ? '\n' : ''));
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const phase = Object.keys(services).find(p => args[2] === containerIds[p]);
      return reply(`${JSON.stringify([inspected(phase)])}\n`);
    }
    if (args[0] === 'container' && args[1] === 'start') {
      const phase = Object.keys(services).find(p => args[2] === containerIds[p]);
      phaseState[phase] = fault === 'fast-exited' ? 'exited' : 'running';
      if (fault === 'lost-start') throw Error('lost original start result');
      return reply(`${containerIds[phase]}\n`);
    }
    if (args[0] === 'container' && args[1] === 'wait') {
      assert.equal(timeoutMs, args[2] === containerIds.transfer ? 80_000 : 330_000);
      const phase = Object.keys(services).find(p => args[2] === containerIds[p]);
      phaseState[phase] = 'exited'; return reply('0\n');
    }
    if (args[0] === 'container' && args[1] === 'logs') {
      const phase = Object.keys(services).find(p => args[2] === containerIds[p]);
      return reply(phase === 'transfer' ?
        'Private writer role apply transfer completed.\n' :
        'Private writer role apply reached writer_role_attested; search remains disabled.\n');
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      const phase = Object.keys(services).find(p => args[2] === containerIds[p]);
      phaseState[phase] = 'removed'; return reply(`${args[2]}\n`);
    }
    if (args[0] === 'volume' && args[1] === 'rm') {
      removedVolume = true; return reply(`${volumeName}\n`);
    }
    throw Error('unexpected fixture command');
  };
  let completed = false;
  try {
    const adapter = createWriterRoleApplyDockerAdapter({ repository, uid, gid,
      jobLock: {}, invocationId, deadline: Number.MAX_SAFE_INTEGER, tick: () => {} }, {
      command: commandRunner, ownerFactory: async () => ({
        identity: async () => identity, containerId: async () => 'e'.repeat(64),
        adminNetwork: async () => ({ id: networks.search_admin_db, ip: '172.30.0.2' }) }),
      verifyCredentials: async () => true, credentialCapture: async () => credential() });
    await adapter.verifyOwner();
    const owner = await adapter.captureOwner();
    await adapter.recheckOwner(owner);
    await adapter.preflight({ publicRoot, volumeName, command });
    await adapter.volumeAbsent(volumeName);
    const volumeItem = await adapter.createVolume(volumeName);
    await adapter.checkVolume(volumeItem);
    const beforeStart = async phase => { calls.push(`fence ${phase}`);
      await adapter.recheckOwner(owner); await adapter.recheckInfrastructure();
      await adapter.checkVolume(volumeItem); };
    const transfer = await adapter.runPhase('transfer', () => beforeStart('transfer'));
    const applied = await adapter.runPhase('apply', () => beforeStart('apply'));
    await adapter.cleanupRemote([transfer, applied], volumeItem);
    await adapter.cleanupPrivate(); await adapter.recheckInfrastructure();
    assert.deepEqual([transfer.stdout, applied.stdout], [
      'Private writer role apply transfer completed.\n',
      'Private writer role apply reached writer_role_attested; search remains disabled.\n']);
    assert.deepEqual([transfer.exitCode, applied.exitCode], [0, 0]);
    const created = calls.findIndex(x => x.includes(' create --no-build '));
    const inspected = calls.findIndex(x => x === `container inspect ${containerIds.transfer}`);
    const fence = calls.indexOf('fence transfer');
    const started = calls.indexOf(`container start ${containerIds.transfer}`);
    assert.ok(created >= 0 && created < inspected && inspected < fence && fence < started);
    const applyCreated = calls.findIndex(x => x.includes(' create --no-build ') &&
      x.endsWith(` ${services.apply}`));
    const applyInspected = calls.findIndex(x => x === `container inspect ${containerIds.apply}`);
    const applyFence = calls.indexOf('fence apply');
    const applyStarted = calls.indexOf(`container start ${containerIds.apply}`);
    assert.ok(started < applyCreated && applyCreated < applyInspected &&
      applyInspected < applyFence && applyFence < applyStarted);
    assert.equal(calls.filter(x => x.includes(' create --no-build ')).length, 2);
    assert.deepEqual(composeCreateFlags, ['true', 'true']);
    assert.equal(calls.filter(x => x.startsWith('container start ')).length, 2);
    completed = true;
  } catch (error) {
    if (!fault || fault === 'fast-exited' || fault === 'create-one-space') throw error;
    if (fault === 'preexisting-name') {
      assert.ok(calls.some(x => x.includes(`name=^/${names.transfer}$`)));
      assert.equal(calls.filter(x => x.includes(' create --no-build ')).length, 0);
    } else assert.ok(calls.some(x => x.includes(' create --no-build ')));
    assert.ok(error instanceof Error);
    if (fault.startsWith('created-')) {
      assert.ok(calls.includes(`container inspect ${containerIds.transfer}`));
      assert.deepEqual(calls.filter(x => x.startsWith('container start ')),
        fault === 'created-network' ? [`container start ${containerIds.transfer}`] : []);
    }
    if (fault === 'lost-create')
      assert.equal(calls.filter(x => x.includes(' create --no-build ')).length, 1);
    if (['orphan-warning-unsuppressed', 'unknown-create-stderr',
      'create-three-spaces', 'create-tail-space', 'create-crlf',
      'create-ansi', 'create-wrong-name'].includes(fault)) {
      assert.equal(calls.filter(x => x.includes(' create --no-build ')).length, 1);
      assert.deepEqual(composeCreateFlags, ['true']);
      assert.equal(calls.filter(x => x.startsWith('container inspect ')).length, 0);
      assert.equal(calls.filter(x => x.startsWith('container start ')).length, 0);
    }
    if (fault === 'lost-start')
      assert.equal(calls.filter(x => x.startsWith('container start ')).length, 1);
    if (fault === 'post-start-identity') {
      assert.equal(calls.filter(x => x.startsWith('container start ')).length, 1);
      assert.ok(calls.includes(`container inspect ${containerIds.transfer}`));
    }
    if (fault === 'zero-finished-at') {
      assert.equal(calls.filter(x => x.startsWith('container start ')).length, 1);
      assert.ok(calls.includes(`container inspect ${containerIds.transfer}`));
    }
    if (fault === 'extra-stopped') {
      assert.equal(calls.filter(x => x.startsWith('container start ')).length, 2);
      assert.equal(calls.filter(x => x.startsWith('container rm ')).length, 0);
    }
  } finally { await rm(repository, { recursive: true, force: true }); }
  assert.equal(composeCreateFlags.every(flag => flag === 'true'), true);
  if (fault && !['fast-exited', 'create-one-space'].includes(fault) && completed)
    throw Error('fault was not rejected');
  if ((!fault || ['fast-exited', 'create-one-space'].includes(fault)) && !completed)
    throw Error('positive did not complete');
}

try {
  const ambient = process.env.COMPOSE_IGNORE_ORPHANS;
  process.env.COMPOSE_IGNORE_ORPHANS = 'true';
  try {
    assert.throws(() => createWriterRoleApplyDockerAdapter({ repository: originalRoot,
      uid, gid, jobLock: {}, invocationId, deadline: Number.MAX_SAFE_INTEGER,
      tick: () => {} }));
  } finally {
    if (ambient === undefined) delete process.env.COMPOSE_IGNORE_ORPHANS;
    else process.env.COMPOSE_IGNORE_ORPHANS = ambient;
  }
  for (const fault of ['', 'fast-exited', 'create-one-space', 'created-command',
    'created-network', 'created-image',
    'post-start-identity', 'zero-finished-at', 'lost-create', 'lost-start', 'preexisting-name',
    'extra-stopped', 'orphan-warning-unsuppressed', 'unknown-create-stderr',
    'create-three-spaces', 'create-tail-space', 'create-crlf',
    'create-ansi', 'create-wrong-name'])
    await scenario(fault);
  process.stdout.write('Fixed writer role apply Docker command-order fixture passed.\n');
} catch {
  process.stderr.write('Fixed writer role apply Docker command-order fixture failed.\n');
  process.exitCode = 1;
}
