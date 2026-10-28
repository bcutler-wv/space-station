import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';

const uid = process.getuid();
async function fixture(work) {
  await mkdir(path.join(process.cwd(), '.cache/results'), { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(path.join(process.cwd(), '.cache/results/create-boundary-lock-'));
  const root = path.join(parent, '.cache/search-db');
  await mkdir(root, { recursive: true, mode: 0o700 });
  try { await work(root, path.join(root, '.job-operation.lock')); }
  finally { await rm(parent, { recursive: true, force: true }); }
}

test('fixed transfer then inspect uses one lock UUID and releases only after owned cleanup', async () => fixture(async (root, file) => {
  let id;
  await withSearchAdminJobLock({ root, uid }, async lock => {
    const boundary = lock.beginCreateBoundary();
    id = boundary.invocationId;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.throws(() => lock.beginAttestor(), /attestor mode/);
    await assert.rejects(lock.markDispatched('transition'), /job dispatch/);
    await assert.rejects(boundary.markDispatched('inspect'), /create boundary dispatch/);
    await boundary.markDispatched('transfer');
    assert.match(await readFile(file, 'utf8'), new RegExp(`"operationId":"${id}"`));
    await assert.rejects(boundary.markDispatched('transfer'), /create boundary dispatch/);
    await boundary.confirmCompletion('transfer');
    await boundary.markDispatched('inspect');
    await boundary.confirmCompletion('inspect');
    await boundary.confirmOwnedCleanup();
  });
  assert.equal(existsSync(file), false);
}));

test('unknown transfer, failed durable record and incomplete final retain the lock', async () => fixture(async (root, file) => {
  await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
    await lock.beginCreateBoundary().markDispatched('transfer');
    throw new Error('unknown remote outcome');
  }), /unknown remote outcome/);
  assert.equal(existsSync(file), true);
  await rm(file);
  for (const fault of ['after-append', 'after-file-sync']) {
    process.env.STATION_JOB_LOCK_FIXTURE = '1';
    try {
      await assert.rejects(withSearchAdminJobLock({ root, uid, fixtureFaultAt: fault },
        lock => lock.beginCreateBoundary().markDispatched('transfer')),
      /job record fault/);
      assert.equal(existsSync(file), true);
      await rm(file);
    } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
  }
  await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
    const boundary = lock.beginCreateBoundary();
    await boundary.markDispatched('transfer');
    await boundary.confirmCompletion('transfer');
    await boundary.markDispatched('inspect');
    await boundary.confirmCompletion('inspect');
  }), /create boundary incomplete/);
  assert.equal(existsSync(file), true);
}));

test('intent prepare uses distinct finite lock mode and pending attempt retains uncertain file', async () => fixture(async (root, file) => {
  await assert.rejects(withSearchAdminJobLock({ root, uid }, async lock => {
    const prepare = lock.beginCreateIntentPrepare();
    assert.match(prepare.invocationId, /^[0-9a-f-]{36}$/);
    assert.throws(() => lock.beginCreateBoundary(), /create boundary mode/);
    await assert.rejects(prepare.markPendingAttempted(), /create intent pending/);
    await prepare.markDispatched('transfer');
    await prepare.confirmCompletion('transfer');
    await prepare.markDispatched('prepare');
    await prepare.confirmCompletion('prepare');
    await prepare.markPendingAttempted();
    throw new Error('partial pending write');
  }), /partial pending write/);
  assert.equal(existsSync(file), true);
  await rm(file);
  await withSearchAdminJobLock({ root, uid }, async lock => {
    const prepare = lock.beginCreateIntentPrepare();
    await prepare.markDispatched('transfer');
    await prepare.confirmCompletion('transfer');
    await prepare.markDispatched('prepare');
    await prepare.confirmCompletion('prepare');
    await prepare.markPendingAttempted();
    await prepare.confirmOwnedCleanup();
  });
  assert.equal(existsSync(file), false);
}));

test('caught pending append/fsync fault cannot confirm cleanup or release lock', async () => fixture(async (root, file) => {
  for (const fault of ['intent-pending-after-append', 'intent-pending-after-file-sync']) {
    process.env.STATION_JOB_LOCK_FIXTURE = '1';
    try {
      await assert.rejects(withSearchAdminJobLock({ root, uid, fixtureFaultAt: fault }, async lock => {
        const prepare = lock.beginCreateIntentPrepare();
        await prepare.markDispatched('transfer');
        await prepare.confirmCompletion('transfer');
        await prepare.markDispatched('prepare');
        await prepare.confirmCompletion('prepare');
        await assert.rejects(prepare.markPendingAttempted(), /job record fault/);
        await assert.rejects(prepare.confirmOwnedCleanup(), /create intent cleanup/);
      }), /create intent incomplete/);
      assert.equal(existsSync(file), true);
      await rm(file);
    } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
  }
}));
