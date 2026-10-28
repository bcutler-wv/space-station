import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runCreateBoundaryOwner } from '../../scripts/search-create-boundary-owner-core.mjs';
import { createBoundaryDockerAdapter } from '../../scripts/search-create-boundary-owner-docker.mjs';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';
import { isCreateBoundaryDiagnosticLine } from '../../scripts/search-create-boundary-owner-diagnostic.mjs';
import { assertAppWorkerWithoutCreateAuthority } from '../support/search-create-boundary-app-worker-config.mjs';

// Real Docker/PG16/OpenSearch delivery. Only the disposable failure cases
// intercept a CLI response after its actual Docker operation has been sent.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let checkpoint = 'setup';
const redactedFailure = () => {
  process.stderr.write(`Create boundary delivery fixture failed at ${checkpoint}.\n`);
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
assert.match(project, /^stationcreate(?:default|runner)[0-9a-f]{12}$/);
const image = `${project}-search-create-transfer`;
const stateVolume = `${project}_search_security_state`;
const credential = path.join(repository, '.cache/search-db/initial-v1/verifier.password');
const transitionCredential = path.join(repository, '.cache/search-db/initial-v1/transition.password');
const metadata = path.join(repository, '.cache/search-db/initial-v1/operation.json');
const lock = path.join(repository, '.cache/search-db/.job-operation.lock');
const invocationParent = path.join(repository, '.cache/search-create-invocations');
const fixedFailure = 'Private create boundary owner operation failed.\n';
const coreFailure = 'Private create boundary owner operation failed.';
const id = /^[0-9a-f]{64}$/;
const volumePattern = new RegExp(`^${project}_search_create_[0-9a-f]{32}$`);
const phaseServices = ['search-create-transfer', 'search-create-boundary'];
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
  const volumes = await names(['volume', 'ls', '--filter', `label=station.create.project=${project}`,
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
  const body = await readFile(lock, 'utf8');
  assert.ok(body.length < 4096);
  const records = body.trim().split(/\n+/).map(line => JSON.parse(line));
  assert.ok(records.length >= 2 && records.length <= 6);
  assert.equal(records[0].state, 'preflight');
  assert.ok(records.every(row => row.operationId === roots[0] && row.version === 1));
  assert.equal(records[1].role, 'create-boundary');
  assert.equal(records[1].phase, 'transfer');
  assert.equal(records[1].state, 'dispatched');
  return roots[0];
}
async function noRetained() {
  assert.equal(await existing(lock), false);
  assert.deepEqual(await readdir(invocationParent), []);
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
    `label=station.create.gate=${project}`, '--format', '{{.ID}}'])).trim();
  for (const item of extra ? extra.split('\n') : []) {
    assert.match(item, id); await docker(['container', 'rm', '-f', item]);
  }
  for (const volume of await invocationVolumes()) await docker(['volume', 'rm', volume]);
  await rm(lock, { force: true });
  for (const parent of [invocationParent]) {
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
  if(mode==='complete'||mode==='wrong-uuid'){
    fixed('phase','ready\n',0,0o660);
    fixed('v1-first-init','v1\n',0,0o440);
    fixed('v1-profile-grant','v1\n',0,0o440);
    fixed('v1-profile-claim','v1\n',1000,0o600);
    fixed('v1-profile-complete','v1\n'+(mode==='wrong-uuid'?'wrong_uuid':uuid)+'\n',1000,0o600);
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
    '--network-alias', 'fixture-sentinel', '--label', `station.create.gate=${project}`,
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
      `${project}_search_admin_db`, '--label', `station.create.gate=${project}`,
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
checkpoint = 'app-worker-authority';
assertAppWorkerWithoutCreateAuthority(JSON.parse(await docker(['compose', 'config', '--format', 'json',
  'app', 'worker'])), repository);
for (const service of ['app', 'worker']) {
  const containers = await names(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}']);
  assert.deepEqual(containers, []);
}

let postgresId = await one(['compose', 'ps', '-q', 'postgres']);
let adminIp;
async function refreshPostgres() {
  postgresId = await one(['compose', 'ps', '-q', 'postgres']);
  const item = JSON.parse(await docker(['container', 'inspect', postgresId]))[0];
  assert.equal(item.Id, postgresId);
  adminIp = item.NetworkSettings.Networks[`${project}_search_admin_db`]?.IPAddress;
  assert.match(adminIp, /^(?:\d{1,3}\.){3}\d{1,3}$/);
}
await refreshPostgres();
const candidate = 'station-mail-v2-g11111111111141118111111111111111';
async function sql(query, role = 'station', password) {
  const args = ['exec'];
  if (password) args.push('-e', `PGPASSWORD=${password}`);
  args.push(postgresId, 'psql', '-X');
  if (password) args.push('-h', adminIp);
  args.push('-U', role, '-d', 'station', '-v', 'ON_ERROR_STOP=1', '-Atqc', query);
  return command('docker', args);
}
async function dbEvidence() {
  const result = await sql(`SELECT md5(
    (SELECT coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY singleton),'') FROM search_generation_control t) ||
    (SELECT coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY generation_token),'') FROM search_generation_history t) ||
    (SELECT coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY generation_token,operation),'') FROM search_generation_dispatch t))`);
  assert.equal(result.code, 0);
  assert.match(result.stdout.trim(), /^[0-9a-f]{32}$/);
  return result.stdout.trim();
}
async function engineEvidence() {
  const script = String.raw`import {createHash} from 'node:crypto';
    import {openSearchAdminObserver} from '/app/packages/search/dist/opensearch-runtime.js';
    const observer=await openSearchAdminObserver({endpoint:'https://opensearch:9200',identityDir:'/run/station-admin'});
    try {const value=await observer.observe(); const suffix='11111111111141118111111111111111';
      process.stdout.write(JSON.stringify({digest:createHash('sha256').update(JSON.stringify(value)).digest('hex'),
        candidate:Object.hasOwn(value.indexes,process.argv[1]),
        nRoles:['station_indexer_'+suffix,'station_query_'+suffix].some(name=>
          Object.hasOwn(value.roles,name)||Object.hasOwn(value.mappings,name))}));}
    finally {await observer.close();}`;
  const output = await one(['run', '--rm', '--pull', 'never', '--network', `${project}_search_internal`,
    '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000',
    '--mount', `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
    image, 'node', '--input-type=module', '-e', script, candidate]);
  const value = JSON.parse(output);
  assert.match(value.digest, /^[0-9a-f]{64}$/);
  assert.equal(value.candidate, false);
  assert.equal(value.nRoles, false);
  return value.digest;
}
async function rawEngineFingerprint() {
  // Raw fixed admin-TLS GETs deliberately do not invoke the rejecting profile
  // observer. Each request must succeed and fit its bound; errors never compare
  // equal to another error. Only the digest leaves the disposable container.
  const script = String.raw`import {createHash} from 'node:crypto';
    import {readFile} from 'node:fs/promises';
    import {Client} from '@opensearch-project/opensearch';
    import {boundedSearchSdkRequest} from '/app/packages/search/dist/opensearch-runtime.js';
    const read=async name=>{const value=await readFile('/run/station-admin/'+name);
      if(value.length<100||value.length>16384)throw Error('identity');return value;};
    const [ca,cert,key]=await Promise.all(['ca.pem','admin.pem','admin.key'].map(read));
    const client=new Client({node:'https://opensearch:9200',ssl:{ca,cert,key,rejectUnauthorized:true},
      maxRetries:0,requestTimeout:5000,sniffOnStart:false,sniffOnConnectionFault:false,sniffInterval:false});
    const request=fn=>boundedSearchSdkRequest(options=>fn(options),128000,5000);
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
      Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
    try {const indexes=await request(options=>client.indices.get({index:'station-mail-*',
        expand_wildcards:'all',allow_no_indices:true,ignore_unavailable:true,include_defaults:false},options));
      const paths=['/_plugins/_security/api/roles','/_plugins/_security/api/rolesmapping',
        '/_plugins/_security/api/securityconfig','/_plugins/_security/api/actiongroups'];
      const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
      if(!object(indexes))throw Error('indexes');
      const security=[];for(const path of paths){const value=await request(options=>
        client.transport.request({method:'GET',path},options));
        if(!object(value))throw Error('security');security.push(value);}
      const digest=createHash('sha256').update(JSON.stringify(canonical({indexes,security}))).digest('hex');
      process.stdout.write(digest);}
    finally {await client.close();}`;
  const output = await one(['run', '--rm', '--pull', 'never', '--network', `${project}_search_internal`,
    '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000',
    '--mount', `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
    image, 'node', '--input-type=module', '-e', script]);
  assert.match(output, /^[0-9a-f]{64}$/);
  return output;
}
async function registryState() {
  await gatesOff();
  const result = await sql(`SELECT stage || '|' || revision || '|' || publication_enabled || '|' || serving_ready ||
    '|' || source_generation_token || '|' || generation_token FROM search_generation_control WHERE singleton=1`);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), 'disabled_intent|3|false|false|legacy-v1|11111111-1111-4111-8111-111111111111');
  const next = await sql(`SELECT lifecycle || '|' || coalesce(index_uuid,'absent') FROM search_generation_history WHERE physical_index='${candidate}'`);
  assert.equal(next.code, 0);
  assert.equal(next.stdout.trim(), 'reserved|absent');
}
async function roleProof() {
  const password = originalTransitionCredential.bytes.toString('utf8').trim();
  const permitted = await sql("SELECT session_user || '|' || current_user || '|' || (SELECT count(*) FROM search_generation_control)",
    'station_search_transition', password);
  assert.equal(permitted.code, 0);
  assert.equal(permitted.stdout.trim(), 'station_search_transition|station_search_transition|1');
  const wrong = await sql('SELECT count(*) FROM search_generation_control',
    'station_search_transition', `${password.slice(0, -1)}${password.endsWith('x') ? 'y' : 'x'}`);
  assert.notEqual(wrong.code, 0); secretFree(wrong.stdout, wrong.stderr);
  for (const query of ['SELECT count(*) FROM users',
    'CREATE TABLE station_create_fixture_denied(id integer)',
    'CREATE ROLE station_create_fixture_denied']) {
    const denied = await sql(query, 'station_search_transition', password);
    assert.notEqual(denied.code, 0);
    secretFree(denied.stdout, denied.stderr);
  }
  const verifier = originalCredential.bytes.toString('utf8').trim();
  const swapped = await sql('SELECT count(*) FROM search_generation_control',
    'station_search_transition', verifier);
  assert.notEqual(swapped.code, 0); secretFree(swapped.stdout, swapped.stderr);
  const grants = await sql(`SELECT count(*) FROM pg_roles WHERE rolname IN
    ('station_indexer_11111111111141118111111111111111','station_query_11111111111141118111111111111111')`);
  assert.equal(grants.code, 0); assert.equal(grants.stdout.trim(), '0');
}
await registryState();
checkpoint = 'role-proof';
await roleProof();
const initialDb = await dbEvidence();
const initialEngine = await engineEvidence();
const initialRawEngine = await rawEngineFingerprint();
checkpoint = 'complete-cli';
const successful = await command('node', ['scripts/search-create-boundary-owner.mjs'], process.env, 245_000);
secretFree(successful.stdout, successful.stderr);
if (successful.code !== 0) {
  const diagnostic = successful.stderr.trim().split('\n').find(isCreateBoundaryDiagnosticLine);
  if (diagnostic) process.stdout.write(`${diagnostic}\n`);
}
assert.equal(successful.code, 0);
assert.equal(successful.stdout, 'Private create boundary owner observation completed.\n');
assert.equal(successful.stderr, '');
assert.equal(await dbEvidence(), initialDb);
assert.equal(await engineEvidence(), initialEngine);
assert.equal(await rawEngineFingerprint(), initialRawEngine);
assert.deepEqual(await stateSnapshot(), completeState);
await registryState(); await roleProof();
await noRetained(); await credentialUnchanged();
process.stdout.write('Actual fixed two-phase create-boundary CLI and read-only evidence passed.\n');

