import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createSearchAdminDockerAdapter } from './search-admin-credentials.mjs';
import { runBoundedOwnerDockerCommand } from './search-owner-docker-command.mjs';
import { operateSearchAdminCredentialsAlreadyJobLocked } from './search-admin-credential-core.mjs';
import { verifyCreateBoundaryServiceConfig,
  verifyCreateIntentPrepareServiceConfig } from './search-create-boundary-service-config.mjs';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { equal, keys, sameStat, sameVolume, verifyOwnerContainerPolicy } from './search-owner-docker-policy.mjs';
import { CreateBoundaryOwnerDiagnosticError } from './search-create-boundary-owner-diagnostic.mjs';

const fail = (reason = 'invariant') => {
  throw new CreateBoundaryOwnerDiagnosticError('input', reason);
};
const imageId = /^sha256:[0-9a-f]{64}$/;
const fullId = /^[0-9a-f]{64}$/;
const containerId = /^[0-9a-f]{12,64}$/;
const one = output => {
  const value = JSON.parse(output);
  if (!Array.isArray(value) || value.length !== 1 || !value[0] ||
      typeof value[0] !== 'object') fail();
  return value[0];
};
const listed = (output, regex, max = 4096) => {
  const lines = output === '' ? [] : output.split('\n');
  if (lines.length > max || lines.some(x => !regex.test(x)) ||
      new Set(lines).size !== lines.length) fail();
  return lines;
};
async function captureTransition(repository, uid, gid) {
  const root = path.join(repository, '.cache/search-db/initial-v1');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== uid ||
      rootStat.gid !== gid || (rootStat.mode & 0o777) !== 0o700 ||
      await realpath(root) !== root) fail();
  const capture = async (name, min, max) => {
    const file = path.join(root, name);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || before.gid !== gid ||
          ![0o400, 0o600].includes(before.mode & 0o777) || before.size < min ||
          before.size > max || !sameStat(before, await lstat(file)) ||
          await realpath(file) !== file) fail();
      const buffer = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== before.size || !sameStat(before, await handle.stat()) ||
          !sameStat(before, await lstat(file))) fail();
      return { stat: before, bytes: buffer.subarray(0, bytesRead) };
    } finally { await handle.close(); }
  };
  return { rootStat, metadata: await capture('operation.json', 2, 4096),
    transition: await capture('transition.password', 43, 43) };
}

