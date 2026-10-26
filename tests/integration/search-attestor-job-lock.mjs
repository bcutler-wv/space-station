import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { operateSearchAdminCredentials } from '../../scripts/search-admin-credential-core.mjs';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';

const script = fileURLToPath(import.meta.url);
const uid = process.getuid(), gid = process.getgid();
const waitFor = async predicate => {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error('bounded attestor lock fixture wait failed');
};
const createRoot = async parent => {
  const cache = path.join(parent, '.cache');
  const root = path.join(cache, 'search-db');
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
};
const finishAttestor = async attestor => {
  for (const phase of ['prepare', 'transfer', 'attestor']) {
    await attestor.markDispatched(phase);
    await attestor.confirmCompletion(phase);
  }
  await attestor.confirmOwnedCleanup();
};

if (process.argv[2] === 'hold') {
  const [, , , root, signal, release, phase] = process.argv;
  await withSearchAdminJobLock({ root, uid }, async lock => {
    const attestor = lock.beginAttestor();
    if (phase === 'prepare') await attestor.markDispatched('prepare');
    await writeFile(signal, attestor.invocationId);
    await waitFor(() => existsSync(release));
    if (phase !== 'prepare') await attestor.markDispatched('prepare');
    await attestor.confirmCompletion('prepare');
    await attestor.markDispatched('transfer');
    await attestor.confirmCompletion('transfer');
    await attestor.markDispatched('attestor');
    await attestor.confirmCompletion('attestor');
    await attestor.confirmOwnedCleanup();
  });
} else {
  const artifactRoot = path.join(process.cwd(), '.cache/results');
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(path.join(artifactRoot, 'search-attestor-job-lock-'));
  let child;
  try {
    const root = await createRoot(parent);
    const jobPath = path.join(root, '.job-operation.lock');
    const identity = { project: 'fixture', service: 'postgres', database: 'station',
      databaseOid: '1', systemIdentifier: '123', owner: 'station', uid, gid };
    const adapter = {
      identity: async () => identity, preflightCreate: async () => {}, applyPolicy: async () => {},
      setPassword: async () => {}, setLogin: async () => {}, authenticate: async () => {},
      audit: async () => {}, disableRoles: async () => {},
    };
    const operate = action => operateSearchAdminCredentials({ action, root, uid, gid, adapter });
    assert.equal((await operate('create')).state, 'created');
    const signal = path.join(parent, 'held');
    const release = path.join(parent, 'release');
    child = spawn(process.execPath, [script, 'hold', root, signal, release, 'preflight'],
      { stdio: 'ignore' });
    const heldResult = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, terminated) => resolve({ code, terminated }));
    });
    try {
      await waitFor(() => existsSync(signal));
      assert.match(await readFile(signal, 'utf8'), /^[a-f0-9-]{36}$/);
      await assert.rejects(operate('verify'), /job locked/);
      await assert.rejects(withSearchAdminJobLock({ root, uid }, async () => {}), /job locked/);
    } finally {
      await writeFile(release, 'release');
      assert.deepEqual(await heldResult, { code: 0, terminated: null });
      child = undefined;
    }
    assert.equal(existsSync(jobPath), false);
    const movedFinalLock = path.join(parent, 'moved-final-lock');
    await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
      await finishAttestor(lock.beginAttestor());
      await rename(jobPath, movedFinalLock);
      await writeFile(jobPath, 'replacement after cleanup', { mode: 0o600 });
      return 'must not succeed';
    }), { message: 'Search admin attestor lock release.' });
    assert.equal(await readFile(jobPath, 'utf8'), 'replacement after cleanup');
    assert.match(await readFile(movedFinalLock, 'utf8'), /"phase":"attestor-confirmed","state":"cleanup-complete"/);
    await rm(jobPath); await rm(movedFinalLock);
    const movedFinalRoot = path.join(parent, 'moved-final-root');
    await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
      await finishAttestor(lock.beginAttestor());
      await rename(root, movedFinalRoot);
      await mkdir(root, { mode: 0o700 });
      await writeFile(jobPath, 'replacement root after cleanup', { mode: 0o600 });
      return 'must not succeed';
    }), { message: 'Search admin attestor lock release.' });
    assert.equal(await readFile(jobPath, 'utf8'), 'replacement root after cleanup');
    assert.match(await readFile(path.join(movedFinalRoot, '.job-operation.lock'), 'utf8'),
      /"phase":"attestor-confirmed","state":"cleanup-complete"/);
    await rm(root, { recursive: true });
    await rename(movedFinalRoot, root);
    await rm(jobPath); // Fixture-owned final lock retained in original root.
    const firstId = await withSearchAdminJobLock({ root, uid }, async lock => {
      const attestor = lock.beginAttestor();
      assert.throws(() => lock.beginAttestor(), /attestor mode/);
      await assert.rejects(lock.markDispatched('verifier'), /job dispatch/);
      await assert.rejects(attestor.markDispatched('transfer'), /attestor dispatch/);
      await attestor.markDispatched('prepare');
      assert.match(await readFile(jobPath, 'utf8'), /"phase":"prepare","state":"dispatched"/);
      await assert.rejects(attestor.markDispatched('prepare'), /attestor dispatch/);
      await assert.rejects(attestor.confirmCompletion('transfer'), /attestor completion/);
      await attestor.confirmCompletion('prepare');
      await assert.rejects(attestor.confirmCompletion('prepare'), /attestor completion/);
      await attestor.markDispatched('transfer');
      await assert.rejects(attestor.confirmCompletion('prepare'), /attestor completion/);
      await attestor.confirmCompletion('transfer');
      await attestor.markDispatched('attestor');
      await attestor.confirmCompletion('attestor');
      await attestor.confirmOwnedCleanup();
      await assert.rejects(attestor.confirmOwnedCleanup(), /attestor cleanup/);
      return attestor.invocationId;
    });
    assert.equal(existsSync(jobPath), false);
    let secondId;
    await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
      const attestor = lock.beginAttestor();
      secondId = attestor.invocationId;
    }), /attestor incomplete/);
    assert.notEqual(firstId, secondId, 'lock creates a unique invocation');
    assert.equal(existsSync(jobPath), false, 'incomplete local preflight releases only owned lock');
    await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
      const attestor = lock.beginAttestor();
      await attestor.markDispatched('prepare');
      await attestor.confirmCompletion('prepare');
      return 'incorrect success';
    }), /attestor incomplete/);
    assert.equal(existsSync(jobPath), true, 'normal return after prepare retains lock without cleanup');
    await rm(jobPath);
    await assert.rejects(withSearchAdminJobLock({ root, uid }, async () => {
      throw new Error('local preflight failure');
    }), /local preflight failure/);
    assert.equal(existsSync(jobPath), false);
    for (const stopAfter of ['prepare', 'transfer']) {
      await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
        const attestor = lock.beginAttestor();
        await attestor.markDispatched('prepare');
        await attestor.confirmCompletion('prepare');
        if (stopAfter === 'transfer') {
          await attestor.markDispatched('transfer');
          await attestor.confirmCompletion('transfer');
        }
        await attestor.confirmOwnedCleanup();
      }), /attestor incomplete/);
      assert.equal(existsSync(jobPath), false, `${stopAfter} cleanup permits release`);
    }
    for (const uncertain of ['prepare', 'transfer', 'attestor']) {
      await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
        const attestor = lock.beginAttestor();
        await attestor.markDispatched('prepare');
        if (uncertain !== 'prepare') {
          await attestor.confirmCompletion('prepare');
          await attestor.markDispatched('transfer');
        }
        if (uncertain === 'attestor') {
          await attestor.confirmCompletion('transfer');
          await attestor.markDispatched('attestor');
        }
        if (uncertain !== 'prepare')
          await assert.rejects(attestor.confirmCompletion('prepare'), /attestor completion/);
        throw new Error(`unknown ${uncertain}`);
      }), new RegExp(`unknown ${uncertain}`));
      assert.equal(existsSync(jobPath), true, `${uncertain} unknown retains lock`);
      await assert.rejects(operate('verify'), /job locked/);
      await rm(jobPath); // Fixture started no remote job; independent cleanup.
    }
    for (const confirmed of ['prepare', 'transfer', 'attestor']) {
      await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
        const attestor = lock.beginAttestor();
        await attestor.markDispatched('prepare');
        await attestor.confirmCompletion('prepare');
        if (confirmed !== 'prepare') {
          await attestor.markDispatched('transfer');
          await attestor.confirmCompletion('transfer');
        }
        if (confirmed === 'attestor') {
          await attestor.markDispatched('attestor');
          await attestor.confirmCompletion('attestor');
        }
        throw new Error('owned cleanup incomplete');
      }), /owned cleanup incomplete/);
      assert.equal(existsSync(jobPath), true, `${confirmed} without cleanup retains lock`);
      await rm(jobPath);
    }
    process.env.STATION_JOB_LOCK_FIXTURE = '1';
    try {
      for (const fault of ['after-append', 'after-file-sync']) {
        await assert.rejects(withSearchAdminJobLock({ root, uid, fixtureFaultAt: fault }, async lock => {
          const attestor = lock.beginAttestor();
          await assert.rejects(attestor.markDispatched('prepare'), /job record fault/);
          await assert.rejects(attestor.markDispatched('prepare'), /attestor dispatch/);
        }), /attestor incomplete/);
        assert.equal(existsSync(jobPath), true, `${fault} retains partial marker`);
        await assert.rejects(operate('verify'), /job locked/);
        await rm(jobPath);
      }
      await assert.rejects(withSearchAdminJobLock({ root, uid,
        fixtureFaultAt: 'before-release-rm' }, async lock => {
        await finishAttestor(lock.beginAttestor());
        return 'must not succeed';
      }), { message: 'Search admin attestor lock release.' });
      assert.equal(existsSync(jobPath), true, 'release failure retains the owned lock');
      await rm(jobPath);
    } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
    const killedSignal = path.join(parent, 'killed-held');
    child = spawn(process.execPath, [script, 'hold', root, killedSignal,
      path.join(parent, 'never-release'), 'prepare'], { stdio: 'ignore' });
    const killedResult = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, terminated) => resolve({ code, terminated }));
    });
    await waitFor(() => existsSync(killedSignal));
    child.kill('SIGKILL');
    assert.deepEqual(await killedResult, { code: null, terminated: 'SIGKILL' });
    child = undefined;
    assert.equal(existsSync(jobPath), true, 'crash retains lock');
    await assert.rejects(operate('verify'), /job locked/);
    await rm(jobPath);
    const moved = path.join(parent, 'moved-lock');
    await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
      const attestor = lock.beginAttestor();
      await rename(jobPath, moved);
      await writeFile(jobPath, 'replacement', { mode: 0o600 });
      await assert.rejects(attestor.markDispatched('prepare'), /job lock identity/);
    }), /attestor incomplete/);
    assert.equal(await readFile(jobPath, 'utf8'), 'replacement');
    await rm(jobPath); await rm(moved);
    const movedRoot = path.join(parent, 'moved-root');
    await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
      lock.beginAttestor();
      await rename(root, movedRoot);
      await mkdir(root, { mode: 0o700 });
      await writeFile(jobPath, 'replacement', { mode: 0o600 });
    }), /attestor incomplete/);
    assert.equal(await readFile(jobPath, 'utf8'), 'replacement', 'replacement root preserved');
    await rm(root, { recursive: true });
    await rename(movedRoot, root);
    await rm(jobPath); // Fixture-owned pre-dispatch inode in the restored original root.
    const outside = path.join(parent, 'outside');
    await writeFile(outside, 'keep');
    await symlink(outside, jobPath);
    await assert.rejects(withSearchAdminJobLock({ root, uid }, async () => {}), /job locked/);
    assert.equal(await realpath(jobPath), outside);
    await rm(jobPath);
    process.stdout.write('PASS: finite attestor phases, shared exclusion, unknown/crash/fault retention and owned cleanup.\n');
  } finally {
    child?.kill('SIGKILL');
    await rm(parent, { recursive: true, force: true });
  }
}
