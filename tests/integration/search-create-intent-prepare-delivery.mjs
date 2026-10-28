import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmod, copyFile, lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runCreateIntentPrepareOwner } from '../../scripts/search-create-intent-owner-core.mjs';
import { createIntentPrepareDockerAdapter } from '../../scripts/search-create-boundary-owner-docker.mjs';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';
import { writeCreateIntentPending } from '../../scripts/search-create-intent-pending.mjs';
import { captureCreateIntentPublic } from '../../scripts/search-create-intent-public.mjs';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { validateCapturedAttestorPublicAtTime } from '../../scripts/search-attestor-command-core.mjs';
import { sealCreateIntent } from '../../scripts/search-create-intent-pure.mjs';

// Disposable real Docker/PG16/OpenSearch TLS proof. Fault seams alter only
// selected owner responses after their underlying Docker operation occurs.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const project = path.basename(repository);
const uid = process.getuid(), gid = process.getgid();
const candidate = 'station-mail-v2-g11111111111141118111111111111111';
const token = '11111111-1111-4111-8111-111111111111';
const image = `${project}-search-create-intent-prepare`;
const lock = path.join(repository, '.cache/search-db/.job-operation.lock');
const pending = path.join(repository, '.cache/search-create-intent/pending.json');
const invocationParent = path.join(repository, '.cache/search-create-invocations');
const source = path.join(repository, '.cache/search-security');
const id = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let checkpoint = 'intent-setup';
const redactedFailure = () => {
  process.stderr.write(`Create intent prepare fixture failed at ${checkpoint}.\n`);
  process.exit(1);
};
process.on('uncaughtException', redactedFailure);
process.on('unhandledRejection', redactedFailure);
assert.equal(process.cwd(), repository);
assert.match(project, /^stationcreate(?:default|runner)[0-9a-f]{12}$/);
assert.equal(process.env.APP_UID, String(uid));
assert.equal(process.env.APP_GID, String(gid));
assert.ok(!Object.keys(process.env).some(key => key.startsWith('DOCKER_') || key.startsWith('COMPOSE_')));

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
    assert.equal(overflow, false); assert.equal(timedOut, false);
    return { ...result, stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function docker(args, timeoutMs = 30_000) {
  const result = await command('docker', args, process.env, timeoutMs);
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  return result.stdout;
}
const one = async args => {
  const value = (await docker(args)).trim();
  assert.ok(value && !value.includes('\n'));
  return value;
};
const exists = async name => lstat(name).then(() => true, () => false);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = await readFile(path.join(repository, '.cache/search-db/initial-v1/operation.json'));
const retainedMetadata = JSON.parse(metadata.toString('utf8'));
const transition = await readFile(path.join(repository, '.cache/search-db/initial-v1/transition.password'));
const verifier = await readFile(path.join(repository, '.cache/search-db/initial-v1/verifier.password'));
const envText = await readFile(path.join(repository, '.env'), 'utf8');
const markers = [transition.toString('utf8').trim(), verifier.toString('utf8').trim(),
  envText.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1],
  ...(await Promise.all(['ca.key', 'admin.key'].map(name => readFile(path.join(source, name), 'utf8'))))
    .map(value => value.split('\n').find(line => line.length >= 40)?.slice(0, 32))]
  .filter(Boolean);
