import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { CredentialOperationError, operateSearchAdminCredentials } from '../../scripts/search-admin-credential-core.mjs';

const uid = process.getuid(), gid = process.getgid();
const parent = await mkdtemp(path.join(process.cwd(), '.cache/results/search-admin-rotation-'));
const cache = path.join(parent, '.cache');
const root = path.join(cache, 'search-db');
await mkdir(cache, { mode: 0o700 });
const installation = { project: 'fixture', service: 'postgres', database: 'station', databaseOid: '19',
  systemIdentifier: '123456789', owner: 'station', uid, gid };
let container = 'a'.repeat(64);
const retired = new Set();
const password = { verifier: null, transition: null };
const login = { verifier: false, transition: false };
const verifier = { verifier: '', transition: '' };
let mutationLog = [], failPassword = false, targetContainers = false, phase = 'initial';
const lockObservations = [];
const assertBothLocks = async point => {
  await new Promise(resolve => setImmediate(resolve));
  const [job, credential] = await Promise.all([
    lstat(path.join(root, '.job-operation.lock')),
    lstat(path.join(root, '.operation.lock')),
  ]);
  assert.equal(job.isFile() && credential.isFile(), true, `${point} retains both owned lock files`);
  lockObservations.push(point);
};
const adapter = {
  identity: async () => installation,
  containerId: async () => container,
  attestAuthentication: async () => {},
  targetContainersAbsent: async () => !targetContainers,
  assertRetiredContainer: async id => {
    if (id === container || !retired.has(id)) throw new CredentialOperationError('remote quiescence');
  },
  preflightCreate: async () => {},
  applyPolicy: async () => {},
  audit: async () => {
    await assertBothLocks('final-audit');
    assert.equal(login.verifier, true);
    assert.equal(login.transition, true);
  },
  auditRecovery: async () => {},
  roleEvidence: async role => ({ login: login[role], verifier: verifier[role] }),
  setPassword: async (role, value) => {
    await assertBothLocks('password');
    mutationLog.push(`password:${role}:${container}`);
    password[role] = value;
    verifier[role] = `SCRAM-SHA-256$${value}`;
    if (failPassword) { failPassword = false; throw new CredentialOperationError('remote uncertain'); }
  },
  setLogin: async (role, value) => {
    mutationLog.push(`${value ? 'login' : 'nologin'}:${role}:${container}`);
    login[role] = value;
  },
  terminateTargetSessions: async role => { mutationLog.push(`terminate:${role}:${container}`); },
  targetSessionsZero: async () => true,
  authenticate: async (role, value) => {
    await assertBothLocks('authentication');
    assert.equal(login[role], true); assert.equal(value, password[role]);
  },
  authenticateRejected: async (role, value) => { assert.equal(login[role], true); assert.notEqual(value, password[role]); },
  disableRoles: async () => {},
};
const operate = (action, role, operationId) => operateSearchAdminCredentials({ action, role, operationId,
  root, uid, gid, adapter });
