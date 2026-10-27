import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { createSearchAdminDockerAdapter } from './search-admin-credentials.mjs';
import { operateSearchAdminCredentialsAlreadyJobLocked } from './search-admin-credential-core.mjs';
import { verifyAttestorServiceConfig } from './search-attestor-service-config.mjs';

const fail = () => { throw new Error('Private search attestor Docker evidence failed.'); };
const idPattern = /^[0-9a-f]{64}$/;
const imagePattern = /^sha256:[0-9a-f]{64}$/;
const containerPattern = /^[0-9a-f]{12,64}$/;
const fixedNames = { prepare: 'search-attestor-prepare', transfer: 'search-attestor-transfer',
  attestor: 'search-engine-attestor' };
const fixedOutput = { prepare: 'Private search attestor preparation completed.\n',
  transfer: 'Private search attestor transfer completed.\n',
  attestor: 'Private search attestor verification completed.\n' };
const commands = { prepare: ['node', 'scripts/search-attestor-prepare.mjs'],
  transfer: ['node', 'scripts/search-attestor-transfer.mjs'],
  attestor: ['node', 'scripts/search-attestor-combined.mjs'] };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (value, expected) => value && typeof value === 'object' &&
  !Array.isArray(value) && equal(Object.keys(value).sort(), [...expected].sort());
const keysSubset = (value, allowed) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const listed = (body, pattern, max) => {
  const lines = body === '' ? [] : body.split('\n');
  if (lines.length > max || lines.some(line => !pattern.test(line)) || new Set(lines).size !== lines.length) fail();
  return lines;
};
const oneJson = text => {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] ||
      typeof parsed[0] !== 'object') fail();
  return parsed[0];
};
const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function captureCredential(repository, uid, gid) {
  const root = path.join(repository, '.cache/search-db/initial-v1');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== uid ||
      rootStat.gid !== gid || (rootStat.mode & 0o777) !== 0o700 ||
      await realpath(root) !== root) fail();
  const capture = async (name, min, max) => {
    const filename = path.join(root, name);
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
          ![0o400, 0o600].includes(stat.mode & 0o777) || stat.size < min ||
          stat.size > max || !sameStat(stat, await lstat(filename)) ||
          await realpath(filename) !== filename) fail();
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size || !sameStat(stat, await handle.stat()) ||
          !sameStat(stat, await lstat(filename))) fail();
      return { stat, bytes: buffer.subarray(0, bytesRead) };
    } finally { await handle.close(); }
  };
  return { rootStat, metadata: await capture('operation.json', 2, 4096),
    verifier: await capture('verifier.password', 43, 43) };
}

function environment(base, trusted) {
  const result = { ...base, ...trusted };
  for (const key of Object.keys(result)) if (key.startsWith('PG') ||
      key.startsWith('COMPOSE_') ||
      key.startsWith('STATION_ATTESTOR_') && !Object.hasOwn(trusted, key)) delete result[key];
  return result;
}

