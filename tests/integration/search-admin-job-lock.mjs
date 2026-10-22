import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CredentialOperationError, operateSearchAdminCredentials } from '../../scripts/search-admin-credential-core.mjs';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';

const script = fileURLToPath(import.meta.url);
const uid = process.getuid(), gid = process.getgid();
const waitFor = async predicate => {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error('bounded fixture wait failed');
};

if (['hold', 'dispatch-hold'].includes(process.argv[2])) {
  const [, , , root, signal, release] = process.argv;
  await withSearchAdminJobLock({ root, uid }, async lock => {
    if (process.argv[2] === 'dispatch-hold') await lock.markDispatched('verifier');
    await writeFile(signal, 'held');
    await waitFor(() => existsSync(release));
  });
} else {
  const parent = await mkdtemp(path.join(process.cwd(), '.cache/results/search-admin-job-lock-'));
  const cache = path.join(parent, '.cache');
  const root = path.join(cache, 'search-db');
  const jobPath = path.join(root, '.job-operation.lock');
  const credentialPath = path.join(root, '.operation.lock');
  let child;
  try {
    await mkdir(cache, { mode: 0o700 });
    const identity = { project: 'fixture', service: 'postgres', database: 'station',
      databaseOid: '1', systemIdentifier: '123', owner: 'station', uid, gid };
    const adapter = {
      identity: async () => identity,
      preflightCreate: async () => {},
      applyPolicy: async () => {},
      setPassword: async () => {},
      setLogin: async () => {},
      authenticate: async () => {},
      audit: async () => {},
      disableRoles: async () => {},
    };
    const operate = action => operateSearchAdminCredentials({ action, root, uid, gid, adapter });
    assert.equal((await operate('create')).state, 'created');
    assert.equal((await operate('verify')).state, 'verified');
    assert.equal(existsSync(jobPath), false);
    assert.equal(existsSync(credentialPath), false);

    const signal = path.join(parent, 'held');
    const release = path.join(parent, 'release');
    child = spawn(process.execPath, [script, 'hold', root, signal, release], { stdio: 'ignore' });
    const childResult = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, terminated) => resolve({ code, terminated }));
    });
    try {
      await waitFor(() => existsSync(signal));
      assert.equal(existsSync(jobPath), true, 'other process owns global job lock');
      await assert.rejects(operate('verify'), /job locked/);
      await assert.rejects(withSearchAdminJobLock({ root, uid }, async () => {}), /job locked/);
      assert.equal(existsSync(credentialPath), false, 'credential lock not taken out of order');
    } finally {
      await writeFile(release, 'go');
      assert.deepEqual(await childResult, { code: 0, terminated: null });
      child = undefined;
    }
    assert.equal(existsSync(jobPath), false);

    await assert.rejects(withSearchAdminJobLock({ root, uid }, async () => {
      throw new Error('definite pre-dispatch failure');
    }), /definite pre-dispatch failure/);
    assert.equal(existsSync(jobPath), false, 'owned pre-dispatch lock released');

    await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
      await lock.markDispatched('verifier');
      throw new Error('remote completion unconfirmed');
    }), /remote completion unconfirmed/);
    const marker = await readFile(jobPath, 'utf8');
    assert.match(marker, /"state":"dispatched"/);
    assert.match(marker, /"role":"verifier"/);
    await assert.rejects(operate('verify'), /job locked/);
    await rm(jobPath); // Fixture-only independent quiescence: no remote job was started.

    const dispatchedSignal = path.join(parent, 'dispatched');
    child = spawn(process.execPath, [script, 'dispatch-hold', root, dispatchedSignal,
      path.join(parent, 'never-release')], { stdio: 'ignore' });
    const killedResult = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, terminated) => resolve({ code, terminated }));
    });
    await waitFor(() => existsSync(dispatchedSignal));
    child.kill('SIGKILL');
    assert.deepEqual(await killedResult, { code: null, terminated: 'SIGKILL' });
    child = undefined;
    assert.match(await readFile(jobPath, 'utf8'), /"state":"dispatched"/);
    await assert.rejects(operate('verify'), /job locked/);
    await rm(jobPath); // Fixture killed before starting any remote work.

    await withSearchAdminJobLock({ root, uid }, async lock => {
      await lock.markDispatched('transition');
      lock.confirmCompletion();
    });
    assert.equal(existsSync(jobPath), false, 'confirmed completion releases owned lock');

    const moved = path.join(parent, 'moved-lock');
    await withSearchAdminJobLock({ root, uid }, async () => {
      await rename(jobPath, moved);
      await writeFile(jobPath, 'replacement', { mode: 0o600 });
    });
    assert.equal(await readFile(jobPath, 'utf8'), 'replacement', 'replacement lock preserved');
    await rm(jobPath); await rm(moved);

    const originalAudit = adapter.audit;
    const movedCredential = path.join(parent, 'moved-credential-lock');
    adapter.audit = async () => {
      await rename(credentialPath, movedCredential);
      await writeFile(credentialPath, 'replacement', { mode: 0o600 });
    };
    assert.equal((await operate('verify')).state, 'verified');
    assert.equal(await readFile(credentialPath, 'utf8'), 'replacement', 'credential lock replacement preserved');
    await rm(credentialPath); await rm(movedCredential);
    adapter.audit = originalAudit;

    const target = path.join(parent, 'unrelated');
    await writeFile(target, 'keep');
    await symlink(target, jobPath);
    await assert.rejects(operate('verify'), /job locked/);
    assert.equal(await readFile(target, 'utf8'), 'keep');
    await rm(jobPath);
    assert.equal((await operate('verify')).state, 'verified');

    const uncertainCache = path.join(parent, 'uncertain/.cache');
    const uncertainRoot = path.join(uncertainCache, 'search-db');
    await mkdir(uncertainCache, { recursive: true, mode: 0o700 });
    const uncertainAdapter = { ...adapter, setPassword: async () => {
      throw new CredentialOperationError('remote uncertain');
    } };
    await assert.rejects(operateSearchAdminCredentials({ action: 'create', root: uncertainRoot, uid, gid,
      adapter: uncertainAdapter }), error => error.kind === 'remote uncertain');
    assert.equal(existsSync(path.join(uncertainRoot, '.job-operation.lock')), false,
      'outer job lock releases after uncertain credential mutation');
    const staged = (await readdir(uncertainRoot)).find(x => x.startsWith('.pending-'));
    assert.ok(staged && existsSync(path.join(uncertainRoot, staged, '.owner-operation-inflight')),
      'existing pending marker still fences uncertain credential mutation');
    process.stdout.write('PASS: cross-process global lock, order, pre-dispatch cleanup, uncertainty retention, inode and symlink denial.\n');
  } finally {
    child?.kill('SIGKILL');
    await rm(parent, { recursive: true, force: true });
  }
}
