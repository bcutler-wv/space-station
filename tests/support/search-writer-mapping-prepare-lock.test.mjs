import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, symlink, unlink,
  writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';

const uid = process.getuid();
const exists = name => lstat(name).then(() => true, error => {
  if (error?.code === 'ENOENT') return false;
  throw error;
});
async function fixture(t) {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.join(process.cwd(), '.cache/results/mapping-lock-'));
  const root = path.join(repository, '.cache/search-db');
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(() => rm(repository, { recursive: true, force: true }));
  return { repository, root, name: path.join(root, '.job-operation.lock') };
}
const records = async name => (await readFile(name, 'utf8')).trim().split(/\n+/).map(JSON.parse);
async function complete(operation) {
  await operation.markDispatched('transfer');
  await operation.confirmCompletion('transfer');
  await operation.markDispatched('prepare');
  await operation.confirmCompletion('prepare');
  await operation.confirmOwnedCleanup();
  await operation.markPendingAttempted();
  await operation.confirmPrepared();
}
async function faulted(item, fault, work) {
  const previous = process.env.STATION_JOB_LOCK_FIXTURE;
  process.env.STATION_JOB_LOCK_FIXTURE = '1';
  try {
    return await withSearchAdminJobLock({ root: item.root, uid, fixtureFaultAt: fault }, work);
  } finally {
    if (previous === undefined) delete process.env.STATION_JOB_LOCK_FIXTURE;
    else process.env.STATION_JOB_LOCK_FIXTURE = previous;
  }
}

test('mapping preparation records exact phases once and releases after same-call completion', async t => {
  const item = await fixture(t);
  let expired;
  const result = await withSearchAdminJobLock({ root: item.root, uid }, async lock => {
    const operation = lock.beginWriterMappingPrepare();
    expired = operation;
    assert.match(operation.invocationId, /^[0-9a-f-]{36}$/);
    await operation.assertOwned();
    assert.throws(() => lock.beginWriterRolePrepare());
    await assert.rejects(operation.markDispatched('prepare'));
    await assert.rejects(operation.confirmPrepared());
    await complete(operation);
    await assert.rejects(operation.confirmPrepared());
    await assert.rejects(operation.markDispatched('transfer'));
    const rows = await records(item.name);
    assert.deepEqual(rows.map(row => [row.role, row.phase, row.state]), [
      [undefined, undefined, 'preflight'],
      ['writer-mapping-prepare', 'transfer', 'dispatched'],
      ['writer-mapping-prepare', 'transfer', 'confirmed'],
      ['writer-mapping-prepare', 'prepare', 'dispatched'],
      ['writer-mapping-prepare', 'prepare', 'confirmed'],
      ['writer-mapping-prepare', 'cleanup', 'confirmed'],
      ['writer-mapping-prepare', 'pending', 'attempted'],
      ['writer-mapping-prepare', 'pending', 'prepared'],
    ]);
    assert.equal(new Set(rows.map(row => row.operationId)).size, 1);
    return 'prepared';
  });
  assert.equal(result, 'prepared');
  assert.equal(await exists(item.name), false);
  await assert.rejects(expired.assertOwned());
  await assert.rejects(expired.markDispatched('transfer'));
});

test('checked no-attempt local cleanup releases, but dispatch uncertainty retains lock', async t => {
  const clean = await fixture(t);
  await assert.rejects(withSearchAdminJobLock({ root: clean.root, uid }, async lock => {
    lock.beginWriterMappingPrepare();
    const local = path.join(clean.repository, 'owned-local');
    await writeFile(local, 'owned');
    assert.equal(await readFile(local, 'utf8'), 'owned');
    await unlink(local);
    assert.equal(await exists(local), false);
    throw Error('local preflight failed');
  }), /local preflight failed/);
  assert.equal(await exists(clean.name), false);
  await assert.rejects(withSearchAdminJobLock({ root: clean.root, uid }, async lock => {
    lock.beginWriterMappingPrepare();
  }), /writer mapping prepare incomplete/);
  assert.equal(await exists(clean.name), false);

  for (const phase of ['transfer', 'prepare', 'cleanup', 'pending']) {
    const item = await fixture(t);
    await assert.rejects(withSearchAdminJobLock({ root: item.root, uid },
      async lock => {
        const operation = lock.beginWriterMappingPrepare();
        await operation.markDispatched('transfer');
        if (phase === 'transfer') throw Error('lost transfer');
        await operation.confirmCompletion('transfer');
        await operation.markDispatched('prepare');
        if (phase === 'prepare') throw Error('lost prepare');
        await operation.confirmCompletion('prepare');
        await operation.confirmOwnedCleanup();
        if (phase === 'cleanup') throw Error('lost after checked cleanup');
        await operation.markPendingAttempted();
        throw Error('uncertain pending');
      }));
    const before = await lstat(item.name);
    assert.equal(before.mode & 0o777, 0o600);
    assert.equal((await records(item.name)).at(-1).role, 'writer-mapping-prepare');
    await assert.rejects(withSearchAdminJobLock({ root: item.root, uid },
      async lock => lock.beginWriterMappingPrepare()), /job locked/);
    assert.equal((await lstat(item.name)).ino, before.ino);
  }
});

