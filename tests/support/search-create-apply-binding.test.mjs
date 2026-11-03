import assert from 'node:assert/strict';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink,
  writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildAttestorPublicFiles } from '../../scripts/search-attestor-pure.mjs';
import { sealCreateIntent } from '../../scripts/search-create-intent-pure.mjs';
import { prepareCreateIntentPending,
  writeCreateIntentPending } from '../../scripts/search-create-intent-pending.mjs';
import { parseCreateApplyApprovalArgs,
  readCreateApplyPending } from '../../scripts/search-create-apply-pending.mjs';
import { writeCreateApplyBinding } from '../../scripts/search-create-apply-binding.mjs';
import { bindCreateApplyOffline } from '../../scripts/search-create-apply-offline.mjs';
import { runCreateApplyOwner } from '../../scripts/search-create-apply-owner-core.mjs';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';

const uid = process.getuid(), gid = process.getgid();
const transitionToken = '22222222-2222-4222-8222-222222222222';
const candidateToken = '11111111-1111-4111-8111-111111111111';
const dispatchId = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const candidateIndex = 'station-mail-v2-g11111111111141118111111111111111';
const candidate = { generationToken: candidateToken, physicalIndex: candidateIndex,
  profileId: 'station-mail-v2', indexUuid: null, lifecycle: 'reserved',
  writerRole: `station_indexer_${candidateToken.replaceAll('-', '')}`,
  queryRole: `station_query_${candidateToken.replaceAll('-', '')}`,
  writerPrincipal: `station-search-indexer-${candidateToken.replaceAll('-', '')}`,
  queryPrincipal: `station-search-query-${candidateToken.replaceAll('-', '')}`,
  writerCertFingerprint: null, queryCertFingerprint: null };
const files = buildAttestorPublicFiles({ generations: [{ token: 'legacy-v1', presence: 'exact' }] });
const digests = files.map(row => ({ path: row.path, sha256: 'a'.repeat(64) }));
const projection = { version: 1, revision: 3, stage: 'disabled_intent',
  transitionToken, sourceToken: 'legacy-v1', sourceIndex: 'station-mail-v1',
  sourceUuid: 'legacy_uuid', candidateToken, candidateIndex, databaseOid: 16384,
  priorObservationDigest: 'd'.repeat(64), publicFiles: files,
  ...searchGenerationDispatchSpec(candidate, 'create_index') };

