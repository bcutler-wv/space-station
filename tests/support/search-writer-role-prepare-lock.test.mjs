import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';

async function fixture(t) {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.join(process.cwd(), '.cache/results/writer-prepare-lock-'));
  const root = path.join(repository, '.cache/search-db');
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(() => rm(repository, { recursive: true, force: true }));
  return { root, name: path.join(root, '.job-operation.lock') };
}
const exists = name => lstat(name).then(() => true, () => false);

async function complete(operation) {
  await operation.markDispatched('transfer');
  await operation.confirmCompletion('transfer');
  await operation.markDispatched('prepare');
  await operation.confirmCompletion('prepare');
  await operation.confirmOwnedCleanup();
  await operation.markPendingAttempted();
  await operation.confirmPrepared();
}

test('fixed writer preparation releases only after transfer, read, cleanup and pending confirmation', async t => {
  const item = await fixture(t);
  await withSearchAdminJobLock({ root: item.root, uid: process.getuid() }, async lock => {
    const operation = lock.beginWriterRolePrepare();
    await assert.rejects(operation.confirmPrepared());
    await assert.rejects(operation.markDispatched('prepare'));
    await complete(operation);
    await assert.rejects(operation.confirmPrepared());
  });
  assert.equal(await exists(item.name), false);
});

test('uncertain transfer, read, pending and final append each retain the original lock', async t => {
  for (const phase of ['transfer', 'prepare', 'pending']) {
    const item = await fixture(t);
    await assert.rejects(withSearchAdminJobLock({ root: item.root, uid: process.getuid() },
      async lock => {
        const operation = lock.beginWriterRolePrepare();
        await operation.markDispatched('transfer');
        if (phase === 'transfer') throw Error('lost transfer');
        await operation.confirmCompletion('transfer');
        await operation.markDispatched('prepare');
        if (phase === 'prepare') throw Error('lost prepare');
        await operation.confirmCompletion('prepare');
        await operation.confirmOwnedCleanup();
        await operation.markPendingAttempted();
        throw Error('uncertain pending');
      }));
    assert.equal(await exists(item.name), true, phase);
    await assert.rejects(withSearchAdminJobLock({ root: item.root, uid: process.getuid() },
      async lock => lock.beginWriterRolePrepare()));
  }
  for (const fault of ['writer-prepare-final-after-append',
    'writer-prepare-final-after-file-sync']) {
    const item = await fixture(t);
    process.env.STATION_JOB_LOCK_FIXTURE = '1';
    try {
      await assert.rejects(withSearchAdminJobLock({ root: item.root,
        uid: process.getuid(), fixtureFaultAt: fault }, async lock => {
        const operation = lock.beginWriterRolePrepare();
        await operation.markDispatched('transfer');
        await operation.confirmCompletion('transfer');
        await operation.markDispatched('prepare');
        await operation.confirmCompletion('prepare');
        await operation.confirmOwnedCleanup();
        await operation.markPendingAttempted();
        await assert.rejects(operation.confirmPrepared(), /job record fault/);
        await assert.rejects(operation.confirmPrepared(), /writer role prepare success/);
      }));
    } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
    assert.equal(await exists(item.name), true, fault);
    const records = (await readFile(item.name, 'utf8')).trim().split(/\n+/).map(JSON.parse);
    assert.equal(records.at(-1).role, 'writer-role-prepare');
    assert.equal(records.at(-1).phase, 'pending');
    assert.equal(records.at(-1).state, 'prepared');
  }
  const release = await fixture(t);
  process.env.STATION_JOB_LOCK_FIXTURE = '1';
  try {
    await assert.rejects(withSearchAdminJobLock({ root: release.root,
      uid: process.getuid(), fixtureFaultAt: 'before-release-rm' },
    async lock => complete(lock.beginWriterRolePrepare())), /writer role prepare lock release/);
  } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
  assert.equal(await exists(release.name), true);
});
