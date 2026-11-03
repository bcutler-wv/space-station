import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runCreateApplyOwner } from '../../scripts/search-create-apply-owner-core.mjs';
import { createApplyDockerAdapter } from '../../scripts/search-create-boundary-owner-docker.mjs';
import { verifyV2IndexProfile } from '../../packages/search/dist/opensearch-v2-profile.js';
import { swapCreateApplyGateFile } from '../support/search-create-apply-gate-file.mjs';

// Runs only in the disposable per-UID checkout created by the established gate.
// Every mutation below is scoped to that checkout's project and is checked
// against the original O/security/E0b baseline before another scenario.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const project = path.basename(repository);
const uid = process.getuid(), gid = process.getgid();
const token = '11111111-1111-4111-8111-111111111111';
const candidate = `station-mail-v2-g${token.replaceAll('-', '')}`;
const lock = path.join(repository, '.cache/search-db/.job-operation.lock');
const pending = path.join(repository, '.cache/search-create-intent/pending.json');
const binding = path.join(repository, '.cache/search-create-apply/binding.json');
const publicParent = path.join(repository, '.cache/search-create-apply-public');
const scratch = path.join(repository, '.cache/results/create-apply-fixture');
const postgres = /^[0-9a-f]{64}$/;
const uuid = /^[A-Za-z0-9_-]{1,128}$/;
let checkpoint = 'setup';
process.on('uncaughtException', () => {
  process.stderr.write(`Create apply runtime fixture failed at ${checkpoint}.\n`); process.exit(1);
});
process.on('unhandledRejection', () => {
  process.stderr.write(`Create apply runtime fixture failed at ${checkpoint}.\n`); process.exit(1);
});
assert.equal(process.cwd(), repository);
assert.match(project, /^stationcreate(?:default|runner)[0-9a-f]{12}$/);
assert.equal(process.env.APP_UID, String(uid));
assert.equal(process.env.APP_GID, String(gid));
assert.ok(!Object.keys(process.env).some(key => /^(?:DOCKER_|COMPOSE_|STATION_CREATE_)/.test(key)));
await mkdir(scratch, { recursive: true, mode: 0o700 });
const scratchStat = await lstat(scratch);
assert.equal(scratchStat.uid, uid); assert.equal(scratchStat.gid, gid);
assert.equal(scratchStat.mode & 0o777, 0o700);
const exists = name => lstat(name).then(() => true, error => {
  if (error?.code === 'ENOENT') return false;
  throw error;
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let privateMarkers = [];
const sourceRoot = path.join(repository, '.cache/search-security');
const originalCredential = await readFile(path.join(repository,
  '.cache/search-db/initial-v1/transition.password'));
const originalMetadata = await readFile(path.join(repository,
  '.cache/search-db/initial-v1/operation.json'));
const envText = await readFile(path.join(repository, '.env'), 'utf8');
privateMarkers = [originalCredential.toString('utf8').trim(),
  (await readFile(path.join(repository, '.cache/search-db/initial-v1/verifier.password'),
    'utf8')).trim(),
  ...[...envText.matchAll(/^(?:POSTGRES_PASSWORD|STATION_MASTER_KEY)=(.+)$/gm)]
    .map(value => value[1]),
  ...(await Promise.all(['ca.key', 'admin.key'].map(name =>
    readFile(path.join(sourceRoot, name), 'utf8')))).map(value =>
    value.split('\n').find(line => line.length >= 40)?.slice(0, 32))]
  .filter(value => typeof value === 'string' && value.length >= 16);

async function command(binary, args, env = process.env, timeoutMs = 30_000, input = null) {
  const child = spawn(binary, args, { cwd: repository, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', overflow = false, timedOut = false;
  const append = (name, chunk) => {
    if (Buffer.byteLength(name === 'stdout' ? stdout : stderr) + chunk.length > 256 * 1024) {
      overflow = true; child.kill('SIGKILL'); return;
    }
    if (name === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout.on('data', chunk => append('stdout', chunk));
  child.stderr.on('data', chunk => append('stderr', chunk));
  if (input) child.stdin.end(input); else child.stdin.end();
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(overflow, false); assert.equal(timedOut, false);
    for (const marker of privateMarkers) {
      assert.equal(stdout.includes(marker), false);
      assert.equal(stderr.includes(marker), false);
    }
    return { ...result, stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function docker(args, timeoutMs = 30_000, input = null) {
  const result = await command('docker', args, process.env, timeoutMs, input);
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  return result.stdout;
}
let pgId = (await docker(['compose', 'ps', '-q', 'postgres'])).trim();
assert.match(pgId, postgres);
async function sql(query) {
  const text = await docker(['exec', pgId, 'psql', '-X', '-U', 'station', '-d', 'station',
    '-v', 'ON_ERROR_STOP=1', '-Atqc', query]);
  return text.trim();
}
async function registry() {
  return JSON.parse(await sql(`SELECT json_build_object(
    'control',(SELECT row_to_json(c) FROM search_generation_control c WHERE singleton=1),
    'history',(SELECT coalesce(json_agg(row_to_json(h) ORDER BY generation_token),'[]'::json)
      FROM search_generation_history h),
    'dispatch',(SELECT coalesce(json_agg(row_to_json(d) ORDER BY generation_token,operation),'[]'::json)
      FROM search_generation_dispatch d))`));
}
async function engine(fromSource = false) {
  const script = String.raw`import {openSearchAdminObserver} from '/app/packages/search/dist/opensearch-runtime.js';
    const o=await openSearchAdminObserver({endpoint:'https://opensearch:9200',identityDir:'/run/station-admin'});
    try {const v=await o.observe();const n=process.argv[1];
      process.stdout.write(JSON.stringify({original:v.indexes['station-mail-v1'],
        candidate:v.indexes[n]??null,roles:v.roles,mappings:v.mappings,
        names:Object.keys(v.indexes).sort()}));} finally {await o.close();}`;
  const result = await docker(['run', '--rm', '--pull', 'never', '--network',
    `${project}_search_internal`, '--label', `station.create.gate=${project}`,
    '--read-only', '--cap-drop', 'ALL', '--user', fromSource ? `${uid}:${gid}` : '1000:1000',
    ...(fromSource ? ['ca.pem', 'admin.pem', 'admin.key'].flatMap(name =>
      ['--mount', `type=bind,source=${path.join(sourceRoot, name)},target=/run/station-admin/${name},readonly`]) :
      ['--mount', `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`]),
    `${project}-search-create-index`, 'node', '--input-type=module', '-e', script, candidate], 45_000);
  return JSON.parse(result);
}
async function rawEngineDigest() {
  // Successful bounded raw admin GETs work even when the profile observer
  // deliberately rejects an unexpected alias or security collection.
  const script = String.raw`import {createHash} from 'node:crypto';
    import {readFile} from 'node:fs/promises';
    import {Client} from '@opensearch-project/opensearch';
    import {boundedSearchSdkRequest} from '/app/packages/search/dist/opensearch-runtime.js';
    const files=await Promise.all(['ca.pem','admin.pem','admin.key'].map(async name=>{
      const value=await readFile('/run/station-admin/'+name);
      if(value.length<100||value.length>16384)throw Error('identity');return value;}));
    const c=new Client({node:'https://opensearch:9200',ssl:{ca:files[0],cert:files[1],
      key:files[2],rejectUnauthorized:true},maxRetries:0,requestTimeout:5000,
      sniffOnStart:false,sniffOnConnectionFault:false,sniffInterval:false});
    const read=fn=>boundedSearchSdkRequest(options=>fn(options),128000,5000);
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
      Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
    try{const indexes=await read(o=>c.indices.get({index:'station-mail-*',
      expand_wildcards:'all',allow_no_indices:true,ignore_unavailable:true,
      include_defaults:false},o));
      if(!indexes||typeof indexes!=='object'||Array.isArray(indexes))throw Error('indexes');
      const security=[];for(const path of ['/_plugins/_security/api/roles',
        '/_plugins/_security/api/rolesmapping','/_plugins/_security/api/securityconfig',
        '/_plugins/_security/api/actiongroups']){
        const value=await read(o=>c.transport.request({method:'GET',path},o));
        if(!value||typeof value!=='object'||Array.isArray(value))throw Error('security');
        security.push(value);}
      process.stdout.write(createHash('sha256').update(JSON.stringify(canonical({indexes,security}))).digest('hex'));
    }finally{await c.close();}`;
  const output = (await docker(['run', '--rm', '--pull', 'never', '--network',
    `${project}_search_internal`, '--label', `station.create.gate=${project}`,
    '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000', '--mount',
    `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
    `${project}-search-create-index`, 'node', '--input-type=module', '-e', script], 45_000)).trim();
  assert.match(output, /^[0-9a-f]{64}$/);
  return output;
}
async function state() {
  const script = String.raw`const fs=require('node:fs');const root='/state',out={};
    for(const n of fs.readdirSync(root).sort()){const s=fs.lstatSync(root+'/'+n);
      out[n]=[s.uid,s.gid,s.mode&0o777,s.isFile(),s.isFile()?fs.readFileSync(root+'/'+n).toString('base64'):null];}
    const s=fs.lstatSync(root);process.stdout.write(JSON.stringify({root:[s.uid,s.gid,s.mode&0o777],files:out}));`;
  return JSON.parse(await docker(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--label', `station.create.gate=${project}`, '--user', '1000:1000',
    '--mount', `type=volume,source=${project}_search_security_state,target=/state,readonly`,
    `${project}-search-create-index`, 'node', '-e', script]));
}
const original = await engine();
const originalState = await state();
assert.ok(original.original && original.candidate === null &&
  !original.names.includes(candidate));
const first = await registry();
assert.equal(first.control.stage, 'disabled_intent');
assert.equal(first.control.revision, 3);
assert.equal(first.history.length, 2);
assert.equal(first.dispatch.length, 0);
const legacyUuid = first.history.find(row => row.generation_token === 'legacy-v1')?.index_uuid;
assert.match(legacyUuid, uuid);
const sourceNames = ['ca.pem', 'admin.pem', 'indexer.pem', 'query.pem', 'admin.key'];
const originalPublic = await Promise.all(sourceNames.map(async name => ({ name,
  bytes: await readFile(path.join(sourceRoot, name)),
  stat: await lstat(path.join(sourceRoot, name)) })));
async function unchangedSources() {
  assert.deepEqual(await readFile(path.join(repository,
    '.cache/search-db/initial-v1/transition.password')), originalCredential);
  assert.deepEqual(await readFile(path.join(repository,
    '.cache/search-db/initial-v1/operation.json')), originalMetadata);
  for (const row of originalPublic) {
    const current = await lstat(path.join(sourceRoot, row.name));
    assert.equal(current.ino, row.stat.ino);
    assert.equal(current.mode, row.stat.mode);
    assert.deepEqual(await readFile(path.join(sourceRoot, row.name)), row.bytes);
  }
  assert.deepEqual(await state(), originalState);
}
function checkPrior(current, candidatePresent) {
  assert.deepEqual(current.original, original.original);
  assert.deepEqual(current.roles, original.roles);
  assert.deepEqual(current.mappings, original.mappings);
  assert.deepEqual(current.names, candidatePresent ? [...original.names, candidate].sort() :
    original.names);
  assert.equal(current.names.includes(candidate), candidatePresent);
  assert.equal(current.candidate === null, !candidatePresent);
  const suffix = token.replaceAll('-', '');
  assert.equal(Object.hasOwn(current.roles, `station_indexer_${suffix}`), false);
  assert.equal(Object.hasOwn(current.roles, `station_query_${suffix}`), false);
  assert.equal(Object.hasOwn(current.mappings, `station_indexer_${suffix}`), false);
  assert.equal(Object.hasOwn(current.mappings, `station_query_${suffix}`), false);
  if (candidatePresent) {
    const derived = verifyV2IndexProfile({ [candidate]: current.candidate }, candidate, null);
    assert.equal(derived, current.candidate?.settings?.index?.uuid);
  }
}
const baseImage = (await docker(['image', 'inspect', '--format', '{{.Id}}',
  `${project}-search-create-index`])).trim();
assert.match(baseImage, /^sha256:[0-9a-f]{64}$/);
const baseTag = `${project}-create-apply-fixture-original`;
await docker(['image', 'tag', baseImage, baseTag]);
assert.equal((await docker(['image', 'inspect', '--format', '{{.Id}}', baseTag])).trim(),
  baseImage);
async function fixtureImage(mode) {
  checkpoint = `image-${mode}`;
  assert.match(mode, /^(?:passthrough|concurrent-hold|transport-held|transport-timeout|false-ack|partial-ack|lost-response|crash-before-sent|crash-after-sent|crash-after-readback|db-after-engine|db-after-confirm)$/);
  assert.equal((await docker(['image', 'inspect', '--format', '{{.Id}}', baseTag])).trim(),
    baseImage);
  const result = await command('docker', ['build', '--quiet', '--pull=false',
    '--build-arg', `BASE=${baseTag}`, '--build-arg', `MODE=${mode}`, '-f',
    'tests/integration/search-create-apply-fixture.Dockerfile', '-t',
    `${project}-search-create-index`, '.'], process.env, 120_000);
  assert.equal(result.code, 0);
  assert.match(result.stdout.trim(), /^sha256:[0-9a-f]{64}$/);
}
async function prepare() {
  checkpoint = 'prepare';
  const before = await registry();
  assert.equal(before.control.revision, 3);
  assert.equal(before.control.stage, 'disabled_intent');
  assert.equal(before.dispatch.length, 0);
  checkPrior(await engine(), false);
  await unchangedSources();
  const result = await command('node', ['scripts/search-create-intent-owner.mjs'],
    process.env, 245_000);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.match(result.stdout, /^Private create intent prepared sha256=[0-9a-f]{64}\.\n$/);
  const bytes = await readFile(pending);
  const intent = JSON.parse(bytes.toString('utf8'));
  const digest = result.stdout.match(/sha256=([0-9a-f]{64})/)[1];
  assert.equal(sha(bytes), digest);
  assert.equal(intent.revision, before.control.revision);
  assert.equal(intent.transitionToken, before.control.transition_token);
  assert.equal(intent.sourceUuid, legacyUuid);
  assert.equal(intent.sourceToken, 'legacy-v1');
  assert.equal(intent.sourceIndex, 'station-mail-v1');
  assert.equal(intent.candidateToken, token);
  assert.equal(intent.candidateIndex, candidate);
  const args = [digest, String(before.control.revision), before.control.transition_token,
    'legacy-v1', 'station-mail-v1', legacyUuid, token, candidate];
  assert.deepEqual(await registry(), before);
  checkPrior(await engine(), false);
  return { bytes, intent, args };
}
function parseMarkers(raw) {
  const markers = [];
  const stderr = raw.split('\n').filter(line => {
    if (!line.startsWith('CREATE_APPLY_FIXTURE:')) return true;
    assert.match(line, /^CREATE_APPLY_FIXTURE:[A-Z0-9_]{1,48}$/);
    markers.push(line.slice('CREATE_APPLY_FIXTURE:'.length));
    return false;
  }).join('\n');
  return { markers, stderr };
}
async function references() {
  const found = {};
  for (const service of ['search-create-apply-transfer', 'search-create-index']) {
    const listing = (await docker(['ps', '-a', '--no-trunc', '--filter',
      `label=com.docker.compose.project=${project}`, '--filter',
      `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'])).trim();
    found[service] = listing ? listing.split('\n') : [];
    assert.ok(found[service].length <= 1 && found[service].every(x => postgres.test(x)));
  }
  return found;
}
async function volumes() {
  const listing = (await docker(['volume', 'ls', '--filter',
    `label=station.create.project=${project}`, '--format', '{{.Name}}'])).trim();
  const found = listing ? listing.split('\n') : [];
  assert.ok(found.length <= 1 && found.every(x =>
    new RegExp(`^${project}_search_create_apply_[0-9a-f]{32}$`).test(x)));
  return found;
}
async function reset() {
  checkpoint = 'fixture-reset';
  // This helper is executable only inside the disposable checkout predicate
  // above. Evidence for the preceding case must already have been asserted.
  for (const ids of Object.values(await references())) for (const id of ids)
    await docker(['container', 'rm', '-f', id]);
  for (const name of await volumes()) await docker(['volume', 'rm', name]);
  assert.deepEqual(await references(), { 'search-create-apply-transfer': [],
    'search-create-index': [] });
  assert.deepEqual(await volumes(), []);
  const current = await engine();
  if (current.candidate) {
    const script = String.raw`import {readFileSync} from 'node:fs';
      import {Client} from '@opensearch-project/opensearch';
      const root='/run/station-admin';const client=new Client({node:'https://opensearch:9200',
        ssl:{ca:readFileSync(root+'/ca.pem'),cert:readFileSync(root+'/admin.pem'),
          key:readFileSync(root+'/admin.key'),rejectUnauthorized:true},maxRetries:0});
      try {const r=await client.indices.delete({index:process.argv[1]});
        if(r.body?.acknowledged!==true)process.exit(2);} finally {await client.close();}`;
    await docker(['run', '--rm', '--pull', 'never', '--network', `${project}_search_internal`,
      '--label', `station.create.gate=${project}`, '--read-only', '--cap-drop', 'ALL',
      '--user', '1000:1000', '--mount',
      `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
      `${project}-search-create-index`, 'node', '--input-type=module', '-e', script, candidate], 45_000);
  }
  // Restore only fixture-owned login state, then reconstruct the finite
  // reservation through the same accepted API used at initial setup.
  await sql('ALTER ROLE station_search_transition LOGIN');
  await sql(`TRUNCATE search_generation_dispatch, search_generation_control,
    search_generation_history;
    INSERT INTO search_generation_control DEFAULT VALUES;
    INSERT INTO search_generation_history
      (generation_token,physical_index,profile_id,index_uuid,lifecycle)
      VALUES ('legacy-v1','station-mail-v1','station-mail-v1','${legacyUuid}','roles_attested');
    UPDATE search_generation_control SET source_generation_token='legacy-v1',revision=revision+1
      WHERE singleton=1 AND stage='disabled' AND source_generation_token IS NULL;`);
  const reserved = await command('docker', ['compose', '--profile', 'search', 'run', '--rm',
    '-T', '--no-deps', 'migrate', 'node', 'tests/integration/search-create-boundary-reserve.mjs'],
  process.env, 90_000);
  assert.equal(reserved.code, 0);
  assert.match(reserved.stdout, /Fixture create candidate reserved through finite database API/);
  for (const name of [lock, pending, binding]) if (await exists(name)) await rm(name);
  if (await exists(publicParent)) {
    const entries = await readdir(publicParent);
    assert.ok(entries.length <= 1);
    for (const entry of entries) {
      assert.match(entry, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      await rm(path.join(publicParent, entry), { recursive: true });
    }
  }
  checkPrior(await engine(), false);
  await unchangedSources();
  const currentDb = await registry();
  assert.equal(currentDb.control.revision, 3);
  assert.equal(currentDb.control.stage, 'disabled_intent');
  assert.equal(currentDb.history.length, 2);
  assert.equal(currentDb.dispatch.length, 0);
  assert.equal(currentDb.history.find(x => x.generation_token === 'legacy-v1')?.index_uuid,
    legacyUuid);
}

async function runInstrumented(mode, args, controller = null) {
  await fixtureImage(mode);
  const evidence = { ids: {}, inspects: {}, rawLogs: {}, markers: {}, result: null,
    failed: false };
  const fixtureCommand = async (argv, env, timeoutMs) => {
    const reply = await command('docker', argv, env, timeoutMs ?? 10_000);
    if (argv[0] === 'compose' && argv.includes('run') &&
        argv.includes('--detach') && reply.code === 0) {
      const phase = argv.at(-1) === 'search-create-index' ? 'create' : 'transfer';
      assert.match(reply.stdout.trim(), postgres);
      evidence.ids[phase] = reply.stdout.trim();
    }
    if (argv[0] === 'container' && argv[1] === 'wait' &&
        argv[2] === evidence.ids.create) {
      const raw = await command('docker', ['container', 'logs', argv[2]], process.env, 10_000);
      assert.equal(raw.code, 0);
      evidence.rawLogs.create = raw;
      evidence.markers.create = parseMarkers(raw.stderr).markers;
    }
    if (argv[0] === 'container' && argv[1] === 'inspect' && reply.code === 0) {
      const phase = Object.keys(evidence.ids).find(key => evidence.ids[key] === argv[2]);
      if (phase) {
        const values = JSON.parse(reply.stdout);
        assert.equal(values.length, 1);
        evidence.inspects[phase] = values[0];
      }
    }
    if (argv[0] === 'container' && argv[1] === 'logs' &&
        argv[2] === evidence.ids.create) {
      evidence.rawLogs.create = reply;
      const parsed = parseMarkers(reply.stderr);
      evidence.markers.create = parsed.markers;
      return { ...reply, stderr: parsed.stderr };
    }
    return reply;
  };
  const adapterFactory = input => createApplyDockerAdapter(input, { command: fixtureCommand });
  const pendingOwner = runCreateApplyOwner({ repository, uid, gid, args, adapterFactory });
  const control = controller ? controller(evidence) : Promise.resolve();
  const [owner, coordinator] = await Promise.allSettled([pendingOwner, control]);
  if (coordinator.status === 'rejected') throw coordinator.reason;
  if (owner.status === 'fulfilled') evidence.result = owner.value;
  else evidence.failed = true;
  return evidence;
}
async function phasePolicy(evidence, phase) {
  const item = evidence.inspects[phase];
  assert.equal(item.Id, evidence.ids[phase]);
  assert.equal(item.Config.User, phase === 'transfer' ? '0:0' : '1000:1000');
  assert.deepEqual(item.Config.Cmd, ['node', `scripts/search-create-apply-${
    phase === 'transfer' ? 'transfer' : 'consumer'}.mjs`]);
  assert.equal(item.HostConfig.ReadonlyRootfs, true);
  assert.equal(item.HostConfig.Privileged, false);
  assert.deepEqual(item.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual((item.HostConfig.CapAdd ?? []).map(x => x.replace(/^CAP_/, '')).sort(),
    phase === 'transfer' ? ['CHOWN', 'DAC_OVERRIDE'] : []);
  assert.deepEqual(item.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(Object.keys(item.HostConfig.PortBindings ?? {}).length, 0);
  assert.equal(item.Config.Env.some(x => /^(?:POSTGRES_PASSWORD|STATION_MASTER_KEY|PGPASSWORD)=/.test(x)), false);
  const mounts = item.HostConfig.Mounts;
  assert.deepEqual(mounts.map(x => x.Target).sort(), phase === 'transfer' ?
    ['/run/create-apply-password/password', '/run/create-apply-intent/intent.json',
      '/run/create-apply-binding/binding.json', '/run/create-apply-public',
      '/run/search-create-apply'].sort() :
    ['/run/search-create-apply', '/run/station-admin', '/run/station-state'].sort());
  assert.deepEqual(item.Mounts.map(x => x.Destination).sort(),
    mounts.map(x => x.Target).sort());
  const invocationId = JSON.parse(await readFile(binding, 'utf8')).invocationId;
  for (const mount of mounts) {
    const actual = item.Mounts.find(x => x.Destination === mount.Target);
    if (mount.Type === 'volume') {
      assert.equal(mount.VolumeOptions?.NoCopy, true);
      assert.equal(actual.RW, phase === 'transfer');
      assert.equal(actual.Name, mount.Source);
      assert.ok([`${project}_search_create_apply_${invocationId.replaceAll('-', '')}`,
        `${project}_search_admin_certs`, `${project}_search_security_state`]
        .includes(actual.Name));
    } else {
      assert.equal(mount.Type, 'bind');
      assert.equal(actual.Source, mount.Source);
      assert.equal(mount.ReadOnly, true);
      assert.equal(actual.RW, false);
    }
  }
  if (phase === 'transfer') {
    assert.equal(item.HostConfig.NetworkMode, 'none');
    assert.ok(Object.keys(item.NetworkSettings.Networks ?? {}).length <= 1);
  } else {
    assert.deepEqual(Object.keys(item.NetworkSettings.Networks).sort(),
      [`${project}_search_admin_db`, `${project}_search_internal`].sort());
    for (const [name, value] of Object.entries(item.NetworkSettings.Networks)) {
      const network = JSON.parse(await docker(['network', 'inspect', name]))[0];
      assert.equal(network.Internal, true);
      assert.equal(value.NetworkID, network.Id);
    }
  }
}
async function readinessAndGrantProbe() {
  const script = String.raw`import {randomUUID} from 'node:crypto';
    import {sql} from 'drizzle-orm';
    import {withSearchAdminDatabase,readSearchAdminRegistrySnapshot} from '/app/packages/db/dist/search-admin-connection.js';
    import {classifySearchGenerationRegistry} from '/app/packages/db/dist/search-generation-oracle.js';
    import {makePreparedAttestorManifest} from '/app/scripts/search-attestor-pure.mjs';
    const role='station_search_transition';
    const db={role,host:'postgres',port:5432,database:'station',passwordFile:'/run/transition/password'};
    const snapshot=await withSearchAdminDatabase(db,x=>readSearchAdminRegistrySnapshot(x,role));
    const result=classifySearchGenerationRegistry(snapshot);
    if(result.status==='ready'||result.status==='incident')process.exit(2);
    const verifierRole='station_search_verifier';
    const verifier=await withSearchAdminDatabase({...db,role:verifierRole,
      passwordFile:'/run/verifier/password'},x=>readSearchAdminRegistrySnapshot(x,verifierRole));
    if(verifier.identity.sessionUser!==verifierRole||verifier.identity.currentUser!==verifierRole||
      classifySearchGenerationRegistry(verifier).status==='ready')process.exit(4);
    let attestorDenied=false,ddlDenied=false,roleDenied=false;
    try {makePreparedAttestorManifest(verifier,randomUUID());} catch {attestorDenied=true;}
    try {await withSearchAdminDatabase(db,x=>x.execute(sql.raw('CREATE TABLE public.create_apply_forbidden(id integer)')));}
    catch {ddlDenied=true;}
    try {await withSearchAdminDatabase(db,x=>x.execute(sql.raw('ALTER ROLE station_search_transition CREATEDB')));}
    catch {roleDenied=true;}
    if(!attestorDenied||!ddlDenied||!roleDenied)process.exit(3);
    process.stdout.write('readable;not-ready;attestor-denied;ddl-denied;role-denied');`;
  const result = await docker(['run', '--rm', '--pull', 'never', '--network',
    `${project}_search_admin_db`, '--label', `station.create.gate=${project}`,
    '--read-only', '--cap-drop', 'ALL', '--user', `${uid}:${gid}`,
    '--tmpfs', `/tmp:rw,noexec,nosuid,size=8m,uid=${uid},gid=${gid},mode=0700`,
    '--mount', `type=bind,source=${repository}/.cache/search-db/initial-v1/transition.password,target=/run/transition/password,readonly`,
    '--mount', `type=bind,source=${repository}/.cache/search-db/initial-v1/verifier.password,target=/run/verifier/password,readonly`,
    `${project}-search-create-index`, 'node', '--input-type=module', '-e', script], 45_000);
  assert.equal(result, 'readable;not-ready;attestor-denied;ddl-denied;role-denied');
}
async function waitForMarker(evidence, wanted) {
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    const id = evidence.ids.create;
    if (id) {
      const raw = await command('docker', ['container', 'logs', id], process.env,
        Math.max(1, Math.min(3_000, deadline - performance.now())));
      assert.equal(raw.code, 0);
      if (parseMarkers(raw.stderr).markers.includes(wanted)) return id;
    }
    await delay(Math.min(100, Math.max(1, deadline - performance.now())));
  }
  throw Error('Fixture marker did not arrive within bounded wait');
}
async function release(id, name) {
  await docker(['exec', '--user', '1000:1000', id, 'node', '-e',
    `require('node:fs').writeFileSync('/tmp/create-apply-${name}-release','1',{mode:0o600,flag:'wx'})`]);
}
async function checkOutcome(evidence, intent, expected) {
  checkpoint = `evidence-${expected.name}`;
  assert.equal(evidence.failed, !expected.success);
  if (expected.success) assert.deepEqual(evidence.result, { state: 'uuid_bound', ready: false });
  assert.equal(Object.keys(evidence.ids).length, expected.phases);
  assert.equal(!!evidence.ids.transfer, expected.phases >= 1);
  assert.equal(!!evidence.ids.create, expected.phases >= 2);
  for (const phase of Object.keys(evidence.ids)) await phasePolicy(evidence, phase);
  const rows = await registry();
  assert.equal(rows.control.stage, expected.stage);
  assert.equal(rows.control.revision, expected.revision);
  assert.equal(rows.control.publication_enabled, false);
  assert.equal(rows.control.serving_ready, false);
  assert.equal(rows.control.source_generation_token, 'legacy-v1');
  assert.equal(rows.control.generation_token, token);
  assert.equal(rows.control.physical_index, candidate);
  assert.equal(rows.history.length, 2);
  assert.equal(rows.history.find(x => x.generation_token === 'legacy-v1')?.index_uuid,
    legacyUuid);
  const candidateHistory = rows.history.find(x => x.generation_token === token);
  assert.equal(candidateHistory.lifecycle, expected.success ? 'bound' : 'reserved');
  assert.equal(rows.dispatch.length, expected.dispatch ? 1 : 0);
  if (expected.dispatch) {
    const dispatch = rows.dispatch[0];
    assert.equal(dispatch.generation_token, token);
    assert.equal(dispatch.operation, 'create_index');
    assert.equal(dispatch.dispatch_id, intent.dispatchId);
    assert.equal(dispatch.owner_id, intent.ownerId);
    assert.equal(dispatch.target, intent.target);
    assert.equal(dispatch.body_identity, intent.bodyIdentity);
    assert.equal(dispatch.state, expected.dispatch);
  }
  const observed = await engine();
  checkPrior(observed, expected.created);
  if (expected.created) {
    const engineUuid = observed.candidate.settings.index.uuid;
    assert.equal(rows.control.index_uuid, expected.success ? engineUuid : null);
    assert.equal(candidateHistory.index_uuid, expected.success ? engineUuid : null);
  } else {
    assert.equal(rows.control.index_uuid, null);
    assert.equal(candidateHistory.index_uuid, null);
  }
  const marks = evidence.markers.create ?? [];
  assert.deepEqual(marks, expected.trace);
  if (expected.sdkCalls === 0) assert.equal(marks.includes('SDK_CREATE_SENT'), false);
  if (expected.sdkCalls === 1) assert.equal(marks.filter(x => x === 'SDK_CREATE_SENT').length, 1);
  assert.equal(marks.filter(x => x === 'SDK_GET_SENT').length,
    expected.getCalls);
  if (expected.success) {
    await readinessAndGrantProbe();
    assert.equal(await exists(lock), false);
    assert.deepEqual(await references(), { 'search-create-apply-transfer': [],
      'search-create-index': [] });
    assert.deepEqual(await volumes(), []);
  } else {
    assert.equal(await exists(lock), true);
    const records = (await readFile(lock, 'utf8')).trim().split(/\n+/).map(JSON.parse);
    assert.equal(records.at(-1).role, 'create-apply');
    assert.equal(records.at(-1).phase, 'create');
    assert.equal(records.at(-1).state, expected.lockState);
    assert.equal(records.at(-1).approvedSha256, expected.args[0]);
    assert.equal(records.at(-1).dispatchId, intent.dispatchId);
    assert.equal(records.at(-1).ownerId, intent.ownerId);
    assert.equal(records.some(x => x.state === 'cleanup-complete'), false);
  }
  assert.equal(await exists(binding), true);
  assert.equal(await exists(pending), true);
  const bound = JSON.parse(await readFile(binding, 'utf8'));
  assert.deepEqual(Object.keys(bound).sort(),
    ['version', 'approvedSha256', 'dispatchId', 'ownerId', 'invocationId'].sort());
  assert.equal(bound.version, 1);
  assert.equal(bound.approvedSha256, expected.args[0]);
  assert.equal(bound.dispatchId, intent.dispatchId);
  assert.equal(bound.ownerId, intent.ownerId);
  assert.notEqual(bound.invocationId, intent.dispatchId);
  assert.notEqual(bound.invocationId, intent.ownerId);
  await unchangedSources();
  const replay = await command('node', ['scripts/search-create-apply-owner.mjs',
    ...expected.args], process.env, 20_000);
  assert.equal(replay.code, 1);
  assert.equal(replay.stdout, '');
  assert.equal(replay.stderr, 'Private create apply owner failed.\n');
  assert.deepEqual(await registry(), rows);
  checkPrior(await engine(), expected.created);
}

async function expectBeforeSend(approved, mutate, expectedTransfer) {
  checkpoint = `presend-${mutate}`;
  const originalDb = await registry();
  let transferCount = 0, transferConfirmed = 0, createCount = 0, reached = false,
    swapped;
  const adapterFactory = input => {
    const adapter = createApplyDockerAdapter(input, { command: (args, env, timeoutMs) =>
      command('docker', args, env, timeoutMs ?? 10_000) });
    return { ...adapter,
      verifyOwner: async () => {
        if (mutate === 'pending-inode') {
          const backup = path.join(scratch, 'pending-backup');
          swapped = await swapCreateApplyGateFile(pending, backup, approved.bytes);
          reached = true;
        }
        if (mutate === 'binding-inode') {
          const backup = path.join(scratch, 'binding-backup');
          swapped = await swapCreateApplyGateFile(binding, backup,
            await readFile(binding));
          assert.notEqual((await lstat(binding)).ino, swapped.original.ino);
          reached = true;
        }
        await adapter.verifyOwner();
      },
      runPhase: async phase => {
        if (phase === 'transfer') transferCount++;
        else createCount++;
        const result = await adapter.runPhase(phase);
        if (phase === 'transfer') {
          transferConfirmed++;
          if (mutate === 'public-inode') {
            const name = path.join(sourceRoot, 'admin.pem');
            const backup = path.join(scratch, 'admin-backup');
            swapped = await swapCreateApplyGateFile(name, backup,
              originalPublic.find(x => x.name === 'admin.pem').bytes);
            reached = true;
          }
        }
        return result;
      } };
  };
  let denied = false;
  try { await runCreateApplyOwner({ repository, uid, gid, args: approved.args,
    adapterFactory }); } catch { denied = true; }
  assert.equal(denied, true);
  assert.equal(reached, true);
  assert.equal(transferCount, expectedTransfer);
  assert.equal(transferConfirmed, expectedTransfer);
  assert.equal(createCount, 0);
  assert.deepEqual(await registry(), originalDb);
  checkPrior(await engine(), false);
  assert.equal(await exists(lock), true);
  assert.equal(await exists(binding), true);
  await swapped.restore();
  await swapped.restore();
  await unchangedSources();
  await reset();
}

checkpoint = 'typed-approval-denials';
let approved = await prepare();
const beforeApproval = await registry();
for (const args of [
  ['0'.repeat(64), ...approved.args.slice(1)],
  [approved.args[0], '4', ...approved.args.slice(2)],
  [...approved.args.slice(0, 3), '22222222-2222-4222-8222-222222222222',
    ...approved.args.slice(4)],
]) {
  const result = await command('node', ['scripts/search-create-apply-owner.mjs', ...args],
    process.env, 20_000);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Private create apply owner failed.\n');
  assert.equal(await exists(binding), false);
  assert.equal(await exists(lock), false);
  assert.deepEqual(await references(), { 'search-create-apply-transfer': [],
    'search-create-index': [] });
  assert.deepEqual(await volumes(), []);
  assert.deepEqual(await registry(), beforeApproval);
  checkPrior(await engine(), false);
}
await rm(pending);
await expectBeforeSend(await prepare(), 'pending-inode', 0);
await expectBeforeSend(await prepare(), 'public-inode', 1);
await expectBeforeSend(await prepare(), 'binding-inode', 0);

checkpoint = 'source-certificate-drift';
approved = await prepare();
const adminSource = path.join(sourceRoot, 'admin.pem');
const originalAdminBytes = originalPublic.find(x => x.name === 'admin.pem').bytes;
const querySource = originalPublic.find(x => x.name === 'query.pem').bytes;
const caSource = originalPublic.find(x => x.name === 'ca.pem').bytes;
assert.equal(new X509Certificate(querySource).verify(
  new X509Certificate(caSource).publicKey), true);
const adminSourceInode = (await lstat(adminSource)).ino;
await writeFile(adminSource, querySource);
assert.equal((await lstat(adminSource)).ino, adminSourceInode);
assert.deepEqual(await readFile(adminSource), querySource);
const certBefore = await registry();
const certDenied = await command('node', ['scripts/search-create-apply-owner.mjs',
  ...approved.args], process.env, 120_000);
assert.equal(certDenied.code, 1);
assert.equal(certDenied.stdout, '');
assert.equal(certDenied.stderr, 'Private create apply owner failed.\n');
assert.equal(await exists(lock), true); assert.equal(await exists(binding), true);
assert.deepEqual(await references(), { 'search-create-apply-transfer': [],
  'search-create-index': [] });
assert.deepEqual(await registry(), certBefore);
checkPrior(await engine(), false);
await writeFile(adminSource, originalAdminBytes);
assert.equal((await lstat(adminSource)).ino, adminSourceInode);
await unchangedSources();
await reset();

checkpoint = 'wrong-transition-credential';
approved = await prepare();
const credentialName = path.join(repository,
  '.cache/search-db/initial-v1/transition.password');
const credentialInode = (await lstat(credentialName)).ino;
const alteredCredential = Buffer.from(originalCredential);
alteredCredential[0] = alteredCredential[0] === 65 ? 66 : 65;
assert.notDeepEqual(alteredCredential, originalCredential);
await writeFile(credentialName, alteredCredential);
assert.equal((await lstat(credentialName)).ino, credentialInode);
const credentialBefore = await registry();
const credentialDenied = await command('node', ['scripts/search-create-apply-owner.mjs',
  ...approved.args], process.env, 120_000);
assert.equal(credentialDenied.code, 1);
assert.equal(credentialDenied.stdout, '');
assert.equal(credentialDenied.stderr, 'Private create apply owner failed.\n');
assert.equal(await exists(lock), true); assert.equal(await exists(binding), true);
assert.deepEqual(await references(), { 'search-create-apply-transfer': [],
  'search-create-index': [] });
assert.deepEqual(await registry(), credentialBefore);
checkPrior(await engine(), false);
await writeFile(credentialName, originalCredential);
assert.equal((await lstat(credentialName)).ino, credentialInode);
await unchangedSources();
await reset();

async function volumeFile(volumeName, file, replacement = null) {
  const script = String.raw`const fs=require('node:fs');const name='/probe/'+process.argv[1];
    if(process.argv[2])fs.writeFileSync(name,Buffer.from(process.argv[2],'base64'));
    const s=fs.lstatSync(name);
    if(!s.isFile())process.exit(2);
    process.stdout.write(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode&0o777,
      bytes:fs.readFileSync(name).toString('base64')}));`;
  const result = await docker(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--label', `station.create.gate=${project}`, '--read-only', '--cap-drop', 'ALL',
    ...(replacement ? ['--cap-add', 'DAC_OVERRIDE'] : []),
    '--user', replacement ? '0:0' : '1000:1000', '--mount',
    `type=volume,source=${project}_${volumeName},target=/probe${replacement ? '' : ',readonly'}`,
    `${project}-search-create-index`, 'node', '-e', script, file,
    replacement ? Buffer.from(replacement).toString('base64') : '']);
  return JSON.parse(result);
}
checkpoint = 'mounted-admin-drift';
approved = await prepare();
const adminVolume = await volumeFile('search_admin_certs', 'admin.pem');
assert.deepEqual(Buffer.from(adminVolume.bytes, 'base64'),
  originalPublic.find(x => x.name === 'admin.pem').bytes);
const wrongAdmin = originalPublic.find(x => x.name === 'query.pem').bytes;
const changedAdmin = await volumeFile('search_admin_certs', 'admin.pem', wrongAdmin);
assert.deepEqual(Buffer.from(changedAdmin.bytes, 'base64'), wrongAdmin);
const adminBefore = await registry();
const adminFault = await runInstrumented('passthrough', approved.args);
assert.equal(adminFault.failed, true);
assert.deepEqual(Object.keys(adminFault.ids).sort(), ['create', 'transfer']);
assert.deepEqual(adminFault.markers.create, []);
assert.deepEqual(await registry(), adminBefore);
checkPrior(await engine(true), false);
assert.equal(await exists(lock), true); assert.equal(await exists(binding), true);
assert.deepEqual(await volumeFile('search_admin_certs', 'admin.pem',
  Buffer.from(adminVolume.bytes, 'base64')), adminVolume);
await unchangedSources();
await reset();

checkpoint = 'e0b-drift';
approved = await prepare();
const stateMarker = originalState.files['v1-profile-complete'];
assert.ok(stateMarker?.[3] === true);
const originalStateBytes = Buffer.from(stateMarker[4], 'base64');
const changedStateBytes = Buffer.from(originalStateBytes);
changedStateBytes[0] ^= 1;
const changedState = await volumeFile('search_security_state',
  'v1-profile-complete', changedStateBytes);
assert.deepEqual(Buffer.from(changedState.bytes, 'base64'), changedStateBytes);
assert.notDeepEqual(await state(), originalState);
const stateBefore = await registry();
const stateFault = await runInstrumented('passthrough', approved.args);
assert.equal(stateFault.failed, true);
assert.deepEqual(Object.keys(stateFault.ids).sort(), ['create', 'transfer']);
assert.deepEqual(stateFault.markers.create, []);
assert.deepEqual(await registry(), stateBefore);
checkPrior(await engine(), false);
assert.equal(await exists(lock), true); assert.equal(await exists(binding), true);
await volumeFile('search_security_state', 'v1-profile-complete', originalStateBytes);
assert.deepEqual(await state(), originalState);
await reset();

checkpoint = 'preexisting-candidate';
approved = await prepare();
const createProbe = String.raw`import {openSearchAdminCreateClient} from '/app/packages/search/dist/opensearch-runtime.js';
  import {createLiteralV2IndexOnce} from '/app/packages/search/dist/opensearch-create-index.js';
  const c=await openSearchAdminCreateClient({endpoint:'https://opensearch:9200',identityDir:'/run/station-admin'});
  try {const x=await createLiteralV2IndexOnce(c.indices,process.argv[1]);
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(x.uuid))process.exit(2);}
  finally {await c.close();}`;
await docker(['run', '--rm', '--pull', 'never', '--network', `${project}_search_internal`,
  '--label', `station.create.gate=${project}`, '--read-only', '--cap-drop', 'ALL',
  '--user', '1000:1000', '--mount',
  `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
  `${project}-search-create-index`, 'node', '--input-type=module', '-e', createProbe, candidate], 45_000);
checkPrior(await engine(), true);
await readinessAndGrantProbe();
const preexistingDb = await registry();
const preexisting = await runInstrumented('passthrough', approved.args);
assert.equal(preexisting.failed, true);
assert.deepEqual(Object.keys(preexisting.ids).sort(), ['create', 'transfer']);
assert.deepEqual(preexisting.markers.create, []);
assert.deepEqual(await references(), {
  'search-create-apply-transfer': [preexisting.ids.transfer],
  'search-create-index': [preexisting.ids.create],
});
assert.deepEqual(await registry(), preexistingDb);
checkPrior(await engine(), true);
assert.equal(await exists(lock), true);
assert.equal(await exists(binding), true);
await reset();

async function drift(phase) {
  const result = await command('docker', ['compose', '--profile', 'search',
    '--profile', 'fixture', 'run', '--rm', '-T', '--no-deps',
    '-e', `SEARCH_DRIFT_PHASE=${phase}`, 'search-profile-drift'], process.env, 90_000);
  assert.equal(result.code, 0);
  return result.stdout;
}
for (const [change, restore] of [
  ['hidden-index', 'hidden-index-restore'], ['alias', 'alias-restore'],
  ['role', 'role-restore'],
]) {
  checkpoint = `apply-engine-${change}`;
  const approved = await prepare();
  const beforeDb = await registry();
  const beforeRaw = await rawEngineDigest();
  await drift(change);
  const changed = await rawEngineDigest();
  assert.notEqual(changed, beforeRaw);
  assert.deepEqual(await registry(), beforeDb);
  const evidence = await runInstrumented('passthrough', approved.args);
  assert.equal(evidence.failed, true);
  assert.deepEqual(Object.keys(evidence.ids).sort(), ['create', 'transfer']);
  assert.deepEqual(evidence.markers.create, []);
  assert.equal(evidence.rawLogs.create.stdout, '');
  assert.equal(parseMarkers(evidence.rawLogs.create.stderr).stderr,
    'Private create apply failed.\n');
  assert.deepEqual(await registry(), beforeDb);
  assert.equal(await rawEngineDigest(), changed);
  assert.equal(await exists(lock), true); assert.equal(await exists(binding), true);
  assert.deepEqual(await state(), originalState);
  await unchangedSources();
  await drift(restore);
  assert.equal(await rawEngineDigest(), beforeRaw);
  checkPrior(await engine(), false);
  await reset();
}

async function replaceInternalNetwork() {
  const name = `${project}_search_internal`;
  const before = JSON.parse(await docker(['network', 'inspect', name]))[0];
  assert.equal(before.Internal, true);
  assert.equal(before.Labels?.['com.docker.compose.project'], project);
  assert.equal(before.Labels?.['com.docker.compose.network'], 'search_internal');
  const opensearchId = (await docker(['compose', '--profile', 'search', 'ps', '-q',
    'opensearch'])).trim();
  assert.deepEqual(Object.keys(before.Containers ?? {}), [opensearchId]);
  const labels = Object.entries(before.Labels).flatMap(([key, value]) => {
    assert.match(key, /^[a-zA-Z0-9_.-]{1,100}$/);
    assert.match(value, /^[a-zA-Z0-9_.-]{1,100}$/);
    return ['--label', `${key}=${value}`];
  });
  await docker(['network', 'disconnect', name, opensearchId]);
  await docker(['network', 'rm', name]);
  await docker(['network', 'create', '--driver', 'bridge', '--internal', ...labels, name]);
  await docker(['network', 'connect', '--alias', 'opensearch', name, opensearchId]);
  const after = JSON.parse(await docker(['network', 'inspect', name]))[0];
  assert.notEqual(after.Id, before.Id);
  assert.equal(after.Internal, true);
}
for (const kind of ['postgres', 'network', 'apply-volume']) {
  checkpoint = `apply-host-${kind}`;
  const approved = await prepare();
  const beforeDb = await registry();
  let reached = false, transferId, volumeName;
  const phaseAttempts = [];
  const adapterFactory = input => {
    const adapter = createApplyDockerAdapter(input, { command: (args, env, ms) =>
      command('docker', args, env, ms ?? 10_000) });
    return { ...adapter,
      createVolume: async name => { volumeName = name; return adapter.createVolume(name); },
      runPhase: async phase => {
        phaseAttempts.push(phase);
        if (phase !== 'transfer') throw Error('Unexpected fixture create dispatch');
        const transfer = await adapter.runPhase(phase);
        transferId = transfer.id;
        assert.match(transferId, postgres);
        const logs = await command('docker', ['container', 'logs', transferId]);
        assert.equal(logs.code, 0);
        assert.equal(logs.stdout, 'Private create apply transfer completed.\n');
        assert.equal(logs.stderr, '');
        if (kind === 'postgres') {
          const beforeId = pgId;
          await docker(['compose', '--profile', 'search', 'up', '-d', '--wait',
            '--force-recreate', '--no-deps', 'postgres'], 120_000);
          pgId = (await docker(['compose', 'ps', '-q', 'postgres'])).trim();
          assert.match(pgId, postgres); assert.notEqual(pgId, beforeId);
          assert.equal(await sql('SELECT 1'), '1');
        } else if (kind === 'network') await replaceInternalNetwork();
        else {
          const previous = JSON.parse(await docker(['volume', 'inspect', volumeName]))[0];
          await docker(['container', 'rm', transferId]);
          await docker(['volume', 'rm', volumeName]);
          await delay(1100);
          await docker(['volume', 'create', '--driver', 'local',
            '--label', `station.create.project=${project}`,
            '--label', `station.create.invocation=${JSON.parse(await readFile(binding,
              'utf8')).invocationId}`, volumeName]);
          const replacement = JSON.parse(await docker(['volume', 'inspect', volumeName]))[0];
          assert.notEqual(replacement.CreatedAt, previous.CreatedAt);
        }
        reached = true;
        return transfer;
      } };
  };
  let denied = false;
  try { await runCreateApplyOwner({ repository, uid, gid, args: approved.args,
    adapterFactory }); } catch { denied = true; }
  assert.equal(denied, true); assert.equal(reached, true);
  assert.deepEqual(phaseAttempts, ['transfer']);
  assert.deepEqual(await registry(), beforeDb);
  checkPrior(await engine(), false);
  assert.equal(await exists(lock), true); assert.equal(await exists(binding), true);
  assert.deepEqual(await state(), originalState);
  await unchangedSources();
  assert.deepEqual((await references())['search-create-index'], []);
  await reset();
}

checkpoint = 'apply-stopped-reference';
let stoppedApproval = await prepare();
const stoppedBefore = await registry();
const stoppedId = (await docker(['container', 'create', '--network', 'none',
  '--label', `station.create.gate=${project}`,
  '--label', `com.docker.compose.project=${project}`,
  '--label', 'com.docker.compose.service=search-create-index',
  `${project}-search-create-index`, 'true'])).trim();
assert.match(stoppedId, postgres);
assert.equal(JSON.parse(await docker(['container', 'inspect', stoppedId]))[0].State.Status,
  'created');
let stoppedFactory = 0, stoppedDenied = false, stoppedPhases = 0;
try { await runCreateApplyOwner({ repository, uid, gid, args: stoppedApproval.args,
  adapterFactory: input => { stoppedFactory++; const adapter = createApplyDockerAdapter(input, {
    command: (args, env, ms) => command('docker', args, env, ms ?? 10_000),
  }); return { ...adapter, runPhase: async phase => {
    stoppedPhases++; return adapter.runPhase(phase);
  } }; } }); } catch { stoppedDenied = true; }
assert.equal(stoppedDenied, true); assert.equal(stoppedFactory, 1);
assert.equal(stoppedPhases, 0);
assert.deepEqual(await registry(), stoppedBefore);
assert.equal(await exists(lock), true); assert.equal(await exists(binding), true);
assert.deepEqual((await references())['search-create-index'], [stoppedId]);
checkPrior(await engine(), false);
await docker(['container', 'rm', stoppedId]);
await reset();

const cases = [
  { name: 'crash-before-sent', stage: 'create_requested', revision: 5,
    dispatch: 'armed', created: false, sdkCalls: 0, getCalls: 0,
    lockState: 'dispatched', markers: ['ARMED'] },
  { name: 'crash-after-sent', stage: 'create_requested', revision: 6,
    dispatch: 'sent_unknown', created: false, sdkCalls: 0, getCalls: 0,
    lockState: 'dispatched', markers: ['DISPATCH_SENT_UNKNOWN'] },
  { name: 'false-ack', stage: 'create_requested', revision: 6,
    dispatch: 'sent_unknown', created: true, sdkCalls: 1, getCalls: 0,
    lockState: 'dispatched', markers: ['SDK_ORIGINAL_TRUE_ACK'] },
  { name: 'partial-ack', stage: 'create_requested', revision: 6,
    dispatch: 'sent_unknown', created: true, sdkCalls: 1, getCalls: 0,
    lockState: 'dispatched', markers: ['SDK_ORIGINAL_TRUE_ACK'] },
  { name: 'lost-response', stage: 'create_requested', revision: 6,
    dispatch: 'sent_unknown', created: true, sdkCalls: 1, getCalls: 0,
    lockState: 'dispatched', markers: ['SDK_ORIGINAL_TRUE_ACK'] },
  { name: 'transport-held', stage: 'create_requested', revision: 6,
    dispatch: 'sent_unknown', created: true, sdkCalls: 1, getCalls: 0,
    lockState: 'dispatched', markers: ['TRANSPORT_REAL_RESPONSE_HELD'] },
  { name: 'transport-timeout', stage: 'create_requested', revision: 6,
    dispatch: 'sent_unknown', created: true, sdkCalls: 1, getCalls: 0,
    lockState: 'dispatched', markers: ['TRANSPORT_REAL_RESPONSE_HELD', 'TRANSPORT_ABORTED'] },
  { name: 'crash-after-readback', stage: 'create_requested', revision: 6,
    dispatch: 'sent_unknown', created: true, sdkCalls: 1, getCalls: 1,
    lockState: 'dispatched', markers: ['SDK_GET_REAL_RESPONSE', 'SDK_READBACK_RETURNED'] },
  { name: 'db-after-engine', stage: 'create_requested', revision: 6,
    dispatch: 'sent_unknown', created: true, sdkCalls: 1, getCalls: 1,
    lockState: 'dispatched', markers: ['AFTER_ENGINE_HELD'] },
  { name: 'db-after-confirm', stage: 'create_requested', revision: 7,
    dispatch: 'response_confirmed', created: true, sdkCalls: 1, getCalls: 1,
    lockState: 'dispatched', markers: ['AFTER_CONFIRM_HELD'] },
  { name: 'concurrent-hold', stage: 'uuid_bound', revision: 8,
    dispatch: 'response_confirmed', created: true, sdkCalls: 1, getCalls: 1,
    success: true, markers: ['PRESEND_HELD'] },
  { name: 'passthrough', stage: 'uuid_bound', revision: 8,
    dispatch: 'response_confirmed', created: true, sdkCalls: 1, getCalls: 1,
    success: true, markers: ['SDK_GET_REAL_RESPONSE'] },
];
const armedTrace = ['ADVANCE_CREATE_REQUESTED', 'ARMED'];
const sentTrace = [...armedTrace, 'DISPATCH_SENT_UNKNOWN'];
const entryTrace = [...sentTrace, 'PRESEND_DB_CONFIRMED', 'SDK_CREATE_SENT',
  'SDK_CREATE_REAL_RESPONSE'];
const readbackTrace = [...entryTrace, 'SDK_GET_SENT', 'SDK_GET_REAL_RESPONSE',
  'SDK_READBACK_RETURNED'];
const traces = {
  'crash-before-sent': armedTrace,
  'crash-after-sent': sentTrace,
  'false-ack': [...entryTrace, 'SDK_ORIGINAL_TRUE_ACK'],
  'partial-ack': [...entryTrace, 'SDK_ORIGINAL_TRUE_ACK'],
  'lost-response': [...entryTrace, 'SDK_ORIGINAL_TRUE_ACK'],
  'transport-held': [...sentTrace, 'PRESEND_DB_CONFIRMED', 'SDK_CREATE_SENT',
    'TRANSPORT_REAL_RESPONSE_HELD'],
  'transport-timeout': [...sentTrace, 'PRESEND_DB_CONFIRMED', 'SDK_CREATE_SENT',
    'TRANSPORT_REAL_RESPONSE_HELD', 'TRANSPORT_ABORTED'],
  'crash-after-readback': readbackTrace,
  'db-after-engine': [...readbackTrace, 'AFTER_ENGINE_HELD', 'AFTER_ENGINE_RELEASED'],
  'db-after-confirm': [...readbackTrace, 'DISPATCH_RESPONSE_CONFIRMED',
    'AFTER_CONFIRM_HELD', 'AFTER_CONFIRM_RELEASED'],
  'concurrent-hold': [...sentTrace, 'PRESEND_DB_CONFIRMED', 'PRESEND_HELD',
    'PRESEND_RELEASED', 'SDK_CREATE_SENT', 'SDK_CREATE_REAL_RESPONSE',
    'SDK_GET_SENT', 'SDK_GET_REAL_RESPONSE', 'SDK_READBACK_RETURNED',
    'DISPATCH_RESPONSE_CONFIRMED', 'ADVANCE_UUID_BOUND'],
  passthrough: [...readbackTrace, 'DISPATCH_RESPONSE_CONFIRMED', 'ADVANCE_UUID_BOUND'],
};
for (const item of cases) {
  checkpoint = `case-${item.name}`;
  const approved = await prepare();
  let controller = null;
  if (item.name.startsWith('db-after-')) controller = async evidence => {
    assert.equal(await sql(`SELECT rolcanlogin FROM pg_roles WHERE rolname='station_search_transition'`), 't');
    const id = await waitForMarker(evidence, item.name === 'db-after-engine' ?
      'AFTER_ENGINE_HELD' : 'AFTER_CONFIRM_HELD');
    assert.equal(await sql(`SELECT 1`), '1');
    await sql('ALTER ROLE station_search_transition NOLOGIN');
    assert.equal(await sql(`SELECT rolcanlogin FROM pg_roles WHERE rolname='station_search_transition'`), 'f');
    await release(id, item.name === 'db-after-engine' ? 'after-engine' : 'after-confirm');
  };
  if (item.name === 'transport-held') controller = async evidence => {
    const id = await waitForMarker(evidence, 'TRANSPORT_REAL_RESPONSE_HELD');
    assert.equal((await docker(['container', 'kill', '--signal=KILL', id])).trim(), id);
    assert.equal((await docker(['container', 'wait', id], 10_000)).trim(), '137');
    const killed = JSON.parse(await docker(['container', 'inspect', id]))[0];
    assert.equal(killed.State.ExitCode, 137);
  };
  if (item.name === 'concurrent-hold') controller = async evidence => {
    const id = await waitForMarker(evidence, 'PRESEND_HELD');
    const heldDb = await registry();
    assert.equal(heldDb.control.revision, 6);
    assert.equal(heldDb.dispatch[0].state, 'sent_unknown');
    const loser = await command('node', ['scripts/search-create-apply-owner.mjs',
      ...approved.args], process.env, 20_000);
    assert.equal(loser.code, 1);
    assert.equal(loser.stdout, '');
    assert.equal(loser.stderr, 'Private create apply owner failed.\n');
    assert.deepEqual(await registry(), heldDb);
    assert.deepEqual(await references(), {
      'search-create-apply-transfer': [evidence.ids.transfer],
      'search-create-index': [id],
    });
    await release(id, 'presend');
  };
  const evidence = await runInstrumented(item.name, approved.args, controller);
  item.phases = 2;
  item.args = approved.args;
  item.trace = traces[item.name];
  await checkOutcome(evidence, approved.intent, item);
  if (item.name === 'lost-response') {
    // Fixture-only external lock loss cannot make an already consumed binding
    // reusable, even though the engine independently shows the candidate.
    const beforeDb = await registry();
    const beforeEngine = await engine();
    const beforeBinding = await readFile(binding);
    const bindingStat = await lstat(binding);
    const beforeRefs = await references();
    await rm(lock);
    let factoryCalls = 0, denied = false;
    try { await runCreateApplyOwner({ repository, uid, gid, args: approved.args,
      adapterFactory: input => {
        factoryCalls++; return createApplyDockerAdapter(input, { command: (args, env, ms) =>
          command('docker', args, env, ms ?? 10_000) });
      } }); } catch { denied = true; }
    assert.equal(denied, true);
    assert.equal(factoryCalls, 0);
    assert.deepEqual(await registry(), beforeDb);
    assert.deepEqual(await engine(), beforeEngine);
    assert.deepEqual(await references(), beforeRefs);
    assert.deepEqual(await readFile(binding), beforeBinding);
    assert.equal((await lstat(binding)).ino, bindingStat.ino);
    assert.equal(await exists(lock), true);
  }
  process.stdout.write(`Create apply fixture checkpoint ${item.name} passed.\n`);
  await reset();
}

for (const fault of ['lost-transfer-command', 'lost-create-command',
  'cleanup-response']) {
  checkpoint = `host-${fault}`;
  await docker(['image', 'tag', baseTag, `${project}-search-create-index`]);
  const approved = await prepare();
  const ids = {}, calls = [];
  const adapterFactory = input => createApplyDockerAdapter(input, {
    command: async (argv, env, timeoutMs) => {
      const result = await command('docker', argv, env, timeoutMs ?? 10_000);
      if (argv[0] === 'compose' && argv.includes('run') && argv.includes('--detach')) {
        const phase = argv.at(-1) === 'search-create-index' ? 'create' : 'transfer';
        assert.equal(result.code, 0);
        assert.match(result.stdout.trim(), postgres);
        ids[phase] = result.stdout.trim(); calls.push(phase);
        if (fault === `lost-${phase}-command`) throw Error('Fixture lost actual host response');
      }
      if (argv[0] === 'container' && argv[1] === 'rm') {
        assert.equal(result.code, 0);
        calls.push('container-rm');
        if (fault === 'cleanup-response') throw Error('Fixture lost actual cleanup response');
      }
      return result;
    },
  });
  let denied = false;
  try { await runCreateApplyOwner({ repository, uid, gid, args: approved.args,
    adapterFactory }); } catch { denied = true; }
  assert.equal(denied, true);
  assert.deepEqual(calls.filter(x => ['transfer', 'create'].includes(x)),
    fault === 'lost-transfer-command' ? ['transfer'] : ['transfer', 'create']);
  if (fault !== 'cleanup-response') {
    const id = fault === 'lost-transfer-command' ? ids.transfer : ids.create;
    assert.equal((await docker(['container', 'wait', id], 330_000)).trim(), '0');
    const logs = await command('docker', ['container', 'logs', id]);
    assert.equal(logs.code, 0);
    assert.equal(logs.stdout, fault === 'lost-transfer-command' ?
      'Private create apply transfer completed.\n' :
      'Private create apply reached uuid_bound; search remains disabled.\n');
    assert.equal(logs.stderr, '');
  } else assert.deepEqual(calls.filter(x => x === 'container-rm'), ['container-rm']);
  const rows = await registry();
  assert.equal(rows.control.stage, fault === 'lost-transfer-command' ?
    'disabled_intent' : 'uuid_bound');
  assert.equal(rows.control.revision, fault === 'lost-transfer-command' ? 3 : 8);
  assert.equal(rows.dispatch.length, fault === 'lost-transfer-command' ? 0 : 1);
  if (rows.dispatch.length) assert.equal(rows.dispatch[0].state, 'response_confirmed');
  checkPrior(await engine(), fault !== 'lost-transfer-command');
  assert.equal(await exists(lock), true);
  assert.equal(await exists(binding), true);
  const records = (await readFile(lock, 'utf8')).trim().split(/\n+/).map(JSON.parse);
  assert.deepEqual([records.at(-1).phase, records.at(-1).state],
    fault === 'lost-transfer-command' ? ['transfer', 'dispatched'] :
      fault === 'lost-create-command' ? ['create', 'dispatched'] :
        ['create', 'confirmed']);
  assert.equal(records.some(x => x.state === 'cleanup-complete'), false);
  const replay = await command('node', ['scripts/search-create-apply-owner.mjs',
    ...approved.args], process.env, 20_000);
  assert.equal(replay.code, 1);
  assert.equal(replay.stdout, '');
  assert.deepEqual(await registry(), rows);
  await reset();
  process.stdout.write(`Create apply fixture checkpoint ${fault} passed.\n`);
}

checkpoint = 'unmodified-cli';
await docker(['image', 'tag', baseImage, `${project}-search-create-index`]);
const happy = await prepare();
const run = await command('node', ['scripts/search-create-apply-owner.mjs', ...happy.args],
  process.env, 480_000);
assert.equal(run.code, 0);
assert.equal(run.stdout, 'Private create apply completed; search remains disabled.\n');
assert.equal(run.stderr, '');
const terminal = await registry();
assert.equal(terminal.control.stage, 'uuid_bound');
assert.equal(terminal.control.revision, 8);
assert.equal(terminal.dispatch[0].state, 'response_confirmed');
assert.equal(terminal.control.publication_enabled, false);
assert.equal(terminal.control.serving_ready, false);
checkPrior(await engine(), true);
assert.equal(await exists(lock), false);
assert.equal(await exists(binding), true);
assert.equal(await exists(pending), true);
assert.deepEqual(await references(), { 'search-create-apply-transfer': [],
  'search-create-index': [] });
assert.deepEqual(await volumes(), []);
const refusal = await command('node', ['scripts/search-create-apply-owner.mjs', ...happy.args],
  process.env, 20_000);
assert.equal(refusal.code, 1);
assert.equal(refusal.stdout, '');
assert.equal(refusal.stderr, 'Private create apply owner failed.\n');
assert.deepEqual(await registry(), terminal);
await reset();
// Save one sealed proposal before the older matrix's terminal source deletion.
// Its exact bytes are restored only by the terminal missing-O probe, which
// never recreates the original physical index or its UUID.
const terminalProposal = await prepare();
await writeFile(path.join(scratch, 'terminal-missing-o.json'), JSON.stringify({
  args: terminalProposal.args,
  pending: terminalProposal.bytes.toString('base64'),
  db: await registry(), original, originalState,
  source: originalPublic.map(row => ({ name: row.name, digest: sha(row.bytes),
    ino: row.stat.ino, mode: row.stat.mode })),
}), { mode: 0o600, flag: 'wx' });
await rm(pending);
process.stdout.write('Actual create apply source gate passed; baseline restored.\n');
