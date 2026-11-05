import assert from 'node:assert/strict';
import fs, { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';

const known = Object.freeze({ approvedSha256: 'a'.repeat(64),
  dispatchId: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222' });
const exists = name => lstat(name).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
async function setup(t) {
  await mkdir('.cache/results', { recursive: true });
  const parent = await mkdtemp(path.resolve('.cache/results/mapping-apply-lock-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, '.cache/search-db');
  await mkdir(root, { recursive: true, mode: 0o700 });
  return { root, lock: path.join(root, '.job-operation.lock') };
}
async function completed(operation) {
  await operation.markBindingAttempted();
  for (const phase of ['transfer', 'apply']) {
    await operation.markDispatched(phase);
    await operation.confirmCompletion(phase);
  }
  await operation.confirmOwnedCleanup();
  await operation.assertOwned();
}

test('normal same-call completion releases; offline binding-only completion retains', async t => {
  const first = await setup(t);
  await withSearchAdminJobLock({ root: first.root, uid: process.getuid() },
    async token => completed(token.beginWriterMappingApply({ ...known })));
  assert.equal(await exists(first.lock), false);
  const second = await setup(t);
  await withSearchAdminJobLock({ root: second.root, uid: process.getuid() },
    async token => token.beginWriterMappingApply({ ...known }).markBindingAttempted());
  assert.equal(await exists(second.lock), true);
});

test('cleanup-confirmed followed by callback throw still retains lock', async t => {
  const x = await setup(t);
  await assert.rejects(() => withSearchAdminJobLock({ root: x.root,
    uid: process.getuid() }, async token => {
    await completed(token.beginWriterMappingApply({ ...known }));
    throw Error('private late failure');
  }));
  assert.equal(await exists(x.lock), true);
});

test('preflight retention is one way, before binding only', async t => {
  const x = await setup(t);
  await withSearchAdminJobLock({ root: x.root, uid: process.getuid() },
    async token => {
      const operation = token.beginWriterMappingApply({ ...known });
      await operation.retainPreflightFailure();
      await assert.rejects(operation.markBindingAttempted());
      await assert.rejects(operation.retainPreflightFailure());
    }).catch(() => {});
  assert.equal(await exists(x.lock), true);
});

for (const [label, step, successor] of [
  ['transfer-dispatched', 'mark-transfer', 'confirm-transfer'],
  ['transfer-confirmed', 'confirm-transfer', 'mark-apply'],
  ['apply-dispatched', 'mark-apply', 'confirm-apply'],
  ['apply-confirmed', 'confirm-apply', 'confirm-cleanup'],
  ['cleanup-complete', 'confirm-cleanup', 'confirm-cleanup'],
]) for (const suffix of ['after-append', 'after-file-sync']) {
  test(`mapping ${label} ${suffix} retains and denies next phase`, async t => {
    const x = await setup(t);
    let reached = false;
    process.env.STATION_JOB_LOCK_FIXTURE = '1';
    try {
      await assert.rejects(() => withSearchAdminJobLock({ root: x.root,
        uid: process.getuid(), fixtureFaultAt: `mapping-apply-${label}-${suffix}` },
      async token => {
        const operation = token.beginWriterMappingApply({ ...known });
        await operation.markBindingAttempted();
        const methods = {
          'mark-transfer': () => operation.markDispatched('transfer'),
          'confirm-transfer': () => operation.confirmCompletion('transfer'),
          'mark-apply': () => operation.markDispatched('apply'),
          'confirm-apply': () => operation.confirmCompletion('apply'),
          'confirm-cleanup': () => operation.confirmOwnedCleanup(),
        };
        const order = ['mark-transfer', 'confirm-transfer', 'mark-apply',
          'confirm-apply', 'confirm-cleanup'];
        for (const key of order) {
          if (key === step) {
            reached = true;
            await assert.rejects(methods[key]());
            await assert.rejects(methods[successor]());
            break;
          }
          await methods[key]();
        }
      }));
    } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
    assert.equal(reached, true);
    assert.equal(await exists(x.lock), true);
  });
}

test('post-rm release failure reports uncertainty with lock absent', async t => {
  const x = await setup(t);
  process.env.STATION_JOB_LOCK_FIXTURE = '1';
  try {
    await assert.rejects(() => withSearchAdminJobLock({ root: x.root,
      uid: process.getuid(), fixtureFaultAt: 'mapping-apply-release-after-rm' },
    async token => completed(token.beginWriterMappingApply({ ...known }))));
  } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
  assert.equal(await exists(x.lock), false);
});

test('same-call success rejects a foreign replacement at final release check', async t => {
  const x = await setup(t);
  const original = fs.lstat;
  let afterCallback = false, checks = 0, reached = false;
  fs.lstat = async (...args) => {
    if (afterCallback && args[0] === x.root && ++checks === 2) {
      await fs.rename(x.lock, `${x.lock}.original`);
      await fs.writeFile(x.lock, 'foreign', { mode: 0o600, flag: 'wx' });
      reached = true;
    }
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => withSearchAdminJobLock({ root: x.root,
      uid: process.getuid() }, async token => {
      await completed(token.beginWriterMappingApply({ ...known }));
      afterCallback = true;
      return 'completed';
    }), { message: 'Search admin writer mapping lock release.' });
  } finally { fs.lstat = original; syncBuiltinESMExports(); }
  assert.equal(reached, true);
  assert.equal(await fs.readFile(x.lock, 'utf8'), 'foreign');
});