const secretFree = (...outputs) => {
  for (const output of outputs) for (const marker of markers)
    assert.equal(output.includes(marker), false);
};
const postgres = await one(['compose', 'ps', '-q', 'postgres']);
assert.match(postgres, id);
async function dbEvidence() {
  const query = `SELECT md5(
    (SELECT coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY singleton),'') FROM search_generation_control t) ||
    (SELECT coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY generation_token),'') FROM search_generation_history t) ||
    (SELECT coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY generation_token,operation),'') FROM search_generation_dispatch t))`;
  const result = await command('docker', ['exec', postgres, 'psql', '-X', '-U', 'station', '-d', 'station',
    '-v', 'ON_ERROR_STOP=1', '-Atqc', query]);
  assert.equal(result.code, 0); assert.match(result.stdout.trim(), /^[0-9a-f]{32}$/);
  return result.stdout.trim();
}
async function engineEvidence() {
  const script = String.raw`import {createHash} from 'node:crypto';
    import {openSearchAdminObserver} from '/app/packages/search/dist/opensearch-runtime.js';
    const observer=await openSearchAdminObserver({endpoint:'https://opensearch:9200',identityDir:'/run/station-admin'});
    try {const value=await observer.observe();
      const candidate=process.argv[1],suffix='11111111111141118111111111111111';
      if(Object.hasOwn(value.indexes,candidate)||['station_indexer_'+suffix,'station_query_'+suffix].some(
        name=>Object.hasOwn(value.roles,name)||Object.hasOwn(value.mappings,name)))process.exit(2);
      process.stdout.write(createHash('sha256').update(JSON.stringify(value)).digest('hex'));}
    finally {await observer.close();}`;
  const result = await one(['run', '--rm', '--pull', 'never', '--network', `${project}_search_internal`,
    '--label', `station.create.gate=${project}`,
    '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000',
    '--mount', `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
    image, 'node', '--input-type=module', '-e', script, candidate]);
  assert.match(result, /^[0-9a-f]{64}$/);
  return result;
}
async function stateEvidence() {
  const script = String.raw`const fs=require('node:fs');const root='/state',out={};
    for(const name of fs.readdirSync(root).sort()){const s=fs.lstatSync(root+'/'+name);
      out[name]=[s.uid,s.gid,s.mode&0o777,s.isFile(),s.isFile()?fs.readFileSync(root+'/'+name).toString('base64'):null];}
    const s=fs.lstatSync(root);process.stdout.write(JSON.stringify({root:[s.uid,s.gid,s.mode&0o777],files:out}));`;
  return JSON.parse(await one(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--label', `station.create.gate=${project}`,
    '--user', '1000:1000', '--mount', `type=volume,source=${project}_search_security_state,target=/state,readonly`,
    image, 'node', '-e', script]));
}
async function registry() {
  const result = await command('docker', ['exec', postgres, 'psql', '-X', '-U', 'station', '-d', 'station',
    '-v', 'ON_ERROR_STOP=1', '-Atqc', `SELECT stage || '|' || revision || '|' || publication_enabled || '|' ||
      serving_ready || '|' || source_generation_token || '|' || generation_token
      FROM search_generation_control WHERE singleton=1`]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), `disabled_intent|3|false|false|legacy-v1|${token}`);
}
async function registryIdentity() {
  const query = `SELECT c.transition_token || '|' || h.index_uuid
    FROM search_generation_control c JOIN search_generation_history h
      ON h.generation_token=c.source_generation_token WHERE c.singleton=1`;
  const result = await command('docker', ['exec', postgres, 'psql', '-X', '-U', 'station',
    '-d', 'station', '-v', 'ON_ERROR_STOP=1', '-Atqc', query]);
  assert.equal(result.code, 0);
  const parts = result.stdout.trim().split('|');
  assert.equal(parts.length, 2);
  assert.match(parts[0], uuid);
  assert.match(parts[1], /^[A-Za-z0-9_-]{1,128}$/);
  return parts;
}
const baseline = { db: await dbEvidence(), engine: await engineEvidence(), state: await stateEvidence() };
async function unchanged() {
  assert.equal(await dbEvidence(), baseline.db);
  assert.equal(await engineEvidence(), baseline.engine);
  assert.deepEqual(await stateEvidence(), baseline.state);
  await registry();
  assert.deepEqual(await readFile(path.join(repository, '.cache/search-db/initial-v1/operation.json')), metadata);
  assert.deepEqual(await readFile(path.join(repository, '.cache/search-db/initial-v1/transition.password')), transition);
}
async function references() {
  const result = {};
  for (const service of ['search-create-transfer', 'search-create-intent-prepare']) {
    const text = (await docker(['ps', '-a', '--no-trunc', '--filter',
      `label=com.docker.compose.project=${project}`, '--filter',
      `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'])).trim();
    result[service] = text ? text.split('\n') : [];
    assert.ok(result[service].length <= 2 && result[service].every(value => id.test(value)));
  }
  return result;
}
async function volumes() {
  const text = (await docker(['volume', 'ls', '--filter', `label=station.create.project=${project}`,
    '--format', '{{.Name}}'])).trim();
  const values = text ? text.split('\n') : [];
  assert.ok(values.length <= 1 && values.every(value =>
    new RegExp(`^${project}_search_create_[0-9a-f]{32}$`).test(value)));
  return values;
}
async function cleanFault() {
  for (const values of Object.values(await references())) for (const value of values)
    await docker(['container', 'rm', '-f', value]);
  for (const value of await volumes()) await docker(['volume', 'rm', value]);
  if (await exists(lock)) await rm(lock);
  if (await exists(invocationParent)) {
    const roots = await readdir(invocationParent);
    assert.ok(roots.length <= 1);
    for (const root of roots) {
      assert.match(root, uuid);
      await rm(path.join(invocationParent, root), { recursive: true, force: true });
    }
  }
  if (await exists(pending)) await rm(pending);
}
async function assertRetained(expectedPhases, expectedPending) {
  assert.equal(await exists(lock), true);
  assert.equal((await lstat(lock)).mode & 0o777, 0o600);
  const records = (await readFile(lock, 'utf8')).trim().split(/\n+/).map(JSON.parse);
  assert.equal(records[0].state, 'preflight');
  assert.ok(records.every(row => row.operationId === records[0].operationId));
  assert.equal(await exists(pending), expectedPending);
  const refs = await references();
  assert.equal(refs['search-create-transfer'].length, expectedPhases >= 1 ? 1 : 0);
  assert.equal(refs['search-create-intent-prepare'].length, expectedPhases >= 2 ? 1 : 0);
  for (const [service, values] of Object.entries(refs)) for (const value of values) {
    const exit = (await docker(['container', 'wait', value], 90_000)).trim();
    assert.equal(exit, '0');
    await phaseEvidence(service === 'search-create-transfer' ? 'transfer' : 'prepare', value);
  }
  assert.equal((await volumes()).length, 1);
}
async function phaseEvidence(phase, containerId) {
  const item = JSON.parse(await docker(['container', 'inspect', containerId]))[0];
  assert.equal(item.Id, containerId);
  assert.equal(item.State.Status, 'exited');
  assert.equal(item.State.ExitCode, 0);
  assert.equal(item.HostConfig.ReadonlyRootfs, true);
  assert.equal(item.Config.User, phase === 'transfer' ? '0:0' : '1000:1000');
  assert.deepEqual(item.Config.Cmd, ['node', phase === 'transfer' ?
    'scripts/search-create-boundary-transfer.mjs' : 'scripts/search-create-intent-prepare.mjs']);
  assert.deepEqual(item.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual((item.HostConfig.CapAdd ?? []).map(x => x.replace(/^CAP_/, '')).sort(),
    phase === 'transfer' ? ['CHOWN', 'DAC_OVERRIDE'] : []);
  assert.equal(Object.keys(item.HostConfig.PortBindings ?? {}).length, 0);
  assert.deepEqual(item.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.ok(item.Config.Env.every(value => !/^(?:POSTGRES_PASSWORD|STATION_MASTER_KEY|DB_HOST|GOCAMO_HMAC|PGPASSWORD|APP_ORIGIN)=/.test(value)));
  const mounts = item.HostConfig.Mounts;
  assert.deepEqual(mounts.map(value => value.Target).sort(), phase === 'transfer' ?
    ['/run/create-boundary', '/run/create-transfer-invocation/invocation',
      '/run/create-transfer-password/password'] :
    ['/run/create-boundary', '/run/station-admin', '/run/station-state']);
  if (phase === 'transfer') {
    assert.equal(item.HostConfig.NetworkMode, 'none');
    assert.deepEqual(Object.keys(item.NetworkSettings.Networks), ['none']);
    assert.equal(mounts.filter(value => value.Type === 'volume').length, 1);
    assert.equal(mounts.find(value => value.Target === '/run/create-boundary')?.VolumeOptions?.NoCopy, true);
    assert.equal(mounts.find(value => value.Target === '/run/create-boundary')?.ReadOnly, false);
    assert.ok(mounts.filter(value => value.Type === 'bind').every(value => value.ReadOnly === true));
  } else {
    assert.deepEqual(Object.keys(item.NetworkSettings.Networks).sort(),
      [`${project}_search_admin_db`, `${project}_search_internal`].sort());
    assert.ok(mounts.every(value => value.Type === 'volume' && value.ReadOnly === true &&
      value.VolumeOptions?.NoCopy === true));
    for (const [network, value] of Object.entries(item.NetworkSettings.Networks)) {
      const current = JSON.parse(await docker(['network', 'inspect', network]))[0];
      assert.equal(value.NetworkID, current.Id);
      assert.equal(current.Internal, true);
    }
    assert.equal(mounts.find(value => value.Target === '/run/station-admin')?.Source,
      `${project}_search_admin_certs`);
    assert.equal(mounts.find(value => value.Target === '/run/station-state')?.Source,
      `${project}_search_security_state`);
  }
  assert.match(mounts.find(value => value.Target === '/run/create-boundary')?.Source,
    new RegExp(`^${project}_search_create_[0-9a-f]{32}$`));
  assert.deepEqual(item.Mounts.map(value => value.Destination).sort(),
    mounts.map(value => value.Target).sort());
  if (phase === 'prepare') assert.ok(item.Mounts.every(value => value.RW === false));
}

checkpoint = 'intent-cli';
const successful = await command('node', ['scripts/search-create-intent-owner.mjs'], process.env, 245_000);
secretFree(successful.stdout, successful.stderr);
assert.equal(successful.code, 0);
assert.equal(successful.stderr, '');
assert.match(successful.stdout, /^Private create intent prepared sha256=[0-9a-f]{64}\.\n$/);
const approved = await readFile(pending);
const approvedSha = successful.stdout.match(/sha256=([0-9a-f]{64})/)[1];
assert.equal(hash(approved), approvedSha);
assert.equal((await lstat(pending)).mode & 0o777, 0o400);
const proposal = JSON.parse(approved.toString('utf8'));
assert.deepEqual(approved, canonicalAttestorValue(proposal).bytes);
assert.equal(proposal.version, 1);
assert.equal(proposal.project, project);
assert.equal(String(proposal.databaseOid), retainedMetadata.databaseOid);
assert.equal(proposal.systemIdentifier, retainedMetadata.systemIdentifier);
assert.equal(proposal.revision, 3);
assert.equal(proposal.stage, 'disabled_intent');
assert.equal(proposal.sourceToken, 'legacy-v1');
assert.equal(proposal.sourceIndex, 'station-mail-v1');
assert.deepEqual([proposal.transitionToken, proposal.sourceUuid], await registryIdentity());
assert.equal(proposal.candidateToken, token);
assert.equal(proposal.candidateIndex, candidate);
assert.match(proposal.dispatchId, uuid);
assert.match(proposal.ownerId, uuid);
assert.notEqual(proposal.dispatchId, proposal.ownerId);
assert.equal(proposal.publicFiles.length, 4);
assert.equal(proposal.publicDigests.length, 4);
assert.equal(approved.toString('utf8').includes('PRIVATE KEY'), false);
assert.equal(approved.toString('utf8').includes('BEGIN CERTIFICATE'), false);
secretFree(approved.toString('utf8'));
assert.equal(await exists(lock), false);
assert.deepEqual(await references(), { 'search-create-transfer': [], 'search-create-intent-prepare': [] });
assert.deepEqual(await volumes(), []);
assert.deepEqual(await readdir(invocationParent), []);
await unchanged();
checkpoint = 'intent-public-identity';
const host = await captureCreateIntentPublic({ repository, uid, gid, files: proposal.publicFiles,
  scratchRoot: path.dirname(pending) });
assert.deepEqual(host.publicDigests, proposal.publicDigests);
await host.recheck();
const mountedScript = String.raw`import {captureCreateIntentAdminVolume} from '/app/scripts/search-create-intent-admin-volume.mjs';
  const value=await captureCreateIntentAdminVolume();process.stdout.write(JSON.stringify(value.public));`;
const mounted = JSON.parse(await one(['run', '--rm', '--pull', 'never', '--network', 'none',
  '--label', `station.create.gate=${project}`,
  '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700',
  '--mount', `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
  image, 'node', '--input-type=module', '-e', mountedScript]));
assert.equal(mounted.caSha256, proposal.publicDigests.find(row => row.path === 'ca.pem').sha256);
assert.equal(mounted.adminSha256, proposal.publicDigests.find(row => row.path === 'v1/admin.pem').sha256);
process.stdout.write('Real create-intent prepare CLI and public certificate identity passed.\n');

checkpoint = 'intent-preexisting';
const refused = await command('node', ['scripts/search-create-intent-owner.mjs'], process.env, 245_000);
secretFree(refused.stdout, refused.stderr);
assert.equal(refused.code, 1);
assert.equal(refused.stdout, '');
assert.equal(refused.stderr, 'Private create intent owner preparation failed.\n');
assert.deepEqual(await readFile(pending), approved);
assert.equal(await exists(lock), false);
assert.deepEqual(await volumes(), []);
await rm(pending);
await unchanged();

checkpoint = 'intent-fresh-projection';
let freshProjection, freshPrepareReached = false;
const freshFactory = input => {
  const adapter = createIntentPrepareDockerAdapter(input, { command: (args, env, timeoutMs) =>
    command('docker', args, env, timeoutMs ?? 10_000) });
  return { ...adapter, runPhase: async phase => {
    const output = await adapter.runPhase(phase);
    if (phase === 'prepare') {
      freshPrepareReached = true;
      freshProjection = output.projection?.projection;
    }
    return output;
  } };
};
await assert.rejects(runCreateIntentPrepareOwner({ repository, uid, gid,
  adapterFactory: freshFactory, writePending: async () => {
    throw Error('fixture stops before a second pending write');
  } }), { message: 'Private create intent owner preparation failed.' });
assert.equal(freshPrepareReached, true);
assert.ok(freshProjection);
await assertRetained(2, false);
const freshHost = await captureCreateIntentPublic({ repository, uid, gid,
  files: freshProjection.publicFiles, scratchRoot: path.dirname(pending) });
const recomputed = sealCreateIntent(freshProjection, freshHost.publicDigests,
  { project, systemIdentifier: retainedMetadata.systemIdentifier,
    dispatchId: proposal.dispatchId, ownerId: proposal.ownerId });
assert.deepEqual(recomputed.intent, proposal);
assert.equal(recomputed.sha256, approvedSha);
assert.deepEqual([freshProjection.transitionToken, freshProjection.sourceUuid],
  await registryIdentity());
await freshHost.recheck();
await unchanged();
await cleanFault();
await unchanged();

checkpoint = 'intent-malformed-pending';
await writeFile(pending, '{"invalid":', { mode: 0o400, flag: 'wx' });
const malformed = await readFile(pending);
const malformedResult = await command('node', ['scripts/search-create-intent-owner.mjs'], process.env, 245_000);
secretFree(malformedResult.stdout, malformedResult.stderr);
assert.equal(malformedResult.code, 1);
assert.equal(malformedResult.stdout, '');
assert.equal(malformedResult.stderr, 'Private create intent owner preparation failed.\n');
assert.deepEqual(await readFile(pending), malformed);
assert.equal(await exists(lock), false);
assert.deepEqual(await volumes(), []);
await rm(pending);
await unchanged();

const failure = 'Private create intent owner preparation failed.';
const faultStages = Object.freeze({
  'lost-volume-response': { create: 1, transfer: 0, prepare: 0, phase: 'transfer', state: 'dispatched' },
  'lost-transfer-response': { create: 1, transfer: 1, prepare: 0, phase: 'transfer', state: 'dispatched' },
  'lost-prepare-response': { create: 1, transfer: 1, prepare: 1, phase: 'prepare', state: 'dispatched' },
  'cleanup-response': { create: 1, transfer: 1, prepare: 1, phase: 'pending', state: 'attempted' },
  'pending-record': { create: 1, transfer: 1, prepare: 1, phase: 'pending', state: 'attempted' },
  'pending-partial': { create: 1, transfer: 1, prepare: 1, phase: 'pending', state: 'attempted' },
  'pending-inode': { create: 1, transfer: 1, prepare: 1, phase: 'pending', state: 'attempted' },
  'pending-same-size': { create: 1, transfer: 1, prepare: 1, phase: 'pending', state: 'attempted' },
  'missing-admin-public': { create: 1, transfer: 1, prepare: 1, phase: 'prepare', state: 'confirmed' },
  'swapped-admin-public': { create: 1, transfer: 1, prepare: 1, phase: 'prepare', state: 'confirmed' },
  'wrong-admin-private': { create: 1, transfer: 1, prepare: 1, phase: 'prepare', state: 'confirmed' },
  'public-replaced-after-capture': { create: 1, transfer: 1, prepare: 1, phase: 'prepare', state: 'confirmed' },
  'expired-admin-public': { create: 1, transfer: 1, prepare: 1, phase: 'prepare', state: 'confirmed' },
});
async function runFault(scenario, { lockFault, writePending: writer, capturePublic, mutate } = {}) {
  checkpoint = `intent-${scenario}`;
  const expected = faultStages[scenario];
  assert.ok(expected);
  const calls = { transfer: 0, prepare: 0, create: 0 };
  let reached = false;
  const outputs = [];
  const invoke = async (args, env, timeoutMs) => {
    const result = await command('docker', args, env, timeoutMs ?? 10_000);
    outputs.push(result.stdout, result.stderr);
    if (args[0] === 'volume' && args[1] === 'create') {
      calls.create++;
      if (scenario === 'lost-volume-response') { reached = true; return { ...result, stdout: '' }; }
    }
    if (args[0] === 'compose' && args.includes('--detach')) {
      const phase = args.at(-1) === 'search-create-transfer' ? 'transfer' :
        args.at(-1) === 'search-create-intent-prepare' ? 'prepare' : null;
      assert.ok(phase);
      calls[phase]++;
      if (scenario === `lost-${phase}-response`) {
        reached = true; return { ...result, stdout: '' };
      }
    }
    if (scenario === 'cleanup-response' && args[0] === 'container' && args[1] === 'rm') {
      reached = true; return { ...result, stdout: '' };
    }
    return result;
  };
  const factory = input => createIntentPrepareDockerAdapter(input, { command: invoke });
  if (lockFault) process.env.STATION_JOB_LOCK_FIXTURE = '1';
  if (writer?.fixture) process.env.STATION_INTENT_PENDING_FIXTURE = '1';
  const checkedCapture = async input => {
    reached = true;
    return (capturePublic ?? captureCreateIntentPublic)(input);
  };
  const checkedWriter = writer && (async (...args) => {
    reached = true;
    return writer.run(...args);
  });
  try {
    await assert.rejects(runCreateIntentPrepareOwner({ repository, uid, gid, adapterFactory: factory,
      ...(lockFault ? { lock: (options, work) => withSearchAdminJobLock({ ...options,
        fixtureFaultAt: lockFault }, work) } : {}),
      ...(writer ? { writePending: checkedWriter } : {}),
      ...(scenario.includes('admin-public') || scenario.includes('admin-private') ||
        scenario === 'public-replaced-after-capture' ? { capturePublic: checkedCapture } : {}) }),
    { message: failure });
  } finally {
    delete process.env.STATION_JOB_LOCK_FIXTURE;
    delete process.env.STATION_INTENT_PENDING_FIXTURE;
  }
  secretFree(...outputs);
  assert.deepEqual(calls, { create: expected.create, transfer: expected.transfer,
    prepare: expected.prepare });
  const records = (await readFile(lock, 'utf8')).trim().split(/\n+/).map(JSON.parse);
  assert.equal(records.at(-1).phase, expected.phase);
  assert.equal(records.at(-1).state, expected.state);
  if (scenario === 'pending-record') reached = records.at(-1).phase === 'pending';
  assert.equal(reached, true);
  if (scenario === 'cleanup-response') {
    assert.equal(await exists(lock), true);
    assert.equal(await exists(pending), true);
    const refs = await references();
    assert.equal(refs['search-create-transfer'].length, 1);
    assert.equal(refs['search-create-intent-prepare'].length, 0);
    assert.equal((await volumes()).length, 1);
  } else await assertRetained(expected.prepare ? 2 : expected.transfer ? 1 : 0,
    scenario === 'pending-same-size' ||
    scenario === 'pending-inode' || scenario === 'pending-partial');
  if (mutate) await mutate();
  await unchanged();
  await cleanFault();
  assert.equal(await exists(lock), false);
  assert.deepEqual(await references(), { 'search-create-transfer': [],
    'search-create-intent-prepare': [] });
  assert.deepEqual(await volumes(), []);
  await unchanged();
  process.stdout.write(`Real create-intent prepare fault passed: ${scenario}.\n`);
}

for (const scenario of ['lost-volume-response', 'lost-transfer-response',
  'lost-prepare-response', 'cleanup-response']) await runFault(scenario);

await runFault('pending-record', { lockFault: 'intent-pending-after-file-sync' });
await runFault('pending-partial', { writePending: { fixture: true,
  run: (prepared, intent, sha, ownerUid, ownerGid) => writeCreateIntentPending(
    prepared, intent, sha, ownerUid, ownerGid,
    { afterFileClose: async () => { throw Error('fixture private failure'); } }) } });
const movedPending = path.join(repository, '.cache/results/intent-original-pending');
await runFault('pending-inode', { writePending: { fixture: true,
  run: (prepared, intent, sha, ownerUid, ownerGid) => writeCreateIntentPending(
    prepared, intent, sha, ownerUid, ownerGid, { afterFileClose: async name => {
      await rename(name, movedPending); await copyFile(movedPending, name);
    } }) }, mutate: async () => { await rm(movedPending); } });
await runFault('pending-same-size', { writePending: { fixture: false,
  run: async (...args) => {
    const saved = await writeCreateIntentPending(...args);
    await chmod(pending, 0o600);
    const bytes = await readFile(pending);
    bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
    await writeFile(pending, bytes);
    await chmod(pending, 0o400);
    return saved;
  } } });

const originalAdmin = await readFile(path.join(source, 'admin.pem'));
const originalKey = await readFile(path.join(source, 'admin.key'));
async function mutateSource(scenario, target, replacement, afterCapture = false) {
  const name = path.join(source, target), moved = `${name}.intent-original`;
  let changed = false;
  const change = async () => {
    await rename(name, moved);
    if (replacement) await copyFile(path.join(source, replacement), name);
    changed = true;
  };
  const restore = async () => {
    if (!changed) return;
    await rm(name, { force: true });
    await rename(moved, name);
  };
  try {
    if (!afterCapture) await change();
    await runFault(scenario, { capturePublic: afterCapture ? async input => {
      const captured = await captureCreateIntentPublic(input);
      await change(); return captured;
    } : undefined, mutate: async () => {
      // Compare DB, engine and E0b while the rejected source is still changed.
      await unchanged();
      await restore();
    } });
  } finally { await restore(); }
  assert.deepEqual(await readFile(path.join(source, 'admin.pem')), originalAdmin);
  assert.deepEqual(await readFile(path.join(source, 'admin.key')), originalKey);
}
await mutateSource('missing-admin-public', 'admin.pem', null);
await mutateSource('swapped-admin-public', 'admin.pem', 'query.pem');
await mutateSource('wrong-admin-private', 'admin.key', 'query.key');
await mutateSource('public-replaced-after-capture', 'admin.pem', 'query.pem', true);

checkpoint = 'intent-expired-admin-public';
const expiredPath = path.join(repository, '.cache/results/intent-expired-admin.pem');
const expiredCommand = await command('openssl', ['x509', '-in', path.join(source, 'admin.pem'),
  '-CA', path.join(source, 'ca.pem'), '-CAkey', path.join(source, 'ca.key'),
  '-set_serial', '1234567', '-days', '0', '-out', expiredPath]);
secretFree(expiredCommand.stdout, expiredCommand.stderr);
assert.equal(expiredCommand.code, 0);
const expiryCheck = await command('openssl', ['x509', '-in', expiredPath, '-checkend', '1', '-noout']);
assert.notEqual(expiryCheck.code, 0);
const expiredCertificate = new X509Certificate(await readFile(expiredPath));
if (Date.parse(expiredCertificate.validTo) >= Date.now())
  await new Promise(resolve => setTimeout(resolve, 1_200));
assert.ok(Date.parse(expiredCertificate.validTo) < Date.now());
await chmod(expiredPath, 0o600);
const adminName = path.join(source, 'admin.pem');
const originalName = `${adminName}.intent-original`;
await rename(adminName, originalName);
try {
  await copyFile(expiredPath, adminName);
  await runFault('expired-admin-public', { mutate: async () => {
    await unchanged();
    await rm(adminName); await rename(originalName, adminName);
  } });
} finally {
  if (await exists(originalName)) {
    await rm(adminName, { force: true }); await rename(originalName, adminName);
  }
  await rm(expiredPath, { force: true });
}
assert.deepEqual(await readFile(adminName), originalAdmin);

checkpoint = 'intent-fingerprint';
const publicBytes = new Map(proposal.publicFiles.map(row => [row.path,
  readFile(path.join(source, row.path === 'ca.pem' ? 'ca.pem' :
    row.path.split('/').at(-1)))]));
for (const [name, value] of publicBytes) publicBytes.set(name, await value);
const fingerprintFiles = proposal.publicFiles.map(row => row.path === 'v1/admin.pem' ?
  { ...row, fingerprint: '0'.repeat(64) } : row);
assert.throws(() => validateCapturedAttestorPublicAtTime(
  { publicFiles: fingerprintFiles }, publicBytes, new Date()));
await unchanged();

checkpoint = 'intent-final';
assert.equal(await exists(pending), false);
assert.equal(await exists(lock), false);
assert.deepEqual(await references(), { 'search-create-transfer': [],
  'search-create-intent-prepare': [] });
assert.deepEqual(await volumes(), []);
await unchanged();
process.stdout.write('Real create-intent prepare fault and preservation matrix passed.\n');