export function createAttestorDockerAdapter({ repository, uid, gid, jobLock,
  invocationId, deadline, tick }, options = {}) {
  if (Object.keys(process.env).some(key => key.startsWith('DOCKER_') ||
      key.startsWith('COMPOSE_') || key.startsWith('STATION_ATTESTOR_'))) fail();
  const ownerFactory = options.ownerFactory ?? createSearchAdminDockerAdapter;
  const verifyCredentials = options.verifyCredentials ?? operateSearchAdminCredentialsAlreadyJobLocked;
  const credentialCapture = options.credentialCapture ?? captureCredential;
  const runCommand = options.command ?? (async (args, env, timeoutMs = 10_000) => {
    const remaining = Math.min(timeoutMs, Math.floor(deadline - performance.now()));
    if (remaining < 1) fail();
    const child = spawn('docker', args, { cwd: repository, env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    const outputs = [[], []]; let sizes = [0, 0], overflow = false, timedOut = false;
    const collect = (index, chunk) => {
      sizes[index] += chunk.length;
      if (sizes[index] > 256 * 1024) { overflow = true; child.kill('SIGKILL'); }
      else outputs[index].push(chunk);
    };
    child.stdout.on('data', chunk => collect(0, chunk));
    child.stderr.on('data', chunk => collect(1, chunk));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, remaining);
    try {
      const exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      if (overflow || timedOut || exit.signal) fail();
      return { ...exit, stdout: Buffer.concat(outputs[0]).toString('utf8'),
        stderr: Buffer.concat(outputs[1]).toString('utf8') };
    } finally { clearTimeout(timer); }
  });
  const docker = async (args, timeoutMs = 10_000) => {
    tick();
    const response = await runCommand(args, environment(process.env, trusted), timeoutMs);
    tick();
    if (!response || response.code !== 0 || response.signal ||
        typeof response.stdout !== 'string' || typeof response.stderr !== 'string' ||
        Buffer.byteLength(response.stdout) > 256 * 1024 ||
        Buffer.byteLength(response.stderr) > 256 * 1024) fail();
    return response;
  };
  const composeArgs = ['compose', '-f', 'compose.yaml', '-f', 'compose.search-attestor.yaml'];
  let installation, retained, project, adminNetwork, postgresId, normalized,
    volumeName, networkIds, volumeIds, images;
  let trusted = { APP_UID: String(uid), APP_GID: String(gid) };
  const compose = (args, timeout) => docker([...composeArgs, '-p', project,
    '--profile', 'search-attestor', ...args], timeout);
  const inspect = async id => oneJson((await docker(['container', 'inspect', id])).stdout);
  const inspectVolume = async name => oneJson((await docker(['volume', 'inspect', name])).stdout);
  const sameVolume = (a, b) => a.Name === b.Name && a.Driver === b.Driver &&
    a.Scope === b.Scope && a.CreatedAt === b.CreatedAt && a.Mountpoint === b.Mountpoint &&
    equal(a.Labels, b.Labels) && equal(a.Options, b.Options);
  const expectVolume = item => {
    if (!item || item.Name !== volumeName || item.Driver !== 'local' ||
        item.Scope !== 'local' || !item.CreatedAt || typeof item.CreatedAt !== 'string' ||
        !keys(item.Labels, ['station.attestor.project', 'station.attestor.invocation']) ||
        item.Labels['station.attestor.project'] !== project ||
        item.Labels['station.attestor.invocation'] !== invocationId ||
        item.Options !== null && !keys(item.Options, [])) fail();
  };
  const checkContainer = (item, phase, id, terminal) => {
    const expected = normalized.services[fixedNames[phase]];
    if (item.Id !== id || !item.Config || !item.HostConfig || !item.NetworkSettings ||
        item.Image !== images[phase] || !imagePattern.test(item.Image) ||
        item.Config.User !== (phase === 'prepare' ? `${uid}:${gid}` :
          phase === 'transfer' ? '0:0' : '1000:1000') ||
        !equal(item.Config.Cmd, commands[phase]) ||
        !equal(item.Config.Entrypoint, images.entrypoint[phase]) ||
        !equal(item.Config.Env, images.env[phase]) ||
        item.Config.Labels?.['com.docker.compose.project'] !== project ||
        item.Config.Labels?.['com.docker.compose.service'] !== fixedNames[phase] ||
        item.HostConfig.Privileged !== false || item.HostConfig.ReadonlyRootfs !== true ||
        !equal(item.HostConfig.CapDrop?.map(x => x.toUpperCase()), ['ALL']) ||
        !equal((item.HostConfig.CapAdd ?? []).map(x => x.toUpperCase()).sort(),
          phase === 'transfer' ? ['CHOWN', 'DAC_OVERRIDE'] : []) ||
        item.HostConfig.PidsLimit !== (phase === 'attestor' ? 128 : 64) ||
        item.HostConfig.Memory !== (phase === 'attestor' ? 536870912 : 268435456) ||
        item.HostConfig.NanoCpus !== (phase === 'attestor' ? 1e9 : 5e8) ||
        item.HostConfig.RestartPolicy?.Name !== 'no' ||
        !equal(item.HostConfig.SecurityOpt, ['no-new-privileges:true']) ||
        (item.HostConfig.Devices ?? []).length !== 0 ||
        (item.HostConfig.GroupAdd ?? []).length !== 0 ||
        item.HostConfig.PidMode !== '' ||
        item.HostConfig.IpcMode !== 'private' ||
        Object.keys(item.HostConfig.PortBindings ?? {}).length !== 0 ||
        Object.values(item.NetworkSettings.Ports ?? {}).some(value => value !== null)) fail();
    const wantedTmpfs = expected.tmpfs[0].slice('/tmp:'.length);
    if (!keys(item.HostConfig.Tmpfs, ['/tmp']) ||
        item.HostConfig.Tmpfs['/tmp'] !== wantedTmpfs) fail();
    const actualMounts = new Map();
    for (const mount of item.Mounts ?? []) {
      if (actualMounts.has(mount.Destination)) fail();
      actualMounts.set(mount.Destination, mount);
    }
    if (actualMounts.size !== expected.volumes.length) fail();
    for (const mount of expected.volumes) {
      const actual = actualMounts.get(mount.target);
      const source = mount.type === 'bind' ? mount.source :
        normalized.volumes[mount.source]?.name;
      if (!actual || actual.Type !== mount.type || actual.Destination !== mount.target ||
          (mount.type === 'bind' ? actual.Source !== source : actual.Name !== source) ||
          actual.RW !== !mount.read_only) fail();
    }
    const hostMounts = item.HostConfig.Mounts;
    if (!Array.isArray(hostMounts) || hostMounts.length !== expected.volumes.length ||
        (item.HostConfig.Binds ?? []).length !== 0 ||
        (item.HostConfig.VolumesFrom ?? []).length !== 0) fail();
    const byTarget = new Map();
    for (const mount of hostMounts) {
      if (!mount || typeof mount.Target !== 'string' || byTarget.has(mount.Target)) fail();
      byTarget.set(mount.Target, mount);
    }
    for (const wanted of expected.volumes) {
      const actual = byTarget.get(wanted.target);
      const source = wanted.type === 'bind' ? wanted.source :
        normalized.volumes[wanted.source]?.name;
      if (!actual || actual.Type !== wanted.type || actual.Source !== source ||
          actual.Target !== wanted.target ||
          (wanted.read_only ? actual.ReadOnly !== true :
            ![undefined, false].includes(actual.ReadOnly)) ||
          ![undefined, '', 'default'].includes(actual.Consistency) ||
          actual.TmpfsOptions != null || actual.ImageOptions != null ||
          actual.ClusterOptions != null) fail();
      if (wanted.type === 'bind') {
        const opts = actual.BindOptions;
        if (actual.VolumeOptions != null || opts != null &&
            (!keysSubset(opts, ['Propagation', 'NonRecursive', 'CreateMountpoint',
              'ReadOnlyNonRecursive', 'ReadOnlyForceRecursive']) ||
              ![undefined, '', 'rprivate'].includes(opts.Propagation) ||
              ![undefined, false].includes(opts.NonRecursive) ||
              ![undefined, false].includes(opts.CreateMountpoint) ||
              ![undefined, false].includes(opts.ReadOnlyNonRecursive) ||
              ![undefined, false].includes(opts.ReadOnlyForceRecursive))) fail();
      } else {
        const opts = actual.VolumeOptions;
        if (actual.BindOptions != null ||
            (wanted.volume?.nocopy === true ? opts == null || opts.NoCopy !== true :
              opts != null && ![undefined, false].includes(opts.NoCopy)) ||
            opts != null && (!keysSubset(opts, ['NoCopy', 'Labels', 'Subpath', 'DriverConfig']) ||
              opts.Labels != null && !keys(opts.Labels, []) ||
              ![undefined, ''].includes(opts.Subpath) ||
              opts.DriverConfig != null)) fail();
      }
    }
    const networkMap = item.NetworkSettings.Networks ?? {};
    const actualNetworks = Object.values(networkMap).map(network => network.NetworkID).sort();
    const expectedNetworks = phase === 'transfer' ? [networkIds.none] :
      (phase === 'prepare' ? [networkIds.search_admin_db] :
        [networkIds.search_admin_db, networkIds.search_internal]).sort();
    if (phase === 'transfer') {
      if (item.HostConfig.NetworkMode !== 'none' ||
          !(keys(networkMap, []) && actualNetworks.length === 0 ||
            keys(networkMap, ['none']) && equal(actualNetworks, expectedNetworks))) fail();
    } else if (!equal(actualNetworks, expectedNetworks)) fail();
    if (terminal && (item.State?.Status !== 'exited' || item.State?.ExitCode !== 0 ||
        !item.State?.StartedAt || !item.State?.FinishedAt ||
        item.State.StartedAt === '0001-01-01T00:00:00Z' ||
        item.State.FinishedAt === '0001-01-01T00:00:00Z' ||
        item.State.Running !== false || item.State.OOMKilled !== false ||
        item.State.Dead !== false || item.State.Error !== '' ||
        item.RestartCount !== 0)) fail();
  };
  const recheckInfrastructure = async () => {
    for (const name of ['search_admin_db', 'search_internal', 'none']) {
      const observed = oneJson((await docker(['network', 'inspect',
        name === 'none' ? name : `${project}_${name}`])).stdout);
      if (observed.Id !== networkIds[name]) fail();
    }
    for (const name of ['search_admin_certs', 'search_security_state']) {
      const current = await inspectVolume(`${project}_${name}`);
      if (!sameVolume(current, volumeIds[name])) fail();
    }
    for (const phase of Object.keys(fixedNames)) {
      const current = oneJson((await docker(['image', 'inspect',
        `${project}-${fixedNames[phase]}`])).stdout);
      if (current.Id !== images[phase] ||
          !equal(current.Config?.Env, images.env[phase]) ||
          !equal(current.Config?.Entrypoint, images.entrypoint[phase])) fail();
    }
  };
  return Object.freeze({
    async verifyOwner() {
      installation = await ownerFactory(uid, gid);
      await verifyCredentials({ action: 'verify',
        root: path.join(repository, '.cache/search-db'), uid, gid,
        adapter: installation, jobLock });
      retained = await credentialCapture(repository, uid, gid);
      const metadata = JSON.parse(retained.metadata.bytes.toString('utf8'));
      const identity = await installation.identity();
      if (metadata.project !== identity.project || metadata.databaseOid !== identity.databaseOid ||
          metadata.systemIdentifier !== identity.systemIdentifier ||
          metadata.uid !== uid || metadata.gid !== gid) fail();
      project = identity.project;
      postgresId = await installation.containerId();
      if (!containerPattern.test(postgresId)) fail();
      adminNetwork = await installation.adminNetwork();
      if (!idPattern.test(adminNetwork.id) ||
          !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(adminNetwork.ip)) fail();
    },
    async captureOwner() {
      if (!retained || !project) fail();
      return { project, databaseOid: (await installation.identity()).databaseOid,
        adminNetwork };
    },
    async recheckOwner(owner) {
      const current = await credentialCapture(repository, uid, gid);
      if (!sameStat(current.rootStat, retained.rootStat) ||
          !sameStat(current.metadata.stat, retained.metadata.stat) ||
          !sameStat(current.verifier.stat, retained.verifier.stat) ||
          !current.metadata.bytes.equals(retained.metadata.bytes) ||
          !current.verifier.bytes.equals(retained.verifier.bytes)) fail();
      const fresh = await ownerFactory(uid, gid);
      const identity = await fresh.identity();
      if (identity.project !== owner.project || identity.databaseOid !== owner.databaseOid ||
          !equal(identity, await installation.identity())) fail();
      if (await fresh.containerId() !== postgresId) fail();
      if (!equal(await fresh.adminNetwork(), owner.adminNetwork)) fail();
      await verifyCredentials({ action: 'verify',
        root: path.join(repository, '.cache/search-db'), uid, gid,
        adapter: fresh, jobLock });
    },
    async preflight({ invocationRoot, publicRoot, volumeName: suppliedVolume }) {
      if (!project) fail();
      volumeName = suppliedVolume;
      trusted = { ...trusted, STATION_ATTESTOR_INVOCATION_ROOT: invocationRoot,
        STATION_ATTESTOR_PUBLIC_ROOT: publicRoot, STATION_ATTESTOR_VOLUME_NAME: volumeName };
      const config = await compose(['config', '--format', 'json',
        ...Object.values(fixedNames)]);
      if (config.stderr !== '') fail();
      normalized = JSON.parse(config.stdout);
      verifyAttestorServiceConfig(normalized, { project, uid, gid, repository,
        invocationId, invocationRoot, publicRoot, volumeName });
      networkIds = {};
      for (const name of ['search_admin_db', 'search_internal']) {
        const network = oneJson((await docker(['network', 'inspect', `${project}_${name}`])).stdout);
        if (!idPattern.test(network.Id) || network.Internal !== true ||
            network.Labels?.['com.docker.compose.project'] !== project ||
            network.Labels?.['com.docker.compose.network'] !== name) fail();
        networkIds[name] = network.Id;
      }
      if (networkIds.search_admin_db !== adminNetwork.id) fail();
      const none = oneJson((await docker(['network', 'inspect', 'none'])).stdout);
      if (!idPattern.test(none.Id) || none.Name !== 'none') fail();
      networkIds.none = none.Id;
      volumeIds = {};
      for (const name of ['search_admin_certs', 'search_security_state']) {
        const volume = await inspectVolume(`${project}_${name}`);
        if (volume.Driver !== 'local' || volume.Scope !== 'local' ||
            volume.Labels?.['com.docker.compose.project'] !== project ||
            volume.Labels?.['com.docker.compose.volume'] !== name) fail();
        volumeIds[name] = volume;
      }
      images = { env: {}, entrypoint: {} };
      for (const phase of Object.keys(fixedNames)) {
        const image = oneJson((await docker(['image', 'inspect', `${project}-${fixedNames[phase]}`])).stdout);
        if (!imagePattern.test(image.Id) ||
            !equal(image.Config?.Cmd, ['node', 'apps/server/dist/main.js']) ||
            !equal(image.Config?.Entrypoint, ['docker-entrypoint.sh'])) fail();
        images[phase] = image.Id;
        images.env[phase] = image.Config.Env;
        images.entrypoint[phase] = image.Config.Entrypoint;
      }
    },
    async volumeAbsent(name) {
      if (name !== volumeName) fail();
      const result = await docker(['volume', 'ls', '--format', '{{.Name}}']);
      if (listed(result.stdout.trim(), /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/, 4096)
        .includes(name)) fail();
    },
    async createVolume(name) {
      if (name !== volumeName) fail();
      const result = await docker(['volume', 'create', '--driver', 'local',
        '--label', `station.attestor.project=${project}`,
        '--label', `station.attestor.invocation=${invocationId}`, name]);
      if (result.stdout !== `${name}\n` || result.stderr !== '') fail();
      const item = await inspectVolume(name);
      expectVolume(item);
      return item;
    },
    async checkVolume(captured) {
      const current = await inspectVolume(volumeName);
      expectVolume(current);
      if (!sameVolume(current, captured)) fail();
    },
    async runPhase(phase) {
      if (!Object.hasOwn(fixedNames, phase)) fail();
      const rendered = await compose(['config', '--format', 'json',
        ...Object.values(fixedNames)]);
      if (rendered.stderr !== '') fail();
      const currentConfig = JSON.parse(rendered.stdout);
      verifyAttestorServiceConfig(currentConfig, { project, uid, gid, repository,
        invocationId, invocationRoot: trusted.STATION_ATTESTOR_INVOCATION_ROOT,
        publicRoot: trusted.STATION_ATTESTOR_PUBLIC_ROOT, volumeName });
      if (!equal(currentConfig, normalized)) fail();
      await recheckInfrastructure();
      const response = await compose(['run', '--detach', '--no-deps', '--pull', 'never',
        fixedNames[phase]], 20_000);
      if (!idPattern.test(response.stdout.trim()) || response.stderr !== '' ||
          response.stdout !== `${response.stdout.trim()}\n`) fail();
      const id = response.stdout.trim();
      const started = await inspect(id);
      checkContainer(started, phase, id, false);
      const waited = await docker(['container', 'wait', id], phase === 'attestor' ? 90_000 : 80_000);
      if (waited.stdout !== '0\n' || waited.stderr !== '') fail();
      const finished = await inspect(id);
      checkContainer(finished, phase, id, true);
      const logs = await docker(['container', 'logs', id]);
      if (logs.stdout !== fixedOutput[phase] || logs.stderr !== '') fail();
      return { id, phase, image: finished.Image,
        created: finished.Created, labels: finished.Config.Labels,
        startedAt: finished.State.StartedAt, finishedAt: finished.State.FinishedAt };
    },
    async cleanupRemote(containers, volume) {
      if (!Array.isArray(containers) || !equal(containers.map(x => x.phase),
        ['prepare', 'transfer', 'attestor'])) fail();
      for (const item of containers) {
        const current = await inspect(item.id);
        checkContainer(current, item.phase, item.id, true);
        if (current.Created !== item.created || !equal(current.Config.Labels, item.labels) ||
            current.Image !== item.image || current.State.StartedAt !== item.startedAt ||
            current.State.FinishedAt !== item.finishedAt) fail();
      }
      await this.checkVolume(volume);
      const references = listed((await docker(['ps', '-a', '--no-trunc', '--filter',
        `volume=${volumeName}`, '--format', '{{.ID}}'])).stdout.trim(), idPattern, 4096);
      const expected = containers.filter(x => x.phase !== 'prepare').map(x => x.id);
      if (!equal(references.sort(), expected.sort())) fail();
      for (const item of [...containers].reverse()) {
        const response = await docker(['container', 'rm', item.id]);
        if (response.stdout !== `${item.id}\n` || response.stderr !== '') fail();
      }
      const after = listed((await docker(['ps', '-a', '--no-trunc', '--filter',
        `volume=${volumeName}`, '--format', '{{.ID}}'])).stdout.trim(), idPattern, 4096);
      if (after.length) fail();
      await this.checkVolume(volume);
      const removed = await docker(['volume', 'rm', volumeName]);
      if (removed.stdout !== `${volumeName}\n` || removed.stderr !== '') fail();
      const names = listed((await docker(['volume', 'ls', '--format', '{{.Name}}'])).stdout.trim(),
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/, 4096);
      if (names.includes(volumeName)) fail();
    },
  });
}