async function fixture(t) {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.join(process.cwd(), '.cache/results/apply-binding-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await mkdir(path.join(repository, '.cache'), { mode: 0o755 });
  await mkdir(path.join(repository, '.cache/search-db'), { mode: 0o700 });
  const seal = sealCreateIntent(projection, digests,
    { project: path.basename(repository), systemIdentifier: '123', dispatchId, ownerId });
  const prepared = await prepareCreateIntentPending(repository, uid, gid);
  await writeCreateIntentPending(prepared, seal.intent, seal.sha256, uid, gid);
  const args = [seal.sha256, String(projection.revision), transitionToken,
    projection.sourceToken, projection.sourceIndex, projection.sourceUuid,
    candidateToken, candidateIndex];
  return { repository, args, seal, pending: prepared.name,
    binding: path.join(repository, '.cache/search-create-apply/binding.json'),
    lock: path.join(repository, '.cache/search-db/.job-operation.lock') };
}

test('typed approval reconstructs exact pending seal and binding remains consumed', async t => {
  const item = await fixture(t);
  const approved = parseCreateApplyApprovalArgs(item.args);
  const pending = await readCreateApplyPending(item.repository, uid, gid, approved);
  assert.equal(await pending.recheck(), true);
  assert.deepEqual(pending.intent(), item.seal.intent);
  const result = await bindCreateApplyOffline({ repository: item.repository, uid, gid, args: item.args });
  assert.equal(result.state, 'bound-offline');
  assert.notEqual(result.invocationId, dispatchId);
  assert.notEqual(result.invocationId, ownerId);
  const binding = JSON.parse(await readFile(item.binding, 'utf8'));
  assert.deepEqual(binding, { approvedSha256: item.seal.sha256, dispatchId, ownerId,
    invocationId: result.invocationId, version: 1 });
  assert.equal((await lstat(item.binding)).mode & 0o777, 0o400);
  assert.equal((await lstat(item.lock)).mode & 0o777, 0o600);
  const records = (await readFile(item.lock, 'utf8')).trim().split(/\n+/).map(JSON.parse);
  assert.equal(records.at(-1).role, 'create-apply');
  assert.equal(records.at(-1).phase, 'binding');
  assert.equal(records.at(-1).state, 'attempted');
  await assert.rejects(bindCreateApplyOffline({ repository: item.repository, uid, gid, args: item.args }));
  await rm(item.lock); // Simulate an externally lost lock in this disposable fixture only.
  const bytes = await readFile(item.binding), inode = (await lstat(item.binding)).ino;
  await assert.rejects(bindCreateApplyOffline({ repository: item.repository, uid, gid, args: item.args }));
  assert.equal((await lstat(item.lock)).isFile(), true);
  assert.equal((await lstat(item.binding)).ino, inode);
  assert.deepEqual(await readFile(item.binding), bytes);
});

test('changed typed fields, digest and malformed or same-size pending fail before binding', async t => {
  assert.throws(() => parseCreateApplyApprovalArgs(['0'.repeat(64), 3, transitionToken,
    'legacy-v1', 'station-mail-v1', 'legacy_uuid', candidateToken, candidateIndex]));
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const item = await fixture(t);
    const args = [...item.args];
    args[index] = index === 0 ? '0'.repeat(64) : index === 1 ? '4' :
      index === 3 ? candidateToken : index === 4 ? candidateIndex :
        index === 5 ? 'wrong_uuid' : index === 7 ? `${candidateIndex}x` : dispatchId;
    await assert.rejects(bindCreateApplyOffline({ repository: item.repository, uid, gid, args }));
    assert.equal(await lstat(item.binding).then(() => true, () => false), false);
  }
  const malformed = await fixture(t);
  await chmod(malformed.pending, 0o600);
  await writeFile(malformed.pending, '{malformed', { mode: 0o600 });
  await chmod(malformed.pending, 0o400);
  await assert.rejects(bindCreateApplyOffline({ repository: malformed.repository,
    uid, gid, args: malformed.args }));
  const changed = await fixture(t);
  const original = (await readFile(changed.pending)).toString('utf8');
  const changedBytes = original.replace('"systemIdentifier":"123"', '"systemIdentifier":"124"');
  assert.equal(changedBytes.length, original.length);
  assert.notEqual(changedBytes, original);
  await chmod(changed.pending, 0o600);
  await writeFile(changed.pending, changedBytes);
  await chmod(changed.pending, 0o400);
  await assert.rejects(bindCreateApplyOffline({ repository: changed.repository,
    uid, gid, args: changed.args }));
  const wrongMode = await fixture(t);
  await chmod(wrongMode.pending, 0o600);
  await assert.rejects(bindCreateApplyOffline({ repository: wrongMode.repository,
    uid, gid, args: wrongMode.args }));
  const linked = await fixture(t);
  const moved = path.join(linked.repository, '.cache/pending-original');
  await rename(linked.pending, moved);
  await symlink(moved, linked.pending);
  await assert.rejects(bindCreateApplyOffline({ repository: linked.repository,
    uid, gid, args: linked.args }));
});