async function copiedVolume(volume) {
  const script = String.raw`const fs=require('node:fs');
    const root='/target'; const s=fs.statSync(root);
    if(s.uid!==1000||s.gid!==1000||(s.mode&0o777)!==0o700)process.exit(1);
    const names=fs.readdirSync(root).sort();
    if(names.join('|')!=='invocation|transition.password')process.exit(1);
    for(const name of names){const st=fs.lstatSync(root+'/'+name);
      if(!st.isFile()||st.uid!==1000||st.gid!==1000||(st.mode&0o777)!==0o400)process.exit(1);}
    process.stdout.write('copied-volume-valid');`;
  const result = await one(['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
    '--user', '1000:1000', '--mount', `type=volume,source=${volume},target=/target,readonly`,
    image, 'node', '-e', script]);
  assert.equal(result, 'copied-volume-valid');
}
async function actualPhaseEvidence(phase, containerId, expectedExit = 0) {
  const item = JSON.parse(await docker(['container', 'inspect', containerId]))[0];
  assert.equal(item.Id, containerId);
  assert.equal(item.State.Status, 'exited');
  assert.equal(item.State.ExitCode, expectedExit);
  assert.equal(item.HostConfig.ReadonlyRootfs, true);
  assert.equal(item.Config.User, phase === 'transfer' ? '0:0' : '1000:1000');
  assert.ok(Array.isArray(item.Config.Env));
  assert.ok(item.Config.Env.every(value => !/^(?:POSTGRES_PASSWORD|STATION_MASTER_KEY|DB_HOST|GOCAMO_HMAC|PGPASSWORD|APP_ORIGIN)=/.test(value)));
  assert.deepEqual(item.HostConfig.CapDrop, ['ALL']);
  assert.equal(exactAddedCapabilities(item.HostConfig.CapAdd, phase), true);
  assert.equal(Object.keys(item.HostConfig.PortBindings ?? {}).length, 0);
  const mounts = item.HostConfig.Mounts;
  assert.ok(Array.isArray(mounts));
  assert.deepEqual(mounts.map(value => value.Target).sort(), phase === 'transfer' ?
    ['/run/create-boundary', '/run/create-transfer-invocation/invocation',
      '/run/create-transfer-password/password'] :
    ['/run/create-boundary', '/run/station-admin', '/run/station-state']);
  if (phase === 'transfer') {
    assert.equal(item.HostConfig.NetworkMode, 'none');
    assert.ok(mounts.filter(value => value.Type === 'volume').length === 1);
    assert.equal(mounts.find(value => value.Target === '/run/create-boundary')?.VolumeOptions?.NoCopy, true);
    assert.deepEqual(Object.keys(item.NetworkSettings.Networks), ['none']);
  } else {
    assert.deepEqual(Object.keys(item.NetworkSettings.Networks).sort(),
      [`${project}_search_admin_db`, `${project}_search_internal`].sort());
    assert.ok(mounts.every(value => value.Type === 'volume' && value.ReadOnly === true &&
      value.VolumeOptions?.NoCopy === true));
    for (const [network, observed] of Object.entries(item.NetworkSettings.Networks)) {
      const current = JSON.parse(await docker(['network', 'inspect', network]))[0];
      assert.equal(observed.NetworkID, current.Id);
      assert.equal(current.Internal, true);
    }
    assert.equal(mounts.find(value => value.Target === '/run/station-admin')?.Source,
      `${project}_search_admin_certs`);
    assert.equal(mounts.find(value => value.Target === '/run/station-state')?.Source,
      `${project}_search_security_state`);
    assert.match(mounts.find(value => value.Target === '/run/create-boundary')?.Source,
      volumePattern);
  }
  assert.deepEqual(item.Mounts.map(value => value.Destination).sort(),
    mounts.map(value => value.Target).sort());
  if (phase === 'inspect') assert.ok(item.Mounts.every(value => value.Type === 'volume' &&
    value.RW === false));
}
async function replaceInternalNetwork() {
  const name = `${project}_search_internal`;
  const before = JSON.parse(await docker(['network', 'inspect', name]))[0];
  assert.equal(before.Name, name);
  assert.equal(before.Driver, 'bridge');
  assert.equal(before.Internal, true);
  const opensearchId = await one(['compose', '--profile', 'search', 'ps', '-q', 'opensearch']);
  assert.deepEqual(Object.keys(before.Containers ?? {}), [opensearchId]);
  const labels = before.Labels;
  assert.equal(labels?.['com.docker.compose.project'], project);
  assert.equal(labels?.['com.docker.compose.network'], 'search_internal');
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => {
    assert.match(key, /^[a-zA-Z0-9_.-]{1,100}$/);
    assert.match(value, /^[a-zA-Z0-9_.-]{1,100}$/);
    return ['--label', `${key}=${value}`];
  });
  await docker(['network', 'disconnect', name, opensearchId]);
  await docker(['network', 'rm', name]);
  await docker(['network', 'create', '--driver', 'bridge', '--internal', ...labelArgs, name]);
  await docker(['network', 'connect', '--alias', 'opensearch', name, opensearchId]);
  const after = JSON.parse(await docker(['network', 'inspect', name]))[0];
  assert.match(after.Id, id);
  assert.notEqual(after.Id, before.Id);
  assert.equal(after.Internal, true);
}
async function failedCombinedEvidence() {
  const containers = await serviceContainers();
  assert.equal(containers['search-create-transfer'].length, 1);
  assert.equal(containers['search-create-boundary'].length, 1);
  await actualPhaseEvidence('transfer', containers['search-create-transfer'][0]);
  const combined = JSON.parse(await docker(['container', 'inspect', containers['search-create-boundary'][0]]))[0];
  assert.equal(combined.State.Status, 'exited');
  assert.ok(Number.isInteger(combined.State.ExitCode) && combined.State.ExitCode > 0 &&
    combined.State.ExitCode <= 255);
  await actualPhaseEvidence('inspect', containers['search-create-boundary'][0],
    combined.State.ExitCode);
}
async function injectScenario(scenario) {
  const calls = { transfer: 0, inspect: 0, create: 0 };
  const observed = { volume: null, ids: {}, outputs: [] };
  let credentialSwapped = false;
  const invoke = async (args, env, timeoutMs) => {
    const phase = args.includes('run') && args.includes('--detach') ?
      ({ 'search-create-transfer': 'transfer', 'search-create-boundary': 'inspect' }[args.at(-1)] ?? null) : null;
    const isCreate = args[0] === 'volume' && args[1] === 'create';
    if (scenario === 'cleanup-refusal' && args[0] === 'container' && args[1] === 'rm')
      return { code: 1, signal: null, stdout: '', stderr: '' };
    const response = await command('docker', args, env, timeoutMs ?? 10_000);
    observed.outputs.push(response.stdout, response.stderr);
    if (phase) {
      calls[phase]++;
      if (id.test(response.stdout.trim())) observed.ids[phase] = response.stdout.trim();
      if (scenario === `lost-${phase}-response`) return { ...response, stdout: '' };
    }
    if (isCreate) {
      calls.create++;
      observed.volume = args.at(-1);
      assert.match(observed.volume, volumePattern);
      if (scenario === 'lost-volume-create-response') return { ...response, stdout: '' };
    }
    if (scenario === 'replaced-credential' && args[0] === 'container' && args[1] === 'logs' &&
        args[2] === observed.ids.transfer) {
      const bytes = await readFile(transitionCredential);
      await rename(transitionCredential, `${transitionCredential}.old`);
      await writeFile(transitionCredential, bytes, { mode: 0o600 });
      credentialSwapped = true;
    }
    if (scenario === 'verifier-substitution' && args[0] === 'container' && args[1] === 'logs' &&
        args[2] === observed.ids.transfer) {
      await docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '0:0',
        '--mount', `type=volume,source=${observed.volume},target=/target`,
        '--mount', `type=bind,source=${credential},target=/input/password,readonly`, image,
        'node', '-e', "const f=require('node:fs');f.writeFileSync('/target/transition.password',f.readFileSync('/input/password'));f.chownSync('/target/transition.password',1000,1000);f.chmodSync('/target/transition.password',0o400)"]);
    }
    if (scenario === 'extra-reference' && args[0] === 'container' && args[1] === 'logs' &&
        args[2] === observed.ids.inspect) {
      await one(['container', 'create', '--network', 'none', '--label', `station.create.gate=${project}`,
        '--mount', `type=volume,source=${observed.volume},target=/target`, image, 'true']);
    }
    if (scenario === 'extra-service-reference' && args[0] === 'container' && args[1] === 'logs' &&
        args[2] === observed.ids.inspect) {
      await one(['container', 'create', '--network', 'none',
        '--label', `com.docker.compose.project=${project}`,
        '--label', 'com.docker.compose.service=search-create-boundary',
        '--label', `station.create.gate=${project}`, image, 'true']);
    }
    if (scenario === 'replaced-volume' && args[0] === 'container' && args[1] === 'logs' &&
        args[2] === observed.ids.transfer) {
      const invocationId = await retained();
      await docker(['container', 'rm', args[2]]);
      await docker(['volume', 'rm', observed.volume]);
      await new Promise(resolve => setTimeout(resolve, 1_100));
      await docker(['volume', 'create', '--driver', 'local',
        '--label', `station.create.project=${project}`,
        '--label', `station.create.invocation=${invocationId}`, observed.volume]);
    }
    if (scenario === 'replaced-postgres' && args[0] === 'container' && args[1] === 'logs' &&
        args[2] === observed.ids.transfer) {
      await docker(['compose', 'up', '-d', '--wait', '--force-recreate', '--no-deps', 'postgres'], 120_000);
      await refreshPostgres();
    }
    if (scenario === 'replaced-network' && args[0] === 'container' && args[1] === 'logs' &&
        args[2] === observed.ids.transfer) await replaceInternalNetwork();
    return response;
  };
  const factory = input => createBoundaryDockerAdapter(input, { command: invoke });
  const faultyLock = (options, work) => withSearchAdminJobLock({ ...options,
    fixtureFaultAt: 'after-append' }, work);
  if (scenario === 'record-io-fault') process.env.STATION_JOB_LOCK_FIXTURE = '1';
  try {
    await assert.rejects(runCreateBoundaryOwner({ repository, uid: process.getuid(),
      gid: process.getgid(), adapterFactory: factory,
      ...(scenario === 'record-io-fault' ? { lock: faultyLock } : {}) }), { message: coreFailure });
  } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
  secretFree(...observed.outputs);
  await retained();
  assert.deepEqual(calls, {
    'lost-volume-create-response': { transfer: 0, inspect: 0, create: 1 },
    'record-io-fault': { transfer: 0, inspect: 0, create: 0 },
    'lost-transfer-response': { transfer: 1, inspect: 0, create: 1 },
    'lost-inspect-response': { transfer: 1, inspect: 1, create: 1 },
    'replaced-credential': { transfer: 1, inspect: 0, create: 1 },
    'replaced-volume': { transfer: 1, inspect: 0, create: 1 },
    'replaced-postgres': { transfer: 1, inspect: 0, create: 1 },
    'replaced-network': { transfer: 1, inspect: 0, create: 1 },
    'verifier-substitution': { transfer: 1, inspect: 1, create: 1 },
    'extra-reference': { transfer: 1, inspect: 1, create: 1 },
    'extra-service-reference': { transfer: 1, inspect: 1, create: 1 },
    'cleanup-refusal': { transfer: 1, inspect: 1, create: 1 },
  }[scenario]);
  for (const [phase, containerId] of Object.entries(observed.ids)) {
    if (scenario === 'replaced-volume' && phase === 'transfer') continue;
    const exit = (await docker(['container', 'wait', containerId], 90_000)).trim();
    if (scenario === 'verifier-substitution' && phase === 'inspect') {
      assert.notEqual(exit, '0');
      assert.match(exit, /^[1-9][0-9]{0,2}$/);
      await actualPhaseEvidence(phase, containerId, Number(exit));
      continue;
    }
    assert.equal(exit, '0');
    await actualPhaseEvidence(phase, containerId);
  }
  if (observed.ids.transfer && observed.volume && scenario !== 'replaced-volume')
    await copiedVolume(observed.volume);
  if (scenario.startsWith('lost-')) {
    const phase = scenario.slice(5, -9);
    if (phase === 'transfer' || phase === 'inspect') {
      assert.equal((await docker(['container', 'wait', observed.ids[phase]], 90_000)).trim(), '0');
      if (phase === 'transfer') await copiedVolume(observed.volume);
    }
  }
  assert.equal(await dbEvidence(), initialDb);
  assert.equal(await engineEvidence(), initialEngine);
  assert.deepEqual(await stateSnapshot(), completeState);
  await registryState();
  await fixtureTeardown();
  if (credentialSwapped) {
    await rm(transitionCredential);
    await rename(`${transitionCredential}.old`, transitionCredential);
  }
  await credentialUnchanged();
  if (scenario === 'replaced-network') {
    assert.equal(await engineEvidence(), initialEngine);
    await networkProof();
  }
  process.stdout.write(`Real create-boundary Docker fault passed: ${scenario}.\n`);
}
for (const scenario of ['record-io-fault', 'lost-volume-create-response', 'lost-transfer-response',
  'lost-inspect-response', 'replaced-credential', 'replaced-volume', 'replaced-postgres',
  'replaced-network',
  'verifier-substitution',
  'extra-reference', 'extra-service-reference', 'cleanup-refusal']) {
  checkpoint = scenario; await injectScenario(scenario);
}
for (const mode of ['fresh', 'unintroduced', 'incomplete', 'wrong-uuid']) {
  checkpoint = `${mode}-rejection`;
  await stateMode(mode);
  const before = await stateSnapshot();
  const denied = await command('node', ['scripts/search-create-boundary-owner.mjs'], process.env, 245_000);
  secretFree(denied.stdout, denied.stderr);
  assert.equal(denied.code, 1);
  assert.equal(denied.stdout, '');
  assert.ok(denied.stderr.startsWith(fixedFailure));
  assert.deepEqual(await stateSnapshot(), before);
  await retained();
  await failedCombinedEvidence();
  await fixtureTeardown();
  await stateMode('complete');
  assert.deepEqual(await stateSnapshot(), completeState);
  assert.equal(await dbEvidence(), initialDb);
  assert.equal(await engineEvidence(), initialEngine);
}
const drift = async phase => docker(['compose', '--profile', 'search', '--profile', 'fixture',
  'run', '--rm', '-T', '--no-deps', '-e', `SEARCH_DRIFT_PHASE=${phase}`, 'search-profile-drift'], 90_000);
