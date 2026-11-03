import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { runCreateApplyOwner } from '../../scripts/search-create-apply-owner-core.mjs';
import { createApplyDockerAdapter } from '../../scripts/search-create-boundary-owner-docker.mjs';

// Terminal-only destructive fixture. The old boundary matrix has already
// completed; no code may reset/recreate O after this process.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const project = path.basename(repository);
const uid = process.getuid(), gid = process.getgid();
assert.equal(process.cwd(), repository);
assert.match(project, /^stationcreate(?:default|runner)[0-9a-f]{12}$/);
assert.equal(process.env.APP_UID, String(uid));
assert.equal(process.env.APP_GID, String(gid));
const saved = JSON.parse(await readFile(path.join(repository,
  '.cache/results/create-apply-fixture/terminal-missing-o.json'), 'utf8'));
const pending = path.join(repository, '.cache/search-create-intent/pending.json');
const binding = path.join(repository, '.cache/search-create-apply/binding.json');
const lock = path.join(repository, '.cache/search-db/.job-operation.lock');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = name => lstat(name).then(() => true, error => {
  if (error?.code === 'ENOENT') return false;
  throw error;
});
assert.equal(await exists(pending), false);
assert.equal(await exists(binding), false);
assert.equal(await exists(lock), false);
async function command(binary, args, timeoutMs = 45_000, env = process.env) {
  const child = spawn(binary, args, { cwd: repository, env,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', tooLarge = false, timedOut = false;
  for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']])
    stream.on('data', bytes => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + bytes.length > 256 * 1024) {
        tooLarge = true; child.kill('SIGKILL'); return;
      }
      if (name === 'stdout') stdout += bytes.toString('utf8');
      else stderr += bytes.toString('utf8');
    });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(tooLarge, false); assert.equal(timedOut, false);
    return { ...exit, stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function docker(args, timeoutMs) {
  const result = await command('docker', args, timeoutMs);
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  return result.stdout;
}
const pgId = (await docker(['compose', 'ps', '-q', 'postgres'])).trim();
assert.match(pgId, /^[0-9a-f]{64}$/);
async function registry() {
  const query = `SELECT json_build_object(
    'control',(SELECT row_to_json(c) FROM search_generation_control c WHERE singleton=1),
    'history',(SELECT coalesce(json_agg(row_to_json(h) ORDER BY generation_token),'[]'::json)
      FROM search_generation_history h),
    'dispatch',(SELECT coalesce(json_agg(row_to_json(d) ORDER BY generation_token,operation),'[]'::json)
      FROM search_generation_dispatch d))`;
  return JSON.parse((await docker(['exec', pgId, 'psql', '-X', '-U', 'station',
    '-d', 'station', '-v', 'ON_ERROR_STOP=1', '-Atqc', query])).trim());
}
async function engine() {
  const script = String.raw`import {openSearchAdminObserver} from '/app/packages/search/dist/opensearch-runtime.js';
    const o=await openSearchAdminObserver({endpoint:'https://opensearch:9200',identityDir:'/run/station-admin'});
    try {const v=await o.observe();process.stdout.write(JSON.stringify({original:v.indexes['station-mail-v1']??null,
      candidate:v.indexes[process.argv[1]]??null,roles:v.roles,mappings:v.mappings,
      names:Object.keys(v.indexes).sort()}));} finally {await o.close();}`;
  return JSON.parse(await docker(['run', '--rm', '--pull', 'never', '--network',
    `${project}_search_internal`, '--label', `station.create.gate=${project}`,
    '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000', '--mount',
    `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
    `${project}-search-create-index`, 'node', '--input-type=module', '-e', script,
    saved.args[7]], 45_000));
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
const baseline = await registry();
assert.deepEqual(baseline, saved.db);
assert.deepEqual(await state(), saved.originalState);
for (const row of saved.source) {
  const name = path.join(repository, '.cache/search-security', row.name);
  const stat = await lstat(name);
  assert.equal(stat.ino, row.ino); assert.equal(stat.mode, row.mode);
  assert.equal(digest(await readFile(name)), row.digest);
}
const before = await engine();
assert.equal(before.candidate, null);
assert.deepEqual(before.roles, saved.original.roles);
assert.deepEqual(before.mappings, saved.original.mappings);
if (before.original) {
  assert.equal(project.startsWith('stationcreatedefault'), true);
  assert.equal(before.original.settings.index.uuid,
    saved.original.original.settings.index.uuid);
  const deletion = String.raw`import {readFileSync} from 'node:fs';
    import {Client} from '@opensearch-project/opensearch';
    const root='/run/station-admin';const c=new Client({node:'https://opensearch:9200',
      ssl:{ca:readFileSync(root+'/ca.pem'),cert:readFileSync(root+'/admin.pem'),
        key:readFileSync(root+'/admin.key'),rejectUnauthorized:true},maxRetries:0});
    try{const r=await c.indices.delete({index:'station-mail-v1'});
      if(r.body?.acknowledged!==true)process.exit(2);}finally{await c.close();}`;
  await docker(['run', '--rm', '--pull', 'never', '--network', `${project}_search_internal`,
    '--label', `station.create.gate=${project}`, '--read-only', '--cap-drop', 'ALL',
    '--user', '1000:1000', '--mount',
    `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
    `${project}-search-create-index`, 'node', '--input-type=module', '-e', deletion], 45_000);
} else assert.equal(project.startsWith('stationcreaterunner'), true);
const absent = await engine();
assert.equal(absent.original, null);
assert.equal(absent.candidate, null);
assert.deepEqual(absent.names, saved.original.names.filter(name => name !== 'station-mail-v1'));
assert.deepEqual(absent.roles, saved.original.roles);
assert.deepEqual(absent.mappings, saved.original.mappings);
assert.deepEqual(await registry(), baseline);
const bytes = Buffer.from(saved.pending, 'base64');
assert.equal(digest(bytes), saved.args[0]);
await writeFile(pending, bytes, { mode: 0o400, flag: 'wx' });
const baseTag = `${project}-create-apply-fixture-original`;
const baseImage = (await docker(['image', 'inspect', '--format', '{{.Id}}', baseTag])).trim();
assert.match(baseImage, /^sha256:[0-9a-f]{64}$/);
const build = await command('docker', ['build', '--quiet', '--pull=false',
  '--build-arg', `BASE=${baseTag}`, '--build-arg', 'MODE=passthrough', '-f',
  'tests/integration/search-create-apply-fixture.Dockerfile', '-t',
  `${project}-search-create-index`, '.'], 120_000);
assert.equal(build.code, 0);
assert.match(build.stdout.trim(), /^sha256:[0-9a-f]{64}$/);
const ids = {}, attempts = [];
const adapterFactory = input => {
  const adapter = createApplyDockerAdapter(input, { command: async (argv, env, timeoutMs) => {
    const reply = await command('docker', argv, timeoutMs ?? 10_000, env);
    if (argv[0] === 'compose' && argv.includes('run') && argv.includes('--detach') &&
        reply.code === 0) {
      const phase = argv.at(-1) === 'search-create-index' ? 'create' : 'transfer';
      ids[phase] = reply.stdout.trim();
    }
    return reply;
  } });
  return { ...adapter, runPhase: async phase => {
    attempts.push(phase); return adapter.runPhase(phase);
  } };
};
let denied = false;
try { await runCreateApplyOwner({ repository, uid, gid, args: saved.args,
  adapterFactory }); } catch { denied = true; }
assert.equal(denied, true);
assert.deepEqual(attempts, ['transfer', 'create']);
assert.match(ids.transfer, /^[0-9a-f]{64}$/);
assert.match(ids.create, /^[0-9a-f]{64}$/);
const raw = await command('docker', ['container', 'logs', ids.create]);
assert.equal(raw.code, 0);
assert.equal(raw.stdout, '');
const markers = raw.stderr.split('\n').filter(line => line.startsWith('CREATE_APPLY_FIXTURE:'));
assert.deepEqual(markers, []);
assert.equal(raw.stderr, 'Private create apply failed.\n');
assert.deepEqual(await registry(), baseline);
assert.deepEqual(await engine(), absent);
assert.deepEqual(await state(), saved.originalState);
assert.equal(await exists(lock), true);
assert.equal(await exists(binding), true);
const records = (await readFile(lock, 'utf8')).trim().split(/\n+/).map(JSON.parse);
assert.equal(records.at(-1).role, 'create-apply');
assert.equal(records.at(-1).phase, 'create');
assert.equal(records.at(-1).state, 'dispatched');
process.stdout.write('Actual terminal missing-O apply rejection passed.\n');