test('preexisting partial binding and forged operation are denied', async t => {
  const item = await fixture(t);
  const root = path.dirname(item.binding);
  await mkdir(root, { mode: 0o700 });
  await writeFile(item.binding, '{partial', { mode: 0o400 });
  const prior = await readFile(item.binding), stat = await lstat(item.binding);
  await assert.rejects(bindCreateApplyOffline({ repository: item.repository,
    uid, gid, args: item.args }));
  assert.equal((await lstat(item.lock)).isFile(), true);
  assert.equal((await lstat(item.binding)).ino, stat.ino);
  assert.deepEqual(await readFile(item.binding), prior);
  const forged = { invocationId: dispatchId, assertBindingAttempted: () => true };
  await assert.rejects(writeCreateApplyBinding(item.repository, uid, gid, forged,
    { approvedSha256: item.seal.sha256, dispatchId, ownerId }));
});

test('live apply operation cannot write a different checkout binding', async t => {
  const first = await fixture(t), second = await fixture(t);
  await withSearchAdminJobLock({ root: path.join(first.repository, '.cache/search-db'), uid },
    async token => {
      const operation = token.beginCreateApply({ approvedSha256: first.seal.sha256,
        dispatchId, ownerId });
      await operation.markBindingAttempted();
      await assert.rejects(writeCreateApplyBinding(second.repository, uid, gid, operation,
        { approvedSha256: first.seal.sha256, dispatchId, ownerId }));
      assert.equal(await lstat(second.binding).then(() => true, () => false), false);
    });
  assert.equal((await lstat(first.lock)).isFile(), true);
});

test('lost or replaced original lock before binding and completion denies success', async t => {
  const beforeWrite = await fixture(t);
  let reachedWrite = false;
  const movedBefore = path.join(beforeWrite.repository, '.cache/original-lock');
  await assert.rejects(bindCreateApplyOffline({ repository: beforeWrite.repository, uid, gid,
    args: beforeWrite.args, writeBinding: async (...args) => {
      await rename(beforeWrite.lock, movedBefore);
      reachedWrite = true;
      return writeCreateApplyBinding(...args);
    } }));
  assert.equal(reachedWrite, true);
  assert.equal((await lstat(movedBefore)).isFile(), true);
  assert.equal(await lstat(beforeWrite.binding).then(() => true, () => false), false);

  const afterWrite = await fixture(t);
  let reachedCompletion = false;
  const movedAfter = path.join(afterWrite.repository, '.cache/original-lock');
  await assert.rejects(bindCreateApplyOffline({ repository: afterWrite.repository, uid, gid,
    args: afterWrite.args, writeBinding: async (...args) => {
      const binding = await writeCreateApplyBinding(...args);
      await rename(afterWrite.lock, movedAfter);
      await writeFile(afterWrite.lock, 'replacement', { mode: 0o600 });
      reachedCompletion = true;
      return binding;
    } }));
  assert.equal(reachedCompletion, true);
  assert.equal((await lstat(movedAfter)).isFile(), true);
  assert.equal((await lstat(afterWrite.binding)).isFile(), true);
  assert.deepEqual(await readFile(afterWrite.lock, 'utf8'), 'replacement');

  const direct = await fixture(t);
  const movedDirect = path.join(direct.repository, '.cache/original-lock');
  await assert.rejects(withSearchAdminJobLock({ root: path.join(direct.repository,
    '.cache/search-db'), uid }, async token => {
    const operation = token.beginCreateApply({ approvedSha256: direct.seal.sha256,
      dispatchId, ownerId });
    await operation.markBindingAttempted();
    await rename(direct.lock, movedDirect);
    return 'cannot confirm unowned lock';
  }));
  assert.equal((await lstat(movedDirect)).isFile(), true);
});

