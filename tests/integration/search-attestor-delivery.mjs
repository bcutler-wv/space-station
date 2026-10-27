import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runAttestorOwner } from '../../scripts/search-attestor-owner-core.mjs';
import { createAttestorDockerAdapter } from '../../scripts/search-attestor-owner-docker.mjs';
import { createSearchAdminDockerAdapter } from '../../scripts/search-admin-credentials.mjs';
import { verifyAttestorServiceConfig } from '../../scripts/search-attestor-service-config.mjs';

// Real Docker/PG16/OpenSearch delivery. Only the disposable failure cases
// intercept a CLI response after its actual Docker operation has been sent.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let checkpoint = 'setup';
const redactedFailure = () => {
  process.stderr.write(`Attestor delivery fixture failed at ${checkpoint}.\n`);
  process.exit(1);
};
process.on('uncaughtException', redactedFailure);
process.on('unhandledRejection', redactedFailure);
assert.equal(process.cwd(), repository);
assert.ok(process.getuid() > 0 && process.getgid() > 0);
assert.equal(process.env.APP_UID, String(process.getuid()));
assert.equal(process.env.APP_GID, String(process.getgid()));
assert.ok(!Object.keys(process.env).some(key => key.startsWith('DOCKER_') || key.startsWith('COMPOSE_')));
const project = path.basename(repository);
assert.match(project, /^stationattestor(?:default|runner)[0-9a-f]{12}$/);
const image = `${project}-search-attestor-transfer`;
const stateVolume = `${project}_search_security_state`;
const credential = path.join(repository, '.cache/search-db/initial-v1/verifier.password');
const transitionCredential = path.join(repository, '.cache/search-db/initial-v1/transition.password');
const metadata = path.join(repository, '.cache/search-db/initial-v1/operation.json');
const lock = path.join(repository, '.cache/search-db/.job-operation.lock');
const invocationParent = path.join(repository, '.cache/search-attestor-invocations');
const publicParent = path.join(repository, '.cache/search-attestor-public');
const fixedFailure = 'Private search attestor owner operation failed; inspect private retained evidence.\n';
const coreFailure = 'Private search attestor owner operation failed.';
const id = /^[0-9a-f]{64}$/;
const volumePattern = new RegExp(`^${project}_search_attestor_[0-9a-f]{32}$`);
const phaseServices = ['search-attestor-prepare', 'search-attestor-transfer', 'search-engine-attestor'];
const exactAddedCapabilities = (value, phase) => {
  const observed = value ?? [];
  const wanted = phase === 'transfer' ? ['CHOWN', 'DAC_OVERRIDE'] : [];
  if (!Array.isArray(observed) || observed.length !== wanted.length) return false;
  const names = observed.map(item => {
    if (item === 'CHOWN' || item === 'CAP_CHOWN') return 'CHOWN';
    if (item === 'DAC_OVERRIDE' || item === 'CAP_DAC_OVERRIDE') return 'DAC_OVERRIDE';
    return null;
  });
  return JSON.stringify(names.sort()) === JSON.stringify(wanted);
};

