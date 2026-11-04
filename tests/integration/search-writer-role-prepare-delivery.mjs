import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runWriterRolePrepareOwner } from '../../scripts/search-writer-role-prepare-owner-core.mjs';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';
import { createWriterRolePrepareDockerAdapter } from '../../scripts/search-create-boundary-owner-docker.mjs';
import { parseWriterRoleApprovalArgs, readWriterRolePending } from '../../scripts/search-writer-role-pending.mjs';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { verifyProfile } from '../../packages/search/dist/opensearch-runtime.js';
import { verifyV2IndexProfile } from '../../packages/search/dist/opensearch-v2-profile.js';
import { buildExpectedSecurityPolicy, compareObservedSecurityCollections } from
  '../../packages/search/dist/opensearch-generation-policy.js';
import { writerPrecreateDiagnostic } from
  '../support/search-create-boundary-delivery-diagnostic-filter.mjs';
import { inspectWriterRolePostgres } from '../support/search-writer-role-postgres-probe.mjs';
import { changeWriterPrepareRegistryFixture } from '../support/search-writer-role-registry-fixture.mjs';
import { runWriterRoleDeliveryCase } from './search-writer-role-delivery-case.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const project = path.basename(repository);
const uid = process.getuid(), gid = process.getgid();
const variant = process.env.STATION_WPREP_GATE_CASE;
const token = '11111111-1111-4111-8111-111111111111';
const candidate = `station-mail-v2-g${token.replaceAll('-', '')}`;
const oldPending = path.join(repository, '.cache/search-create-intent/pending.json');
const oldBinding = path.join(repository, '.cache/search-create-apply/binding.json');
const pending = path.join(repository, '.cache/search-writer-role-intent/pending.json');
const lock = path.join(repository, '.cache/search-db/.job-operation.lock');
const sourceRoot = path.join(repository, '.cache/search-security');
const fixtureRoot = path.join(repository, '.cache/results/writer-role-prepare-fixture');
const fullId = /^[0-9a-f]{64}$/;
const roleUuid = /^[A-Za-z0-9_-]{1,128}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const gateStarted = performance.now();
const exists = name => lstat(name).then(() => true, error => {
  if (error?.code === 'ENOENT') return false;
  throw error;
});
let checkpoint = 'setup';
const die = () => { process.stderr.write(`Writer role preparation fixture failed at ${checkpoint}.\n`);
  process.exit(1); };
process.on('uncaughtException', die);
process.on('unhandledRejection', die);
assert.equal(process.cwd(), repository);
assert.match(project, /^stationcreate(?:default|runner)[0-9a-f]{12}$/);
assert.ok(['default', 'runner', 'runner-volume', 'runner-missing-o'].includes(variant));
const deliveryCase = process.env.STATION_WRITER_DELIVERY_CASE;
assert.ok(deliveryCase === undefined ||
  ['positive', 'prestart', 'lost-return', 'false-ack', 'held-timeout'].includes(deliveryCase));