function ownerRig(item, fault = null, hooks = {}) {
  const calls = [];
  const adapterFactory = async () => ({
    verifyOwner: async () => { calls.push('verify-owner'); },
    captureOwner: async () => ({ project: path.basename(item.repository),
      databaseOid: '16384', systemIdentifier: '123' }),
    recheckOwner: async () => {
      calls.push('owner');
      if (fault === 'owner-replaced' && calls.includes('transfer')) throw Error('owner drift');
    },
    recheckInfrastructure: async () => {
      calls.push('infrastructure');
      if (fault === 'network-replaced' && calls.includes('transfer')) throw Error('network drift');
    },
    preflight: async input => {
      calls.push('preflight');
      assert.match(input.publicRoot, /\.cache\/search-create-apply-public\//);
      assert.match(input.volumeName, /_search_create_apply_/);
    },
    volumeAbsent: async () => { calls.push('absent'); },
    createVolume: async name => { calls.push('volume'); return { name }; },
    checkVolume: async () => {
      calls.push('volume-check');
      if (fault === 'volume-replaced' && calls.includes('transfer')) throw Error('volume drift');
    },
    runPhase: async phase => {
      calls.push(phase);
      await hooks.runPhase?.(phase, item);
      if (fault === `lost-${phase}`) throw Error('response lost');
      return { phase, id: phase };
    },
    cleanupRemote: async phases => {
      calls.push('cleanup');
      assert.deepEqual(phases.map(row => row.phase), ['transfer', 'create']);
      if (fault === 'cleanup') throw Error('cleanup uncertain');
    },
  });
  const publicStage = async () => ({ root: path.join(item.repository,
    '.cache/search-create-apply-public', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  recheck: async () => { calls.push('public');
    if (fault === 'public-replaced' && calls.includes('transfer')) throw Error('public drift');
    return true; },
  recheckSource: async () => true,
  cleanup: async () => {
    calls.push('public-cleanup');
    if (fault === 'public-cleanup') throw Error('local cleanup uncertain');
    return true;
  } });
  return { adapterFactory, publicStage, calls };
}

test('fixed owner releases B only after original two-phase success and keeps binding consumed', async t => {
  const item = await fixture(t), rig = ownerRig(item);
  const result = await runCreateApplyOwner({ repository: item.repository, uid, gid,
    args: item.args, ...rig });
  assert.deepEqual(result, { state: 'uuid_bound', ready: false });
  assert.deepEqual(rig.calls.filter(x => ['transfer', 'create', 'cleanup', 'public-cleanup'].includes(x)),
    ['transfer', 'create', 'cleanup', 'public-cleanup']);
  await assert.rejects(lstat(item.lock));
  assert.equal((await lstat(item.binding)).mode & 0o777, 0o400);
  assert.equal((await lstat(item.pending)).mode & 0o777, 0o400);
  await assert.rejects(runCreateApplyOwner({ repository: item.repository, uid, gid,
    args: item.args, ...ownerRig(item) }));
  assert.equal((await lstat(item.lock)).isFile(), true);
});

test('lost command response, owner/network/volume/public drift and cleanup ambiguity retain B', async t => {
  const cases = [
    ['lost-transfer', 1, 0, 'transfer', 'dispatched'],
    ['lost-create', 1, 1, 'create', 'dispatched'],
    ['owner-replaced', 1, 0, 'transfer', 'dispatched'],
    ['network-replaced', 1, 0, 'transfer', 'dispatched'],
    ['volume-replaced', 1, 0, 'transfer', 'dispatched'],
    ['public-replaced', 1, 0, 'transfer', 'dispatched'],
    ['cleanup', 1, 1, 'create', 'confirmed'],
    ['public-cleanup', 1, 1, 'create', 'confirmed'],
  ];
  for (const [fault, transferCount, createCount, phase, state] of cases) {
    const item = await fixture(t), rig = ownerRig(item, fault);
    await assert.rejects(runCreateApplyOwner({ repository: item.repository, uid, gid,
      args: item.args, ...rig }), fault);
    assert.equal((await lstat(item.lock)).isFile(), true, fault);
    assert.equal((await lstat(item.binding)).isFile(), true, fault);
    assert.equal(rig.calls.filter(x => x === 'transfer').length, transferCount, fault);
    assert.equal(rig.calls.filter(x => x === 'create').length, createCount, fault);
    const records = (await readFile(item.lock, 'utf8')).trim().split(/\n+/).map(JSON.parse);
    assert.deepEqual([records.at(-1).phase, records.at(-1).state], [phase, state], fault);
    assert.equal(records.some(row => row.state === 'cleanup-complete'), false, fault);
  }
});

test('original pending replacement and original lock replacement deny create completion', async t => {
  const pending = await fixture(t);
  const pendingRig = ownerRig(pending, null, { runPhase: async phase => {
    if (phase === 'transfer') {
      const bytes = await readFile(pending.pending);
      await writeFile(`${pending.pending}.replacement`, bytes, { mode: 0o400 });
      await rename(`${pending.pending}.replacement`, pending.pending);
    }
  } });
  await assert.rejects(runCreateApplyOwner({ repository: pending.repository, uid, gid,
    args: pending.args, ...pendingRig }));
  assert.equal(pendingRig.calls.includes('create'), false);
  assert.equal((await lstat(pending.lock)).isFile(), true);

  const lock = await fixture(t);
  const lockRig = ownerRig(lock, null, { runPhase: async phase => {
    if (phase === 'create') {
      await rename(lock.lock, path.join(lock.repository, '.cache/old-job-lock'));
      await writeFile(lock.lock, 'replacement', { mode: 0o600 });
    }
  } });
  await assert.rejects(runCreateApplyOwner({ repository: lock.repository, uid, gid,
    args: lock.args, ...lockRig }));
  assert.equal(lockRig.calls.filter(x => x === 'create').length, 1);
  assert.equal((await lstat(lock.lock)).isFile(), true);
});

test('concurrent owner has one winner and replay is denied after original success', async t => {
  const item = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const transferStarted = new Promise(resolve => { entered = resolve; });
  const firstRig = ownerRig(item, null, { runPhase: async phase => {
    if (phase === 'transfer') { entered(); await gate; }
  } });
  const first = runCreateApplyOwner({ repository: item.repository, uid, gid,
    args: item.args, ...firstRig });
  await transferStarted;
  await assert.rejects(runCreateApplyOwner({ repository: item.repository, uid, gid,
    args: item.args, ...ownerRig(item) }));
  release();
  assert.equal((await first).state, 'uuid_bound');
  assert.equal(firstRig.calls.filter(x => x === 'create').length, 1);
  await assert.rejects(runCreateApplyOwner({ repository: item.repository, uid, gid,
    args: item.args, ...ownerRig(item) }));
});

test('in-apply pending inode replacement retains binding and lock', async t => {
  const item = await fixture(t);
  let replaced = false;
  await assert.rejects(bindCreateApplyOffline({ repository: item.repository, uid, gid,
    args: item.args, writeBinding: async (...args) => {
      const binding = await writeCreateApplyBinding(...args);
      const moved = path.join(item.repository, '.cache/pending-original');
      const before = await lstat(item.pending), bytes = await readFile(item.pending);
      await rename(item.pending, moved);
      await copyFile(moved, item.pending);
      assert.notEqual((await lstat(item.pending)).ino, before.ino);
      assert.deepEqual(await readFile(item.pending), bytes);
      replaced = true;
      return binding;
    } }));
  assert.equal(replaced, true);
  assert.equal((await lstat(item.lock)).isFile(), true);
  assert.equal((await lstat(item.binding)).isFile(), true);
});

test('same-inode same-size pending mutation after binding is not adopted', async t => {
  const item = await fixture(t);
  let changed = false;
  await assert.rejects(bindCreateApplyOffline({ repository: item.repository, uid, gid,
    args: item.args, writeBinding: async (...args) => {
      const binding = await writeCreateApplyBinding(...args);
      const before = await lstat(item.pending);
      const original = (await readFile(item.pending)).toString('utf8');
      const altered = original.replace('"systemIdentifier":"123"', '"systemIdentifier":"124"');
      assert.equal(altered.length, original.length);
      await chmod(item.pending, 0o600);
      await writeFile(item.pending, altered);
      await chmod(item.pending, 0o400);
      const after = await lstat(item.pending);
      assert.equal(after.ino, before.ino);
      assert.equal(after.size, before.size);
      changed = true;
      return binding;
    } }));
  assert.equal(changed, true);
  assert.equal((await lstat(item.lock)).isFile(), true);
  assert.equal((await lstat(item.binding)).isFile(), true);
});

test('failed lock append/fsync and partial binding retain the exclusive lock', async t => {
  for (const fault of ['apply-binding-after-append', 'apply-binding-after-file-sync']) {
    const item = await fixture(t);
    process.env.STATION_JOB_LOCK_FIXTURE = '1';
    try {
      await assert.rejects(bindCreateApplyOffline({ repository: item.repository, uid, gid,
        args: item.args, lock: (options, work) => withSearchAdminJobLock({
          ...options, fixtureFaultAt: fault }, work) }));
    } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
    assert.equal((await lstat(item.lock)).isFile(), true);
    assert.equal(await lstat(item.binding).then(() => true, () => false), false);
  }
  const item = await fixture(t);
  process.env.STATION_CREATE_APPLY_FIXTURE = '1';
  try {
    await assert.rejects(bindCreateApplyOffline({ repository: item.repository, uid, gid,
      args: item.args, writeBinding: (...args) => writeCreateApplyBinding(...args, {
        afterFileClose: async () => { throw Error('fixture partial write'); },
      }) }));
  } finally { delete process.env.STATION_CREATE_APPLY_FIXTURE; }
  assert.equal((await lstat(item.lock)).isFile(), true);
  assert.equal((await lstat(item.binding)).isFile(), true);

  const replaced = await fixture(t);
  let changedInode = false;
  process.env.STATION_CREATE_APPLY_FIXTURE = '1';
  try {
    await assert.rejects(bindCreateApplyOffline({ repository: replaced.repository, uid, gid,
      args: replaced.args, writeBinding: (...args) => writeCreateApplyBinding(...args, {
        afterFileClose: async name => {
          const before = await lstat(name), bytes = await readFile(name);
          const moved = path.join(replaced.repository, '.cache/original-binding');
          await rename(name, moved); await copyFile(moved, name);
          assert.notEqual((await lstat(name)).ino, before.ino);
          assert.deepEqual(await readFile(name), bytes);
          changedInode = true;
        },
      }) }));
  } finally { delete process.env.STATION_CREATE_APPLY_FIXTURE; }
  assert.equal(changedInode, true);
  assert.equal((await lstat(replaced.lock)).isFile(), true);
  assert.equal((await lstat(replaced.binding)).isFile(), true);
});

test('caught binding-record fsync failure cannot release apply lock', async t => {
  const item = await fixture(t);
  process.env.STATION_JOB_LOCK_FIXTURE = '1';
  try {
    await assert.rejects(withSearchAdminJobLock({ root: path.join(item.repository,
      '.cache/search-db'), uid, fixtureFaultAt: 'apply-binding-after-file-sync' },
    async token => {
      const operation = token.beginCreateApply({ approvedSha256: item.seal.sha256,
        dispatchId, ownerId });
      await assert.rejects(operation.markBindingAttempted());
      return 'caught';
    }));
  } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
  assert.equal((await lstat(item.lock)).isFile(), true);
});

test('two concurrent offline owners admit exactly one binding', async t => {
  const item = await fixture(t);
  let release, reached;
  const entered = new Promise(resolve => { reached = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const first = bindCreateApplyOffline({ repository: item.repository, uid, gid,
    args: item.args, writeBinding: async (...args) => {
      reached(); await hold; return writeCreateApplyBinding(...args);
    } });
  await entered;
  await assert.rejects(bindCreateApplyOffline({ repository: item.repository,
    uid, gid, args: item.args }));
  release();
  await first;
  assert.equal((await lstat(item.binding)).isFile(), true);
  assert.equal((await lstat(item.lock)).isFile(), true);
});