async function command(binary, args, env = process.env, timeoutMs = 30_000) {
  const child = spawn(binary, args, { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', overflow = false, timedOut = false;
  const collect = (current, chunk) => {
    if (Buffer.byteLength(current) + chunk.length > 256 * 1024) {
      overflow = true; child.kill('SIGKILL'); return current;
    }
    return current + chunk.toString('utf8');
  };
  child.stdout.on('data', chunk => { stdout = collect(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = collect(stderr, chunk); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(overflow, false);
    assert.equal(timedOut, false);
    return { ...result, stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function docker(args, timeoutMs = 30_000) {
  const result = await command('docker', args, process.env, timeoutMs);
  assert.equal(result.code, 0, `Docker fixture command failed: ${args.slice(0, 3).join(' ')}`);
  assert.equal(result.signal, null);
  return result.stdout;
}
const one = async args => {
  const result = (await docker(args)).trim();
  assert.ok(result && !result.includes('\n'));
  return result;
};
const sameFile = (a, b) => a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino &&
  a.stat.uid === b.stat.uid && a.stat.gid === b.stat.gid && a.stat.mode === b.stat.mode &&
  a.bytes.equals(b.bytes);
async function capture(file) { return { stat: await stat(file), bytes: await readFile(file) }; }
const originalCredential = await capture(credential);
const originalTransitionCredential = await capture(transitionCredential);
const originalMetadata = await capture(metadata);
const envText = await readFile(path.join(repository, '.env'), 'utf8');
const postgresSecret = envText.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1];
assert.ok(postgresSecret && postgresSecret.length >= 32);
const privateKey = await readFile(path.join(repository, '.cache/search-security/ca.key'), 'utf8');
const markers = [originalCredential.bytes.toString('utf8').trim(),
  originalTransitionCredential.bytes.toString('utf8').trim(), postgresSecret,
  privateKey.split('\n').find(line => line.length >= 40)?.slice(0, 32)].filter(Boolean);
function secretFree(...outputs) {
  for (const output of outputs) for (const marker of markers)
    assert.ok(!output.includes(marker), 'Generated secret marker reached captured output');
}
async function credentialUnchanged() {
  assert.ok(sameFile(originalCredential, await capture(credential)));
  assert.ok(sameFile(originalTransitionCredential, await capture(transitionCredential)));
  assert.ok(sameFile(originalMetadata, await capture(metadata)));
}
async function names(args) {
  const text = (await docker(args)).trim();
  const list = text ? text.split('\n') : [];
  assert.ok(list.length <= 32 && list.every(value => /^[a-zA-Z0-9_.-]{1,255}$/.test(value)));
  return list;
}
async function serviceContainers() {
  const result = {};
  for (const service of phaseServices) {
    const text = (await docker(['ps', '-a', '--no-trunc', '--filter',
      `label=com.docker.compose.project=${project}`, '--filter',
      `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'])).trim();
    result[service] = text ? text.split('\n') : [];
    assert.ok(result[service].length <= 2 && result[service].every(value => id.test(value)));
  }
  return result;
}
async function invocationVolumes() {
  const volumes = await names(['volume', 'ls', '--filter', `label=station.attestor.project=${project}`,
    '--format', '{{.Name}}']);
  assert.ok(volumes.every(value => volumePattern.test(value)));
  return volumes;
}
async function existing(pathname) { return await stat(pathname).then(() => true, () => false); }
async function retained() {
  assert.equal(await existing(lock), true, 'attempted failure retains global lock');
  assert.equal((await stat(lock)).mode & 0o777, 0o600);
  const roots = await readdir(invocationParent);
  assert.equal(roots.length, 1, 'one invocation root retained');
  assert.match(roots[0], /^[0-9a-f-]{36}$/);
  return roots[0];
}
async function noRetained() {
  assert.equal(await existing(lock), false);
  assert.deepEqual(await readdir(invocationParent), []);
  assert.deepEqual(await readdir(publicParent), []);
  assert.deepEqual(await invocationVolumes(), []);
  const containers = await serviceContainers();
  assert.ok(Object.values(containers).every(list => list.length === 0));
}
async function gatesOff() {
  const postgresId = await one(['compose', 'ps', '-q', 'postgres']);
  assert.match(postgresId, id);
  const row = (await docker(['exec', postgresId, 'psql', '-X', '-U', 'station', '-d', 'station',
    '-Atqc', "SELECT publication_enabled::text || '|' || serving_ready::text FROM search_generation_control WHERE singleton=1"])).trim();
  assert.equal(row, 'false|false');
}
async function fixtureTeardown() {
  const containers = await serviceContainers();
  for (const item of Object.values(containers).flat()) await docker(['container', 'rm', '-f', item]);
  const extra = (await docker(['ps', '-a', '--no-trunc', '--filter',
    `label=station.attestor.gate=${project}`, '--format', '{{.ID}}'])).trim();
  for (const item of extra ? extra.split('\n') : []) {
    assert.match(item, id); await docker(['container', 'rm', '-f', item]);
  }
  for (const volume of await invocationVolumes()) await docker(['volume', 'rm', volume]);
  await rm(lock, { force: true });
  for (const parent of [invocationParent, publicParent]) {
    if (await existing(parent)) {
      const children = await readdir(parent);
      assert.ok(children.length <= 1);
      for (const child of children) {
        assert.match(child, /^[0-9a-f-]{36}$/);
        await rm(path.join(parent, child), { recursive: true, force: true });
      }
    }
  }
}

const stateScript = String.raw`
  const fs=require('node:fs');
  const mode=process.argv[1], uuid=process.argv[2];
  const root='/state';
  const remove=name=>fs.rmSync(root+'/'+name,{force:true});
  const fixed=(name,text,uid,permissions)=>{
    fs.writeFileSync(root+'/'+name,text);
    fs.chownSync(root+'/'+name,uid,1000);
    fs.chmodSync(root+'/'+name,permissions);
  };
  if(mode==='complete'){
    fixed('phase','ready\n',0,0o660);
    fixed('v1-first-init','v1\n',0,0o440);
    fixed('v1-profile-grant','v1\n',0,0o440);
    fixed('v1-profile-claim','v1\n',1000,0o600);
    fixed('v1-profile-complete','v1\n'+uuid+'\n',1000,0o600);
  } else if(mode==='fresh'){
    fixed('phase','fresh\n',0,0o660);
    remove('v1-profile-claim'); remove('v1-profile-complete');
  } else if(mode==='unintroduced'){
    remove('v1-profile-claim'); remove('v1-profile-complete');
  } else if(mode==='incomplete'){
    remove('v1-profile-complete');
  } else if(mode==='legacy'){
    for(const name of ['v1-first-init','v1-profile-grant','v1-profile-claim','v1-profile-complete'])remove(name);
  } else process.exit(2);
`;
async function stateSnapshot() {
  const script = String.raw`
    const fs=require('node:fs');
    const root='/state';
    const output={};
    for(const name of fs.readdirSync(root).sort()){
      const s=fs.lstatSync(root+'/'+name);
      output[name]=[s.uid,s.gid,s.mode&0o777,s.isFile(),
        s.isFile()?fs.readFileSync(root+'/'+name).toString('base64'):null];
    }
    const s=fs.lstatSync(root);
    process.stdout.write(JSON.stringify({root:[s.uid,s.gid,s.mode&0o777],files:output}));
  `;
  return JSON.parse(await one(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--read-only', '--user', '0:0', '--mount', `type=volume,source=${stateVolume},target=/state,readonly`,
    image, 'node', '-e', script]));
}
const completeState = await stateSnapshot();
assert.deepEqual(completeState.root, [0, 1000, 0o770]);
assert.deepEqual(Object.keys(completeState.files).sort(),
  ['phase', 'v1-first-init', 'v1-profile-claim', 'v1-profile-complete', 'v1-profile-grant']);
const marker = await one(['run', '--rm', '--pull', 'never', '--network', 'none',
  '--user', '1000:1000', '--mount', `type=volume,source=${stateVolume},target=/state,readonly`,
  image, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/state/v1-profile-complete','utf8').split(String.fromCharCode(10))[1])"]);
assert.match(marker, /^[A-Za-z0-9_-]{1,128}$/);
async function stateMode(mode) {
  await docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '0:0',
    '--mount', `type=volume,source=${stateVolume},target=/state`, image,
    'node', '-e', stateScript, mode, marker]);
}

async function networkProof() {
  const sentinel = (await one(['run', '-d', '--pull', 'never', '--network', `${project}_default`,
    '--network-alias', 'fixture-sentinel', '--label', `station.attestor.gate=${project}`,
    '--user', '1000:1000', image, 'node', '-e',
    "require('node:net').createServer(()=>{}).listen(9199,'0.0.0.0')"]));
  assert.match(sentinel, id);
  try {
    const postgres = await one(['compose', 'ps', '-q', 'postgres']);
    const opensearch = await one(['compose', '--profile', 'search', 'ps', '-q', 'opensearch']);
    assert.match(postgres, id); assert.match(opensearch, id);
    const containerIp = async (container, network) => {
      const item = JSON.parse(await docker(['container', 'inspect', container]))[0];
      assert.equal(item.Id, container);
      const ip = item.NetworkSettings.Networks[network]?.IPAddress;
      assert.match(ip, /^(?:\d{1,3}\.){3}\d{1,3}$/);
      return ip;
    };
    const targets = [
      await containerIp(postgres, `${project}_default`),
      await containerIp(postgres, `${project}_search_admin_db`),
      await containerIp(opensearch, `${project}_search_internal`),
      await containerIp(sentinel, `${project}_default`),
    ];
    assert.equal(new Set(targets).size, 4);
    for (const [profile, network] of [['default', `${project}_default`],
      ['admin', `${project}_search_admin_db`],
      ['internal', `${project}_search_internal`], ['none', 'none']]) {
      const output = await docker(['run', '--rm', '--pull', 'never', '--network', network,
        '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000', image,
        'node', 'tests/support/search-attestor-delivery-network.mjs', profile, ...targets]);
      assert.equal(output, `Network isolation probe passed for ${profile}.\n`);
    }
    const combined = await one(['container', 'create', '--pull', 'never', '--network',
      `${project}_search_admin_db`, '--label', `station.attestor.gate=${project}`,
      '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000', image,
      'node', 'tests/support/search-attestor-delivery-network.mjs', 'combined', ...targets]);
    assert.match(combined, id);
    try {
      await docker(['network', 'connect', `${project}_search_internal`, combined]);
      await docker(['container', 'start', combined]);
      assert.equal((await docker(['container', 'wait', combined])).trim(), '0');
      assert.equal(await docker(['container', 'logs', combined]),
        'Network isolation probe passed for combined.\n');
    } finally { await docker(['container', 'rm', '-f', combined]); }
  } finally { await docker(['container', 'rm', '-f', sentinel]); }
}
checkpoint = 'network-proof';
await networkProof();

// Exercise the unmodified fixed production wrapper once for each owner pair.
checkpoint = 'complete-cli';
const successful = await command('node', ['scripts/search-attestor-owner.mjs'], process.env, 245_000);
secretFree(successful.stdout, successful.stderr);
if (successful.code !== 0) {
  // Read-only fixture forensics. Never print retained records, Docker output,
  // paths, IDs, or the fixed owner's private subprocess errors.
  const emit = (name, value) => process.stdout.write(`Attestor delivery diagnostic ${name}=${value}.\n`);
  const count = async directory => await readdir(directory).then(items => Math.min(items.length, 99), () => -1);
  const inspectDocker = async args => {
    const result = await command('docker', args, process.env, 5000);
    if (result.code !== 0 || result.signal) throw new Error('diagnostic unavailable');
    return result.stdout;
  };
  let invocationId = '00000000-0000-4000-8000-000000000001';
  let lockStage;
  try {
    const body = await readFile(lock, 'utf8');
    assert.ok(body.length <= 8192);
    const records = body.trim().split(/\n+/).map(line => JSON.parse(line));
    assert.ok(records.length >= 1 && records.length <= 8);
    assert.ok(records.every(item => item.version === 1 &&
      /^[0-9a-f-]{36}$/.test(item.operationId)));
    invocationId = records[0].operationId;
    const last = records.at(-1);
    lockStage = last.phase && ['prepare', 'transfer', 'attestor'].includes(last.phase) &&
      ['dispatched', 'confirmed'].includes(last.state)
      ? `${last.phase}-${last.state}` : last.state === 'preflight' ? 'preflight' : 'other';
  } catch { lockStage = await existing(lock) ? 'unreadable' : 'absent'; }
  emit('lock-stage', lockStage);
  emit('invocation-roots', await count(invocationParent));
  emit('public-roots', await count(publicParent));
  let scopedConfig;
  try {
    const env = { ...process.env,
      STATION_ATTESTOR_INVOCATION_ROOT: path.join(invocationParent, invocationId),
      STATION_ATTESTOR_PUBLIC_ROOT: path.join(publicParent, invocationId),
      STATION_ATTESTOR_VOLUME_NAME: `${project}_search_attestor_${invocationId.replaceAll('-', '')}` };
    const result = await command('docker', ['compose', '-f', 'compose.yaml',
      '-f', 'compose.search-attestor.yaml', '-p', project, '--profile', 'search-attestor',
      'config', '--format', 'json', ...phaseServices], env, 5000);
    if (result.code !== 0 || result.stderr !== '') emit('scoped-config', 'command-failed');
    else {
      const candidate = JSON.parse(result.stdout);
      verifyAttestorServiceConfig(candidate, { project,
        uid: process.getuid(), gid: process.getgid(), repository, invocationId,
        invocationRoot: env.STATION_ATTESTOR_INVOCATION_ROOT,
        publicRoot: env.STATION_ATTESTOR_PUBLIC_ROOT,
        volumeName: env.STATION_ATTESTOR_VOLUME_NAME });
      scopedConfig = candidate;
      emit('scoped-config', 'valid');
    }
  } catch { emit('scoped-config', 'invalid'); }
  try {
    const installation = await createSearchAdminDockerAdapter(process.getuid(), process.getgid());
    const identity = await installation.identity();
    const metadataBody = JSON.parse(originalMetadata.bytes.toString('utf8'));
    emit('owner-installation', 'valid');
    emit('credential-metadata-match', metadataBody.project === identity.project &&
      metadataBody.databaseOid === identity.databaseOid &&
      metadataBody.systemIdentifier === identity.systemIdentifier &&
      metadataBody.uid === process.getuid() && metadataBody.gid === process.getgid());
  } catch { emit('owner-installation', 'invalid'); }
  for (const [index, service] of phaseServices.entries()) {
    const phase = index + 1;
    try {
      const listing = (await inspectDocker(['ps', '-a', '--no-trunc', '--filter',
        `label=com.docker.compose.project=${project}`, '--filter',
        `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'])).trim();
      const values = listing ? listing.split('\n') : [];
      assert.ok(values.length <= 2 && values.every(value => id.test(value)));
      emit(`phase-${phase}-count`, values.length);
      if (values.length === 1) {
        const item = JSON.parse(await inspectDocker(['container', 'inspect', values[0]]))[0];
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const expectedCommands = [
          ['node', 'scripts/search-attestor-prepare.mjs'],
          ['node', 'scripts/search-attestor-transfer.mjs'],
          ['node', 'scripts/search-attestor-combined.mjs'],
        ];
        const expectedTargets = [
          ['/run/search-attestor', '/run/search-attestor/manifest', '/run/search-db/password'],
          ['/run/search-attestor', '/run/search-transfer-invocation/invocation',
            '/run/search-transfer-manifest/manifest.json', '/run/search-transfer-password/password',
            '/run/search-transfer-public'],
          ['/run/search-attestor', '/run/station-admin', '/run/station-state'],
        ];
        const expectedNetworks = [
          [`${project}_search_admin_db`], [],
          [`${project}_search_admin_db`, `${project}_search_internal`],
        ];
        const tmpfsOptions = phase === 1
          ? `rw,noexec,nosuid,size=8m,uid=${process.getuid()},gid=${process.getgid()},mode=0700`
          : phase === 2 ? 'rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0700'
            : 'rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700';
        const status = ['created', 'running', 'exited', 'dead'].includes(item?.State?.Status)
          ? item.State.Status : 'other';
        emit(`phase-${phase}-state`, status);
        emit(`phase-${phase}-inspect-id-match`, item?.Id === values[0]);
        emit(`phase-${phase}-exit`, Number.isInteger(item?.State?.ExitCode) ?
          item.State.ExitCode : 'unknown');
        emit(`phase-${phase}-user-match`, item?.Config?.User ===
          (phase === 1 ? `${process.getuid()}:${process.getgid()}` :
            phase === 2 ? '0:0' : '1000:1000'));
        emit(`phase-${phase}-command-match`, same(item?.Config?.Cmd, expectedCommands[phase - 1]));
        emit(`phase-${phase}-labels-match`,
          item?.Config?.Labels?.['com.docker.compose.project'] === project &&
          item?.Config?.Labels?.['com.docker.compose.service'] === service);
        try {
          const built = JSON.parse(await inspectDocker(['image', 'inspect', `${project}-${service}`]))[0];
          emit(`phase-${phase}-image-match`, item?.Image === built?.Id &&
            same(item?.Config?.Env, built?.Config?.Env) &&
            same(item?.Config?.Entrypoint, built?.Config?.Entrypoint));
        } catch { emit(`phase-${phase}-image-match`, 'unavailable'); }
        const capAddMatch = exactAddedCapabilities(item?.HostConfig?.CapAdd,
          phase === 2 ? 'transfer' : 'other');
        const capDropMatch = same(item?.HostConfig?.CapDrop?.map(value => value.toUpperCase()), ['ALL']);
        const resourceMatch = item?.HostConfig?.PidsLimit === (phase === 3 ? 128 : 64) &&
          item.HostConfig.Memory === (phase === 3 ? 536870912 : 268435456) &&
          item.HostConfig.NanoCpus === (phase === 3 ? 1e9 : 5e8);
        const hostSafetyMatch = item?.HostConfig?.Privileged === false &&
          item.HostConfig.ReadonlyRootfs === true &&
          item.HostConfig.RestartPolicy?.Name === 'no' &&
          same(item.HostConfig.SecurityOpt, ['no-new-privileges:true']);
        const isolationMatch = (item?.HostConfig?.Devices ?? []).length === 0 &&
          (item?.HostConfig?.GroupAdd ?? []).length === 0 &&
          item?.HostConfig?.PidMode === '' && item?.HostConfig?.IpcMode === 'private' &&
          Object.keys(item?.HostConfig?.PortBindings ?? {}).length === 0 &&
          Object.values(item?.NetworkSettings?.Ports ?? {}).every(value => value === null);
        emit(`phase-${phase}-host-policy-match`, capAddMatch && capDropMatch &&
          resourceMatch && hostSafetyMatch && isolationMatch);
        emit(`phase-${phase}-cap-add-match`, capAddMatch);
        emit(`phase-${phase}-cap-drop-match`, capDropMatch);
        emit(`phase-${phase}-resources-match`, resourceMatch);
        emit(`phase-${phase}-host-safety-match`, hostSafetyMatch);
        emit(`phase-${phase}-isolation-match`, isolationMatch);
        emit(`phase-${phase}-tmpfs-match`, item?.HostConfig?.Tmpfs?.['/tmp'] === tmpfsOptions &&
          Object.keys(item.HostConfig.Tmpfs).length === 1);
        emit(`phase-${phase}-mount-count`, Array.isArray(item?.Mounts) ? item.Mounts.length : -1);
        emit(`phase-${phase}-mount-targets-match`, same(item?.Mounts?.map(value =>
          value.Destination).sort(), expectedTargets[phase - 1]));
        emit(`phase-${phase}-host-mount-targets-match`, same(item?.HostConfig?.Mounts?.map(value =>
          value.Target).sort(), expectedTargets[phase - 1]));
        if (scopedConfig) {
          const expectedMounts = scopedConfig.services[service].volumes;
          const effective = item?.Mounts ?? [];
          const host = item?.HostConfig?.Mounts ?? [];
          const sourceFor = mount => mount.type === 'bind' ? mount.source :
            scopedConfig.volumes[mount.source]?.name;
          const effectiveInventory = Array.isArray(effective) &&
            effective.length === expectedMounts.length &&
            new Set(effective.map(value => value.Destination)).size === effective.length;
          const hostInventory = Array.isArray(host) && host.length === expectedMounts.length &&
            new Set(host.map(value => value.Target)).size === host.length &&
            (item?.HostConfig?.Binds ?? []).length === 0 &&
            (item?.HostConfig?.VolumesFrom ?? []).length === 0;
          emit(`phase-${phase}-effective-mount-inventory-match`, effectiveInventory);
          emit(`phase-${phase}-host-mount-inventory-match`, hostInventory);
          emit(`phase-${phase}-effective-mount-source-match`, effectiveInventory &&
            expectedMounts.every(wanted => {
              const actual = effective.find(value => value.Destination === wanted.target);
              return actual?.Type === wanted.type && actual.Destination === wanted.target &&
                (wanted.type === 'bind' ? actual.Source === sourceFor(wanted) :
                  actual.Name === sourceFor(wanted));
            }));
          emit(`phase-${phase}-effective-mount-rw-match`, effectiveInventory &&
            expectedMounts.every(wanted => effective.find(value =>
              value.Destination === wanted.target)?.RW === !wanted.read_only));
          emit(`phase-${phase}-host-mount-source-match`, hostInventory &&
            expectedMounts.every(wanted => {
              const actual = host.find(value => value.Target === wanted.target);
              return actual?.Type === wanted.type && actual.Source === sourceFor(wanted) &&
                actual.Target === wanted.target;
            }));
          emit(`phase-${phase}-host-mount-readonly-match`, hostInventory &&
            expectedMounts.every(wanted => {
              const actual = host.find(value => value.Target === wanted.target);
              return wanted.read_only ? actual?.ReadOnly === true :
                [undefined, false].includes(actual?.ReadOnly);
            }));
          const empty = value => value && typeof value === 'object' &&
            !Array.isArray(value) && Object.keys(value).length === 0;
          const subset = (value, names) => value && typeof value === 'object' &&
            !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
          const commonOptionsMatch = hostInventory && host.every(actual => actual &&
            [undefined, '', 'default'].includes(actual.Consistency) &&
            actual.TmpfsOptions == null && actual.ImageOptions == null &&
            actual.ClusterOptions == null);
          const bindOptionsMatch = hostInventory && expectedMounts.filter(wanted =>
            wanted.type === 'bind').every(wanted => {
            const actual = host.find(value => value.Target === wanted.target);
            const opts = actual?.BindOptions;
            return actual?.VolumeOptions == null && (opts == null ||
              subset(opts, ['Propagation', 'NonRecursive', 'CreateMountpoint',
                'ReadOnlyNonRecursive', 'ReadOnlyForceRecursive']) &&
              [undefined, '', 'rprivate'].includes(opts.Propagation) &&
              [undefined, false].includes(opts.NonRecursive) &&
              [undefined, false].includes(opts.CreateMountpoint) &&
              [undefined, false].includes(opts.ReadOnlyNonRecursive) &&
              [undefined, false].includes(opts.ReadOnlyForceRecursive));
          });
          const volumeNocopyMatch = hostInventory && expectedMounts.filter(wanted =>
            wanted.type === 'volume').every(wanted => {
            const opts = host.find(value => value.Target === wanted.target)?.VolumeOptions;
            return wanted.volume?.nocopy === true ? opts?.NoCopy === true :
              opts == null || [undefined, false].includes(opts.NoCopy);
          });
          const volumeExtraOptionsMatch = hostInventory && expectedMounts.filter(wanted =>
            wanted.type === 'volume').every(wanted => {
            const actual = host.find(value => value.Target === wanted.target);
            const opts = actual?.VolumeOptions;
            return actual?.BindOptions == null && (opts == null ||
              subset(opts, ['NoCopy', 'Labels', 'Subpath', 'DriverConfig']) &&
              (opts.Labels == null || empty(opts.Labels)) &&
              [undefined, ''].includes(opts.Subpath) && opts.DriverConfig == null);
          });
          emit(`phase-${phase}-host-mount-options-match`, commonOptionsMatch &&
            bindOptionsMatch && volumeNocopyMatch && volumeExtraOptionsMatch);
          emit(`phase-${phase}-host-common-options-match`, commonOptionsMatch);
          emit(`phase-${phase}-bind-options-match`, bindOptionsMatch);
          emit(`phase-${phase}-volume-nocopy-match`, volumeNocopyMatch);
          emit(`phase-${phase}-volume-extra-options-match`, volumeExtraOptionsMatch);
        }
        emit(`phase-${phase}-tmpfs-count`, item?.HostConfig?.Tmpfs &&
          typeof item.HostConfig.Tmpfs === 'object' ? Object.keys(item.HostConfig.Tmpfs).length : -1);
        emit(`phase-${phase}-network-count`, item?.NetworkSettings?.Networks &&
          typeof item.NetworkSettings.Networks === 'object' ?
          Object.keys(item.NetworkSettings.Networks).length : -1);
        emit(`phase-${phase}-network-names-match`, same(Object.keys(
          item?.NetworkSettings?.Networks ?? {}).filter(name => name !== 'none').sort(),
        expectedNetworks[phase - 1]));
        const expectedNetworkNames = phase === 2 ? ['none'] :
          phase === 1 ? ['search_admin_db'] : ['search_admin_db', 'search_internal'];
        try {
          const ids = await Promise.all(expectedNetworkNames.map(async name => {
            const observed = JSON.parse(await inspectDocker(['network', 'inspect',
              name === 'none' ? name : `${project}_${name}`]))[0];
            return [name === 'none' ? 'none' : `${project}_${name}`, observed?.Id];
          }));
          const map = item?.NetworkSettings?.Networks ?? {};
          const actualIds = Object.values(map).map(value => value.NetworkID).sort();
          const wantedIds = ids.map(([, value]) => value).sort();
          emit(`phase-${phase}-network-id-match`, phase === 2 ?
            Object.keys(map).length === 0 ||
              Object.keys(map).length === 1 && map.none?.NetworkID === ids[0][1] :
            same(actualIds, wantedIds));
          emit(`phase-${phase}-network-mode-match`, phase === 2 ?
            item?.HostConfig?.NetworkMode === 'none' : true);
        } catch {
          emit(`phase-${phase}-network-id-match`, 'unavailable');
          emit(`phase-${phase}-network-mode-match`, 'unavailable');
        }
      }
    } catch { emit(`phase-${phase}-inspection`, 'unavailable'); }
  }
  try {
    const listing = (await inspectDocker(['volume', 'ls', '--filter',
      `label=station.attestor.project=${project}`, '--format', '{{.Name}}'])).trim();
    const volumes = listing ? listing.split('\n') : [];
    assert.ok(volumes.length <= 32 && volumes.every(value => volumePattern.test(value)));
    emit('invocation-volumes', volumes.length);
  }
  catch { emit('invocation-volumes', 'unavailable'); }
  for (const [index, name] of ['search_admin_db', 'search_internal'].entries()) {
    try {
      const item = JSON.parse(await inspectDocker(['network', 'inspect', `${project}_${name}`]))[0];
      emit(`network-${index + 1}-identity`, /^[0-9a-f]{64}$/.test(item?.Id) &&
        item.Internal === true && item.Labels?.['com.docker.compose.project'] === project &&
        item.Labels?.['com.docker.compose.network'] === name);
    } catch { emit(`network-${index + 1}-identity`, 'unavailable'); }
  }
  for (const [index, name] of ['search_admin_certs', 'search_security_state'].entries()) {
    try {
      const item = JSON.parse(await inspectDocker(['volume', 'inspect', `${project}_${name}`]))[0];
      emit(`volume-${index + 1}-identity`, item?.Driver === 'local' && item.Scope === 'local' &&
        item.Labels?.['com.docker.compose.project'] === project &&
        item.Labels?.['com.docker.compose.volume'] === name);
    } catch { emit(`volume-${index + 1}-identity`, 'unavailable'); }
  }
  for (const [index, name] of phaseServices.entries()) {
    try {
      const item = JSON.parse(await inspectDocker(['image', 'inspect', `${project}-${name}`]))[0];
      emit(`image-${index + 1}-identity`, /^sha256:[0-9a-f]{64}$/.test(item?.Id) &&
        JSON.stringify(item.Config?.Cmd) === '["node","apps/server/dist/main.js"]' &&
        JSON.stringify(item.Config?.Entrypoint) === '["docker-entrypoint.sh"]');
    } catch { emit(`image-${index + 1}-identity`, 'unavailable'); }
  }
}
assert.ok(successful.code === 0, 'fixed CLI did not complete');
assert.ok(successful.stdout === 'Private search attestor owner verification completed.\n');
assert.ok(successful.stderr === '');
await noRetained(); await credentialUnchanged(); await gatesOff();
assert.deepEqual(await stateSnapshot(), completeState, 'complete E0b state unchanged by delivery');
process.stdout.write('Actual fixed CLI completed with PG16/OpenSearch TLS.\n');

async function copiedVolume(volume) {
  assert.match(volume, volumePattern);
  const output = await docker(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000',
    '--mount', `type=volume,source=${volume},target=/run/search-attestor,readonly,volume-nocopy`,
    image, 'node', 'tests/support/search-attestor-delivery-volume.mjs']);
  assert.equal(output, 'Fixed transferred inventory is readable by UID 1000.\n');
}
async function actualPhaseEvidence(phase, containerId) {
  const item = JSON.parse(await docker(['container', 'inspect', containerId]))[0];
  assert.equal(item.Id, containerId);
  assert.equal(item.State.Status, 'exited');
  assert.equal(item.State.ExitCode, 0);
  assert.equal(item.HostConfig.ReadonlyRootfs, true);
  assert.equal(item.Config.User, phase === 'prepare' ? `${process.getuid()}:${process.getgid()}` :
    phase === 'transfer' ? '0:0' : '1000:1000');
  assert.deepEqual(item.HostConfig.CapDrop, ['ALL']);
  assert.equal(exactAddedCapabilities(item.HostConfig.CapAdd, phase), true);
  const mounts = item.HostConfig.Mounts;
  assert.ok(Array.isArray(mounts));
  const targets = mounts.map(value => value.Target).sort();
  if (phase === 'prepare') {
    assert.deepEqual(targets, ['/run/search-attestor', '/run/search-attestor/manifest',
      '/run/search-db/password']);
    assert.equal(mounts.find(value => value.Target === '/run/search-attestor')?.ReadOnly, true);
    assert.equal(mounts.find(value => value.Target === '/run/search-attestor/manifest')?.ReadOnly ?? false, false);
    assert.deepEqual(Object.keys(item.NetworkSettings.Networks), [`${project}_search_admin_db`]);
  } else if (phase === 'transfer') {
    assert.deepEqual(targets, ['/run/search-attestor', '/run/search-transfer-invocation/invocation',
      '/run/search-transfer-manifest/manifest.json', '/run/search-transfer-password/password',
      '/run/search-transfer-public']);
    assert.equal(item.HostConfig.NetworkMode, 'none');
    assert.ok(mounts.filter(value => value.Type === 'volume').length === 1);
  } else {
    assert.deepEqual(targets, ['/run/search-attestor', '/run/station-admin', '/run/station-state']);
    assert.deepEqual(Object.keys(item.NetworkSettings.Networks).sort(),
      [`${project}_search_admin_db`, `${project}_search_internal`].sort());
    assert.ok(mounts.every(value => value.ReadOnly === true));
  }
  assert.equal(Object.keys(item.HostConfig.PortBindings ?? {}).length, 0);
}

async function injectScenario(scenario) {
  const calls = { prepare: 0, transfer: 0, attestor: 0, create: 0 };
  const observed = { volume: null, ids: {}, outputs: [] };
  let inspectLost = false;
  const invoke = async (args, env, timeoutMs) => {
    const phase = args.includes('run') && args.includes('--detach') ?
      ({ 'search-attestor-prepare': 'prepare', 'search-attestor-transfer': 'transfer',
        'search-engine-attestor': 'attestor' }[args.at(-1)] ?? null) : null;
    const isCreate = args[0] === 'volume' && args[1] === 'create';
    if (scenario === 'cleanup-refusal' && args[0] === 'container' && args[1] === 'rm')
      return { code: 1, signal: null, stdout: '', stderr: 'injected refusal' };
    const response = await command('docker', args, env, timeoutMs ?? 10_000);
    observed.outputs.push(response.stdout, response.stderr);
    if (phase) {
      calls[phase]++;
      if (id.test(response.stdout.trim())) observed.ids[phase] = response.stdout.trim();
      if (scenario === `lost-${phase}-response`)
        return { ...response, stdout: '' };
    }
    if (isCreate) {
      calls.create++;
      observed.volume = args.at(-1);
      assert.match(observed.volume, volumePattern);
      if (scenario === 'partial-transfer') {
        await docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '0:0',
          '--mount', `type=volume,source=${observed.volume},target=/target`,
          '--mount', `type=bind,source=${credential},target=/input/password,readonly`, image,
          'node', '-e', "const f=require('node:fs');f.writeFileSync('/target/password',f.readFileSync('/input/password').subarray(0,8),{mode:0o400})"]);
      }
      if (scenario === 'lost-volume-create-response') return { ...response, stdout: '' };
      if (scenario === 'ambiguous-post-create-inspect') inspectLost = true;
    }
    if (inspectLost && args[0] === 'volume' && args[1] === 'inspect') {
      inspectLost = false;
      return { code: 1, signal: null, stdout: '', stderr: 'injected inspect loss' };
    }
    if (scenario === 'replaced-artifact' && args[0] === 'volume' && args[1] === 'ls') {
      const roots = await readdir(invocationParent);
      assert.equal(roots.length, 1);
      const manifest = path.join(invocationParent, roots[0], 'manifest/manifest.json');
      const bytes = await readFile(manifest);
      await rename(manifest, `${manifest}.old`);
      await writeFile(manifest, bytes, { mode: 0o600 });
      await rm(`${manifest}.old`);
    }
    if (args[0] === 'container' && args[1] === 'logs') {
      const logged = Object.entries(observed.ids).find(([, value]) => value === args[2])?.[0];
      if (logged === 'transfer' && scenario !== 'partial-transfer') {
        await actualPhaseEvidence('transfer', args[2]);
        await copiedVolume(observed.volume);
      }
      if (logged === 'prepare') await actualPhaseEvidence('prepare', args[2]);
      if (logged === 'attestor') await actualPhaseEvidence('attestor', args[2]);
      if (logged === 'transfer' && scenario === 'replaced-volume') {
        const invocationId = await retained();
        await docker(['container', 'rm', args[2]]);
        await docker(['volume', 'rm', observed.volume]);
        await new Promise(resolve => setTimeout(resolve, 1_100));
        await docker(['volume', 'create', '--driver', 'local',
          '--label', `station.attestor.project=${project}`,
          '--label', `station.attestor.invocation=${invocationId}`, observed.volume]);
      }
      if (logged === 'attestor' && scenario === 'postflight-drift') {
        await docker(['compose', 'up', '-d', '--wait', '--force-recreate', '--no-deps', 'postgres'], 120_000);
      }
      if (logged === 'attestor' && scenario === 'outstanding-reference') {
        const reference = await one(['container', 'create', '--network', 'none',
          '--label', `station.attestor.gate=${project}`,
          '--mount', `type=volume,source=${observed.volume},target=/target`, image, 'true']);
        assert.match(reference, id);
      }
    }
    return response;
  };
  const factory = async input => {
    if (scenario === 'preexisting-volume') {
      const name = `${project}_search_attestor_${input.invocationId.replaceAll('-', '')}`;
      observed.volume = name;
      await docker(['volume', 'create', '--driver', 'local',
        '--label', `station.attestor.project=${project}`,
        '--label', `station.attestor.invocation=${input.invocationId}`, name]);
    }
    return createAttestorDockerAdapter(input, { command: invoke });
  };
  await assert.rejects(runAttestorOwner({ repository, uid: process.getuid(),
    gid: process.getgid(), adapterFactory: factory }), { message: coreFailure });
  secretFree(...observed.outputs);
  await retained();
  const expected = {
    'lost-prepare-response': [1, 0, 0, 0],
    'preexisting-volume': [1, 0, 0, 0],
    'lost-volume-create-response': [1, 0, 0, 1],
    'ambiguous-post-create-inspect': [1, 0, 0, 1],
    'replaced-artifact': [1, 0, 0, 0],
    'lost-transfer-response': [1, 1, 0, 1],
    'partial-transfer': [1, 1, 0, 1],
    'replaced-volume': [1, 1, 0, 1],
    'lost-attestor-response': [1, 1, 1, 1],
    'postflight-drift': [1, 1, 1, 1],
    'outstanding-reference': [1, 1, 1, 1],
    'cleanup-refusal': [1, 1, 1, 1],
  }[scenario];
  assert.deepEqual([calls.prepare, calls.transfer, calls.attestor, calls.create], expected,
    `${scenario} preserves send-once boundaries`);
  if (scenario === 'lost-prepare-response' || scenario === 'lost-transfer-response' ||
      scenario === 'lost-attestor-response') {
    const phase = scenario.slice(5, -9);
    const completed = (await docker(['container', 'wait', observed.ids[phase]], 90_000)).trim();
    assert.equal(completed, '0');
    await actualPhaseEvidence(phase, observed.ids[phase]);
    if (phase === 'transfer') await copiedVolume(observed.volume);
  }
  if (scenario === 'partial-transfer') {
    const completed = (await docker(['container', 'wait', observed.ids.transfer], 90_000)).trim();
    assert.notEqual(completed, '0');
    const partial = (await docker(['run', '--rm', '--pull', 'never', '--network', 'none',
      '--user', '0:0', '--mount', `type=volume,source=${observed.volume},target=/target,readonly`,
      image, 'node', '-e', "process.stdout.write(String(require('node:fs').statSync('/target/password').size))"])).trim();
    assert.equal(partial, '8');
  }
  const phaseContainers = await serviceContainers();
  assert.equal(phaseContainers['search-attestor-prepare'].length, 1);
  if (observed.volume) assert.ok((await invocationVolumes()).includes(observed.volume));
  await credentialUnchanged(); await gatesOff();
  await fixtureTeardown();
  await credentialUnchanged();
  process.stdout.write(`Real Docker fault injection passed: ${scenario}.\n`);
}

for (const scenario of [
  'lost-prepare-response', 'preexisting-volume', 'lost-volume-create-response',
  'ambiguous-post-create-inspect', 'replaced-artifact', 'lost-transfer-response',
  'partial-transfer', 'replaced-volume', 'lost-attestor-response',
  'postflight-drift', 'outstanding-reference', 'cleanup-refusal',
]) { checkpoint = scenario; await injectScenario(scenario); }

for (const mode of ['fresh', 'unintroduced', 'incomplete']) {
  checkpoint = `${mode}-rejection`;
  await stateMode('complete');
  await stateMode(mode);
  const variantState = await stateSnapshot();
  const rejected = await command('node', ['scripts/search-attestor-owner.mjs'], process.env, 245_000);
  secretFree(rejected.stdout, rejected.stderr);
  assert.equal(rejected.code, 1, `${mode} retained marker must reject`);
  assert.ok(rejected.stdout === '');
  assert.ok(rejected.stderr === fixedFailure);
  await retained();
  const containers = await serviceContainers();
  assert.equal(containers['search-attestor-prepare'].length, 1);
  assert.equal(containers['search-attestor-transfer'].length, 1);
  assert.equal(containers['search-engine-attestor'].length, 1);
  await actualPhaseEvidence('prepare', containers['search-attestor-prepare'][0]);
  await actualPhaseEvidence('transfer', containers['search-attestor-transfer'][0]);
  const final = JSON.parse(await docker(['container', 'inspect',
    containers['search-engine-attestor'][0]]))[0];
  assert.equal(final.State.Status, 'exited');
  assert.notEqual(final.State.ExitCode, 0);
  const volumes = await invocationVolumes();
  assert.equal(volumes.length, 1);
  await copiedVolume(volumes[0]);
  assert.deepEqual(await stateSnapshot(), variantState, `${mode} E0b state unchanged by rejection`);
  await credentialUnchanged(); await gatesOff();
  await fixtureTeardown();
  await stateMode('complete');
  assert.deepEqual(await stateSnapshot(), completeState, 'E0b modes restored exactly');
  await credentialUnchanged(); await gatesOff();
  process.stdout.write(`Actual ${mode} retained marker was rejected.\n`);
}

checkpoint = 'legacy-cli';
await stateMode('legacy');
const legacyBefore = await stateSnapshot();
const legacy = await command('node', ['scripts/search-attestor-owner.mjs'], process.env, 245_000);
secretFree(legacy.stdout, legacy.stderr);
assert.ok(legacy.code === 0, 'grantless legacy CLI did not complete');
assert.ok(legacy.stdout === 'Private search attestor owner verification completed.\n');
assert.ok(legacy.stderr === '');
await noRetained();
const legacyState = await stateSnapshot();
assert.deepEqual(legacyState, legacyBefore, 'legacy E0b state unchanged by delivery');
assert.deepEqual(Object.keys(legacyState.files), ['phase']);
await stateMode('complete');
assert.deepEqual(await stateSnapshot(), completeState, 'E0b modes remain unchanged');
await credentialUnchanged(); await gatesOff();
process.stdout.write('Actual grantless legacy delivery completed with fixed UID 1000.\n');
