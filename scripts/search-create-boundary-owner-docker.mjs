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
import { verifyCreateApplyServiceConfig,
  verifyWriterRolePrepareServiceConfig } from './search-create-apply-service-config.mjs';
import { fixedWriterRoleApplyCommand, verifyWriterRoleApplyServiceConfig,
  verifyWriterRoleApplyMergedConfig, verifyWriterRoleApplyCreatedContainer,
  verifyWriterRoleApplyEffectiveContainer } from './search-writer-role-apply-service-config.mjs';
import { stageWriterRoleApplyOverride } from './search-writer-role-apply-override.mjs';
import { fixedWriterMappingPrepareNames, verifyWriterMappingPrepareNamedConfig,
  verifyWriterMappingPrepareNamedEffectiveContainer,
  verifyWriterMappingPrepareCreatedContainer } from
  './search-writer-mapping-prepare-service-config.mjs';
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
  deadline, tick }, options = {}, kind = 'boundary') {
  const intent = kind === 'intent', apply = kind === 'apply', writer = kind === 'writer-prepare',
    writerApply = kind === 'writer-apply', mapping = kind === 'writer-mapping-prepare';
  const names = mapping ? { transfer: 'search-writer-mapping-prepare-transfer',
    prepare: 'search-writer-mapping-prepare' } : writerApply ? { transfer: 'search-writer-role-apply-transfer',
    apply: 'search-writer-role-apply' } : writer ? { transfer: 'search-writer-role-prepare-transfer',
    prepare: 'search-writer-role-prepare' } :
    apply ? { transfer: 'search-create-apply-transfer', create: 'search-create-index' } :
    { transfer: 'search-create-transfer',
      [intent ? 'prepare' : 'inspect']: intent ? 'search-create-intent-prepare' : 'search-create-boundary' };
  const phases = Object.keys(names);
  const commands = mapping ? { transfer: ['node', 'scripts/search-writer-mapping-prepare-transfer.mjs'],
    prepare: ['node', 'scripts/search-writer-mapping-prepare.mjs'] } :
    writerApply ? { transfer: ['node', 'scripts/search-writer-role-apply-transfer.mjs'] } :
    writer ? { transfer: ['node', 'scripts/search-writer-role-prepare-transfer.mjs'],
    prepare: ['node', 'scripts/search-writer-role-prepare.mjs'] } :
    apply ? { transfer: ['node', 'scripts/search-create-apply-transfer.mjs'],
    create: ['node', 'scripts/search-create-apply-consumer.mjs'] } :
    { transfer: ['node', 'scripts/search-create-boundary-transfer.mjs'],
    [intent ? 'prepare' : 'inspect']: ['node',
      intent ? 'scripts/search-create-intent-prepare.mjs' : 'scripts/search-create-boundary.mjs'] };
  const outputs = mapping ? { transfer: 'Private writer mapping preparation transfer completed.\n' } :
    writerApply ? { transfer: 'Private writer role apply transfer completed.\n',
    apply: 'Private writer role apply reached writer_role_attested; search remains disabled.\n' } :
    writer ? { transfer: 'Private writer role preparation transfer completed.\n' } :
    apply ? { transfer: 'Private create apply transfer completed.\n',
    create: 'Private create apply reached uuid_bound; search remains disabled.\n' } :
    { transfer: 'Private create boundary transfer completed.\n',
      inspect: 'Private create boundary evidence completed.\n' };
  if (Object.keys(process.env).some(key => key.startsWith('DOCKER_') ||
      key.startsWith('COMPOSE_') || key.startsWith('PG') ||
      key.startsWith('STATION_CREATE_') || key.startsWith('STATION_WRITER_PREPARE_') ||
      key.startsWith('STATION_WRITER_APPLY_') ||
      mapping && key.startsWith('STATION_WRITER_MAPPING_PREPARE_'))) fail();
  const ownerFactory = options.ownerFactory ?? createSearchAdminDockerAdapter;
  const verifyCredentials = options.verifyCredentials ?? operateSearchAdminCredentialsAlreadyJobLocked;
  const credentialCapture = options.credentialCapture ?? captureTransition;
  const runCommand = options.command ?? ((args, env, timeoutMs = 10_000) =>
    runBoundedOwnerDockerCommand({ repository, deadline, args, env, timeoutMs,
      reject: kind => fail(kind) }));
  let installation, retained, identity, project, postgresId, adminNetwork, normalized,
    volumeName, networkIds, volumeIds, images, override, approvedFields, containerNames;
  let trusted = { APP_UID: String(uid), APP_GID: String(gid) };
  const docker = async (args, timeoutMs = 10_000, ignoreOrphans = false,
    classifyStderrLater = false) => {
    tick();
    const env = { ...process.env, ...trusted };
    for (const key of Object.keys(env)) if (key.startsWith('PG') || key.startsWith('COMPOSE_') ||
        (key.startsWith('STATION_CREATE_') || key.startsWith('STATION_WRITER_PREPARE_') ||
          key.startsWith('STATION_WRITER_APPLY_') ||
          mapping && key.startsWith('STATION_WRITER_MAPPING_PREPARE_')) &&
          !Object.hasOwn(trusted, key)) delete env[key];
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
  const compose = (args, timeoutMs, withOverride = writerApply) => docker(['compose', '-f', 'compose.yaml',
    '-f', mapping ? 'compose.search-writer-mapping-prepare.yaml' :
      writerApply ? 'compose.search-writer-role-apply.yaml' :
      writer ? 'compose.search-writer-role-prepare.yaml' :
      apply ? 'compose.search-create-apply.yaml' : 'compose.search-create-boundary.yaml', '-p', project,
    ...(withOverride && writerApply ? ['-f', override.file] : []),
    '--profile', mapping ? 'search-writer-mapping-prepare' :
      writerApply ? 'search-writer-role-apply' : writer ? 'search-writer-role-prepare' :
      apply ? 'search-create-apply' : 'search-create-boundary', ...args], timeoutMs,
  args[0] === 'run' || (writerApply || mapping) && args[0] === 'create',
  args[0] === 'run' || (writerApply || mapping) && args[0] === 'create');
  const inspect = async id => one((await docker(['container', 'inspect', id])).stdout);
  const inspectVolume = async name => one((await docker(['volume', 'inspect', name])).stdout);
  const serviceReferences = async phase => listed((await docker(['ps', '-a', '--no-trunc',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${names[phase]}`,
    '--format', '{{.ID}}'])).stdout.trim(), fullId);
  const namedReferences = async phase => listed((await docker(['ps', '-a', '--no-trunc',
    '--filter', `name=^/${containerNames[phase]}$`, '--format', '{{.ID}}'])).stdout.trim(), fullId);
  const volume = item => {
    if (!item || item.Name !== volumeName || item.Driver !== 'local' ||
        item.Scope !== 'local' || typeof item.CreatedAt !== 'string' || !item.CreatedAt ||
        !keys(item.Labels, ['station.create.project', 'station.create.invocation']) ||
        item.Labels['station.create.project'] !== project ||
        item.Labels['station.create.invocation'] !== invocationId ||
        item.Options !== null && !keys(item.Options, [])) fail();
  };
  const infrastructure = async () => {
    if (writerApply) await override.recheck();
    if (mapping) {
      if (!normalized || !networkIds || !volumeIds || !images) fail();
      const rendered = JSON.parse((await compose(['config', '--format', 'json',
        ...Object.values(names)])).stdout);
      if (!equal(rendered, normalized)) fail();
    }
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
    if (mapping) {
      verifyWriterMappingPrepareNamedEffectiveContainer(item, { config: normalized,
        context: { repository, project, invocationId,
          invocationRoot: trusted.STATION_WRITER_MAPPING_PREPARE_INVOCATION_ROOT,
          publicRoot: trusted.STATION_WRITER_MAPPING_PREPARE_PUBLIC_ROOT, volumeName },
        phase: names[phase], id, image: images[phase], env: images.env[phase],
        entrypoint: images.entrypoint[phase],
        networkIds: { search_admin_db: networkIds.search_admin_db,
          search_internal: networkIds.search_internal },
        noneNetworkId: networkIds.none, terminal });
      if (terminal && (item.State?.Status !== 'exited' || item.State.ExitCode !== 0 ||
          item.State.Running !== false || item.State.Paused !== false ||
          item.State.Restarting !== false || item.State.OOMKilled !== false ||
          item.State.Dead !== false || item.State.Error !== '' ||
          item.RestartCount !== 0 || !item.State.StartedAt ||
          !item.State.FinishedAt ||
          item.State.StartedAt === '0001-01-01T00:00:00Z' ||
          item.State.FinishedAt === '0001-01-01T00:00:00Z')) fail();
      return;
    }
    if (writerApply) {
      const attachedNames = Object.keys(item.NetworkSettings?.Networks ?? {}).sort();
      if (phase === 'transfer' ?
        !equal(attachedNames, []) && !equal(attachedNames, ['none']) :
        !equal(attachedNames,
          [`${project}_search_admin_db`, `${project}_search_internal`].sort())) fail();
      verifyWriterRoleApplyEffectiveContainer(item, { service: names[phase], id,
        image: images[phase], env: images.env[phase],
        entrypoint: images.entrypoint[phase], repository, project, invocationId,
        publicRoot: trusted.STATION_WRITER_APPLY_PUBLIC_ROOT, volumeName,
        networkIds: [networkIds.search_admin_db, networkIds.search_internal],
        noneNetworkId: networkIds.none, approvedFields });
      if (terminal && (item.State?.Status !== 'exited' || item.State?.ExitCode !== 0 ||
          item.State?.Running !== false || item.State?.OOMKilled !== false ||
          item.State?.Dead !== false || item.State?.Error !== '' ||
          item.RestartCount !== 0 || !item.State?.StartedAt ||
          !item.State?.FinishedAt ||
          item.State.StartedAt === '0001-01-01T00:00:00Z' ||
          item.State.FinishedAt === '0001-01-01T00:00:00Z')) fail();
      return;
    }
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
    async preflight({ invocationRoot, publicRoot, volumeName: name, command }) {
      volumeName = name;
      if (mapping) {
        containerNames = fixedWriterMappingPrepareNames(invocationId);
        trusted = { ...trusted,
          STATION_WRITER_MAPPING_PREPARE_INVOCATION_ROOT: invocationRoot,
          STATION_WRITER_MAPPING_PREPARE_PUBLIC_ROOT: publicRoot,
          STATION_WRITER_MAPPING_PREPARE_VOLUME_NAME: volumeName,
          STATION_WRITER_MAPPING_PREPARE_TRANSFER_NAME: containerNames.transfer,
          STATION_WRITER_MAPPING_PREPARE_READ_NAME: containerNames.prepare };
      } else trusted = writerApply ? { ...trusted,
        STATION_WRITER_APPLY_PUBLIC_ROOT: publicRoot,
        STATION_WRITER_APPLY_VOLUME_NAME: volumeName } :
        writer ? { ...trusted,
        STATION_WRITER_PREPARE_PUBLIC_ROOT: publicRoot,
        STATION_WRITER_PREPARE_INVOCATION_ROOT: invocationRoot,
        STATION_WRITER_PREPARE_VOLUME_NAME: volumeName } :
        apply ? { ...trusted, STATION_CREATE_APPLY_PUBLIC_ROOT: publicRoot,
        STATION_CREATE_APPLY_VOLUME_NAME: volumeName } :
        { ...trusted, STATION_CREATE_INVOCATION_ROOT: invocationRoot,
          STATION_CREATE_VOLUME_NAME: volumeName };
      const response = await compose(['config', '--format', 'json', ...Object.values(names)],
        undefined, false);
      if (response.stderr !== '') fail();
      normalized = JSON.parse(response.stdout);
      if (mapping) verifyWriterMappingPrepareNamedConfig(normalized,
        { repository, project, invocationId, invocationRoot, publicRoot, volumeName });
      else if (writerApply) {
        if (!Array.isArray(command) || !equal(command,
          fixedWriterRoleApplyCommand(command.slice(2)))) fail();
        approvedFields = Object.freeze(command.slice(2));
        commands.apply = command;
        verifyWriterRoleApplyServiceConfig(normalized,
          { project, repository, invocationId, publicRoot, volumeName });
        containerNames = { transfer: `station_writer_transfer_${invocationId.replaceAll('-', '')}`,
          apply: `station_writer_apply_${invocationId.replaceAll('-', '')}` };
        override = await stageWriterRoleApplyOverride({ repository, uid, gid, invocationId,
          transferName: containerNames.transfer, applyName: containerNames.apply,
          transferCommand: commands.transfer, applyCommand: command });
        await override.recheck();
        const merged = JSON.parse((await compose(['config', '--format', 'json',
          ...Object.values(names)])).stdout);
        verifyWriterRoleApplyMergedConfig(merged, { project, repository, invocationId,
          publicRoot, volumeName, transferName: containerNames.transfer,
          applyName: containerNames.apply, approvedFields });
        normalized = merged;
      } else if (writer) verifyWriterRolePrepareServiceConfig(normalized,
        { project, repository, invocationId, invocationRoot, publicRoot, volumeName });
      else if (apply) verifyCreateApplyServiceConfig(normalized,
        { project, repository, invocationId, publicRoot, volumeName });
      else (intent ? verifyCreateIntentPrepareServiceConfig : verifyCreateBoundaryServiceConfig)(normalized,
        { project, repository, invocationId, invocationRoot, volumeName });
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
      if (writerApply || mapping) for (const phase of phases)
        if ((await namedReferences(phase)).length) fail();
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
    async runPhase(phase, beforeStart) {
      if (!Object.hasOwn(names, phase)) fail();
      if (writerApply || mapping) {
        if (typeof beforeStart !== 'function') fail();
        if (writerApply) await override.recheck();
        const rendered = JSON.parse((await compose(['config', '--format', 'json',
          ...Object.values(names)])).stdout);
        if (!equal(rendered, normalized)) fail();
        await infrastructure();
        if ((await serviceReferences(phase)).length ||
            mapping && (await namedReferences(phase)).length) fail();
        const create = await compose(['create', '--no-build', '--pull', 'never',
          '--no-recreate', names[phase]], 20_000);
        const progress = create.stderr.split('\n').filter(Boolean);
        if (create.stdout !== '' || !progress.every(line =>
          new RegExp(`^ ?Container ${containerNames[phase]} {1,2}(Creating|Created)$`).test(line)))
          fail('dispatch-stderr');
        if (mapping && (progress.length !== 2 ||
            !/Creating$/.test(progress[0]) || !/Created$/.test(progress[1])))
          fail('dispatch-stderr');
        const references = await serviceReferences(phase);
        if (references.length !== 1) fail();
        const id = references[0];
        const created = await inspect(id);
        if (mapping && !equal(await namedReferences(phase), [id])) fail();
        if (mapping) verifyWriterMappingPrepareCreatedContainer(created, {
          config: normalized, context: { repository, project, invocationId,
            invocationRoot: trusted.STATION_WRITER_MAPPING_PREPARE_INVOCATION_ROOT,
            publicRoot: trusted.STATION_WRITER_MAPPING_PREPARE_PUBLIC_ROOT, volumeName },
          phase: names[phase], id, image: images[phase], env: images.env[phase],
          entrypoint: images.entrypoint[phase],
          networkIds: { search_admin_db: networkIds.search_admin_db,
            search_internal: networkIds.search_internal },
          noneNetworkId: networkIds.none, terminal: false });
        else verifyWriterRoleApplyCreatedContainer(created, { service: names[phase], id,
          containerName: containerNames[phase], image: images[phase],
          env: images.env[phase], entrypoint: images.entrypoint[phase],
          repository, project, invocationId, publicRoot: trusted.STATION_WRITER_APPLY_PUBLIC_ROOT,
          volumeName, networkIds: [networkIds.search_admin_db, networkIds.search_internal],
          networkByName: { [`${project}_search_admin_db`]: networkIds.search_admin_db,
            [`${project}_search_internal`]: networkIds.search_internal,
            none: networkIds.none },
          noneNetworkId: networkIds.none, approvedFields });
        await infrastructure(); if (writerApply) await override.recheck();
        await beforeStart();
        await infrastructure(); if (writerApply) await override.recheck();
        const started = await docker(['container', 'start', id], 20_000);
        if (started.stdout !== `${id}\n` || started.stderr !== '') fail('dispatch-stdout');
        const running = await inspect(id);
        if (running.Created !== created.Created || running.Name !== created.Name ||
            running.Image !== created.Image ||
            !equal(running.Config?.Labels, created.Config?.Labels)) fail();
        checkedContainer(running, phase, id, running.State?.Status === 'exited');
        if (!['running', 'exited'].includes(running.State?.Status) ||
            running.State?.Running !== (running.State.Status === 'running') ||
            !running.State?.StartedAt ||
            running.State.StartedAt === '0001-01-01T00:00:00Z') fail();
        const waited = await docker(['container', 'wait', id],
          phase === 'transfer' ? 80_000 : mapping ? 210_000 : 330_000, false, true);
        if (waited.stderr !== '' || waited.stdout !== '0\n') fail();
        const finished = await inspect(id);
        if (finished.Created !== created.Created || finished.Name !== created.Name ||
            finished.Image !== created.Image ||
            !equal(finished.Config?.Labels, created.Config?.Labels)) fail();
        checkedContainer(finished, phase, id, true);
        if (mapping && (finished.State.StartedAt !== running.State.StartedAt ||
            running.State.Status === 'exited' &&
            finished.State.FinishedAt !== running.State.FinishedAt)) fail();
        const logs = await docker(['container', 'logs', id], 10_000, false, true);
        if (logs.stderr !== '' || phase === 'transfer' && logs.stdout !== outputs[phase]) fail();
        if (mapping && phase === 'prepare') {
          if (!logs.stdout.endsWith('\n') ||
              Buffer.byteLength(logs.stdout, 'utf8') > 256 * 1024) fail();
          const raw = logs.stdout.slice(0, -1);
          try {
            if (`${canonicalAttestorValue(JSON.parse(raw), 256 * 1024).bytes.toString('utf8')}\n` !==
                logs.stdout) fail();
          } catch { fail(); }
        } else if (!mapping && logs.stdout !== outputs[phase]) fail();
        return { id, phase, image: created.Image, created: created.Created,
          labels: created.Config.Labels, startedAt: finished.State.StartedAt,
          finishedAt: finished.State.FinishedAt, stdout: logs.stdout,
          stderr: logs.stderr, exitCode: finished.State.ExitCode,
          ...(mapping && phase === 'prepare' ? { rawOutput: logs.stdout } : {}) };
      }
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
        phase === 'transfer' ? 80_000 : apply ? 330_000 : writer ? 210_000 : 90_000,
        false, true);
      if (waited.stderr !== '') fail('wait-stderr');
      if (waited.stdout !== '0\n') fail('wait-exit');
      const finished = await inspect(id);
      checkedContainer(finished, phase, id, true);
      const logs = await docker(['container', 'logs', id], 10_000, false, true);
      if (logs.stderr !== '') fail('logs-stderr');
      let projection;
      if (phase === 'prepare' && !writer) {
        if (!logs.stdout.endsWith('\n') || Buffer.byteLength(logs.stdout) > 256 * 1024) fail('logs-stdout');
        try {
          projection = JSON.parse(logs.stdout.slice(0, -1));
          if (`${canonicalAttestorValue(projection, 256 * 1024).bytes.toString('utf8')}\n` !== logs.stdout)
            fail('logs-stdout');
        } catch { fail('logs-stdout'); }
      } else if (writer && phase === 'prepare') {
        if (!logs.stdout.endsWith('\n') || Buffer.byteLength(logs.stdout) > 256 * 1024)
          fail('logs-stdout');
        try {
          const value = JSON.parse(logs.stdout.slice(0, -1));
          if (`${canonicalAttestorValue(value, 256 * 1024).bytes.toString('utf8')}\n` !==
              logs.stdout) fail('logs-stdout');
        } catch { fail('logs-stdout'); }
      } else if (logs.stdout !== outputs[phase]) fail('logs-stdout');
      return { id, phase, image: finished.Image, created: finished.Created,
        labels: finished.Config.Labels, startedAt: finished.State.StartedAt,
        finishedAt: finished.State.FinishedAt,
        ...(phase === 'prepare' && writer ? { rawOutput: logs.stdout } :
          phase === 'prepare' ? { projection } : {}) };
    },
    async cleanupRemote(containers, capturedVolume) {
      if (!Array.isArray(containers) || !equal(containers.map(x => x.phase), phases)) fail();
      if (writerApply) await override.recheck();
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
      if (writerApply || mapping) for (const phase of phases)
        if ((await namedReferences(phase)).length) fail();
      await this.checkVolume(capturedVolume);
      const removed = await docker(['volume', 'rm', volumeName]);
      if (removed.stdout !== `${volumeName}\n` || removed.stderr !== '') fail();
      if (listed((await docker(['volume', 'ls', '--format', '{{.Name}}'])).stdout.trim(),
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/).includes(volumeName)) fail();
    },
    async cleanupPrivate() {
      if (!writerApply) fail();
      await override.cleanup();
    },
  });
}

/** Existing fixed success-only observation adapter. */
export function createBoundaryDockerAdapter(input, options = {}) {
  return fixedBoundaryDockerAdapter(input, options, 'boundary');
}

/** Fixed read-only projection adapter, never an SDK create caller. */
export function createIntentPrepareDockerAdapter(input, options = {}) {
  return fixedBoundaryDockerAdapter(input, options, 'intent');
}

/** Fixed approved create delivery; the owner supplies the original sealed sources. */
export function createApplyDockerAdapter(input, options = {}) {
  return fixedBoundaryDockerAdapter(input, options, 'apply');
}

/** Fixed writer-role read-only proposal adapter; no caller-selected command. */
export function createWriterRolePrepareDockerAdapter(input, options = {}) {
  return fixedBoundaryDockerAdapter(input, options, 'writer-prepare');
}

/** Fixed one-shot writer-role delivery with created-before-start inspection. */
export function createWriterRoleApplyDockerAdapter(input, options = {}) {
  return fixedBoundaryDockerAdapter(input, options, 'writer-apply');
}

/** Fixed read-only writer-mapping proposal with created-before-start inspection. */
export function createWriterMappingPrepareDockerAdapter(input, options = {}) {
  return fixedBoundaryDockerAdapter(input, options, 'writer-mapping-prepare');
}
