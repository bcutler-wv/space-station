import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir,
  rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { ensureSearchGenerationIdentity } from '../../scripts/search-generation-identity.mjs';
import { captureCreateIntentPublic } from '../../scripts/search-create-intent-public.mjs';
import { runWriterMappingApplyOwner } from '../../scripts/search-writer-mapping-apply-owner-core.mjs';
import { stageWriterMappingApplyPublic } from '../../scripts/search-writer-mapping-apply-public-stage.mjs';
import { fixture as mappingFixture } from './search-writer-mapping-intent-pure.test.mjs';

const uid = process.getuid(), gid = process.getgid();
const token = '11111111-1111-4111-8111-111111111111';
const canon = value => canonicalAttestorValue(value, 256 * 1024).bytes;
const exists = name => lstat(name).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
async function setup(t, variant = {}, fault = {}) {
  await mkdir('.cache/results', { recursive: true });
  const parent = await mkdtemp(path.resolve('.cache/results/mapping-execute-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repository = path.join(parent, 'stationfixture');
  await mkdir(repository);
  execFileSync(process.execPath, [path.resolve('scripts/init-search-security.mjs')],
    { cwd: repository, stdio: 'ignore', timeout: 30_000 });
  const cache = path.join(repository, '.cache');
  await mkdir(path.join(cache, 'search-db'), { mode: 0o700 });
  await ensureSearchGenerationIdentity(token, {
    v1Root: path.join(cache, 'search-security'),
    outputRoot: path.join(cache, 'search-generations') });
  const ca = await readFile(path.join(cache, 'search-security/ca.pem'));
  const writer = await readFile(path.join(cache, 'search-generations', token.replaceAll('-', ''), 'writer.pem'));
  const retained = variant.retainedSource ? await ensureSearchGenerationIdentity(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
      v1Root: path.join(cache, 'search-security'),
      outputRoot: path.join(cache, 'search-generations') }) : null;
  const retainedFingerprints = retained ? { writer: retained.writerCertFingerprint,
    query: retained.queryCertFingerprint } : null;
  const provisional = mappingFixture({ ...variant, caPem: ca, writerPem: writer,
    retainedFingerprints });
  const scratchRoot = path.join(cache, 'search-create-intent');
  await mkdir(scratchRoot, { mode: 0o700 });
  const captured = await captureCreateIntentPublic({ repository, uid, gid,
    files: provisional.roleEvidence.intent.publicFiles, scratchRoot });
  const f = mappingFixture({ ...variant, caPem: ca, writerPem: writer,
    retainedFingerprints, priorDigestsOverride: captured.publicDigests });
  for (const [relative, value] of [
    ['search-create-intent/pending.json', f.createEvidence.intent],
    ['search-create-apply/binding.json', f.createEvidence.binding],
    ['search-writer-role-intent/pending.json', f.roleEvidence.intent],
    ['search-writer-role-apply/binding.json', f.roleEvidence.binding],
    ['search-writer-mapping-intent/pending.json', f.sealed.intent],
  ]) {
    const name = path.join(cache, relative);
    await mkdir(path.dirname(name), { mode: 0o700, recursive: true });
    await writeFile(name, canon(value), { mode: 0o400 });
  }
  const intent = f.sealed.intent;
  const args = [f.sealed.sha256, String(intent.revision), intent.transitionToken,
    intent.sourceToken, intent.sourceIndex, intent.sourceUuid,
    intent.candidateToken, intent.candidateIndex, intent.candidateUuid];
  const calls = [], starts = [];
  let stageRoot;
  const adapterFactory = async () => ({
    verifyOwner: async () => { calls.push('verify'); },
    captureOwner: async () => ({ project: fault.ownerProject ?? 'stationfixture',
      databaseOid: fault.ownerOid ?? intent.databaseOid,
      systemIdentifier: fault.ownerSystem ?? intent.systemIdentifier }),
    recheckOwner: async value => {
      calls.push('owner');
      if (fault.kind === 'mutate-owner-copy') value.systemIdentifier = 'changed';
    },
    recheckInfrastructure: async () => { calls.push('infra'); },
    preflight: async value => { calls.push('preflight'); stageRoot = value.publicRoot; },
    volumeAbsent: async () => { calls.push('absent'); },
    createVolume: async name => { calls.push('volume'); return { name }; },
    checkVolume: async () => { calls.push('volume-check'); },
    runPhase: async (phase, beforeStart) => {
      calls.push(`${phase}-created`);
      if (fault.phase === phase && fault.kind === 'skip-fence') return {
        id: phase === 'transfer' ? 'a'.repeat(64) : 'b'.repeat(64), phase,
        exitCode: 0, stdout: phase === 'transfer' ?
          'Private writer mapping apply transfer completed.\n' :
          'Private writer mapping apply reached writer_attested; search remains disabled.\n',
        stderr: '' };
      if (fault.phase === phase && fault.kind === 'unawaited-fence') {
        void beforeStart().catch(() => {});
        return { id: phase === 'transfer' ? 'a'.repeat(64) : 'b'.repeat(64),
          phase, exitCode: 0, stdout: phase === 'transfer' ?
            'Private writer mapping apply transfer completed.\n' :
            'Private writer mapping apply reached writer_attested; search remains disabled.\n',
          stderr: '' };
      }
      if (fault.phase === phase && fault.kind === 'pending-inode') {
        const name = path.join(cache, 'search-writer-mapping-intent/pending.json');
        const moved = path.join(cache, 'moved-mapping-intent');
        await rename(name, moved); await copyFile(moved, name); await chmod(name, 0o400);
      }
      if (fault.phase === phase && fault.kind === 'stage-mode')
        await chmod(stageRoot, 0o777);
      if (fault.phase === phase && fault.kind === 'swallow-pending') {
        const name = path.join(cache, 'search-writer-mapping-intent/pending.json');
        await chmod(name, 0o600);
        try { await beforeStart(); }
        catch {
          calls.push('caught-fence');
          return { id: phase === 'transfer' ? 'a'.repeat(64) : 'b'.repeat(64),
            phase, exitCode: 0,
            stdout: phase === 'transfer' ?
              'Private writer mapping apply transfer completed.\n' :
              'Private writer mapping apply reached writer_attested; search remains disabled.\n',
            stderr: '' };
        }
      } else await beforeStart();
      if (fault.phase === phase && fault.kind === 'late-duplicate')
        fault.lateFence = beforeStart;
      if (fault.phase === phase && fault.kind === 'duplicate-fence') {
        try { await beforeStart(); } catch { calls.push('caught-duplicate'); }
      }
      starts.push(phase);
      calls.push(`${phase}-started`);
      if (fault.phase === phase && fault.kind === 'lost') throw Error('private lost');
      return { id: phase === 'transfer' ? 'a'.repeat(64) : 'b'.repeat(64),
        phase, exitCode: 0, stdout: phase === 'transfer' ?
          'Private writer mapping apply transfer completed.\n' :
          'Private writer mapping apply reached writer_attested; search remains disabled.\n',
        stderr: '' };
    },
    cleanupRemote: async () => {
      calls.push('remote-cleanup');
      if (fault.kind === 'late-duplicate' && fault.lateFence) {
        try { await fault.lateFence(); } catch { calls.push('caught-late'); }
      }
      if (fault.kind === 'cleanup-failure') throw Error('private cleanup');
    },
    containersAbsent: async () => { calls.push('containers-absent'); },
    cleanupPrivate: async () => { calls.push('private-cleanup'); },
  });
  return { repository, cache, f, args, calls, starts,
    input: { repository, uid, gid, args, adapterFactory },
    lock: path.join(cache, 'search-db/.job-operation.lock'),
    binding: path.join(cache, 'search-writer-mapping-apply/binding.json'),
    stageParent: path.join(cache, 'search-writer-mapping-apply-public'),
    scratch: path.join(cache, 'search-writer-mapping-public') };
}

for (const variant of [{}, { retainedSource: true, absent: true }]) {
  test(`same-call mapping owner completes with real public PEMs ${JSON.stringify(variant)}`,
    { timeout: 90_000 }, async t => {
      const x = await setup(t, variant);
      const result = await runWriterMappingApplyOwner(x.input);
      assert.deepEqual(result, { state: 'writer_attested', ready: false });
      assert.deepEqual(x.starts, ['transfer', 'apply']);
      assert.equal(await exists(x.lock), false);
      assert.equal(await exists(x.binding), true);
      assert.equal((await lstat(x.binding)).mode & 0o777, 0o400);
      assert.equal(await exists(x.stageParent), false);
      assert.equal(await exists(x.scratch), false);
      await assert.rejects(() => runWriterMappingApplyOwner(x.input),
        { message: 'Private writer mapping apply owner failed.' });
    });
}

test('lost apply result retains consumed binding and lock without retry',
  { timeout: 90_000 }, async t => {
    const x = await setup(t, {}, { phase: 'apply', kind: 'lost' });
    await assert.rejects(() => runWriterMappingApplyOwner(x.input),
      { message: 'Private writer mapping apply owner failed.' });
    assert.deepEqual(x.starts, ['transfer', 'apply']);
    assert.equal(await exists(x.lock), true);
    assert.equal(await exists(x.binding), true);
  });

test('omitted beforeStart cannot validate transfer',
  { timeout: 90_000 }, async t => {
    const x = await setup(t, {}, { phase: 'transfer', kind: 'skip-fence' });
    await assert.rejects(() => runWriterMappingApplyOwner(x.input),
      { message: 'Private writer mapping apply owner failed.' });
    assert.deepEqual(x.starts, []);
    assert.equal(await exists(x.lock), true);
  });

for (const phase of ['transfer', 'apply']) {
  test(`${phase} unawaited beforeStart cannot validate phase result`,
    { timeout: 90_000 }, async t => {
      const x = await setup(t, {}, { phase, kind: 'unawaited-fence' });
      await assert.rejects(() => runWriterMappingApplyOwner(x.input),
        { message: 'Private writer mapping apply owner failed.' });
      assert.equal(await exists(x.lock), true);
      assert.deepEqual(x.starts, phase === 'transfer' ? [] : ['transfer']);
    });
  test(`${phase} swallowed failed beforeStart cannot validate phase result`,
    { timeout: 90_000 }, async t => {
      const x = await setup(t, {}, { phase, kind: 'swallow-pending' });
      await assert.rejects(() => runWriterMappingApplyOwner(x.input),
        { message: 'Private writer mapping apply owner failed.' });
      assert.equal(x.calls.includes('caught-fence'), true);
      assert.equal(await exists(x.lock), true);
    });
  test(`${phase} duplicate during cleanup poisons completed phase`,
    { timeout: 90_000 }, async t => {
      const fault = { phase, kind: 'late-duplicate' };
      const x = await setup(t, {}, fault);
      await assert.rejects(() => runWriterMappingApplyOwner(x.input),
        { message: 'Private writer mapping apply owner failed.' });
      assert.equal(x.calls.includes('caught-late'), true);
      assert.equal(await exists(x.lock), true);
    });
}

test('fresh lock refuses prior consumed binding',
  { timeout: 90_000 }, async t => {
    const x = await setup(t);
    await runWriterMappingApplyOwner(x.input);
    await assert.rejects(() => runWriterMappingApplyOwner(x.input),
      { message: 'Private writer mapping apply owner failed.' });
    assert.equal(await exists(x.binding), true);
    await chmod(x.binding, 0o600);
});

test('duplicate caught fence cannot authorize transfer start result',
  { timeout: 90_000 }, async t => {
    const x = await setup(t, {}, { phase: 'transfer', kind: 'duplicate-fence' });
    await assert.rejects(() => runWriterMappingApplyOwner(x.input),
      { message: 'Private writer mapping apply owner failed.' });
    assert.equal(x.calls.includes('caught-duplicate'), true);
    assert.equal(await exists(x.lock), true);
  });

test('overlapping owners allow only the original active lock holder',
  { timeout: 90_000 }, async t => {
    const x = await setup(t);
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const original = x.input.adapterFactory;
    const first = runWriterMappingApplyOwner({ ...x.input,
      adapterFactory: async (...args) => {
        const adapter = await original(...args);
        return { ...adapter, preflight: async value => {
          enter(); await held; return adapter.preflight(value);
        } };
      } });
    await entered;
    await assert.rejects(() => runWriterMappingApplyOwner(x.input),
      { message: 'Private writer mapping apply owner failed.' });
    release();
    assert.deepEqual(await first, { state: 'writer_attested', ready: false });
    assert.deepEqual(x.starts, ['transfer', 'apply']);
  });

for (const [label, override] of [
  ['project', { ownerProject: 'foreign' }],
  ['database OID', { ownerOid: 1 }],
  ['system identifier', { ownerSystem: 'foreign' }],
]) {
  test(`actual captured owner ${label} drift denies both starts`,
    { timeout: 90_000 }, async t => {
      const x = await setup(t, {}, override);
      await assert.rejects(() => runWriterMappingApplyOwner(x.input),
        { message: 'Private writer mapping apply owner failed.' });
      assert.deepEqual(x.starts, []);
      assert.equal(await exists(x.lock), true);
    });
}

test('no binding attempt releases after checked preflight denial',
  { timeout: 90_000 }, async t => {
    const x = await setup(t);
    const wrong = [...x.args]; wrong[0] = '0'.repeat(64);
    await assert.rejects(() => runWriterMappingApplyOwner({ ...x.input,
      args: wrong }), { message: 'Private writer mapping apply owner failed.' });
    assert.equal(await exists(x.binding), false);
    assert.equal(await exists(x.lock), false);
  });

test('coherently resealed pending intent cannot change original approved project',
  { timeout: 90_000 }, async t => {
    const x = await setup(t);
    const changed = JSON.parse(JSON.stringify(x.f.sealed.intent));
    changed.project = 'foreignproject';
    const pendingName = path.join(x.cache, 'search-writer-mapping-intent/pending.json');
    await chmod(pendingName, 0o600);
    const bytes = canon(changed);
    await writeFile(pendingName, bytes);
    await chmod(pendingName, 0o400);
    const args = [...x.args];
    args[0] = createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(() => runWriterMappingApplyOwner({ ...x.input, args }),
      { message: 'Private writer mapping apply owner failed.' });
    assert.deepEqual(x.starts, []);
    assert.equal(await exists(x.binding), false);
  });

test('unknown partial stage inode retains preflight lock without binding',
  { timeout: 90_000 }, async t => {
    const x = await setup(t);
    const publicStage = async input => {
      input.onAttempt('parent');
      const parent = path.join(x.cache, 'search-writer-mapping-apply-public');
      await mkdir(parent, { mode: 0o700 });
      input.onAttempt('root');
      await mkdir(path.join(parent, input.invocationId), { mode: 0o700 });
      throw Error('private after mkdir before capture');
    };
    await assert.rejects(() => runWriterMappingApplyOwner({ ...x.input,
      publicStage }), { message: 'Private writer mapping apply owner failed.' });
    assert.equal(await exists(x.binding), false);
    assert.equal(await exists(x.lock), true);
    assert.equal((await readdir(x.stageParent)).length, 1);
  });

test('known partial stage is cleaned and preflight lock released',
  { timeout: 90_000 }, async t => {
    const x = await setup(t);
    const publicStage = input => stageWriterMappingApplyPublic({ ...input,
      onCreate: item => {
        input.onCreate(item);
        if (item.kind === 'dir' && item.name.endsWith(input.invocationId))
          throw Error('private after captured root');
      } });
    await assert.rejects(() => runWriterMappingApplyOwner({ ...x.input,
      publicStage }), { message: 'Private writer mapping apply owner failed.' });
    assert.equal(await exists(x.binding), false);
    assert.equal(await exists(x.lock), false);
    assert.equal(await exists(x.stageParent), false);
  });

test('actual stage mkdir followed by failed first identity capture retains preflight lock',
  { timeout: 90_000 }, async t => {
    const x = await setup(t);
    const original = fs.promises.lstat;
    let reached = false;
    fs.promises.lstat = async (...args) => {
      if (!reached && typeof args[0] === 'string' &&
          args[0].startsWith(`${x.stageParent}/`) &&
          path.dirname(args[0]) === x.stageParent) {
        reached = true;
        throw Object.assign(Error('injected private capture failure'), { code: 'EIO' });
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => runWriterMappingApplyOwner(x.input),
        { message: 'Private writer mapping apply owner failed.' });
    } finally { fs.promises.lstat = original; syncBuiltinESMExports(); }
    assert.equal(reached, true);
    assert.equal(await exists(x.lock), true);
    assert.equal(await exists(x.binding), false);
  });

test('foreign replacement of staged root is preserved and lock retained',
  { timeout: 90_000 }, async t => {
    const x = await setup(t);
    let replaced = false, foreign;
    const publicStage = async input => {
      const stage = await stageWriterMappingApplyPublic(input);
      return { ...stage, cleanup: async () => {
        await rename(stage.root, `${stage.root}.original`);
        await mkdir(stage.root, { mode: 0o700 });
        foreign = path.join(stage.root, 'foreign');
        await writeFile(foreign, 'foreign');
        replaced = true;
        return stage.cleanup();
      } };
    };
    await assert.rejects(() => runWriterMappingApplyOwner({ ...x.input, publicStage }),
      { message: 'Private writer mapping apply owner failed.' });
    assert.equal(replaced, true);
    assert.equal(await readFile(foreign, 'utf8'), 'foreign');
    assert.equal(await exists(x.lock), true);
  });

test('cleanup uncertainty retains original consumed binding and lock',
  { timeout: 90_000 }, async t => {
    const x = await setup(t, {}, { kind: 'cleanup-failure' });
    await assert.rejects(() => runWriterMappingApplyOwner(x.input),
      { message: 'Private writer mapping apply owner failed.' });
    assert.deepEqual(x.starts, ['transfer', 'apply']);
    assert.equal(await exists(x.lock), true);
    assert.equal(await exists(x.binding), true);
});

test('mutable host recheck argument cannot rebase captured owner',
  { timeout: 90_000 }, async t => {
    const x = await setup(t, {}, { kind: 'mutate-owner-copy' });
    assert.deepEqual(await runWriterMappingApplyOwner(x.input),
      { state: 'writer_attested', ready: false });
    assert.deepEqual(x.starts, ['transfer', 'apply']);
  });

for (const mode of ['live', 'absent']) {
  test(`stage ${mode} trailing source await cannot adopt a new output`, async t => {
    const repository = await mkdtemp(path.resolve('.cache/results/mapping-stage-fence-'));
    t.after(() => rm(repository, { recursive: true, force: true }));
    await mkdir(path.join(repository, '.cache'), { mode: 0o700 });
    const invocationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const root = path.join(repository, '.cache/search-writer-mapping-apply-public', invocationId);
    let armed = false, reached = false, sourceReads = 0;
    const stage = await stageWriterMappingApplyPublic({ repository, uid, gid,
      invocationId, candidateToken: token,
      priorFiles: [{ path: 'ca.pem' }],
      priorBytes: new Map([['ca.pem', Buffer.from('public')]]),
      candidateBytes: new Map([['ca.pem', Buffer.from('public')],
        [`generations/${token.replaceAll('-', '')}/writer.pem`, Buffer.from('public')]]),
      onAttempt() {}, onCreate() {},
      recheckSource: async () => {
        if (armed && (mode === 'absent' || ++sourceReads === 2)) {
          reached = true;
          if (mode === 'live')
            await writeFile(path.join(root, 'candidate-public/unexpected'), 'x');
          else await mkdir(root, { recursive: true, mode: 0o700 });
        }
        return true;
      } });
    if (mode === 'absent') await stage.cleanup();
    armed = true;
    await assert.rejects(() => mode === 'live' ? stage.recheck() : stage.checkAbsent());
    assert.equal(reached, true);
    assert.equal(await exists(mode === 'live' ?
      path.join(root, 'candidate-public/unexpected') : root), true);
  });
}

for (const kind of ['pending-inode', 'stage-mode', 'swallow-pending']) {
  test(`apply pre-start ${kind} reaches fence and retains lock`,
    { timeout: 90_000 }, async t => {
      const x = await setup(t, {}, { phase: 'apply', kind });
      await assert.rejects(() => runWriterMappingApplyOwner(x.input),
        { message: 'Private writer mapping apply owner failed.' });
      assert.deepEqual(x.starts, ['transfer']);
      assert.equal(await exists(x.lock), true);
      assert.equal(await exists(x.binding), true);
      if (kind === 'swallow-pending')
        assert.equal(x.calls.includes('caught-fence'), true);
    });
}
