import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { CredentialOperationError, operateSearchAdminCredentials } from '../../scripts/search-admin-credential-core.mjs';

const socket = process.env.SEARCH_ADMIN_TEST_SOCKET;
const port = process.env.SEARCH_ADMIN_TEST_PORT;
assert.ok((socket === `${process.cwd()}/.cache/results` ||
  socket?.startsWith(`${process.cwd()}/.cache/results/`)) && /^\d{4,5}$/.test(port ?? ''));
const roleName = role => `station_search_${role}`;
const rootParent = await mkdtemp(`${process.cwd()}/.cache/results/search-admin-credential-fixture-`);
const privateParent = path.join(rootParent, '.cache');
await mkdir(privateParent, { mode: 0o700 });
const root = path.join(privateParent, 'search-db');
const uid = process.getuid(), gid = process.getgid();
let phase = 'initial', failure;
const cleanEnv = () => {
  const env = { ...process.env, PGHOST: socket, PGPORT: port, PGUSER: 'station' };
  for (const key of ['PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE']) delete env[key];
  return env;
};
async function run(args, input = '', host = socket) {
  const env = { ...cleanEnv(), PGHOST: host };
  const child = spawn('psql', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
  child.stdout.on('data', x => { stdout += x.toString('utf8'); if (stdout.length > 8192) child.kill('SIGKILL'); });
  child.stderr.on('data', x => { stderr += x.toString('utf8'); if (stderr.length > 8192) child.kill('SIGKILL'); });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function owner(sql) {
  const result = await run(['-X', '-U', 'station', '-d', 'station', '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t', '-f', '-'], sql);
  if (result.code !== 0) throw new Error('fixture owner query failed');
  return result.stdout.trim();
}
const apply = await readFile(new URL('../../ops/postgres/search-admin-roles-apply.sql', import.meta.url), 'utf8');
const audit = await readFile(new URL('../../ops/postgres/search-admin-roles-audit.sql', import.meta.url), 'utf8');
const policy = `BEGIN; SET LOCAL station.search_admin_rotation_target='none';
  SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='750ms';\n${apply}\n${audit}\nCOMMIT;`;
const auditOnly = `BEGIN READ ONLY; SET LOCAL station.search_admin_rotation_target='none';
  SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='750ms';\n${audit}\nCOMMIT;`;
const rotationAudit = role => `BEGIN READ ONLY; SET LOCAL station.search_admin_rotation_target='${roleName(role)}';
  SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='750ms';\n${audit}\nCOMMIT;`;
const installation = { project: 'fixture', service: 'postgres', database: 'station',
  databaseOid: await owner("select oid::text from pg_database where datname='station'"),
  systemIdentifier: await owner('select system_identifier::text from pg_control_system()'),
  owner: 'station', uid, gid };
let rotationContainer = 'a'.repeat(64), heldTargetContainer = false;
const retiredContainers = new Set();
const scramAttempt = (role, candidate) => run(['-X', '-h', '127.0.0.1', '-p', port, '-U', roleName(role), '-d', 'station',
  '-W', '-A', '-t', '-c', "select session_user || '|' || current_user"], `${candidate}\n`, '127.0.0.1');
async function heldSession(role, secret) {
  const child = spawn('psql', ['-X', '-h', '127.0.0.1', '-p', port, '-U', roleName(role), '-d', 'station',
    '-W', '-A', '-t', '-c', "SELECT pg_sleep(20); SELECT 'still';"],
  { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); if (stderr.length > 1024) child.kill('SIGKILL'); });
  child.stdin.on('error', () => {});
  child.stdin.end(`${secret}\n`);
  const timer = setTimeout(() => child.kill('SIGKILL'), 35_000);
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  }).finally(() => clearTimeout(timer));
  let active = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await owner(`select count(*) from pg_stat_activity where usename='${roleName(role)}' and state='active' and query like '%pg_sleep%'`) !== '0') {
      active = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!active) { child.kill('SIGKILL'); throw new Error('held other-role session did not start'); }
  return { child, completion };
}
const adapter = {
  identity: async () => installation,
  containerId: async () => rotationContainer,
  attestAuthentication: async () => {},
  targetContainersAbsent: async () => !heldTargetContainer,
  assertRetiredContainer: async id => {
    if (id === rotationContainer || !retiredContainers.has(id)) throw new CredentialOperationError('remote quiescence');
  },
  roleEvidence: async role => {
    const row = await owner(`select rolcanlogin::text || '|' || rolpassword from pg_authid where rolname='${roleName(role)}'`);
    const [status, verifier] = row.split('|');
    assert.ok(['true', 'false'].includes(status) && verifier?.startsWith('SCRAM-SHA-256$'));
    return { login: status === 'true', verifier };
  },
  terminateTargetSessions: async role => {
    const result = await owner(`select pg_terminate_backend(pid,3000) from pg_stat_activity where usename='${roleName(role)}' and pid<>pg_backend_pid()`);
    assert.ok(!result || result.split('\n').every(x => x === 't'));
    assert.equal(await owner(`select count(*) from pg_stat_activity where usename='${roleName(role)}'`), '0');
  },
  targetSessionsZero: async role => (await owner(`select count(*) from pg_stat_activity where usename='${roleName(role)}'`)) === '0',
  preflightCreate: async () => {
    const rows = await owner("select rolname || '|' || rolcanlogin::text || '|' || (rolpassword is not null)::text from pg_authid where rolname in ('station_search_verifier','station_search_transition')");
    if (rows && rows.split('\n').some(x => !/^station_search_(verifier|transition)\|false\|false$/.test(x))) throw new Error('preflight');
  },
  applyPolicy: async () => owner(policy),
  audit: async () => owner(auditOnly),
  auditRecovery: async role => owner(rotationAudit(role)),
  setPassword: async (role, password) => {
    const result = await run(['-X', '-U', 'station', '-d', 'station', '-v', 'ON_ERROR_STOP=1', '-c', `\\password ${roleName(role)}`],
      `${password}\n${password}\n`);
    if (result.code !== 0 || result.stdout.includes(password) || result.stderr.includes(password)) throw new Error('password prompt');
  },
  setLogin: async (role, enabled) => owner(`alter role ${roleName(role)} ${enabled ? 'LOGIN' : 'NOLOGIN'}`),
  authenticate: async (role, password) => {
    const good = await scramAttempt(role, password);
    assert.equal(good.code, 0, 'actual SCRAM credential succeeds');
    assert.equal(good.stdout.trim(), `${roleName(role)}|${roleName(role)}`);
    const wrong = await scramAttempt(role, password[0] === 'A' ? `B${password.slice(1)}` : `A${password.slice(1)}`);
    assert.equal(wrong.code, 2);
    assert.equal(wrong.stdout.trim(), '');
    assert.match(wrong.stderr, /password authentication failed/);
  },
  authenticateRejected: async (role, password) => {
    const denied = await scramAttempt(role, password);
    assert.equal(denied.code, 2);
    assert.equal(denied.stdout.trim(), '');
    assert.match(denied.stderr, /password authentication failed/);
  },
  disableRoles: async () => {
    for (const role of ['verifier', 'transition']) await owner(`alter role ${roleName(role)} NOLOGIN;
      select pg_terminate_backend(pid) from pg_stat_activity where usename='${roleName(role)}' and pid<>pg_backend_pid();`);
  },
  disableAndClearRoles: async () => {
    await adapter.disableRoles();
    for (const role of ['verifier', 'transition']) await owner(`alter role ${roleName(role)} password null`);
  }
};
const operate = action => operateSearchAdminCredentials({ action, root, uid, gid, adapter });
const assertDenied = async (action, label) => assert.rejects(operate(action), undefined, label);
const pendingName = async () => (await readdir(root)).find(x => x.startsWith('.pending-'));
try {
  await owner("alter role station_search_verifier nologin password null; alter role station_search_transition nologin password null");
  phase = 'partial staged file with durable metadata';
  adapter.afterFirstSecret = async () => { throw new Error('fixture injected partial stage'); };
  await assert.rejects(operate('create'));
  assert.ok(await pendingName());
  delete adapter.afterFirstSecret;
  await operate('abort-pending-create');

  phase = 'remote uncertainty blocks automatic abort';
  const originalSetPasswordForTimeout = adapter.setPassword;
  adapter.setPassword = async () => { throw new CredentialOperationError('remote uncertain'); };
  await assert.rejects(operate('create'), error => error.kind === 'remote uncertain');
  await assertDenied('abort-pending-create', 'inflight marker blocks abort');
  adapter.setPassword = originalSetPasswordForTimeout;
  // This fixture injected no remote work. Only here can it safely simulate the
  // operator's independent proof of quiescence before removing the marker.
  await rm(path.join(root, await pendingName(), '.owner-operation-inflight'));
  await operate('abort-pending-create');

  phase = 'interruption before first password and explicit abort';
  const originalApply = adapter.applyPolicy;
  adapter.applyPolicy = async () => { throw new Error('fixture injected pre-password failure'); };
  const originalDisable = adapter.disableRoles;
  adapter.disableRoles = async () => { throw new Error('fixture injected shutdown uncertainty'); };
  await assert.rejects(operate('create'), error => error.kind === 'shutdown uncertain');
  assert.ok(await pendingName());
  adapter.disableRoles = originalDisable;
  adapter.applyPolicy = originalApply;
  const sentinel = path.join(rootParent, 'preexisting-sentinel');
  await writeFile(sentinel, 'keep');
  await operate('abort-pending-create');
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');

  phase = 'between-password interruption and explicit abort';
  const originalSetPassword = adapter.setPassword;
  adapter.setPassword = async (role, password) => {
    if (role === 'transition') throw new Error('fixture injected second password failure');
    return originalSetPassword(role, password);
  };
  await assert.rejects(operate('create'));
  assert.ok(await pendingName());
  await assertDenied('create', 'pending material blocks replay');
  adapter.setPassword = originalSetPassword;
  await operate('abort-pending-create');
  assert.equal(await pendingName(), undefined);
  assert.equal(await owner("select count(*) from pg_authid where rolname like 'station_search_%' and (rolcanlogin or rolpassword is not null)"), '0');

  phase = 'before-publication interruption and explicit abort';
  const originalAudit = adapter.audit;
  adapter.audit = async () => { throw new Error('fixture injected pre-publication failure'); };
  await assert.rejects(operate('create'));
  assert.ok(await pendingName());
  adapter.audit = originalAudit;
  await operate('abort-pending-create');

  phase = 'post-publication failure retains complete bundle';
  adapter.afterPublication = async () => { throw new Error('fixture injected post-publication response failure'); };
  await assert.rejects(operate('create'));
  delete adapter.afterPublication;
  assert.ok((await readdir(root)).includes('initial-v1'));
  phase = 'exact authentication and byte-stable retained verify';
  const files = ['verifier.password', 'transition.password', 'operation.json'];
  const before = await Promise.all(files.map(x => readFile(path.join(root, 'initial-v1', x))));
  assert.equal((await operate('verify')).state, 'verified');
  const after = await Promise.all(files.map(x => readFile(path.join(root, 'initial-v1', x))));
  assert.deepEqual(after, before);
  await assertDenied('create', 'published bundle blocks rotation');
  await assertDenied('abort-pending-create', 'published bundle blocks abort');

  phase = 'read-only drift rejection';
  await owner('revoke select on search_generation_control from station_search_verifier');
  await assertDenied('verify', 'missing required grant denied');
  assert.equal(await owner("select has_table_privilege('station_search_verifier','search_generation_control','SELECT')"), 'f');
  await owner('grant select on search_generation_control to station_search_verifier');
  await owner('alter role station_search_verifier createdb');
  await assertDenied('verify', 'dangerous role denied');
  assert.equal(await owner("select rolcreatedb from pg_roles where rolname='station_search_verifier'"), 't');
  await owner('alter role station_search_verifier nocreatedb');
  assert.equal((await operate('verify')).state, 'verified');
  await owner('alter role station_search_verifier nologin');
  await assertDenied('verify', 'missing LOGIN role rejected without repair');
  assert.equal(await owner("select rolcanlogin from pg_roles where rolname='station_search_verifier'"), 'f');
  await owner('alter role station_search_verifier login');
  const missingRegistry = await run(['-X', '-U', 'station', '-d', 'station', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    `BEGIN; ALTER TABLE search_generation_dispatch RENAME TO search_generation_dispatch_missing_probe;\n${audit}\nCOMMIT;`);
  assert.notEqual(missingRegistry.code, 0, 'audit denies missing dispatch table');
  assert.equal(await owner("select to_regclass('public.search_generation_dispatch')::text"), 'search_generation_dispatch');

  phase = 'file rejection';
  const verifierFile = path.join(root, 'initial-v1/verifier.password');
  const original = await readFile(verifierFile);
  await chmod(verifierFile, 0o644); await assertDenied('verify', 'public mode denied'); await chmod(verifierFile, 0o600);
  await writeFile(verifierFile, 'bad'); await assertDenied('verify', 'malformed secret denied');
  await writeFile(verifierFile, 'A'.repeat(5000)); await assertDenied('verify', 'oversize secret denied');
  const wrongValid = original.toString('utf8');
  await writeFile(verifierFile, `${wrongValid[0] === 'A' ? 'B' : 'A'}${wrongValid.slice(1)}`);
  await assertDenied('verify', 'wrong but well-formed password denied');
  await writeFile(verifierFile, original); await chmod(verifierFile, 0o600);
  const backup = path.join(rootParent, 'private-backup');
  await writeFile(backup, original, { mode: 0o600 });
  await rm(verifierFile); await symlink(backup, verifierFile);
  await assertDenied('verify', 'secret symlink denied');
  await rm(verifierFile); await writeFile(verifierFile, original, { mode: 0o600 });
  const metadataPath = path.join(root, 'initial-v1/operation.json');
  const metadataBytes = await readFile(metadataPath);
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, uid: uid + 1 }));
  await assertDenied('verify', 'foreign owner identity denied');
  await writeFile(metadataPath, metadataBytes);
  const link = path.join(root, 'initial-v1/link');
  await symlink(verifierFile, link); await assertDenied('verify', 'extra symlink denied'); await rm(link);
  const lock = await open(path.join(root, '.operation.lock'), 'wx', 0o600);
  try { await assertDenied('verify', 'concurrent lock denied'); }
  finally { await lock.close(); await rm(path.join(root, '.operation.lock')); }
  assert.equal((await stat(verifierFile)).mode & 0o777, 0o600);
  assert.equal((await operate('verify')).state, 'verified');

  phase = 'actual SCRAM premutation rotation abort';
  adapter.afterRotationStaged = async () => { throw new Error('staged before mutation'); };
  await assert.rejects(operateSearchAdminCredentials({ action: 'rotate', role: 'transition', root, uid, gid, adapter }),
    /staged before mutation/);
  delete adapter.afterRotationStaged;
  const abortStage = (await readdir(root)).find(x => x.startsWith('.rotation-'));
  assert.ok(abortStage);
  assert.equal((await operateSearchAdminCredentials({ action: 'abort-pending-rotation', role: 'transition',
    operationId: abortStage.slice('.rotation-'.length), root, uid, gid, adapter })).state, 'rotation-aborted');
  assert.equal((await operate('verify')).state, 'verified');

  phase = 'target-only actual SCRAM rotation for both roles';
  for (const target of ['verifier', 'transition']) {
    const other = target === 'verifier' ? 'transition' : 'verifier';
    const otherFile = await readFile(path.join(root, `initial-v1/${other}.password`));
    const otherEvidence = await adapter.roleEvidence(other);
    const old = (await readFile(path.join(root, `initial-v1/${target}.password`))).toString('utf8');
    heldTargetContainer = true;
    await assert.rejects(operateSearchAdminCredentials({ action: 'rotate', role: target, root, uid, gid, adapter }),
      /target containers/);
    heldTargetContainer = false;
    const held = target === 'verifier' ? await heldSession(other, otherFile.toString('utf8')) : undefined;
    const targetSession = target === 'verifier' ? await heldSession(target, old) : undefined;
    try {
      assert.equal((await operateSearchAdminCredentials({ action: 'rotate', role: target, root, uid, gid, adapter })).state,
        'rotated');
      if (targetSession) {
        const ended = await targetSession.completion;
        assert.notEqual(ended.code, 0, 'target session terminated during rotation');
      }
      if (held) {
        assert.equal(held.child.exitCode, null, 'original other-role session survives rotation');
        const result = await held.completion;
        assert.equal(result.code, 0);
        assert.match(result.stdout, /still/);
      }
    } finally { held?.child.kill('SIGKILL'); targetSession?.child.kill('SIGKILL'); }
    await adapter.authenticateRejected(target, old);
    assert.deepEqual(await readFile(path.join(root, `initial-v1/${other}.password`)), otherFile);
    assert.deepEqual(await adapter.roleEvidence(other), otherEvidence);
    assert.equal((await operate('verify')).state, 'verified');
  }

  phase = 'actual SCRAM with two uncertain container-bound attempts';
  const originalPassword = adapter.setPassword;
  adapter.setPassword = async (role, value) => {
    await originalPassword(role, value);
    throw new CredentialOperationError('remote uncertain');
  };
  await assert.rejects(operateSearchAdminCredentials({ action: 'rotate', role: 'verifier', root, uid, gid, adapter }),
    error => error.kind === 'remote uncertain');
  let rotation = (await readdir(root)).find(x => x.startsWith('.rotation-'));
  assert.ok(rotation);
  const rotationId = rotation.slice('.rotation-'.length);
  const inflight = path.join(root, rotation, '.owner-operation-inflight');
  assert.equal(JSON.parse(await readFile(inflight, 'utf8')).containerId, 'a'.repeat(64));
  await assert.rejects(operateSearchAdminCredentials({ action: 'abort-pending-rotation', role: 'verifier',
    operationId: rotationId, root, uid, gid, adapter }), /rotation started/);
  const sameSession = await run(['-X', '-U', 'station', '-d', 'station', '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t', '-f', '-'],
    `${rotationAudit('verifier')}\n${auditOnly}`);
  assert.notEqual(sameSession.code, 0,
    'normal audit rejects target NOLOGIN with a password after recovery audit in the same session');
  assert.match(sameSession.stderr, /unsafe preexisting search admin role/);
  await owner('revoke select on search_generation_control from station_search_transition');
  const beforeDrift = await readFile(inflight);
  await assert.rejects(operateSearchAdminCredentials({ action: 'finish-pending-rotation', role: 'verifier',
    operationId: rotationId, root, uid, gid, adapter }));
  assert.deepEqual(await readFile(inflight), beforeDrift, 'other-role grant drift dispatches no mutation');
  await owner('grant select on search_generation_control to station_search_transition');
  await owner('alter role station_search_transition createdb');
  await assert.rejects(operateSearchAdminCredentials({ action: 'finish-pending-rotation', role: 'verifier',
    operationId: rotationId, root, uid, gid, adapter }));
  assert.deepEqual(await readFile(inflight), beforeDrift, 'other-role flag drift dispatches no mutation');
  await owner('alter role station_search_transition nocreatedb');
  await assert.rejects(operateSearchAdminCredentials({ action: 'finish-pending-rotation', role: 'verifier',
    operationId: rotationId, root, uid, gid, adapter }), /remote quiescence/);
  rotationContainer = 'b'.repeat(64);
  retiredContainers.add('a'.repeat(64));
  await assert.rejects(operateSearchAdminCredentials({ action: 'finish-pending-rotation', role: 'verifier',
    operationId: rotationId, root, uid, gid, adapter }), error => error.kind === 'remote uncertain');
  assert.equal(JSON.parse(await readFile(inflight, 'utf8')).containerId, 'b'.repeat(64));
  rotationContainer = 'c'.repeat(64);
  await assert.rejects(operateSearchAdminCredentials({ action: 'finish-pending-rotation', role: 'verifier',
    operationId: rotationId, root, uid, gid, adapter }), /remote quiescence/);
  retiredContainers.add('b'.repeat(64));
  adapter.setPassword = originalPassword;
  assert.equal((await operateSearchAdminCredentials({ action: 'finish-pending-rotation', role: 'verifier',
    operationId: rotationId, root, uid, gid, adapter })).state, 'rotated');
  assert.equal((await operate('verify')).state, 'verified');
  process.stdout.write('PASS: create/abort/retained proof plus both target-only SCRAM rotations and A/B uncertainty recovery.\n');
} catch (error) {
  failure = error;
  process.stderr.write(`FAIL: ${phase}.\n`);
} finally {
  await rm(rootParent, { recursive: true, force: true });
}
if (failure) process.exitCode = 1;