const stageName = async () => (await readdir(root)).find(x => x.startsWith('.rotation-'));
const staged = async () => {
  const name = await stageName();
  assert.ok(name);
  return { name, operationId: name.slice('.rotation-'.length), directory: path.join(root, name) };
};
let failure;
try {
  phase = 'create baseline';
  await operate('create');
  await operate('verify');
  const baseline = await readFile(path.join(root, 'initial-v1/transition.password'));

  phase = 'pre-mutation abort and held containers';
  targetContainers = true;
  await assert.rejects(operate('rotate', 'verifier'), /target containers/);
  assert.equal(await stageName(), undefined);
  targetContainers = false;
  adapter.afterRotationStaged = async () => { throw new Error('fixture staged'); };
  await assert.rejects(operate('rotate', 'verifier'), /fixture staged/);
  delete adapter.afterRotationStaged;
  let stage = await staged();
  await assert.rejects(operate('verify'), /incomplete setup/);
  await assert.rejects(operate('rotate', 'transition'), /pending rotation/);
  await assert.rejects(operate('abort-pending-rotation', 'transition', stage.operationId), /rotation ownership/);
  assert.equal((await operate('abort-pending-rotation', 'verifier', stage.operationId)).state, 'rotation-aborted');
  assert.equal(await stageName(), undefined);

  phase = 'stage inventory and immutable evidence';
  adapter.afterRotationStaged = async () => { throw new Error('fixture staged'); };
  await assert.rejects(operate('rotate', 'verifier'), /fixture staged/);
  delete adapter.afterRotationStaged;
  stage = await staged();
  const publishPath = path.join(stage.directory, 'new.publish');
  const publish = await readFile(publishPath);
  await writeFile(publishPath, 'A'.repeat(43));
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), /rotation secret/);
  await writeFile(publishPath, publish);
  await rm(publishPath);
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), /rotation inventory/);
  await writeFile(publishPath, publish, { mode: 0o600 });
  const newPath = path.join(stage.directory, 'new.password');
  const beforeBadMode = mutationLog.length;
  await chmod(newPath, 0o400);
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), /secret/);
  assert.equal(mutationLog.length, beforeBadMode, 'stage 0400 rejection dispatches no mutation');
  await chmod(newPath, 0o600);
  await chmod(newPath, 0o644);
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), /secret/);
  await chmod(newPath, 0o600);
  await rm(publishPath);
  await symlink(newPath, publishPath);
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), /secret/);
  await rm(publishPath);
  await writeFile(publishPath, publish, { mode: 0o600 });
  const metaPath = path.join(stage.directory, 'rotation.json');
  const meta = await readFile(metaPath);
  await writeFile(metaPath, JSON.stringify({ ...JSON.parse(meta), uid: uid + 1 }));
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), /rotation metadata/);
  await writeFile(metaPath, meta);
  const extra = path.join(stage.directory, 'extra');
  await writeFile(extra, 'x');
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), /rotation inventory/);
  await rm(extra);
  assert.equal((await operate('abort-pending-rotation', 'verifier', stage.operationId)).state, 'rotation-aborted');

  phase = 'uncertain A then uncertain B bound to each container';
  failPassword = true;
  await assert.rejects(operate('rotate', 'verifier'), error => error.kind === 'remote uncertain');
  stage = await staged();
  const markerA = JSON.parse(await readFile(path.join(stage.directory, '.owner-operation-inflight'), 'utf8'));
  assert.equal(markerA.containerId, 'a'.repeat(64));
  assert.equal(markerA.action, 'password');
  await assert.rejects(operate('abort-pending-rotation', 'verifier', stage.operationId), /rotation started/);
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), /remote quiescence/);
  const beforeDenied = mutationLog.length;
  assert.equal(mutationLog.length, beforeDenied);
  container = 'b'.repeat(64);
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), /remote quiescence/);
  retired.add('a'.repeat(64));
  failPassword = true;
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), error => error.kind === 'remote uncertain');
  const markerB = JSON.parse(await readFile(path.join(stage.directory, '.owner-operation-inflight'), 'utf8'));
  assert.equal(markerB.containerId, 'b'.repeat(64));
  assert.notEqual(markerB.attemptId, markerA.attemptId);
  assert.notEqual(markerB.containerId, markerA.containerId);
  container = 'c'.repeat(64);
  const beforeThird = mutationLog.length;
  await assert.rejects(operate('finish-pending-rotation', 'verifier', stage.operationId), /remote quiescence/);
  assert.equal(mutationLog.length, beforeThird, 'no mutation while B remains unresolved');
  retired.add('b'.repeat(64));
  assert.equal((await operate('finish-pending-rotation', 'verifier', stage.operationId)).state, 'rotated');
  assert.equal(await stageName(), undefined);
  assert.deepEqual(await readFile(path.join(root, 'initial-v1/transition.password')), baseline);
  await operate('verify');

  phase = 'post-rename finish with target old denied';
  const oldTransition = await readFile(path.join(root, 'initial-v1/transition.password'));
  adapter.afterRotationPublication = async () => {
    await assertBothLocks('publication');
    throw new Error('fixture after rename');
  };
  await assert.rejects(operate('rotate', 'transition'), /fixture after rename/);
  delete adapter.afterRotationPublication;
  stage = await staged();
  assert.equal((await readdir(stage.directory)).includes('new.publish'), false);
  assert.notDeepEqual(await readFile(path.join(root, 'initial-v1/transition.password')), oldTransition);
  await assert.rejects(operate('abort-pending-rotation', 'transition', stage.operationId), /rotation started/);
  assert.equal((await operate('finish-pending-rotation', 'transition', stage.operationId)).state, 'rotated');
  await operate('verify');
  for (const point of ['password', 'publication', 'final-audit', 'authentication'])
    assert.ok(lockObservations.includes(point), `${point} lock assertion executed`);
  for (const lock of ['.job-operation.lock', '.operation.lock'])
    await assert.rejects(lstat(path.join(root, lock)), { code: 'ENOENT' });
  process.stdout.write('PASS: pre-mutation abort, target-only rotation, A/B uncertainty, finish-new after rename.\n');
} catch (error) {
  failure = error;
  process.stderr.write(`FAIL: ${phase}.\n`);
} finally { await rm(parent, { recursive: true, force: true }); }
if (failure) process.exitCode = 1;