for (const [mutation, restore] of [['profile', 'restore'], ['shadow', 'shadow-restore'],
  ['role', 'role-restore'], ['extra-index', 'extra-index-restore'],
  ['candidate-index', 'candidate-index-restore'], ['alias', 'alias-restore']]) {
  checkpoint = 'engine-drift';
  await drift(mutation);
  const changedEngine = await rawEngineFingerprint();
  assert.notEqual(changedEngine, initialRawEngine);
  const denied = await command('node', ['scripts/search-create-boundary-owner.mjs'], process.env, 245_000);
  secretFree(denied.stdout, denied.stderr); assert.equal(denied.code, 1); await retained();
  await failedCombinedEvidence();
  assert.equal(await dbEvidence(), initialDb);
  assert.deepEqual(await stateSnapshot(), completeState);
  await registryState(); await credentialUnchanged();
  assert.equal(await rawEngineFingerprint(), changedEngine);
  await fixtureTeardown();
  await drift(restore);
  assert.equal(await engineEvidence(), initialEngine);
  assert.equal(await rawEngineFingerprint(), initialRawEngine);
}
for (const field of ['databaseOid', 'systemIdentifier', 'project']) {
  checkpoint = 'host-identity-rejection';
  const saved = JSON.parse(originalMetadata.bytes.toString('utf8'));
  const changed = { ...saved, [field]: field === 'project' ? 'wrongfixture' :
    field === 'databaseOid' ? '999999' : '18446744073709551614' };
  await rename(metadata, `${metadata}.old`);
  await writeFile(metadata, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
  try {
    const denied = await command('node', ['scripts/search-create-boundary-owner.mjs'], process.env, 245_000);
    secretFree(denied.stdout, denied.stderr);
    assert.equal(denied.code, 1);
    await noRetained();
  } finally {
    await rm(metadata);
    await rename(`${metadata}.old`, metadata);
  }
  await credentialUnchanged();
}
checkpoint = 'host-identity-rejection';
const wrongOwner = 'station_create_wrong_owner';
assert.equal((await sql(`CREATE ROLE ${wrongOwner} NOLOGIN`)).code, 0);
assert.equal((await sql(`ALTER DATABASE station OWNER TO ${wrongOwner}`)).code, 0);
try {
  const denied = await command('node', ['scripts/search-create-boundary-owner.mjs'], process.env, 245_000);
  secretFree(denied.stdout, denied.stderr);
  assert.equal(denied.code, 1);
  await noRetained();
} finally {
  assert.equal((await sql('ALTER DATABASE station OWNER TO station')).code, 0);
  assert.equal((await sql(`DROP ROLE ${wrongOwner}`)).code, 0);
}
assert.equal(await dbEvidence(), initialDb);
checkpoint = project.startsWith('stationcreatedefault') ? 'mapping-drift' : 'source-loss';
await drift(checkpoint === 'mapping-drift' ? 'mapping-extra' : 'delete-v1');
const terminalEngine = await rawEngineFingerprint();
assert.notEqual(terminalEngine, initialRawEngine);
const terminal = await command('node', ['scripts/search-create-boundary-owner.mjs'], process.env, 245_000);
secretFree(terminal.stdout, terminal.stderr); assert.equal(terminal.code, 1); await retained();
await failedCombinedEvidence();
assert.equal(await dbEvidence(), initialDb);
assert.deepEqual(await stateSnapshot(), completeState);
await registryState(); await credentialUnchanged();
assert.equal(await rawEngineFingerprint(), terminalEngine);
await fixtureTeardown();
assert.equal(await dbEvidence(), initialDb); await registryState();
assert.deepEqual(await stateSnapshot(), completeState);
process.stdout.write(`Actual create-boundary terminal ${checkpoint} rejection passed.\n`);