if (deliveryCase) assert.ok(['default', 'runner'].includes(variant));
assert.equal(process.env.APP_UID, String(uid)); assert.equal(process.env.APP_GID, String(gid));
assert.equal(uid, variant === 'default' ? 1000 : 1001);
assert.equal(gid, uid);
await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
assert.equal((await lstat(fixtureRoot)).mode & 0o777, 0o700);
const ownerEnv = { ...process.env };
delete ownerEnv.STATION_WPREP_GATE_CASE;
const privateMarkers = [
  (await readFile(path.join(repository, '.cache/search-db/initial-v1/transition.password'), 'utf8')).trim(),
  (await readFile(path.join(repository, '.cache/search-db/initial-v1/verifier.password'), 'utf8')).trim(),
  ...(await readFile(path.join(repository, '.env'), 'utf8')).matchAll(/^(?:POSTGRES_PASSWORD|STATION_MASTER_KEY)=(.+)$/gm),
].flatMap(x => Array.isArray(x) ? [x[1]] : [x]).filter(x => typeof x === 'string' && x.length >= 16);
async function command(binary, args, env = ownerEnv, timeoutMs = 30_000) {
  const child = spawn(binary, args, { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', overflow = false, timedOut = false;
  const append = (key, chunk) => {
    if (Buffer.byteLength(key === 'stdout' ? stdout : stderr) + chunk.length > 256 * 1024) {
      overflow = true; child.kill('SIGKILL'); return;
    }
    if (key === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout.on('data', chunk => append('stdout', chunk));
  child.stderr.on('data', chunk => append('stderr', chunk));
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  try {
    const terminal = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(overflow, false); assert.equal(timedOut, false);
    for (const marker of privateMarkers) {
      assert.equal(stdout.includes(marker), false); assert.equal(stderr.includes(marker), false);
    }
    return { ...terminal, stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function docker(args, timeoutMs = 30_000) {
  const result = await command('docker', args, ownerEnv, timeoutMs);
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  return result.stdout;
}
let postgresId = (await docker(['compose', 'ps', '-q', 'postgres'])).trim();
assert.match(postgresId, fullId);
const sql = async statement => (await docker(['exec', postgresId, 'psql', '-X', '-U', 'station',
  '-d', 'station', '-v', 'ON_ERROR_STOP=1', '-Atqc', statement])).trim();
async function databaseIdentity() {
  const line = await sql(`SELECT (pg_control_system()).system_identifier::text || '|' ||
    d.oid::text || '|' || r.rolname FROM pg_database d JOIN pg_roles r
    ON r.oid=d.datdba WHERE d.datname=current_database()`);
  const [systemIdentifier, databaseOid, owner] = line.split('|');
  assert.match(systemIdentifier, /^[1-9][0-9]{0,19}$/);
  assert.match(databaseOid, /^[1-9][0-9]{0,9}$/);
  assert.equal(owner, 'station');
  return { systemIdentifier, databaseOid: Number(databaseOid), owner };
}
async function registry(diagnostic) {
  diagnostic?.step('registry-rows-command');
  const rowText = await sql(`SELECT json_build_object(
    'control',(SELECT row_to_json(c) FROM search_generation_control c WHERE singleton=1),
    'history',(SELECT coalesce(json_agg(row_to_json(h) ORDER BY generation_token),'[]'::json)
      FROM search_generation_history h),
    'dispatch',(SELECT coalesce(json_agg(row_to_json(d) ORDER BY generation_token,operation),'[]'::json)
      FROM search_generation_dispatch d))`);
  diagnostic?.step('registry-rows-parse');
  const rows = JSON.parse(rowText);
  diagnostic?.step('registry-micro-command');
  const microText = await sql(`SELECT json_build_object(
    'control',(SELECT to_char(updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM search_generation_control WHERE singleton=1),
    'history',(SELECT coalesce(json_agg(json_build_array(generation_token,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY generation_token),'[]'::json) FROM search_generation_history),
    'dispatch',(SELECT coalesce(json_agg(json_build_array(generation_token,operation,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY generation_token,operation),'[]'::json) FROM search_generation_dispatch))`);
  diagnostic?.step('registry-micro-parse');
  const microseconds = JSON.parse(microText);
  diagnostic?.step('registry-micro-shape');
  assert.match(microseconds.control, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  for (const section of ['history', 'dispatch'])
    for (const row of microseconds[section])
      assert.match(row.at(-1), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  return { ...rows, microseconds };
}
async function engine(fromSource = false, diagnostic) {
  const script = String.raw`import {openSearchAdminObserver} from '/app/packages/search/dist/opensearch-runtime.js';
    const o=await openSearchAdminObserver({endpoint:'https://opensearch:9200',identityDir:'/run/station-admin'});
    if(process.env.STATION_WRITER_PRECREATE_TRACE==='1')process.stderr.write('STATION_WRITER_PRECREATE_OBSERVE\n');
    try {const v=await o.observe();process.stdout.write(JSON.stringify(v));}
    finally {await o.close();}`;
  const args = ['run', '--rm', '--pull', 'never', '--network',
    `${project}_search_internal`, '--label', `station.create.gate=${project}`,
    '--read-only', '--cap-drop', 'ALL', '--user', fromSource ? `${uid}:${gid}` : '1000:1000',
    ...(diagnostic ? ['-e', 'STATION_WRITER_PRECREATE_TRACE=1'] : []),
    ...(fromSource ? ['ca.pem', 'admin.pem', 'admin.key'].flatMap(name =>
      ['--mount', `type=bind,source=${path.join(sourceRoot, name)},target=/run/station-admin/${name},readonly`]) :
      ['--mount', `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`]),
    `${project}-search-writer-role-prepare`, 'node', '--input-type=module', '-e', script];
  if (!diagnostic) return JSON.parse(await docker(args, 45_000));
  diagnostic.step('engine-open');
  const result = await command('docker', args, ownerEnv, 45_000);
  if (result.stderr.split('\n').includes('STATION_WRITER_PRECREATE_OBSERVE'))
    diagnostic.step('engine-observe');
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  diagnostic.step('engine-parse');
  return JSON.parse(result.stdout);
}
async function rawEngineDigest() {
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
      const security=[];for(const path of ['/_plugins/_security/api/roles',
        '/_plugins/_security/api/rolesmapping','/_plugins/_security/api/securityconfig',
        '/_plugins/_security/api/actiongroups']){
        security.push(await read(o=>c.transport.request({method:'GET',path},o)));}
      process.stdout.write(createHash('sha256').update(JSON.stringify(canonical({indexes,security}))).digest('hex'));
    }finally{await c.close();}`;
  const value = (await docker(['run', '--rm', '--pull', 'never', '--network',
    `${project}_search_internal`, '--label', `station.create.gate=${project}`,
    '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000', '--mount',
    `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
    `${project}-search-writer-role-prepare`, 'node', '--input-type=module', '-e', script], 45_000)).trim();
  assert.match(value, /^[0-9a-f]{64}$/);
  return value;
}
async function state(diagnostic) {
  const script = String.raw`const fs=require('node:fs'),c=require('node:crypto');
    const root='/state'; const rows=fs.readdirSync(root).sort().map(n=>{const s=fs.lstatSync(root+'/'+n);
      return[n,s.uid,s.gid,s.mode&0o777,s.ino,s.isFile()?c.createHash('sha256').update(fs.readFileSync(root+'/'+n)).digest('hex'):null]});
    process.stdout.write(JSON.stringify(rows));`;
  diagnostic?.step('e0b-command');
  const value = await docker(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--label', `station.create.gate=${project}`, '--user', '1000:1000', '--mount',
    `type=volume,source=${project}_search_security_state,target=/state,readonly`,
    `${project}-search-writer-role-prepare`, 'node', '-e', script]);
  diagnostic?.step('e0b-parse');
  return JSON.parse(value);
}
async function adminFiles(diagnostic) {
  const script = String.raw`const fs=require('node:fs'),c=require('node:crypto');
    const root='/run/station-admin';process.stdout.write(JSON.stringify(['ca.pem','admin.pem','admin.key'].map(n=>{
      const s=fs.lstatSync(root+'/'+n);return[n,s.uid,s.gid,s.mode&0o777,s.ino,
        c.createHash('sha256').update(fs.readFileSync(root+'/'+n)).digest('hex')]})));`;
  diagnostic?.step('admin-command');
  const value = await docker(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--label', `station.create.gate=${project}`, '--user', '1000:1000', '--mount',
    `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
    `${project}-search-writer-role-prepare`, 'node', '-e', script]);
  diagnostic?.step('admin-parse');
  return JSON.parse(value);
}
async function hostResources(diagnostic) {
  const networkNames = [`${project}_search_admin_db`, `${project}_search_internal`, 'none'];
  const volumeNames = [`${project}_search_admin_certs`, `${project}_search_security_state`];
  diagnostic?.step('host-networks');
  const networks = Object.fromEntries(await Promise.all(networkNames.map(async name => {
    const item = JSON.parse(await docker(['network', 'inspect', name]))[0];
    assert.match(item.Id, fullId);
    return [name, { id: item.Id, internal: item.Internal, labels: item.Labels }];
  })));
  diagnostic?.step('host-volumes');
  const fixedVolumes = Object.fromEntries(await Promise.all(volumeNames.map(async name => {
    const item = JSON.parse(await docker(['volume', 'inspect', name]))[0];
    assert.equal(item.Name, name);
    return [name, { created: item.CreatedAt, labels: item.Labels,
      driver: item.Driver, options: item.Options }];
  })));
  diagnostic?.step('host-postgres');
  const pg = await inspectWriterRolePostgres(docker, postgresId, project);
  assert.equal(pg.id, postgresId);
  return { postgres: { id: pg.id, created: pg.created }, networks, fixedVolumes };
}
const sourceNames = ['ca.pem', 'admin.pem', 'admin.key', 'indexer.pem', 'query.pem'];
async function sources() {
  return Promise.all(sourceNames.map(async name => {
    const file = path.join(sourceRoot, name), stat = await lstat(file);
    return { name, bytes: await readFile(file), dev: stat.dev, ino: stat.ino,
      mode: stat.mode, uid: stat.uid, gid: stat.gid };
  }));
}
function sameSources(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].name, expected[i].name);
    assert.deepEqual(actual[i].bytes, expected[i].bytes);
    for (const key of ['dev', 'ino', 'mode', 'uid', 'gid'])
      assert.equal(actual[i][key], expected[i][key]);
  }
}
async function snapshot(diagnostic) {
  const currentRegistry = await registry(diagnostic);
  const currentEngine = await engine(false, diagnostic);
  const currentState = await state(diagnostic);
  const currentAdmin = await adminFiles(diagnostic);
  diagnostic?.step('sources');
  const currentSources = await sources();
  const host = await hostResources(diagnostic);
  return { registry: currentRegistry, engine: currentEngine, state: currentState,
    admin: currentAdmin, sources: currentSources, host };
}
function checkBeforeCreate(value, diagnostic) {
  diagnostic?.step('baseline-stage');
  assert.equal(value.registry.control.stage, 'disabled_intent');
  assert.equal(value.registry.control.revision, 3);
  assert.equal(value.registry.control.publication_enabled, false);
  assert.equal(value.registry.control.serving_ready, false);
  assert.equal(value.registry.dispatch.length, 0);
  assert.ok(value.engine.indexes['station-mail-v1']);
  assert.equal(Object.hasOwn(value.engine.indexes, candidate), false);
  diagnostic?.step('baseline-profile');
  assert.equal(verifyProfile({ 'station-mail-v1': value.engine.indexes['station-mail-v1'] }),
    value.registry.history.find(row => row.generation_token === 'legacy-v1').index_uuid);
}
const precreateDiagnostic = writerPrecreateDiagnostic(value => { checkpoint = value; });
const precreate = await snapshot(precreateDiagnostic);
checkBeforeCreate(precreate, precreateDiagnostic);
precreateDiagnostic.restore();
checkpoint = 'create-intent';
const intentResult = await command('node', ['scripts/search-create-intent-owner.mjs'], ownerEnv, 245_000);
assert.equal(intentResult.code, 0); assert.equal(intentResult.stderr, '');
assert.match(intentResult.stdout, /^Private create intent prepared sha256=[0-9a-f]{64}\.\n$/);
const createBytes = await readFile(oldPending);
const create = JSON.parse(createBytes.toString('utf8'));
assert.equal(hash(createBytes), intentResult.stdout.match(/sha256=([0-9a-f]{64})/)[1]);
const oldArgs = [hash(createBytes), String(create.revision), create.transitionToken,
  create.sourceToken, create.sourceIndex, create.sourceUuid,
  create.candidateToken, create.candidateIndex];
assert.deepEqual(await registry(), precreate.registry);
checkpoint = 'create-apply';
const createResult = await command('node', ['scripts/search-create-apply-owner.mjs', ...oldArgs],
  ownerEnv, 480_000);
assert.equal(createResult.code, 0); assert.equal(createResult.stderr, '');
assert.equal(createResult.stdout, 'Private create apply completed; search remains disabled.\n');
checkpoint = 'bound-baseline';
const baseline = await snapshot();
assert.deepEqual(baseline.host, precreate.host);
const originalDatabase = await databaseIdentity();
assert.equal(originalDatabase.databaseOid, create.databaseOid);
assert.equal(originalDatabase.systemIdentifier, create.systemIdentifier);
assert.equal(baseline.registry.control.stage, 'uuid_bound');
assert.equal(baseline.registry.control.revision, create.revision + 5);
assert.equal(baseline.registry.control.publication_enabled, false);
assert.equal(baseline.registry.control.serving_ready, false);
assert.equal(baseline.registry.dispatch.length, 1);
assert.equal(baseline.registry.dispatch[0].state, 'response_confirmed');
assert.equal(baseline.registry.dispatch[0].dispatch_id, create.dispatchId);
assert.equal(baseline.registry.dispatch[0].owner_id, create.ownerId);
assert.equal(baseline.registry.control.index_uuid,
  baseline.registry.history.find(row => row.generation_token === token)?.index_uuid);
assert.match(baseline.registry.control.index_uuid, roleUuid);
assert.ok(baseline.engine.indexes['station-mail-v1']);
assert.ok(baseline.engine.indexes[candidate]);
assert.equal(baseline.engine.indexes[candidate].settings.index.uuid,
  baseline.registry.control.index_uuid);
assert.deepEqual(Object.keys(baseline.engine.indexes).sort(),
  ['station-mail-v1', candidate].sort());
assert.equal(verifyProfile({ 'station-mail-v1': baseline.engine.indexes['station-mail-v1'] }),
  baseline.registry.history.find(row => row.generation_token === 'legacy-v1').index_uuid);
assert.equal(verifyV2IndexProfile({ [candidate]: baseline.engine.indexes[candidate] },
  candidate, baseline.registry.control.index_uuid), baseline.registry.control.index_uuid);
for (const name of ['station-mail-v1', candidate])
  assert.deepEqual(baseline.engine.indexes[name].aliases, {});
const legacyRow = baseline.registry.history.find(row => row.generation_token === 'legacy-v1');
const securityPolicy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
  generations: [{ token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
    presence: 'exact', uuid: legacyRow.index_uuid,
    writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
    writerCertFingerprint: null, queryCertFingerprint: null }] });
assert.equal(compareObservedSecurityCollections(securityPolicy,
  baseline.engine.roles, baseline.engine.mappings), 'exact');
const suffix = token.replaceAll('-', '');
for (const name of [`station_indexer_${suffix}`, `station_query_${suffix}`]) {
  assert.equal(Object.hasOwn(baseline.engine.roles, name), false);
  assert.equal(Object.hasOwn(baseline.engine.mappings, name), false);
}
const oldCreateStat = await lstat(oldPending), oldBindingStat = await lstat(oldBinding);
const oldBindingBytes = await readFile(oldBinding);
assert.equal((await lstat(lock).then(() => true, () => false)), false);
assert.equal(await exists(pending), false);
async function unchanged() {
  assert.deepEqual(await databaseIdentity(), originalDatabase);
  const current = await snapshot();
  assert.deepEqual(current.registry, baseline.registry);
  assert.deepEqual(current.engine, baseline.engine);
  assert.deepEqual(current.state, baseline.state);
  assert.deepEqual(current.admin, baseline.admin);
  assert.deepEqual(current.host, baseline.host);
  sameSources(current.sources, baseline.sources);
  await unchangedCreateFiles();
}
async function unchangedCreateFiles() {
  assert.deepEqual(await readFile(oldPending), createBytes);
  assert.deepEqual(await readFile(oldBinding), oldBindingBytes);
  for (const [name, prior] of [[oldPending, oldCreateStat], [oldBinding, oldBindingStat]]) {
    const stat = await lstat(name);
    assert.equal(stat.dev, prior.dev); assert.equal(stat.ino, prior.ino);
    assert.equal(stat.mode, prior.mode);
  }
}
async function references() {
  const result = [];
  for (const service of ['search-writer-role-prepare-transfer', 'search-writer-role-prepare']) {
    const text = (await docker(['ps', '-a', '--no-trunc', '--filter',
      `label=com.docker.compose.project=${project}`, '--filter',
      `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'])).trim();
    if (text) {
      for (const id of text.split('\n')) assert.match(id, fullId);
      result.push(...text.split('\n'));
    }
  }
  return result;
}
async function volumes() {
  const text = (await docker(['volume', 'ls', '--filter',
    `label=station.create.project=${project}`, '--format', '{{.Name}}'])).trim();
  const names = text ? text.split('\n') : [];
  for (const name of names)
    assert.match(name, new RegExp(`^${project}_search_writer_prepare_[0-9a-f]{32}$`));
  return names;
}
function roleArgs(sha256) {
  return [sha256, String(baseline.registry.control.revision),
    baseline.registry.control.transition_token, create.sourceToken,
    create.sourceIndex, create.sourceUuid, create.candidateToken,
    create.candidateIndex, baseline.registry.control.index_uuid];
}
async function checkPending(stdout) {
  const match = /^Private writer role proposal prepared: ([0-9a-f]{64})\n$/.exec(stdout);
  assert.ok(match);
  const bytes = await readFile(pending), stat = await lstat(pending);
  assert.equal(stat.mode & 0o777, 0o400);
  assert.equal(hash(bytes), match[1]);
  const intent = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(canonicalAttestorValue(intent, 256 * 1024).bytes, bytes);
  const approvedArgs = roleArgs(match[1]);
  assert.deepEqual([intent.revision, intent.transitionToken, intent.sourceToken,
    intent.sourceIndex, intent.sourceUuid, intent.candidateToken,
    intent.candidateIndex, intent.candidateUuid],
  [Number(approvedArgs[1]), ...approvedArgs.slice(2)]);
  assert.equal(intent.project, project);
  assert.equal(intent.databaseOid, create.databaseOid);
  assert.equal(intent.systemIdentifier, create.systemIdentifier);
  assert.equal(intent.priorEvidenceDigest, create.priorEvidenceDigest);
  assert.deepEqual(intent.publicFiles, create.publicFiles);
  assert.deepEqual(intent.publicDigests, create.publicDigests);
  assert.notEqual(intent.dispatchId, create.dispatchId);
  assert.notEqual(intent.ownerId, create.ownerId);
  assert.notEqual(intent.dispatchId, intent.ownerId);
  assert.equal(intent.createApprovedSha256, hash(createBytes));
  assert.equal(intent.originalCreateBindingSha256, hash(oldBindingBytes));
  const approved = parseWriterRoleApprovalArgs(approvedArgs);
  const captured = await readWriterRolePending(repository, uid, gid, approved);
  assert.equal(await captured.recheck(), true);
  assert.equal(await exists(lock), false);
  assert.deepEqual(await references(), []); assert.deepEqual(await volumes(), []);
  await unchanged();
  return { bytes, intent, sha256: match[1] };
}
checkpoint = 'unmodified-owner';
const happy = await command('node', ['scripts/search-writer-role-prepare-owner.mjs'], ownerEnv, 400_000);
process.stderr.write(happy.stdout + happy.stderr);
assert.equal(happy.code, 0); assert.equal(happy.stderr, '');
await checkPending(happy.stdout);
if (deliveryCase) {
  await runWriterRoleDeliveryCase({ deliveryCase, repository, project, uid, gid,
    candidate, baseline, securityPolicy, create, createBytes, oldBindingBytes, roleArgs,
    command, docker, sql, registry, engine, state, adminFiles, hostResources,
    sources, sourceRoot, pending, lock, ownerEnv, fixtureRoot, hash,
    setCheckpoint: value => { checkpoint = value; } });
  process.exit(0);
}
const replay = await command('node', ['scripts/search-writer-role-prepare-owner.mjs'], ownerEnv, 20_000);
process.stderr.write(replay.stdout + replay.stderr);
assert.equal(replay.code, 1); assert.equal(replay.stdout, '');
assert.equal(replay.stderr, 'Private writer role preparation owner failed.\n');
await rm(pending);
await unchanged();
process.stdout.write('Writer role preparation checkpoint unmodified-owner passed.\n');

checkpoint = 'instrumented-image';
const readImage = `${project}-search-writer-role-prepare`;
const baseId = JSON.parse(await docker(['image', 'inspect', readImage]))[0].Id;
assert.match(baseId, /^sha256:[0-9a-f]{64}$/);
const baseTag = `${project}-writer-prepare-original`;
await docker(['image', 'tag', baseId, baseTag]);
assert.equal(JSON.parse(await docker(['image', 'inspect', baseTag]))[0].Id, baseId);
await docker(['build', '--pull=false', '--network=none', '--build-arg', `BASE=${baseTag}`,
  '-f', 'tests/integration/search-writer-role-prepare-fixture.Dockerfile', '-t', readImage,
  '.'], 120_000);
const derivedId = JSON.parse(await docker(['image', 'inspect', readImage]))[0].Id;
assert.match(derivedId, /^sha256:[0-9a-f]{64}$/);
assert.notEqual(derivedId, baseId);
const transport = [];
let pendingBoundary = 0;
let activePhase = null;
let fixtureViolation = false;
let transferAttempts = 1, readAttempts = 1, cleanupSuccesses = 1;
const seenLogIds = new Set();
async function recordFixtureLogs(id, raw) {
  assert.match(id, fullId);
  assert.equal(seenLogIds.has(id), false);
  const item = JSON.parse(await docker(['container', 'inspect', id]))[0];
  assert.equal(item.Config.Labels['com.docker.compose.project'], project);
  assert.equal(item.Config.Labels['com.docker.compose.service'],
    'search-writer-role-prepare');
  assert.equal(item.Image, derivedId);
  assert.ok(Buffer.byteLength(raw) <= 64 * 1024);
  const lines = raw.split('\n');
  assert.equal(lines.pop(), '');
  assert.ok(lines.length > 0);
  const counts = { GET: 0, HEAD: 0, OTHER: 0 };
  let terminal = '';
  for (const line of lines) {
    if (line === 'Private writer role preparation failed.') {
      assert.equal(terminal, '');
      terminal = `${line}\n`;
      continue;
    }
    assert.equal(terminal, '');
    assert.match(line, /^WRITER_PREPARE_FIXTURE:(GET|HEAD|OTHER)$/);
    counts[line.slice('WRITER_PREPARE_FIXTURE:'.length)]++;
  }
  await writeFile(path.join(fixtureRoot, `transport-${id}.log`), raw,
    { mode: 0o600, flag: 'wx' });
  seenLogIds.add(id);
  transport.push({ id, ...counts });
  return terminal;
}
const fixtureCommand = async (args, env, timeoutMs) => {
  const result = await command('docker', args, env, timeoutMs ?? 10_000);
  if (args[0] === 'container' && args[1] === 'logs') {
    assert.equal(args.length, 3);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) < 128 * 1024);
    process.stderr.write(result.stdout + result.stderr);
    if (activePhase === 'prepare') {
      let terminal;
      try { terminal = await recordFixtureLogs(args[2], result.stderr); }
      catch (error) { fixtureViolation = true; throw error; }
      return { ...result, stderr: terminal };
    }
    assert.equal(result.stderr, '');
  }
  return result;
};
const adapterFactory = input => {
  const adapter = createWriterRolePrepareDockerAdapter(input, { command: fixtureCommand });
  return { ...adapter, runPhase: async phase => {
    if (phase === 'transfer') transferAttempts++;
    else if (phase === 'prepare') readAttempts++;
    else throw Error('Unexpected fixture phase');
    activePhase = phase;
    try { return await adapter.runPhase(phase); }
    finally { activePhase = null; }
  }, cleanupRemote: async (...args) => {
    const result = await adapter.cleanupRemote(...args);
    cleanupSuccesses++;
    return result;
  } };
};
const runCore = (overrides = {}) => runWriterRolePrepareOwner({ repository, uid, gid,
  adapterFactory, ...overrides });
checkpoint = 'readonly-grant';
await sql('ALTER ROLE station_search_transition SET default_transaction_read_only=on');
const roleConfig = await sql(`SELECT coalesce(array_to_string(rolconfig,','),'')
  FROM pg_roles WHERE rolname='station_search_transition'`);
assert.match(roleConfig, /default_transaction_read_only=on/);
const transitionPassword = (await readFile(path.join(repository,
  '.cache/search-db/initial-v1/transition.password'), 'utf8')).trim();
const postgresProbe = await inspectWriterRolePostgres(docker, postgresId, project);
const adminIp = postgresProbe.adminIp;
assert.match(adminIp, /^(?:\d{1,3}\.){3}\d{1,3}$/);
const transitionQuery = async query => command('docker', ['exec',
  '-e', `PGPASSWORD=${transitionPassword}`, postgresId, 'psql', '-X', '-h', adminIp,
  '-U', 'station_search_transition', '-d', 'station', '-v', 'ON_ERROR_STOP=1',
  '-Atqc', query]);
const roleRead = await transitionQuery(`SELECT current_user,
  current_setting('default_transaction_read_only')`);
assert.equal(roleRead.code, 0);
assert.equal(roleRead.stdout.trim(), 'station_search_transition|on');
const deniedWrite = await transitionQuery(`UPDATE search_generation_control
  SET revision=revision WHERE singleton=1`);
assert.notEqual(deniedWrite.code, 0);
assert.match(deniedWrite.stderr, /cannot execute UPDATE in a read-only transaction/);
assert.deepEqual(await registry(), baseline.registry);
assert.deepEqual(await databaseIdentity(), originalDatabase);
checkpoint = 'instrumented-owner';
let instrumented;
try {
  instrumented = await runCore({ writePending: async (...args) => {
    pendingBoundary++;
    assert.equal(await exists(pending), false);
    assert.deepEqual(await references(), []);
    assert.deepEqual(await volumes(), []);
    const roots = path.join(repository, '.cache/search-writer-role-invocations');
    assert.deepEqual(await readdir(roots), []);
    const { writeWriterRolePending } = await import('../../scripts/search-create-intent-pending.mjs');
    return writeWriterRolePending(...args);
  } });
  assert.equal(instrumented.state, 'prepared');
  assert.equal(fixtureViolation, false);
  assert.equal(pendingBoundary, 1);
  assert.equal(transport.length, 1);
  assert.ok(transport[0].GET > 0);
  assert.equal(transport[0].OTHER, 0);
  await checkPending(`Private writer role proposal prepared: ${instrumented.sha256}\n`);
  await rm(pending);
  await unchanged();
} finally {
  await sql('ALTER ROLE station_search_transition RESET default_transaction_read_only');
  await docker(['image', 'tag', baseTag, readImage]);
}
assert.equal(JSON.parse(await docker(['image', 'inspect', readImage]))[0].Id, baseId);
process.stdout.write('Writer role preparation checkpoint instrumented-owner passed.\n');

// Reuse the immutable original O/N/U and checked create files for every fault.
// Only fixture-owned references and paths are removed after each denial has
// been observed; the original baseline is never reconstructed.
async function cleanFault() {
  for (const id of await references()) await docker(['container', 'rm', '-f', id]);
  for (const name of await volumes()) await docker(['volume', 'rm', name]);
  for (const parentName of ['search-writer-role-invocations', 'search-create-apply-public']) {
    const parent = path.join(repository, '.cache', parentName);
    if (!await exists(parent)) continue;
    const names = await readdir(parent);
    assert.ok(names.length <= 1);
    for (const name of names) {
      assert.match(name, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      await rm(path.join(parent, name), { recursive: true });
    }
  }
  if (await exists(lock)) await rm(lock);
  if (await exists(pending)) await rm(pending);
  assert.deepEqual(await references(), []);
  assert.deepEqual(await volumes(), []);
  await unchanged();
}
async function retainedLock(phase, stateName) {
  assert.equal(await exists(lock), true);
  const lines = (await readFile(lock, 'utf8')).trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 2);
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.role, 'writer-role-prepare');
  assert.equal(last.phase, phase);
  assert.equal(last.state, stateName);
  assert.equal(await exists(pending), false);
}
async function collectUnseenPrepareLogs() {
  for (const id of await references()) {
    const item = JSON.parse(await docker(['container', 'inspect', id]))[0];
    if (item.Config.Labels['com.docker.compose.service'] !==
        'search-writer-role-prepare' || seenLogIds.has(id)) continue;
    const logs = await command('docker', ['container', 'logs', id]);
    assert.equal(logs.code, 0);
    process.stderr.write(logs.stdout + logs.stderr);
    await recordFixtureLogs(id, logs.stderr);
  }
}
async function drift(phase) {
  const result = await command('docker', ['compose', '--profile', 'search',
    '--profile', 'fixture', 'run', '--rm', '-T', '--no-deps',
    '-e', `SEARCH_DRIFT_PHASE=${phase}`, 'search-profile-drift'], ownerEnv, 90_000);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.ok(result.stdout.length > 0 && result.stdout.length < 4096);
}
async function denied(name, fault, expected) {
  checkpoint = `fault-${name}`;
  await docker(['image', 'tag', derivedId, readImage]);
  const transportBefore = transport.length;
  const phases = [];
  let reached = false;
  const wrapped = input => {
    const adapter = adapterFactory(input);
    return { ...adapter,
      runPhase: async phase => {
        phases.push(phase);
        const value = await adapter.runPhase(phase);
        if (phase === expected.afterPhase) {
          await fault({ phase, value, input });
          reached = true;
          if (expected.lostReturn) throw Error('Fixture lost completed phase return');
        }
        return value;
      },
      cleanupRemote: async (...args) => {
        if (expected.cleanupBefore) {
          assert.deepEqual((await references()).length, 2);
          assert.deepEqual((await volumes()).length, 1);
          reached = true;
          throw Error('Fixture refused checked remote cleanup');
        }
        if (expected.cleanup) {
          await adapter.cleanupRemote(...args);
          reached = true;
          throw Error('Fixture lost checked cleanup return');
        }
        return adapter.cleanupRemote(...args);
      } };
  };
  let rejected = false;
  checkpoint = `fault-${name}-owner`;
  try { await runCore({ adapterFactory: wrapped }); }
  catch { rejected = true; }
  checkpoint = `fault-${name}-logs`;
  await collectUnseenPrepareLogs();
  assert.equal(fixtureViolation, false);
  assert.equal(transport.every(row => row.OTHER === 0), true);
  assert.equal(transport.length - transportBefore,
    expected.phases.includes('prepare') ? 1 : 0);
  assert.equal(reached, true);
  assert.equal(rejected, true);
  assert.deepEqual(phases, expected.phases);
  checkpoint = `fault-${name}-evidence`;
  await retainedLock(expected.lockPhase, expected.lockState);
  await expected.observe?.();
  checkpoint = `fault-${name}-restore`;
  await expected.restore?.();
  assert.deepEqual(await registry(), baseline.registry);
  assert.deepEqual(await engine(), baseline.engine);
  assert.deepEqual(await state(), baseline.state);
  assert.deepEqual(await adminFiles(), baseline.admin);
  assert.deepEqual(await hostResources(), baseline.host);
  sameSources(await sources(), baseline.sources);
  checkpoint = `fault-${name}-cleanup`;
  await cleanFault();
  await docker(['image', 'tag', baseTag, readImage]);
  process.stdout.write(`Writer role preparation checkpoint ${name} passed.\n`);
}

if (variant === 'default' || variant === 'runner') {
await denied('lost-transfer-return', async ({ value }) => {
  assert.match(value.id, fullId);
  assert.equal(value.phase, 'transfer');
  const raw = await command('docker', ['container', 'logs', value.id]);
  assert.equal(raw.code, 0);
  assert.equal(raw.stdout, 'Private writer role preparation transfer completed.\n');
  assert.equal(raw.stderr, '');
  assert.equal(raw.signal, null);
}, { afterPhase: 'transfer', phases: ['transfer'], lockPhase: 'transfer',
  lockState: 'dispatched', lostReturn: true });
await denied('lost-prepare-return', async ({ value }) => {
  assert.match(value.id, fullId);
  assert.equal(value.phase, 'prepare');
  assert.equal(typeof value.rawOutput, 'string');
  assert.equal(transport.at(-1)?.id, value.id);
  assert.ok(transport.at(-1).GET > 0);
}, { afterPhase: 'prepare', phases: ['transfer', 'prepare'],
  lockPhase: 'prepare', lockState: 'dispatched', lostReturn: true });
await denied('lost-cleanup-return', async () => {}, {
  phases: ['transfer', 'prepare'], lockPhase: 'prepare',
  lockState: 'confirmed', cleanup: true });
await denied('cleanup-refused', async () => {}, {
  phases: ['transfer', 'prepare'], lockPhase: 'prepare',
  lockState: 'confirmed', cleanupBefore: true });

// The producer read is real in each case; the replacement is inserted only
// after its transfer phase has completed and the owner has pinned the original.
for (const name of ['create-pending-inode', 'create-binding-inode']) {
  const file = name === 'create-pending-inode' ? oldPending : oldBinding;
  const original = name === 'create-pending-inode' ? oldCreateStat : oldBindingStat;
  const held = path.join(fixtureRoot, `${name}.held`);
  await denied(name, async () => {
    await rename(file, held);
    await writeFile(file, await readFile(held), { mode: 0o400, flag: 'wx' });
    const replaced = await lstat(file);
    assert.notEqual(replaced.ino, original.ino);
    assert.equal((await readdir(path.dirname(file))).includes(path.basename(held)), false);
  }, { afterPhase: 'transfer', phases: ['transfer'],
    lockPhase: 'transfer', lockState: 'dispatched', restore: async () => {
      assert.equal(await exists(held), true);
      await rm(file);
      await rename(held, file);
      assert.equal((await lstat(file)).ino, original.ino);
    } });
}

const publicName = path.join(sourceRoot, 'indexer.pem');
const publicHeld = path.join(fixtureRoot, 'indexer.pem.held');
await denied('public-pem-inode', async () => {
  await rename(publicName, publicHeld);
  await writeFile(publicName, await readFile(publicHeld), { mode: 0o400, flag: 'wx' });
  assert.notEqual((await lstat(publicName)).ino,
    baseline.sources.find(row => row.name === 'indexer.pem').ino);
}, { afterPhase: 'transfer', phases: ['transfer'],
  lockPhase: 'transfer', lockState: 'dispatched',
  observe: async () => assert.equal(await exists(publicHeld), true),
  restore: async () => { await rm(publicName); await rename(publicHeld, publicName); } });

const publicBytesHeld = path.join(fixtureRoot, 'indexer-bytes.held');
await denied('public-pem-bytes', async () => {
  await rename(publicName, publicBytesHeld);
  await writeFile(publicName, baseline.sources.find(row => row.name === 'query.pem').bytes,
    { mode: 0o400, flag: 'wx' });
  assert.notDeepEqual(await readFile(publicName),
    baseline.sources.find(row => row.name === 'indexer.pem').bytes);
}, { afterPhase: 'transfer', phases: ['transfer'],
  lockPhase: 'transfer', lockState: 'dispatched',
  observe: async () => assert.equal(await exists(publicBytesHeld), true),
  restore: async () => { await rm(publicName); await rename(publicBytesHeld, publicName); } });

for (const name of ['registry-revision', 'registry-candidate-uuid', 'create-dispatch-owner']) {
  let changed;
  await denied(name, async () => {
    changed = await changeWriterPrepareRegistryFixture(name, 'mutate', baseline.registry,
      { runSql: sql, readRegistry: registry });
    assert.deepEqual(await registry(), changed);
  }, { afterPhase: 'transfer', phases: ['transfer', 'prepare'],
    lockPhase: 'prepare', lockState: 'dispatched',
    observe: async () => assert.deepEqual(await registry(), changed),
    restore: async () => {
      await changeWriterPrepareRegistryFixture(name, 'restore', baseline.registry,
        { runSql: sql, readRegistry: registry });
    } });
}

async function volumeFile(volumeName, file, replacement = null) {
  const script = String.raw`const fs=require('node:fs');const name='/probe/'+process.argv[1];
    if(process.argv[2])fs.writeFileSync(name,Buffer.from(process.argv[2],'base64'));
    const s=fs.lstatSync(name);
    if(!s.isFile())process.exit(2);
    process.stdout.write(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode&0o777,
      ino:s.ino,bytes:fs.readFileSync(name).toString('base64')}));`;
  return JSON.parse(await docker(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--label', `station.create.gate=${project}`, '--read-only', '--cap-drop', 'ALL',
    ...(replacement ? ['--cap-add', 'DAC_OVERRIDE'] : []),
    '--user', replacement ? '0:0' : '1000:1000', '--mount',
    `type=volume,source=${project}_${volumeName},target=/probe${replacement ? '' : ',readonly'}`,
    `${project}-search-writer-role-prepare`, 'node', '-e', script, file,
    replacement ? Buffer.from(replacement).toString('base64') : '']));
}
const originalAdmin = await volumeFile('search_admin_certs', 'admin.pem');
const wrongAdmin = baseline.sources.find(row => row.name === 'query.pem').bytes;
await denied('mounted-admin-pem', async () => {
  const changed = await volumeFile('search_admin_certs', 'admin.pem', wrongAdmin);
  assert.deepEqual(Buffer.from(changed.bytes, 'base64'), wrongAdmin);
}, { afterPhase: 'transfer', phases: ['transfer', 'prepare'],
  lockPhase: 'prepare', lockState: 'dispatched',
  observe: async () => {
    assert.notDeepEqual(await adminFiles(), baseline.admin);
    assert.deepEqual(await engine(true), baseline.engine);
  },
  restore: async () => {
    const restored = await volumeFile('search_admin_certs', 'admin.pem',
      Buffer.from(originalAdmin.bytes, 'base64'));
    assert.deepEqual(restored, originalAdmin);
  } });

const originalState = await volumeFile('search_security_state', 'v1-profile-complete');
const flippedState = Buffer.from(originalState.bytes, 'base64');
flippedState[0] ^= 1;
await denied('mounted-e0b', async () => {
  const changed = await volumeFile('search_security_state', 'v1-profile-complete', flippedState);
  assert.deepEqual(Buffer.from(changed.bytes, 'base64'), flippedState);
}, { afterPhase: 'transfer', phases: ['transfer', 'prepare'],
  lockPhase: 'prepare', lockState: 'dispatched',
  observe: async () => assert.notDeepEqual(await state(), baseline.state),
  restore: async () => {
    const restored = await volumeFile('search_security_state', 'v1-profile-complete',
      Buffer.from(originalState.bytes, 'base64'));
    assert.deepEqual(restored, originalState);
  } });

for (const [change, restore] of [
  ['hidden-index', 'hidden-index-restore'],
  ['alias', 'alias-restore'],
  ['role', 'role-restore'],
]) {
  const priorRaw = await rawEngineDigest();
  let changedRaw;
  await denied(`engine-${change}`, async () => {
    await drift(change);
    changedRaw = await rawEngineDigest();
    assert.notEqual(changedRaw, priorRaw);
  }, { afterPhase: 'transfer', phases: ['transfer', 'prepare'],
    lockPhase: 'prepare', lockState: 'dispatched',
    observe: async () => assert.equal(await rawEngineDigest(), changedRaw),
    restore: async () => {
      await drift(restore);
      assert.equal(await rawEngineDigest(), priorRaw);
  } });
}
async function candidateInterval(value) {
  assert.ok(['1s', '2s'].includes(value));
  const script = String.raw`import {readFileSync} from 'node:fs';
    import {Client} from '@opensearch-project/opensearch';
    const root='/run/station-admin';const c=new Client({node:'https://opensearch:9200',
      ssl:{ca:readFileSync(root+'/ca.pem'),cert:readFileSync(root+'/admin.pem'),
      key:readFileSync(root+'/admin.key'),rejectUnauthorized:true},maxRetries:0,requestTimeout:5000});
    try {const r=await c.indices.putSettings({index:process.argv[1],
      body:{index:{refresh_interval:process.argv[2]}}});
      if(r.body?.acknowledged!==true)process.exit(2);process.stdout.write('ok');}
    finally {await c.close();}`;
  assert.equal(await docker(['run', '--rm', '--pull', 'never', '--network',
    `${project}_search_internal`, '--label', `station.create.gate=${project}`,
    '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000', '--mount',
    `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
    `${project}-search-writer-role-prepare`, 'node', '--input-type=module', '-e', script,
    candidate, value], 45_000), 'ok');
}
const candidateRaw = await rawEngineDigest();
let changedCandidateRaw;
await denied('candidate-profile', async () => {
  await candidateInterval('2s');
  changedCandidateRaw = await rawEngineDigest();
  assert.notEqual(changedCandidateRaw, candidateRaw);
}, { afterPhase: 'transfer', phases: ['transfer', 'prepare'],
  lockPhase: 'prepare', lockState: 'dispatched',
  observe: async () => assert.equal(await rawEngineDigest(), changedCandidateRaw),
  restore: async () => {
    await candidateInterval('1s');
    assert.equal(await rawEngineDigest(), candidateRaw);
  } });

checkpoint = 'fault-stopped-service';
const stoppedId = (await docker(['container', 'create', '--network', 'none',
  '--label', `station.create.gate=${project}`,
  '--label', `com.docker.compose.project=${project}`,
  '--label', 'com.docker.compose.service=search-writer-role-prepare',
  readImage, 'true'])).trim();
assert.match(stoppedId, fullId);
assert.equal(JSON.parse(await docker(['container', 'inspect', stoppedId]))[0].State.Status,
  'created');
let stoppedPhases = 0, stoppedDenied = false;
try {
  await runCore({ adapterFactory: input => {
    const adapter = adapterFactory(input);
    return { ...adapter, runPhase: async phase => {
      stoppedPhases++; return adapter.runPhase(phase);
    } };
  } });
} catch { stoppedDenied = true; }
assert.equal(stoppedDenied, true);
assert.equal(stoppedPhases, 0);
assert.deepEqual(await references(), [stoppedId]);
assert.equal(await exists(pending), false);
assert.deepEqual(await registry(), baseline.registry);
assert.deepEqual(await engine(), baseline.engine);
await docker(['container', 'rm', stoppedId]);
await cleanFault();
process.stdout.write('Writer role preparation checkpoint stopped-service passed.\n');

checkpoint = 'fault-concurrent-owners';
await docker(['image', 'tag', derivedId, readImage]);
const concurrentBefore = transport.length;
const concurrent = await Promise.allSettled([runCore(), runCore()]);
assert.deepEqual(concurrent.map(row => row.status).sort(), ['fulfilled', 'rejected']);
const winner = concurrent.find(row => row.status === 'fulfilled').value;
assert.equal(winner.state, 'prepared');
assert.equal(transport.length - concurrentBefore, 1);
assert.ok(transport.at(-1).GET > 0);
assert.equal(transport.at(-1).OTHER, 0);
await checkPending(`Private writer role proposal prepared: ${winner.sha256}\n`);
await rm(pending);
await unchanged();
await docker(['image', 'tag', baseTag, readImage]);
process.stdout.write('Writer role preparation checkpoint concurrent-owners passed.\n');

checkpoint = 'fault-partial-pending';
await docker(['image', 'tag', derivedId, readImage]);
let pendingReached = false;
const partialBefore = transport.length;
let partialDenied = false;
try {
  await runCore({ writePending: async (prepared, intent, digest) => {
    assert.equal(await exists(prepared.name), false);
    const bytes = canonicalAttestorValue(intent, 256 * 1024).bytes;
    assert.equal(hash(bytes), digest);
    const handle = await open(prepared.name, 'wx', 0o400);
    try {
      await handle.writeFile(bytes.subarray(0, Math.floor(bytes.length / 2)));
      await handle.sync();
    } finally { await handle.close(); }
    pendingReached = true;
    throw Error('Fixture lost pending file completion');
  } });
} catch { partialDenied = true; }
assert.equal(pendingReached, true);
assert.equal(partialDenied, true);
assert.equal(transport.length - partialBefore, 1);
assert.ok(transport.at(-1).GET > 0);
assert.equal(transport.at(-1).OTHER, 0);
assert.deepEqual(await references(), []);
assert.deepEqual(await volumes(), []);
assert.equal(await exists(pending), true);
assert.ok((await lstat(pending)).size > 0);
assert.ok((await lstat(pending)).size < 256 * 1024);
const partialLines = (await readFile(lock, 'utf8')).trim().split('\n').filter(Boolean);
const partialLast = JSON.parse(partialLines.at(-1));
assert.deepEqual([partialLast.role, partialLast.phase, partialLast.state],
  ['writer-role-prepare', 'pending', 'attempted']);
// After exact failure evidence, simulate external loss of only the disposable
// lock: the existing partial proposal still blocks replay before Docker.
await rm(lock);
let replayFactories = 0;
let partialReplayDenied = false;
try { await runCore({ adapterFactory: input => {
  replayFactories++;
  return adapterFactory(input);
} }); } catch { partialReplayDenied = true; }
assert.equal(partialReplayDenied, true);
assert.equal(replayFactories, 0);
assert.equal(await exists(pending), true);
await cleanFault();
await docker(['image', 'tag', baseTag, readImage]);
process.stdout.write('Writer role preparation checkpoint partial-pending passed.\n');

for (const fault of ['writer-prepare-final-after-append',
  'writer-prepare-final-after-file-sync']) {
  checkpoint = `fault-${fault}`;
  await docker(['image', 'tag', derivedId, readImage]);
  const before = transport.length;
  process.env.STATION_JOB_LOCK_FIXTURE = '1';
  let rejected = false;
  try {
    await runCore({ lock: (options, work) =>
      withSearchAdminJobLock({ ...options, fixtureFaultAt: fault }, work) });
  } catch { rejected = true; }
  finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
  assert.equal(rejected, true);
  assert.equal(transport.length - before, 1);
  assert.ok(transport.at(-1).GET > 0);
  assert.equal(transport.at(-1).OTHER, 0);
  assert.deepEqual(await references(), []);
  assert.deepEqual(await volumes(), []);
  assert.equal(await exists(pending), true);
  assert.equal((await lstat(pending)).mode & 0o777, 0o400);
  const bytes = await readFile(pending);
  assert.deepEqual(canonicalAttestorValue(JSON.parse(bytes.toString('utf8')), 256 * 1024).bytes,
    bytes);
  const lines = (await readFile(lock, 'utf8')).trim().split('\n').filter(Boolean);
  const last = JSON.parse(lines.at(-1));
  assert.deepEqual([last.role, last.phase, last.state],
    ['writer-role-prepare', 'pending', 'prepared']);
  await rm(lock);
  let factories = 0, replayDenied = false;
  try { await runCore({ adapterFactory: input => {
    factories++; return adapterFactory(input);
  } }); } catch { replayDenied = true; }
  assert.equal(replayDenied, true);
  assert.equal(factories, 0);
  await cleanFault();
  await docker(['image', 'tag', baseTag, readImage]);
  process.stdout.write(`Writer role preparation checkpoint ${fault} passed.\n`);
}
}

async function replaceNetwork() {
  const name = `${project}_search_internal`;
  const before = JSON.parse(await docker(['network', 'inspect', name]))[0];
  assert.equal(before.Internal, true);
  assert.equal(before.Labels['com.docker.compose.project'], project);
  assert.equal(before.Labels['com.docker.compose.network'], 'search_internal');
  const opensearchId = (await docker(['compose', '--profile', 'search', 'ps', '-q',
    'opensearch'])).trim();
  assert.deepEqual(Object.keys(before.Containers ?? {}), [opensearchId]);
  const labels = Object.entries(before.Labels).flatMap(([key, value]) => {
    assert.match(key, /^[A-Za-z0-9_.-]{1,100}$/);
    assert.match(value, /^[A-Za-z0-9_.-]{1,100}$/);
    return ['--label', `${key}=${value}`];
  });
  await docker(['network', 'disconnect', name, opensearchId]);
  await docker(['network', 'rm', name]);
  await docker(['network', 'create', '--driver', 'bridge', '--internal', ...labels, name]);
  await docker(['network', 'connect', '--alias', 'opensearch', name, opensearchId]);
  const after = JSON.parse(await docker(['network', 'inspect', name]))[0];
  assert.notEqual(after.Id, before.Id);
  assert.equal(after.Internal, true);
  return { original: before.Id, replacement: after.Id };
}
checkpoint = `terminal-${variant}`;
await docker(['image', 'tag', derivedId, readImage]);
const terminalTransportBefore = transport.length;
const terminalPhases = [];
let terminalVolume = null, terminalReached = false, terminalEvidence;
const terminalFactory = input => {
  const adapter = adapterFactory(input);
  return { ...adapter,
    createVolume: async name => {
      terminalVolume = name;
      return adapter.createVolume(name);
    },
    runPhase: async phase => {
      terminalPhases.push(phase);
      const value = await adapter.runPhase(phase);
      if (phase !== 'transfer') return value;
      if (variant === 'default') {
        const previous = postgresId;
        const prior = await inspectWriterRolePostgres(docker, previous, project);
        await docker(['compose', '--profile', 'search', 'up', '-d', '--wait',
          '--force-recreate', '--no-deps', 'postgres'], 120_000);
        postgresId = (await docker(['compose', 'ps', '-q', 'postgres'])).trim();
        const replacement = await inspectWriterRolePostgres(docker, postgresId, project);
        assert.notEqual(postgresId, previous);
        assert.notEqual(replacement.created, prior.created);
        assert.equal(await sql('SELECT 1'), '1');
        terminalEvidence = { original: previous, replacement: postgresId };
      } else if (variant === 'runner') {
        terminalEvidence = await replaceNetwork();
      } else if (variant === 'runner-volume') {
        assert.match(terminalVolume,
          new RegExp(`^${project}_search_writer_prepare_[0-9a-f]{32}$`));
        const prior = JSON.parse(await docker(['volume', 'inspect', terminalVolume]))[0];
        await docker(['container', 'rm', value.id]);
        await docker(['volume', 'rm', terminalVolume]);
        await new Promise(resolve => setTimeout(resolve, 1100));
        const invocation = terminalVolume.slice(-32);
        await docker(['volume', 'create', '--driver', 'local',
          '--label', `station.create.project=${project}`,
          '--label', `station.create.invocation=${invocation.slice(0, 8)}-${invocation.slice(8, 12)}-${invocation.slice(12, 16)}-${invocation.slice(16, 20)}-${invocation.slice(20)}`,
          terminalVolume]);
        const replacement = JSON.parse(await docker(['volume', 'inspect', terminalVolume]))[0];
        assert.notEqual(replacement.CreatedAt, prior.CreatedAt);
        terminalEvidence = { original: prior.CreatedAt, replacement: replacement.CreatedAt };
      } else {
        assert.equal(variant, 'runner-missing-o');
        const prior = baseline.engine.indexes['station-mail-v1'].settings.index.uuid;
        await drift('delete-v1');
        const after = await engine();
        assert.equal(Object.hasOwn(after.indexes, 'station-mail-v1'), false);
        assert.equal(after.indexes[candidate].settings.index.uuid,
          baseline.registry.control.index_uuid);
        terminalEvidence = { original: prior, candidate: after.indexes[candidate].settings.index.uuid };
      }
      terminalReached = true;
      return value;
    } };
};
let terminalDenied = false;
checkpoint = `terminal-${variant}-owner`;
try { await runCore({ adapterFactory: terminalFactory }); }
catch { terminalDenied = true; }
checkpoint = `terminal-${variant}-logs`;
await collectUnseenPrepareLogs();
assert.equal(fixtureViolation, false);
assert.equal(transport.every(row => row.OTHER === 0), true);
assert.equal(transport.length - terminalTransportBefore,
  variant === 'runner-missing-o' ? 1 : 0);
if (variant === 'runner-missing-o') assert.ok(transport.at(-1).GET > 0);
assert.equal(terminalReached, true);
assert.equal(terminalDenied, true);
checkpoint = `terminal-${variant}-evidence`;
assert.deepEqual(terminalPhases, variant === 'runner-missing-o' ?
  ['transfer', 'prepare'] : ['transfer']);
if (variant === 'runner-missing-o') {
  assert.match(terminalEvidence.original, roleUuid);
  assert.equal(terminalEvidence.candidate, baseline.registry.control.index_uuid);
} else assert.notEqual(terminalEvidence.original, terminalEvidence.replacement);
await retainedLock(variant === 'runner-missing-o' ? 'prepare' : 'transfer', 'dispatched');
assert.deepEqual(await registry(), baseline.registry);
assert.deepEqual(await databaseIdentity(), originalDatabase);
assert.deepEqual(await state(), baseline.state);
assert.deepEqual(await adminFiles(), baseline.admin);
sameSources(await sources(), baseline.sources);
await unchangedCreateFiles();
const terminalHost = await hostResources();
if (variant === 'default') {
  assert.notEqual(terminalHost.postgres.id, baseline.host.postgres.id);
  assert.deepEqual(terminalHost.networks, baseline.host.networks);
  assert.deepEqual(terminalHost.fixedVolumes, baseline.host.fixedVolumes);
} else if (variant === 'runner') {
  assert.deepEqual(terminalHost.postgres, baseline.host.postgres);
  assert.notEqual(terminalHost.networks[`${project}_search_internal`].id,
    baseline.host.networks[`${project}_search_internal`].id);
  assert.equal(terminalHost.networks[`${project}_search_internal`].internal, true);
  assert.deepEqual(terminalHost.networks[`${project}_search_internal`].labels,
    baseline.host.networks[`${project}_search_internal`].labels);
  for (const name of [`${project}_search_admin_db`, 'none'])
    assert.deepEqual(terminalHost.networks[name], baseline.host.networks[name]);
  assert.deepEqual(terminalHost.fixedVolumes, baseline.host.fixedVolumes);
} else assert.deepEqual(terminalHost, baseline.host);
if (variant === 'runner-missing-o') {
  const after = await engine();
  assert.equal(Object.hasOwn(after.indexes, 'station-mail-v1'), false);
  assert.deepEqual(Object.keys(after.indexes).sort(),
    Object.keys(baseline.engine.indexes).filter(name => name !== 'station-mail-v1').sort());
  assert.equal(after.indexes[candidate].settings.index.uuid,
    baseline.registry.control.index_uuid);
  assert.deepEqual(after.indexes[candidate], baseline.engine.indexes[candidate]);
  assert.deepEqual(after.roles, baseline.engine.roles);
  assert.deepEqual(after.mappings, baseline.engine.mappings);
} else assert.deepEqual(await engine(), baseline.engine);
process.stdout.write(`Writer role preparation checkpoint terminal-${variant} passed.\n`);
assert.ok(performance.now() - gateStarted < 3_150_000);
const getAttempts = transport.reduce((sum, row) => sum + row.GET, 0);
const headAttempts = transport.reduce((sum, row) => sum + row.HEAD, 0);
assert.equal(readAttempts, 1 + transport.length);
for (const value of [transferAttempts, readAttempts, cleanupSuccesses,
  getAttempts, headAttempts]) assert.ok(Number.isSafeInteger(value) && value >= 0 && value < 1000);
process.stdout.write(`Writer role preparation summary variant=${variant} transfer=${transferAttempts} read=${readAttempts} get=${getAttempts} head=${headAttempts} cleanup=${cleanupSuccesses}.\n`);