/** Fixed two-service Docker adapter; options are a private scripted-test seam. */
function fixedBoundaryDockerAdapter({ repository, uid, gid, jobLock, invocationId,
  deadline, tick }, options = {}, intent = false) {
  const names = { transfer: 'search-create-transfer',
    [intent ? 'prepare' : 'inspect']: intent ? 'search-create-intent-prepare' : 'search-create-boundary' };
  const phases = Object.keys(names);
  const commands = { transfer: ['node', 'scripts/search-create-boundary-transfer.mjs'],
    [intent ? 'prepare' : 'inspect']: ['node',
      intent ? 'scripts/search-create-intent-prepare.mjs' : 'scripts/search-create-boundary.mjs'] };
  const outputs = { transfer: 'Private create boundary transfer completed.\n',
    inspect: 'Private create boundary evidence completed.\n' };
  if (Object.keys(process.env).some(key => key.startsWith('DOCKER_') ||
      key.startsWith('COMPOSE_') || key.startsWith('PG') ||
      key.startsWith('STATION_CREATE_'))) fail();
  const ownerFactory = options.ownerFactory ?? createSearchAdminDockerAdapter;
  const verifyCredentials = options.verifyCredentials ?? operateSearchAdminCredentialsAlreadyJobLocked;
  const credentialCapture = options.credentialCapture ?? captureTransition;
  const runCommand = options.command ?? ((args, env, timeoutMs = 10_000) =>
    runBoundedOwnerDockerCommand({ repository, deadline, args, env, timeoutMs,
      reject: kind => fail(kind) }));
  let installation, retained, identity, project, postgresId, adminNetwork, normalized,
    volumeName, networkIds, volumeIds, images;
  let trusted = { APP_UID: String(uid), APP_GID: String(gid) };
  const docker = async (args, timeoutMs = 10_000, ignoreOrphans = false,
    classifyStderrLater = false) => {
    tick();
    const env = { ...process.env, ...trusted };
    for (const key of Object.keys(env)) if (key.startsWith('PG') || key.startsWith('COMPOSE_') ||
        key.startsWith('STATION_CREATE_') && !Object.hasOwn(trusted, key)) delete env[key];
    if (ignoreOrphans) env.COMPOSE_IGNORE_ORPHANS = 'true';
    let result;
    try { result = await runCommand(args, env, timeoutMs); }
    catch (error) {
      if (error instanceof CreateBoundaryOwnerDiagnosticError) throw error;
      fail('command-response');
    }
    tick();
    if (!result || result.code !== 0 || result.signal || typeof result.stdout !== 'string' ||
        typeof result.stderr !== 'string' || Buffer.byteLength(result.stdout) > 256 * 1024 ||
        Buffer.byteLength(result.stderr) > 256 * 1024) fail('command-response');
    if (!classifyStderrLater && result.stderr !== '') fail('command-response');
    return result;
  };
  const compose = (args, timeoutMs) => docker(['compose', '-f', 'compose.yaml',
    '-f', 'compose.search-create-boundary.yaml', '-p', project,
    '--profile', 'search-create-boundary', ...args], timeoutMs,
  args[0] === 'run', args[0] === 'run');
  const inspect = async id => one((await docker(['container', 'inspect', id])).stdout);
  const inspectVolume = async name => one((await docker(['volume', 'inspect', name])).stdout);
  const serviceReferences = async phase => listed((await docker(['ps', '-a', '--no-trunc',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${names[phase]}`,
    '--format', '{{.ID}}'])).stdout.trim(), fullId);
  const volume = item => {
    if (!item || item.Name !== volumeName || item.Driver !== 'local' ||
        item.Scope !== 'local' || typeof item.CreatedAt !== 'string' || !item.CreatedAt ||
        !keys(item.Labels, ['station.create.project', 'station.create.invocation']) ||
        item.Labels['station.create.project'] !== project ||
        item.Labels['station.create.invocation'] !== invocationId ||
        item.Options !== null && !keys(item.Options, [])) fail();
  };
  const infrastructure = async () => {
    for (const name of ['search_admin_db', 'search_internal', 'none']) {
      const item = one((await docker(['network', 'inspect',
        name === 'none' ? name : `${project}_${name}`])).stdout);
      if (item.Id !== networkIds[name]) fail();
    }
    for (const name of ['search_admin_certs', 'search_security_state'])
      if (!sameVolume(await inspectVolume(`${project}_${name}`), volumeIds[name])) fail();
    for (const phase of phases) {
      const item = one((await docker(['image', 'inspect', `${project}-${names[phase]}`])).stdout);
      if (item.Id !== images[phase] || !equal(item.Config?.Env, images.env[phase]) ||
          !equal(item.Config?.Entrypoint, images.entrypoint[phase])) fail();
    }
  };
  const checkedContainer = (item, phase, id, terminal) => {
    const service = normalized.services[names[phase]];
    verifyOwnerContainerPolicy(item, {
      id, image: images[phase], env: images.env[phase],
      entrypoint: images.entrypoint[phase], command: commands[phase],
      user: phase === 'transfer' ? '0:0' : '1000:1000', project,
      service: names[phase], capAdd: phase === 'transfer' ? ['CHOWN', 'DAC_OVERRIDE'] : [],
      pids: phase === 'transfer' ? 64 : 128,
      memory: phase === 'transfer' ? 268435456 : 536870912,
      nanoCpus: phase === 'transfer' ? 5e8 : 1e9,
      tmpfs: service.tmpfs[0].slice('/tmp:'.length), mounts: service.volumes,
      volumes: normalized.volumes,
      networks: phase === 'transfer' ? [networkIds.none] :
        [networkIds.search_admin_db, networkIds.search_internal],
      none: phase === 'transfer', terminal,
    }, reason => fail(reason));
  };
  return Object.freeze({
    async recheckInfrastructure() { await infrastructure(); },
    async verifyOwner() {
      installation = await ownerFactory(uid, gid);
      await verifyCredentials({ action: 'verify', root: path.join(repository, '.cache/search-db'),
        uid, gid, adapter: installation, jobLock });
      retained = await credentialCapture(repository, uid, gid);
      const metadata = JSON.parse(retained.metadata.bytes.toString('utf8'));
      identity = await installation.identity();
      if (metadata.project !== identity.project || metadata.databaseOid !== identity.databaseOid ||
          metadata.systemIdentifier !== identity.systemIdentifier ||
          metadata.uid !== uid || metadata.gid !== gid || identity.owner !== 'station') fail();
      project = identity.project;
      postgresId = await installation.containerId();
      if (!containerId.test(postgresId)) fail();
      adminNetwork = await installation.adminNetwork();
      if (!fullId.test(adminNetwork.id) ||
          !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(adminNetwork.ip)) fail();
    },
    async captureOwner() {
      if (!retained || !identity) fail();
      return { project, databaseOid: identity.databaseOid,
        systemIdentifier: identity.systemIdentifier, owner: identity.owner,
        uid, gid, adminNetwork };
    },
    async recheckOwner(owner) {
      const current = await credentialCapture(repository, uid, gid);
      if (!sameStat(current.rootStat, retained.rootStat) ||
          !sameStat(current.metadata.stat, retained.metadata.stat) ||
          !sameStat(current.transition.stat, retained.transition.stat) ||
          !current.metadata.bytes.equals(retained.metadata.bytes) ||
          !current.transition.bytes.equals(retained.transition.bytes)) fail();
      const fresh = await ownerFactory(uid, gid);
      const currentIdentity = await fresh.identity();
      if (!equal(currentIdentity, identity) ||
          !equal(currentIdentity, { project: owner.project, service: 'postgres',
            database: 'station', databaseOid: owner.databaseOid,
            systemIdentifier: owner.systemIdentifier, owner: 'station', uid, gid }) ||
          await fresh.containerId() !== postgresId ||
          !equal(await fresh.adminNetwork(), adminNetwork)) fail();
      await verifyCredentials({ action: 'verify', root: path.join(repository, '.cache/search-db'),
        uid, gid, adapter: fresh, jobLock });
    },
    async preflight({ invocationRoot, volumeName: name }) {
      volumeName = name;
      trusted = { ...trusted, STATION_CREATE_INVOCATION_ROOT: invocationRoot,
        STATION_CREATE_VOLUME_NAME: volumeName };
      const response = await compose(['config', '--format', 'json', ...Object.values(names)]);
      if (response.stderr !== '') fail();
      normalized = JSON.parse(response.stdout);
      (intent ? verifyCreateIntentPrepareServiceConfig : verifyCreateBoundaryServiceConfig)(normalized,
        { project, repository, invocationId,
        invocationRoot, volumeName });
      networkIds = {};
      for (const name of ['search_admin_db', 'search_internal']) {
        const item = one((await docker(['network', 'inspect', `${project}_${name}`])).stdout);
        if (!fullId.test(item.Id) || item.Internal !== true ||
            item.Labels?.['com.docker.compose.project'] !== project ||
            item.Labels?.['com.docker.compose.network'] !== name) fail();
        networkIds[name] = item.Id;
      }
      if (networkIds.search_admin_db !== adminNetwork.id) fail();
      const none = one((await docker(['network', 'inspect', 'none'])).stdout);
      if (!fullId.test(none.Id) || none.Name !== 'none') fail();
      networkIds.none = none.Id;
      volumeIds = {};
      for (const name of ['search_admin_certs', 'search_security_state']) {
        const item = await inspectVolume(`${project}_${name}`);
        if (item.Driver !== 'local' || item.Scope !== 'local' ||
            item.Labels?.['com.docker.compose.project'] !== project ||
            item.Labels?.['com.docker.compose.volume'] !== name) fail();
        volumeIds[name] = item;
      }
      images = { env: {}, entrypoint: {} };
      for (const phase of phases) {
        const item = one((await docker(['image', 'inspect', `${project}-${names[phase]}`])).stdout);
        if (!imageId.test(item.Id) ||
            !equal(item.Config?.Cmd, ['node', 'apps/server/dist/main.js']) ||
            !equal(item.Config?.Entrypoint, ['docker-entrypoint.sh'])) fail();
        images[phase] = item.Id;
        images.env[phase] = item.Config.Env;
        images.entrypoint[phase] = item.Config.Entrypoint;
      }
    },
    async volumeAbsent(name) {
      if (name !== volumeName || listed((await docker(['volume', 'ls', '--format', '{{.Name}}']))
        .stdout.trim(), /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/).includes(name)) fail();
      for (const phase of phases) if ((await serviceReferences(phase)).length) fail();
    },
    async createVolume(name) {
      if (name !== volumeName) fail();
      const response = await docker(['volume', 'create', '--driver', 'local',
        '--label', `station.create.project=${project}`,
        '--label', `station.create.invocation=${invocationId}`, name]);
      if (response.stdout !== `${name}\n` || response.stderr !== '') fail();
      const item = await inspectVolume(name);
      volume(item);
      return item;
    },
    async checkVolume(captured) {
      const current = await inspectVolume(volumeName);
      volume(current);
      if (!sameVolume(current, captured)) fail();
    },
    async runPhase(phase) {
      if (!Object.hasOwn(names, phase)) fail();
      const response = await compose(['config', '--format', 'json', ...Object.values(names)]);
      if (response.stderr !== '' || !equal(JSON.parse(response.stdout), normalized)) fail();
      await infrastructure();
      const sent = await compose(['run', '--detach', '--no-deps', '--pull', 'never', names[phase]], 20_000);
      if (sent.stderr !== '') fail('dispatch-stderr');
      if (!fullId.test(sent.stdout.trim()) ||
          sent.stdout !== `${sent.stdout.trim()}\n`) fail('dispatch-stdout');
      const id = sent.stdout.trim();
      checkedContainer(await inspect(id), phase, id, false);
      const waited = await docker(['container', 'wait', id],
        phase === 'transfer' ? 80_000 : 90_000, false, true);
      if (waited.stderr !== '') fail('wait-stderr');
      if (waited.stdout !== '0\n') fail('wait-exit');
      const finished = await inspect(id);
      checkedContainer(finished, phase, id, true);
      const logs = await docker(['container', 'logs', id], 10_000, false, true);
      if (logs.stderr !== '') fail('logs-stderr');
      let projection;
      if (phase === 'prepare') {
        if (!logs.stdout.endsWith('\n') || Buffer.byteLength(logs.stdout) > 256 * 1024) fail('logs-stdout');
        try {
          projection = JSON.parse(logs.stdout.slice(0, -1));
          if (`${canonicalAttestorValue(projection, 256 * 1024).bytes.toString('utf8')}\n` !== logs.stdout)
            fail('logs-stdout');
        } catch { fail('logs-stdout'); }
      } else if (logs.stdout !== outputs[phase]) fail('logs-stdout');
      return { id, phase, image: finished.Image, created: finished.Created,
        labels: finished.Config.Labels, startedAt: finished.State.StartedAt,
        finishedAt: finished.State.FinishedAt, ...(phase === 'prepare' ? { projection } : {}) };
    },
    async cleanupRemote(containers, capturedVolume) {
      if (!Array.isArray(containers) || !equal(containers.map(x => x.phase), phases)) fail();
      for (const item of containers) {
        const current = await inspect(item.id);
        checkedContainer(current, item.phase, item.id, true);
        if (current.Created !== item.created || !equal(current.Config.Labels, item.labels) ||
            current.Image !== item.image || current.State.StartedAt !== item.startedAt ||
            current.State.FinishedAt !== item.finishedAt) fail();
      }
      await this.checkVolume(capturedVolume);
      for (const item of containers) if (!equal(await serviceReferences(item.phase), [item.id])) fail();
      const references = listed((await docker(['ps', '-a', '--no-trunc', '--filter',
        `volume=${volumeName}`, '--format', '{{.ID}}'])).stdout.trim(), fullId);
      if (!equal(references.sort(), containers.map(x => x.id).sort())) fail();
      for (const item of [...containers].reverse()) {
        const removed = await docker(['container', 'rm', item.id]);
        if (removed.stdout !== `${item.id}\n` || removed.stderr !== '') fail();
      }
      if (listed((await docker(['ps', '-a', '--no-trunc', '--filter',
        `volume=${volumeName}`, '--format', '{{.ID}}'])).stdout.trim(), fullId).length) fail();
      for (const phase of phases) if ((await serviceReferences(phase)).length) fail();
      await this.checkVolume(capturedVolume);
      const removed = await docker(['volume', 'rm', volumeName]);
      if (removed.stdout !== `${volumeName}\n` || removed.stderr !== '') fail();
      if (listed((await docker(['volume', 'ls', '--format', '{{.Name}}'])).stdout.trim(),
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/).includes(volumeName)) fail();
    },
  });
}

/** Existing fixed success-only observation adapter. */
export function createBoundaryDockerAdapter(input, options = {}) {
  return fixedBoundaryDockerAdapter(input, options, false);
}

/** Fixed read-only projection adapter, never an SDK create caller. */
export function createIntentPrepareDockerAdapter(input, options = {}) {
  return fixedBoundaryDockerAdapter(input, options, true);
}
