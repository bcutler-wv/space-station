import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { prepareCreateIntentPending, writeCreateIntentPending } from
  '../../scripts/search-create-intent-pending.mjs';
import { runWriterRolePrepareOwner } from '../../scripts/search-writer-role-prepare-owner-core.mjs';
import { runWriterRolePrepare } from '../../scripts/search-writer-role-prepare-core.mjs';
import { pureFixture } from './search-writer-role-prepare-fixture.mjs';

const uid = process.getuid(), gid = process.getgid();
const exists = name => lstat(name).then(() => true, () => false);
async function fixture(t, fault = '') {
  await mkdir('.cache/results', { recursive: true });
  const parent = await mkdtemp(path.join(process.cwd(), '.cache/results/writer-prepare-owner-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repository = path.join(parent, 'stationfixture');
  await mkdir(repository);
  await mkdir(path.join(repository, '.cache'));
  await mkdir(path.join(repository, '.cache/search-db'), { mode: 0o700 });
  const f = pureFixture();
  const oldPending = await prepareCreateIntentPending(repository, uid, gid);
  await writeCreateIntentPending(oldPending, f.createEvidence.intent,
    f.createEvidence.approvedSha256, uid, gid);
  const boundRoot = path.join(repository, '.cache/search-create-apply');
  await mkdir(boundRoot, { mode: 0o700 });
  await writeFile(path.join(boundRoot, 'binding.json'),
    canonicalAttestorValue(f.createEvidence.binding).bytes, { mode: 0o400 });
  const calls = [];
  let cleaned = false, localInvocation;
  const stageRoot = path.join(repository, '.cache/staged-public');
  const publicStage = async () => {
    calls.push('stage');
    await mkdir(stageRoot, { mode: 0o700 });
    return { root: stageRoot,
      recheck: async () => { calls.push('public-recheck');
        if (fault === 'public-drift' && calls.includes('prepare')) throw Error('drift'); },
      recheckSource: async () => { calls.push('public-source'); },
      cleanup: async () => { calls.push('local-public-cleanup');
        await rm(stageRoot, { recursive: true }); } };
  };
  const adapterFactory = async () => ({
    verifyOwner: async () => { calls.push('verify-owner'); },
    captureOwner: async () => ({ project: 'stationfixture', databaseOid: '16384',
      systemIdentifier: '123' }),
    recheckOwner: async () => { calls.push('owner');
      if (fault === 'owner-drift' && calls.includes('prepare')) throw Error('drift'); },
    recheckInfrastructure: async () => { calls.push('infra');
      if (fault === 'infra-drift' && calls.includes('prepare')) throw Error('drift'); },
    preflight: async ({ invocationRoot }) => {
      calls.push('preflight');
      localInvocation = JSON.parse(await readFile(path.join(invocationRoot, 'invocation.json'), 'utf8'));
      assert.equal(localInvocation.project, 'stationfixture');
    },
    volumeAbsent: async () => { calls.push('absent'); },
    createVolume: async name => { calls.push('volume'); return { name }; },
    checkVolume: async () => { calls.push('volume-check'); },
    runPhase: async phase => {
      calls.push(phase);
      if (fault === `lost-${phase}`) throw Error('lost response');
      if (phase === 'transfer') return { id: phase, phase };
      f.setInvocation(localInvocation);
      let rawOutput = await runWriterRolePrepare(f.deps);
      if (fault === 'bad-output') rawOutput = `${rawOutput}X`;
      return { id: phase, phase, rawOutput };
    },
    cleanupRemote: async () => { calls.push('remote-cleanup');
      if (fault === 'remote-cleanup') throw Error('uncertain cleanup');
      cleaned = true; },
  });
  const lock = path.join(repository, '.cache/search-db/.job-operation.lock');
  const pending = path.join(repository, '.cache/search-writer-role-intent/pending.json');
  const run = (overrides = {}) => runWriterRolePrepareOwner({ repository, uid, gid,
    adapterFactory, publicStage, ...overrides });
  return { repository, f, calls, run, lock, pending, cleaned: () => cleaned,
    oldPending: oldPending.name, binding: path.join(boundRoot, 'binding.json') };
}

test('fixed owner keeps exact checked output until cleanup, then writes one canonical proposal', async t => {
  const item = await fixture(t);
  const result = await item.run();
  assert.equal(result.state, 'prepared');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(item.calls.filter(x => ['transfer', 'prepare', 'remote-cleanup',
    'local-public-cleanup'].includes(x)),
  ['transfer', 'prepare', 'remote-cleanup', 'local-public-cleanup']);
  assert.equal(await exists(item.lock), false);
  assert.equal((await lstat(item.pending)).mode & 0o777, 0o400);
  const intent = JSON.parse(await readFile(item.pending, 'utf8'));
  assert.equal(intent.candidateUuid, 'created_uuid');
  assert.equal(intent.project, 'stationfixture');
  assert.deepEqual(await readdir(path.join(item.repository,
    '.cache/search-writer-role-invocations')), []);
  await assert.rejects(item.run(), /Private writer role preparation owner failed/);
  assert.deepEqual(item.calls.filter(x => ['transfer', 'prepare'].includes(x)),
    ['transfer', 'prepare']);
});

test('uncertain send, output, cleanup and identity drift retain lock and deny proposal', async t => {
  for (const fault of ['lost-transfer', 'lost-prepare', 'bad-output',
    'remote-cleanup', 'public-drift', 'owner-drift', 'infra-drift']) {
    const item = await fixture(t, fault);
    await assert.rejects(item.run(), /Private writer role preparation owner failed/);
    assert.equal(await exists(item.lock), true, fault);
    assert.equal(await exists(item.pending), false, fault);
    assert.deepEqual(item.calls.filter(x => ['transfer', 'prepare'].includes(x)),
      fault === 'lost-transfer' ? ['transfer'] : ['transfer', 'prepare'], fault);
  }
});

test('old binding replacement and local pending write fault retain lock before any replay', async t => {
  const replaced = await fixture(t);
  let changed = false;
  const adapterFactory = async () => ({
    verifyOwner: async () => {}, captureOwner: async () => ({ project: 'stationfixture',
      databaseOid: '16384', systemIdentifier: '123' }),
    recheckOwner: async () => {}, recheckInfrastructure: async () => {},
    preflight: async () => {}, volumeAbsent: async () => {},
    createVolume: async name => ({ name }), checkVolume: async () => {},
    runPhase: async phase => {
      if (phase === 'transfer') {
        const original = path.join(replaced.repository, '.cache/old-binding');
        await rename(replaced.binding, original);
        await writeFile(replaced.binding, await readFile(original), { mode: 0o400 });
        changed = true;
      }
      return { id: phase, phase };
    }, cleanupRemote: async () => {},
  });
  await assert.rejects(replaced.run({ adapterFactory }));
  assert.equal(changed, true);
  assert.equal(await exists(replaced.lock), true);
  assert.equal(await exists(replaced.pending), false);
  const partial = await fixture(t);
  await assert.rejects(partial.run({ writePending: async () => {
    await mkdir(path.dirname(partial.pending), { recursive: true, mode: 0o700 });
    await writeFile(partial.pending, '{partial', { mode: 0o400 });
    throw Error('partial fsync');
  } }));
  assert.equal(await exists(partial.lock), true);
  assert.equal(await readFile(partial.pending, 'utf8'), '{partial');
  await assert.rejects(partial.run());
  assert.equal(await exists(partial.lock), true);
});

test('one waiting owner cannot adopt the first owner lock or create a second proposal', async t => {
  const item = await fixture(t);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const adapterFactory = async () => {
    entered();
    await hold;
    throw Error('held before transfer');
  };
  const first = item.run({ adapterFactory });
  await reached;
  assert.equal(await exists(item.lock), true);
  await assert.rejects(item.run(), /Private writer role preparation owner failed/);
  assert.equal(await exists(item.pending), false);
  release();
  await assert.rejects(first);
  assert.equal(await exists(item.lock), false);
  assert.deepEqual(item.calls.filter(x => ['transfer', 'prepare'].includes(x)), []);
});

test('replaced original lock before pending persistence denies success', async t => {
  const item = await fixture(t);
  let reached = false;
  const moved = path.join(item.repository, '.cache/original-job-lock');
  await assert.rejects(item.run({ writePending: async () => {
    await rename(item.lock, moved);
    reached = true;
    throw Error('original lock displaced');
  } }));
  assert.equal(reached, true);
  assert.equal(await exists(moved), true);
  assert.equal(await exists(item.pending), false);
  assert.equal(item.cleaned(), true);
});
