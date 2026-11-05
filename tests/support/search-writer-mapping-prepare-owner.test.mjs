import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename,
  rm, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { ensureSearchGenerationIdentity } from '../../scripts/search-generation-identity.mjs';
import { fixture as mappingFixture } from './search-writer-mapping-intent-pure.test.mjs';
import { runWriterMappingPrepareOwner, parseWriterMappingPrepareArgs } from
  '../../scripts/search-writer-mapping-prepare-owner-core.mjs';
import { makeWriterMappingPrepareInvocation, stageWriterMappingPreparePublic } from
  '../../scripts/search-writer-mapping-prepare-local.mjs';
import { prepareWriterMappingPending } from '../../scripts/search-create-intent-pending.mjs';
import { readOriginalWriterMappingFiles } from '../../scripts/search-writer-role-pending.mjs';

const uid = process.getuid(), gid = process.getgid();
const token = '11111111-1111-4111-8111-111111111111';
const suffix = token.replaceAll('-', '');
const canon = value => canonicalAttestorValue(value, 256 * 1024).bytes;
const exists = name => lstat(name).then(() => true, () => false);
const denied = work => assert.rejects(work,
  { message: 'Private writer mapping preparation owner failed.' });

async function fixture(t, variant = {}) {
  await mkdir('.cache/results', { recursive: true });
  const parent = await mkdtemp(path.resolve('.cache/results/mapping-owner-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repository = path.join(parent, 'stationfixture');
  await mkdir(repository);
  execFileSync(process.execPath, [path.resolve('scripts/init-search-security.mjs')],
    { cwd: repository, stdio: 'ignore', timeout: 30_000 });
  const cache = path.join(repository, '.cache');
  await mkdir(path.join(cache, 'search-db'), { mode: 0o700 });
  await mkdir(path.join(cache, 'search-writer-mapping-public'), { mode: 0o700 });
  const signer = await ensureSearchGenerationIdentity(token, {
    v1Root: path.join(cache, 'search-security'),
    outputRoot: path.join(cache, 'search-generations') });
  const ca = await readFile(path.join(cache, 'search-security/ca.pem'));
  const writer = await readFile(path.join(cache, 'search-generations', suffix, 'writer.pem'));
  const f = mappingFixture({ ...variant, caPem: ca, writerPem: writer });
  const sources = [
    ['search-create-intent/pending.json', f.createEvidence.intent],
    ['search-create-apply/binding.json', f.createEvidence.binding],
    ['search-writer-role-intent/pending.json', f.roleEvidence.intent],
    ['search-writer-role-apply/binding.json', f.roleEvidence.binding],
  ];
  for (const [relative, value] of sources) {
    const name = path.join(cache, relative);
    await mkdir(path.dirname(name), { mode: 0o700 });
    await writeFile(name, canon(value), { mode: 0o400 });
  }
  const args = [f.createEvidence.approvedSha256, f.roleEvidence.approvedSha256,
    signer.generationToken, signer.writerPrincipal, signer.queryPrincipal,
    signer.writerCertFingerprint, signer.queryCertFingerprint];
  const calls = [], starts = [];
  const ids = [f.sealed.intent.dispatchId, f.sealed.intent.ownerId];
  const output = `${canon({ intent: f.sealed.intent, sha256: f.sealed.sha256,
    adminPublic: { caSha256: f.priorDigests.find(x => x.path === 'ca.pem').sha256,
      adminSha256: f.priorDigests.find(x => x.path === 'v1/admin.pem').sha256 } }).toString('utf8')}\n`;
  const adapterFactory = async () => ({
    verifyOwner: async () => { calls.push('verify-owner'); },
    captureOwner: async () => ({ project: 'stationfixture',
      databaseOid: 16384, systemIdentifier: f.roleEvidence.intent.systemIdentifier }),
    recheckOwner: async () => { calls.push('recheck-owner'); },
    recheckInfrastructure: async () => { calls.push('recheck-infra'); },
    preflight: async () => { calls.push('preflight'); },
    volumeAbsent: async () => { calls.push('volume-absent'); },
    createVolume: async name => { calls.push('volume-created'); return { name }; },
    checkVolume: async () => { calls.push('volume-check'); },
    runPhase: async (phase, beforeStart) => {
      calls.push(`${phase}-created`);
      await beforeStart();
      starts.push(phase);
      calls.push(`${phase}-started`);
      return { id: phase, phase, ...(phase === 'prepare' ? { rawOutput: output } : {}) };
    },
    cleanupRemote: async () => { calls.push('remote-cleanup'); },
  });
  const input = { repository, uid, gid, args, adapterFactory,
    newId: () => ids.shift() };
  const lock = path.join(cache, 'search-db/.job-operation.lock');
  const pending = path.join(cache, 'search-writer-mapping-intent/pending.json');
  return { repository, cache, ca, writer, f, signer, args, input, calls, starts,
    lock, pending, output, sources };
}

for (const variant of [{}, { retainedSource: true, absent: true }]) {
  test(`real local proposal owner completes one checked transfer/read ${JSON.stringify(variant)}`,
    { timeout: 90_000 }, async t => {
      const x = await fixture(t, variant);
      const result = await runWriterMappingPrepareOwner(x.input);
      assert.deepEqual(result, { state: 'prepared', sha256: x.f.sealed.sha256 });
      assert.deepEqual(x.starts, ['transfer', 'prepare']);
      assert.equal(x.calls.filter(value => value === 'volume-absent').length, 2);
      assert.equal((await lstat(x.pending)).mode & 0o777, 0o400);
      assert.deepEqual(await readFile(x.pending), canon(x.f.sealed.intent));
      assert.equal(await exists(x.lock), false);
      assert.equal(await exists(path.join(x.cache,
        'search-writer-mapping-prepare-public')), false);
      assert.equal(await exists(path.join(x.cache,
        'search-writer-mapping-invocations')), false);
      await denied(() => runWriterMappingPrepareOwner(x.input));
      assert.deepEqual(x.starts, ['transfer', 'prepare']);
    });
}

test('seven caller fields are pinned synchronously; malformed input reaches no adapter', async t => {
  const x = await fixture(t);
  assert.deepEqual(parseWriterMappingPrepareArgs(x.args).signerResult.generationToken, token);
  let read = 0;
  const args = [...x.args];
  Object.defineProperty(args, 0, { enumerable: true, get() { read++; throw Error('secret'); } });
  await denied(() => runWriterMappingPrepareOwner({ ...x.input, args }));
  assert.equal(read, 0);
  assert.deepEqual(x.calls, []);
  const changed = [...x.args]; changed[0] = '0'.repeat(64);
  await denied(() => runWriterMappingPrepareOwner({ ...x.input, args: changed }));
  assert.deepEqual(x.starts, []);
});

test('caller approval mutation during acquisition cannot rebase the original SHAs',
  { timeout: 45_000 }, async t => {
    const x = await fixture(t);
    const originalReader = async (...values) => {
      const result = await readOriginalWriterMappingFiles(...values);
      x.args[0] = '0'.repeat(64); x.args[1] = '1'.repeat(64);
      return result;
    };
    const result = await runWriterMappingPrepareOwner({ ...x.input, originalReader });
    assert.equal(result.sha256, x.f.sealed.sha256);
    assert.deepEqual(x.starts, ['transfer', 'prepare']);
  });

test('original raw response bytes remain latched through checked cleanup',
  { timeout: 45_000 }, async t => {
    const x = await fixture(t);
    let prepared;
    const adapterFactory = async () => ({ ...(await x.input.adapterFactory()),
      runPhase: async (phase, beforeStart) => {
        await beforeStart(); x.starts.push(phase);
        const item = { id: phase, phase,
          ...(phase === 'prepare' ? { rawOutput: x.output } : {}) };
        if (phase === 'prepare') prepared = item;
        return item;
      },
      cleanupRemote: async () => { prepared.rawOutput = '{}'; },
    });
    const result = await runWriterMappingPrepareOwner({ ...x.input, adapterFactory });
    assert.equal(result.sha256, x.f.sealed.sha256);
    assert.deepEqual(await readFile(x.pending), canon(x.f.sealed.intent));
  });

test('both completed pre-start fences reject reached original-file mutations',
  { timeout: 90_000 }, async t => {
    for (const phase of ['transfer', 'prepare']) {
      const x = await fixture(t);
      const name = path.join(x.cache, 'search-writer-role-apply/binding.json');
      let reached = false;
      const adapterFactory = async () => ({ ...(await x.input.adapterFactory()),
        runPhase: async (current, beforeStart) => {
          x.calls.push(`${current}-created`);
          if (current === phase) {
            const moved = path.join(x.cache, 'moved-binding');
            await rename(name, moved); await copyFile(moved, name);
            await chmod(name, 0o400); reached = true;
          }
          await beforeStart(); x.starts.push(current);
          return { id: current, phase: current };
        } });
      await denied(() => runWriterMappingPrepareOwner({ ...x.input, adapterFactory }));
      assert.equal(reached, true);
      assert.deepEqual(x.starts, phase === 'transfer' ? [] : ['transfer']);
      assert.equal(await exists(x.lock), true);
      assert.equal(await exists(x.pending), false);
    }
  });

test('omitted and swallowed pre-start checks cannot produce a proposal',
  { timeout: 90_000 }, async t => {
    for (const fault of ['omitted', 'swallowed', 'duplicate']) {
      const x = await fixture(t);
      const adapterFactory = async () => ({ ...(await x.input.adapterFactory()),
        runPhase: async (phase, beforeStart) => {
          if (fault === 'omitted') return { id: phase, phase,
            ...(phase === 'prepare' ? { rawOutput: x.output } : {}) };
          if (fault === 'duplicate') {
            await beforeStart(); await assert.rejects(beforeStart());
          } else {
            const name = path.join(x.cache, 'search-writer-role-apply/binding.json');
            await chmod(name, 0o600);
            try { await beforeStart(); } catch { /* fixture swallows the fence. */ }
          }
          return { id: phase, phase,
            ...(phase === 'prepare' ? { rawOutput: x.output } : {}) };
        } });
      await denied(() => runWriterMappingPrepareOwner({ ...x.input, adapterFactory }));
      assert.deepEqual(x.starts, []);
      assert.equal(await exists(x.lock), true);
      assert.equal(await exists(x.pending), false);
    }
  });

test('lost return, cleanup failure and partial pending fail closed after dispatch',
  { timeout: 90_000 }, async t => {
    for (const fault of ['lost', 'cleanup', 'pending']) {
      const x = await fixture(t);
      const adapterFactory = async () => ({ ...(await x.input.adapterFactory()),
        runPhase: async (phase, beforeStart) => {
          await beforeStart(); x.starts.push(phase);
          if (fault === 'lost' && phase === 'prepare') throw Error('lost return');
          return { id: phase, phase,
            ...(phase === 'prepare' ? { rawOutput: x.output } : {}) };
        },
        cleanupRemote: async () => {
          if (fault === 'cleanup') throw Error('uncertain cleanup');
        } });
      const pendingWriter = fault === 'pending' ? async (prepared) => {
        await writeFile(prepared.name, '{partial', { mode: 0o400 });
        throw Error('partial write');
      } : undefined;
      await denied(() => runWriterMappingPrepareOwner({ ...x.input,
        adapterFactory, ...(pendingWriter ? { pendingWriter } : {}) }));
      assert.equal(await exists(x.pending), fault === 'pending');
      assert.equal(await exists(x.lock), true);
      if (fault === 'pending') {
        await rm(x.lock); // Simulate external loss of the original lock only.
        const ids = [x.f.sealed.intent.dispatchId, x.f.sealed.intent.ownerId];
        await denied(() => runWriterMappingPrepareOwner({ ...x.input,
          newId: () => ids.shift() }));
        assert.deepEqual(x.starts, ['transfer', 'prepare']);
      }
    }
  });

test('checked partial local creation releases only after exact owned cleanup',
  { timeout: 90_000 }, async t => {
    for (const kind of ['pending-parent', 'invocation', 'stage']) {
      const x = await fixture(t);
      const pendingFactory = kind === 'pending-parent' ? async (...args) => {
        await prepareWriterMappingPending(...args);
        throw Error('fixture interruption after pending parent creation');
      } : prepareWriterMappingPending;
      const makeInvocation = kind === 'invocation' ? async (...args) => {
        await makeWriterMappingPrepareInvocation(...args);
        throw Error('fixture interruption after owned creation');
      } : makeWriterMappingPrepareInvocation;
      const publicStage = kind === 'stage' ? async (...args) => {
        await stageWriterMappingPreparePublic(...args);
        throw Error('fixture interruption after owned creation');
      } : stageWriterMappingPreparePublic;
      await denied(() => runWriterMappingPrepareOwner({ ...x.input,
        pendingFactory, makeInvocation, publicStage }));
      assert.equal(await exists(x.lock), false, kind);
      assert.equal(await exists(x.pending), false, kind);
      assert.equal(await exists(path.join(x.cache,
        'search-writer-mapping-invocations')), false, kind);
      assert.equal(await exists(path.join(x.cache,
        'search-writer-mapping-prepare-public')), false, kind);
      assert.deepEqual(x.starts, []);
    }
  });

test('new private public scratch is removed after a healthy proposal',
  { timeout: 45_000 }, async t => {
    const x = await fixture(t);
    const scratch = path.join(x.cache, 'search-writer-mapping-public');
    await rm(scratch, { recursive: true });
    const result = await runWriterMappingPrepareOwner(x.input);
    assert.equal(result.state, 'prepared');
    assert.equal(await exists(scratch), false);
    assert.equal(await exists(x.lock), false);
  });

test('original CA and staged same-byte replacement reject before a scripted start',
  { timeout: 90_000 }, async t => {
    for (const kind of ['ca', 'stage']) {
      const x = await fixture(t);
      let stageRoot, reached = false;
      const adapterFactory = async () => ({ ...(await x.input.adapterFactory()),
        preflight: async value => { stageRoot = value.publicRoot; },
        runPhase: async (phase, beforeStart) => {
          if (kind === 'ca') {
            await chmod(path.join(x.cache, 'search-security/ca.pem'), 0o400);
          } else {
            const name = path.join(stageRoot, 'ca.pem');
            const moved = path.join(x.cache, 'moved-stage-ca');
            await rename(name, moved); await copyFile(moved, name);
            await chmod(name, 0o400);
          }
          reached = true;
          await beforeStart();
          x.starts.push(phase);
          return { id: phase, phase };
        } });
      await denied(() => runWriterMappingPrepareOwner({ ...x.input, adapterFactory }));
      assert.equal(reached, true);
      assert.deepEqual(x.starts, []);
      assert.equal(await exists(x.lock), true);
      assert.equal(await exists(x.pending), false);
    }
  });

test('uncertain pre-dispatch cleanup uses the preflight-failure latch and denies release',
  { timeout: 90_000 }, async t => {
    const x = await fixture(t);
    let reached = false;
    const publicStage = async (...args) => {
      const result = await stageWriterMappingPreparePublic(...args);
      await chmod(result.root, 0o777);
      reached = true;
      throw Error('fixture interruption with altered original stage');
    };
    await denied(() => runWriterMappingPrepareOwner({ ...x.input, publicStage }));
    assert.equal(reached, true);
    assert.equal(await exists(x.lock), true);
    const log = await readFile(x.lock, 'utf8');
    assert.match(log, /"role":"writer-mapping-prepare","phase":"preflight","state":"failed"/);
    assert.deepEqual(x.starts, []);
    assert.equal(await exists(x.pending), false);
});

test('owner rechecks receive fresh private baseline copies',
  { timeout: 45_000 }, async t => {
    const x = await fixture(t);
    const seen = [];
    const adapterFactory = async () => ({ ...(await x.input.adapterFactory()),
      recheckOwner: async baseline => {
        seen.push(baseline.systemIdentifier);
        baseline.systemIdentifier = 'changed by callback';
      } });
    const result = await runWriterMappingPrepareOwner({ ...x.input, adapterFactory });
    assert.equal(result.state, 'prepared');
    assert.ok(seen.length > 2);
    assert.ok(seen.every(value => value === x.f.roleEvidence.intent.systemIdentifier));
    assert.equal(await exists(x.lock), false);
  });

test('preflight public drift retains the original lock after safe local cleanup',
  { timeout: 45_000 }, async t => {
    const x = await fixture(t);
    let reached = false;
    const adapterFactory = async () => ({ ...(await x.input.adapterFactory()),
      preflight: async () => {
        await chmod(path.join(x.cache, 'search-generations', suffix, 'writer.pem'), 0o400);
        reached = true;
        throw Error('private fixture failure');
      } });
    await denied(() => runWriterMappingPrepareOwner({ ...x.input, adapterFactory }));
    assert.equal(reached, true);
    assert.deepEqual(x.starts, []);
    assert.equal(await exists(x.lock), true);
    assert.match(await readFile(x.lock, 'utf8'),
      /"role":"writer-mapping-prepare","phase":"preflight","state":"failed"/);
  });

test('four-file recheck rejects an unexpected leaf added after its last file read',
  { timeout: 45_000 }, async t => {
    const x = await fixture(t);
    const captured = await readOriginalWriterMappingFiles(x.repository, uid, gid);
    const target = path.join(x.cache, 'search-writer-role-apply/binding.json');
    const originalOpen = fsPromises.open;
    let reached = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === target) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          if (!reached) {
            reached = true;
            await writeFile(path.join(path.dirname(target), 'unexpected'), 'x',
              { mode: 0o400 });
          }
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(captured.recheck()); }
    finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
    assert.equal(reached, true);
  });

test('public stage recheck rejects nested directory drift after last PEM read',
  { timeout: 45_000 }, async t => {
    const x = await fixture(t);
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const stage = await stageWriterMappingPreparePublic(x.repository, uid, gid,
      id, token, new Map([['ca.pem', x.ca],
        [`generations/${suffix}/writer.pem`, x.writer]]), () => {});
    const target = path.join(stage.root, 'generations', suffix, 'writer.pem');
    const originalOpen = fsPromises.open;
    let reached = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === target) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          if (!reached) {
            reached = true;
            await chmod(path.dirname(target), 0o777);
          }
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(stage.recheck()); }
    finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
    assert.equal(reached, true);
  });