test('failed owned-local cleanup latches preflight uncertainty before record I/O', async t => {
  const item = await fixture(t);
  const owned = path.join(item.repository, 'owned-local');
  await assert.rejects(withSearchAdminJobLock({ root: item.root, uid }, async lock => {
    const operation = lock.beginWriterMappingPrepare();
    await mkdir(owned, { mode: 0o700 });
    await writeFile(path.join(owned, 'child'), 'owned');
    try { await rmdir(owned); }
    catch {
      await operation.retainPreflightFailure();
      await assert.rejects(operation.retainPreflightFailure(),
        /writer mapping prepare preflight/);
      await assert.rejects(operation.markDispatched('transfer'),
        /writer mapping prepare dispatch/);
      throw Error('private cleanup failure');
    }
  }));
  assert.equal(await readFile(path.join(owned, 'child'), 'utf8'), 'owned');
  assert.equal(await exists(item.name), true);
  assert.deepEqual((await records(item.name)).at(-1), {
    version: 1, operationId: (await records(item.name))[0].operationId,
    pid: process.pid, role: 'writer-mapping-prepare', phase: 'preflight', state: 'failed',
  });
  await assert.rejects(withSearchAdminJobLock({ root: item.root, uid },
    async lock => lock.beginWriterMappingPrepare()), /job locked/);
});

test('preflight-failure append and fsync faults stay latched and retain original lock', async t => {
  for (const point of ['after-append', 'after-file-sync']) {
    const item = await fixture(t);
    const owned = path.join(item.repository, 'owned-local');
    await assert.rejects(faulted(item, `mapping-prepare-preflight-failed-${point}`,
      async lock => {
        const operation = lock.beginWriterMappingPrepare();
        await writeFile(owned, 'owned');
        await assert.rejects(operation.retainPreflightFailure(), /job record fault/);
        await assert.rejects(operation.retainPreflightFailure(),
          /writer mapping prepare preflight/);
        await assert.rejects(operation.markDispatched('transfer'),
          /writer mapping prepare dispatch/);
      }));
    assert.equal(await readFile(owned, 'utf8'), 'owned');
    assert.equal(await exists(item.name), true);
    const rows = await records(item.name);
    assert.equal(rows.filter(row => row.phase === 'preflight' && row.state === 'failed').length, 1);
  }
});

test('every later mapping-only append/fsync fault denies retry and phase advancement', async t => {
  const steps = [
    ['transfer-dispatched', operation => operation.markDispatched('transfer'),
      operation => operation.confirmCompletion('transfer')],
    ['transfer-confirmed', operation => operation.confirmCompletion('transfer'),
      operation => operation.markDispatched('prepare')],
    ['prepare-dispatched', operation => operation.markDispatched('prepare'),
      operation => operation.confirmCompletion('prepare')],
    ['prepare-confirmed', operation => operation.confirmCompletion('prepare'),
      operation => operation.confirmOwnedCleanup()],
    ['cleanup-confirmed', operation => operation.confirmOwnedCleanup(),
      operation => operation.markPendingAttempted()],
    ['pending-attempted', operation => operation.markPendingAttempted(),
      operation => operation.confirmPrepared()],
  ];
  for (const [target] of steps) for (const point of ['after-append', 'after-file-sync']) {
    const item = await fixture(t);
    const fault = target === 'transfer-dispatched' ? point :
      `mapping-prepare-${target}-${point}`;
    let originalInode;
    await assert.rejects(faulted(item, fault, async lock => {
      const operation = lock.beginWriterMappingPrepare();
      originalInode = (await lstat(item.name)).ino;
      for (const [name, step, next] of steps) {
        if (name !== target) { await step(operation); continue; }
        await assert.rejects(step(operation), /job record fault/);
        await assert.rejects(step(operation));
        await assert.rejects(next(operation));
        return;
      }
      assert.fail('target step was not reached');
    }));
    assert.equal(await exists(item.name), true, fault);
    assert.equal((await lstat(item.name)).ino, originalInode);
    const [phase, state] = target.split('-');
    const rows = await records(item.name);
    assert.equal(rows.at(-1).role, 'writer-mapping-prepare');
    assert.equal(rows.at(-1).phase, phase);
    assert.equal(rows.at(-1).state, state);
    assert.equal(rows.filter(row => row.phase === phase && row.state === state).length, 1);
  }
});

test('concurrent owner and callback failure after final confirmation do not release', async t => {
  const concurrent = await fixture(t);
  await withSearchAdminJobLock({ root: concurrent.root, uid }, async lock => {
    const operation = lock.beginWriterMappingPrepare();
    await assert.rejects(withSearchAdminJobLock({ root: concurrent.root, uid },
      async second => second.beginWriterMappingPrepare()), /job locked/);
    await complete(operation);
  });
  assert.equal(await exists(concurrent.name), false);
  const failed = await fixture(t);
  await assert.rejects(withSearchAdminJobLock({ root: failed.root, uid }, async lock => {
    await complete(lock.beginWriterMappingPrepare());
    throw Error('callback failed after prepared append');
  }), /writer mapping prepare lock release/);
  assert.equal(await exists(failed.name), true);
  assert.equal((await records(failed.name)).at(-1).state, 'prepared');
});

test('append and fsync faults latch terminal attempts without a second record', async t => {
  for (const fault of ['after-append', 'after-file-sync',
    'mapping-prepare-final-after-append', 'mapping-prepare-final-after-file-sync']) {
    const item = await fixture(t);
    await assert.rejects(faulted(item, fault, async lock => {
      const operation = lock.beginWriterMappingPrepare();
      if (fault.startsWith('mapping-')) {
        await operation.markDispatched('transfer');
        await operation.confirmCompletion('transfer');
        await operation.markDispatched('prepare');
        await operation.confirmCompletion('prepare');
        await operation.confirmOwnedCleanup();
        await operation.markPendingAttempted();
        await assert.rejects(operation.confirmPrepared(), /job record fault/);
        await assert.rejects(operation.confirmPrepared(), /writer mapping prepare success/);
      } else {
        await assert.rejects(operation.markDispatched('transfer'), /job record fault/);
        await assert.rejects(operation.markDispatched('transfer'), /writer mapping prepare dispatch/);
      }
    }));
    assert.equal(await exists(item.name), true, fault);
    const rows = await records(item.name);
    const last = rows.at(-1);
    assert.equal(last.role, 'writer-mapping-prepare');
    assert.equal(last.phase, fault.startsWith('mapping-') ? 'pending' : 'transfer');
    assert.equal(last.state, fault.startsWith('mapping-') ? 'prepared' : 'dispatched');
    assert.equal(rows.filter(row => row.phase === last.phase && row.state === last.state).length, 1);
  }
});

test('release faults report uncertainty and never claim a physically retained lock', async t => {
  for (const fault of ['before-release-rm', 'mapping-prepare-release-after-rm',
    'mapping-prepare-release-after-sync']) {
    const item = await fixture(t);
    await assert.rejects(faulted(item, fault, async lock => complete(
      lock.beginWriterMappingPrepare())), /writer mapping prepare lock release/);
    assert.equal(await exists(item.name), fault === 'before-release-rm', fault);
  }
});

test('original lock and root replacement cannot release a foreign path', async t => {
  const file = await fixture(t);
  await assert.rejects(withSearchAdminJobLock({ root: file.root, uid }, async lock => {
    await complete(lock.beginWriterMappingPrepare());
    const bytes = await readFile(file.name);
    await rename(file.name, `${file.name}.original`);
    await writeFile(file.name, bytes, { mode: 0o600 });
  }), /writer mapping prepare lock release/);
  assert.equal(await exists(file.name), true);
  assert.equal(await exists(`${file.name}.original`), true);

  const root = await fixture(t);
  await assert.rejects(withSearchAdminJobLock({ root: root.root, uid }, async lock => {
    await complete(lock.beginWriterMappingPrepare());
    await rename(root.root, `${root.root}.original`);
    await mkdir(root.root, { mode: 0o700 });
    await writeFile(path.join(root.root, 'foreign'), 'untouched', { mode: 0o600 });
  }), /writer mapping prepare lock release/);
  assert.equal(await readFile(path.join(root.root, 'foreign'), 'utf8'), 'untouched');
  assert.equal(await exists(path.join(`${root.root}.original`, '.job-operation.lock')), true);

  const symlinked = await fixture(t);
  await assert.rejects(withSearchAdminJobLock({ root: symlinked.root, uid }, async lock => {
    await complete(lock.beginWriterMappingPrepare());
    await rename(symlinked.name, `${symlinked.name}.original`);
    await symlink(`${symlinked.name}.original`, symlinked.name);
  }), /writer mapping prepare lock release/);
  assert.equal((await lstat(symlinked.name)).isSymbolicLink(), true);
  const mode = await fixture(t);
  await assert.rejects(withSearchAdminJobLock({ root: mode.root, uid }, async lock => {
    await complete(lock.beginWriterMappingPrepare());
    await chmod(mode.name, 0o644);
  }), /writer mapping prepare lock release/);
  assert.equal((await lstat(mode.name)).mode & 0o777, 0o644);
});
