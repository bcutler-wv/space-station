import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink,
  writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { ensureSearchGenerationIdentity } from '../../scripts/search-generation-identity.mjs';
import { bindWriterMappingOffline } from '../../scripts/search-writer-mapping-offline.mjs';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';
import { writeWriterMappingBinding, writeWriterRoleBinding } from
  '../../scripts/search-writer-role-binding.mjs';
import { fixture as mappingFixture } from './search-writer-mapping-intent-pure.test.mjs';

const uid = process.getuid(), gid = process.getgid();
const token = '11111111-1111-4111-8111-111111111111';
const suffix = token.replaceAll('-', '');
const canon = value => canonicalAttestorValue(value, 256 * 1024).bytes;
const exists = name => lstat(name).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const denied = work => assert.rejects(work, {
  message: 'Private writer mapping binding failed.',
});

async function fixture(t, variant = {}) {
  await mkdir('.cache/results', { recursive: true });
  const parent = await mkdtemp(path.resolve('.cache/results/mapping-offline-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repository = path.join(parent, 'stationfixture');
  await mkdir(repository);
  execFileSync(process.execPath, [path.resolve('scripts/init-search-security.mjs')],
    { cwd: repository, stdio: 'ignore', timeout: 30_000 });
  const cache = path.join(repository, '.cache');
  await mkdir(path.join(cache, 'search-db'), { mode: 0o700 });
  const signer = await ensureSearchGenerationIdentity(token, {
    v1Root: path.join(cache, 'search-security'),
    outputRoot: path.join(cache, 'search-generations'),
  });
  const ca = await readFile(path.join(cache, 'search-security/ca.pem'));
  const writer = await readFile(path.join(cache, 'search-generations', suffix, 'writer.pem'));
  const f = mappingFixture({ ...variant, caPem: ca, writerPem: writer });
  for (const [relative, value] of [
    ['search-create-intent/pending.json', f.createEvidence.intent],
    ['search-create-apply/binding.json', f.createEvidence.binding],
    ['search-writer-role-intent/pending.json', f.roleEvidence.intent],
    ['search-writer-role-apply/binding.json', f.roleEvidence.binding],
    ['search-writer-mapping-intent/pending.json', f.sealed.intent],
  ]) {
    const name = path.join(cache, relative);
    await mkdir(path.dirname(name), { mode: 0o700 });
    await writeFile(name, canon(value), { mode: 0o400 });
  }
  const intent = f.sealed.intent;
  const args = [f.sealed.sha256, String(intent.revision), intent.transitionToken,
    intent.sourceToken, intent.sourceIndex, intent.sourceUuid,
    intent.candidateToken, intent.candidateIndex, intent.candidateUuid];
  const input = { repository, uid, gid, args };
  return { repository, cache, f, signer, input, args,
    lock: path.join(cache, 'search-db/.job-operation.lock'),
    binding: path.join(cache, 'search-writer-mapping-apply/binding.json'),
    scratch: path.join(cache, 'search-writer-mapping-public'),
    pending: path.join(cache, 'search-writer-mapping-intent/pending.json') };
}

for (const variant of [{}, { retainedSource: true, absent: true }]) {
  test(`constructor-produced proposal binds once with real public PEMs ${JSON.stringify(variant)}`,
    { timeout: 90_000 }, async t => {
      const x = await fixture(t, variant);
      const result = await bindWriterMappingOffline(x.input);
      assert.equal(result.state, 'bound-offline');
      assert.equal(result.approvedSha256, x.f.sealed.sha256);
      assert.equal((await lstat(x.binding)).mode & 0o777, 0o400);
      assert.equal((await lstat(x.lock)).isFile(), true);
      assert.equal(await exists(x.scratch), false);
      const bound = JSON.parse(await readFile(x.binding, 'utf8'));
      assert.equal(bound.invocationId, result.invocationId);
      assert.equal(bound.approvedSha256, x.f.sealed.sha256);
      await denied(() => bindWriterMappingOffline(x.input));
      await rm(x.lock);
      await denied(() => bindWriterMappingOffline(x.input));
    });
}

test('external SHA, tuple, and descriptor checks fail before binding',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    const wrong = [...x.args]; wrong[0] = '0'.repeat(64);
    await denied(() => bindWriterMappingOffline({ ...x.input, args: wrong }));
    assert.equal(await exists(x.binding), false);
    const tuple = [...x.args]; tuple[8] = 'changed_uuid';
    await denied(() => bindWriterMappingOffline({ ...x.input, args: tuple }));
    const getter = [...x.args]; let touched = 0;
    Object.defineProperty(getter, 0, { get() { touched++; throw Error('private'); } });
    await denied(() => bindWriterMappingOffline({ ...x.input, args: getter }));
    assert.equal(touched, 0);
  });

test('same-byte original pending inode replacement is denied',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    const moved = path.join(x.cache, 'moved-pending');
    const fixtureInput = { ...x.input, fixture: {
      capturePublic: async (...values) => {
        await rename(x.pending, moved);
        await copyFile(moved, x.pending);
        await chmod(x.pending, 0o400);
        const { captureApprovedWriterMappingPublic } = await import(
          '../../scripts/search-writer-mapping-public.mjs');
        return captureApprovedWriterMappingPublic(...values);
      },
    } };
    process.env.STATION_WRITER_MAPPING_FIXTURE = '1';
    try { await denied(() => bindWriterMappingOffline(fixtureInput)); }
    finally { delete process.env.STATION_WRITER_MAPPING_FIXTURE; }
    assert.equal(await exists(x.binding), false);
    assert.equal(await exists(x.lock), true);
  });

test('partial public acquisition cleans owned scratch but retains uncertain lock',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    process.env.STATION_WRITER_MAPPING_FIXTURE = '1';
    try {
      await denied(() => bindWriterMappingOffline({ ...x.input, fixture: {
        capturePublic: async () => { throw Error('private'); },
      } }));
    } finally { delete process.env.STATION_WRITER_MAPPING_FIXTURE; }
    assert.equal(await exists(x.binding), false);
    assert.equal(await exists(x.scratch), false);
    assert.equal(await exists(x.lock), true);
  });

test('checked public rejection after a complete capture retains the original lock',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    process.env.STATION_WRITER_MAPPING_FIXTURE = '1';
    try {
      await denied(() => bindWriterMappingOffline({ ...x.input, fixture: {
        capturePublic: async (...values) => {
          const { captureApprovedWriterMappingPublic } = await import(
            '../../scripts/search-writer-mapping-public.mjs');
          const result = await captureApprovedWriterMappingPublic(...values);
          await chmod(path.join(x.cache, 'search-generations', suffix, 'writer.pem'), 0o600);
          return result;
        },
      } }));
    } finally { delete process.env.STATION_WRITER_MAPPING_FIXTURE; }
    assert.equal(await exists(x.binding), false);
    assert.equal(await exists(x.lock), true);
  });

test('durable binding attempt fault retains lock and denies second binding attempt',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    let operation;
    process.env.STATION_WRITER_MAPPING_FIXTURE = '1';
    process.env.STATION_JOB_LOCK_FIXTURE = '1';
    try {
      await denied(() => bindWriterMappingOffline({ ...x.input, fixture: {
        lock: (options, work) => withSearchAdminJobLock({ ...options,
          fixtureFaultAt: 'mapping-binding-after-append' }, async handle =>
          work({ ...handle, beginWriterMappingApply: known => {
            operation = handle.beginWriterMappingApply(known);
            return operation;
          } })),
      } }));
      await assert.rejects(() => operation.markBindingAttempted(),
        /Search admin writer mapping binding/);
    } finally {
      delete process.env.STATION_WRITER_MAPPING_FIXTURE;
      delete process.env.STATION_JOB_LOCK_FIXTURE;
    }
    assert.equal(await exists(x.lock), true);
    assert.equal(await exists(x.binding), false);
  });

test('pre-existing empty scratch remains original after a healthy binding',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    await mkdir(x.scratch, { mode: 0o700 });
    const original = await lstat(x.scratch);
    await bindWriterMappingOffline(x.input);
    const current = await lstat(x.scratch);
    assert.equal(current.ino, original.ino);
    assert.equal((current.mode & 0o777), 0o700);
  });

test('candidate private keys are unreadable while public-only binding succeeds',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    for (const leaf of ['writer.key', 'query.key'])
      await chmod(path.join(x.cache, 'search-generations', suffix, leaf), 0);
    const result = await bindWriterMappingOffline(x.input);
    assert.equal(result.state, 'bound-offline');
    assert.equal(await exists(x.binding), true);
  });

test('unexpected candidate inventory is denied',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    const extra = path.join(x.cache, 'search-generations', suffix, 'unexpected');
    await writeFile(extra, 'unexpected', { mode: 0o400 });
    await denied(() => bindWriterMappingOffline(x.input));
    await rm(extra);
    assert.equal(await exists(x.binding), false);
  });

test('original consumed binding symlink is denied before new binding',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    const original = path.join(x.cache, 'search-writer-role-apply/binding.json');
    const moved = path.join(x.cache, 'original-binding');
    await rename(original, moved);
    await symlink(moved, original);
    await denied(() => bindWriterMappingOffline(x.input));
    assert.equal(await exists(x.binding), false);
  });

test('checked preflight cleanup releases lock when established sources remain original',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    process.env.STATION_WRITER_MAPPING_FIXTURE = '1';
    try {
      await denied(() => bindWriterMappingOffline({ ...x.input, fixture: {
        capturePublic: async (...values) => {
          const { captureApprovedWriterMappingPublic } = await import(
            '../../scripts/search-writer-mapping-public.mjs');
          const actual = await captureApprovedWriterMappingPublic(...values);
          return { ...actual, publicDigests: [] };
        },
      } }));
    } finally { delete process.env.STATION_WRITER_MAPPING_FIXTURE; }
    assert.equal(await exists(x.scratch), false);
    assert.equal(await exists(x.lock), false);
    assert.equal(await exists(x.binding), false);
  });

test('partial exclusive binding prevents replay even after external lock removal',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    process.env.STATION_WRITER_MAPPING_FIXTURE = '1';
    try {
      await denied(() => bindWriterMappingOffline({ ...x.input, fixture: {
        writeBinding: (...values) => writeWriterMappingBinding(...values, {
          afterFileWrite: () => { throw Error('fixture write fault'); },
        }),
      } }));
    } finally { delete process.env.STATION_WRITER_MAPPING_FIXTURE; }
    assert.equal(await exists(x.lock), true);
    assert.equal(await exists(x.binding), true);
    await rm(x.lock);
    await denied(() => bindWriterMappingOffline(x.input));
    assert.equal(await exists(x.binding), true);
  });

test('original mapping pending parent replacement during public capture retains lock',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    const parent = path.dirname(x.pending);
    const moved = path.join(x.cache, 'moved-mapping-pending');
    process.env.STATION_WRITER_MAPPING_FIXTURE = '1';
    try {
      await denied(() => bindWriterMappingOffline({ ...x.input, fixture: {
        capturePublic: async (...values) => {
          const { captureApprovedWriterMappingPublic } = await import(
            '../../scripts/search-writer-mapping-public.mjs');
          const actual = await captureApprovedWriterMappingPublic(...values);
          await rename(parent, moved);
          await mkdir(parent, { mode: 0o700 });
          await copyFile(path.join(moved, 'pending.json'), x.pending);
          await chmod(x.pending, 0o400);
          return actual;
        },
      } }));
    } finally { delete process.env.STATION_WRITER_MAPPING_FIXTURE; }
    assert.equal(await exists(x.binding), false);
    assert.equal(await exists(x.lock), true);
  });

test('failed preflight-failure fsync still latches and retains original lock',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    let operation;
    process.env.STATION_WRITER_MAPPING_FIXTURE = '1';
    process.env.STATION_JOB_LOCK_FIXTURE = '1';
    try {
      await denied(() => bindWriterMappingOffline({ ...x.input, fixture: {
        lock: (options, work) => withSearchAdminJobLock({ ...options,
          fixtureFaultAt: 'mapping-preflight-failed-after-file-sync' }, async handle =>
          work({ ...handle, beginWriterMappingApply: known => {
            operation = handle.beginWriterMappingApply(known);
            return operation;
          } })),
        capturePublic: async () => { throw Error('fixture incomplete acquisition'); },
      } }));
      await assert.rejects(() => operation.markBindingAttempted(),
        /Search admin writer mapping binding/);
    } finally {
      delete process.env.STATION_WRITER_MAPPING_FIXTURE;
      delete process.env.STATION_JOB_LOCK_FIXTURE;
    }
    assert.equal(await exists(x.lock), true);
    assert.equal(await exists(x.binding), false);
  });

test('actual binding writer rejects replacement of its newly created directory at sync',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    const root = path.join(x.cache, 'search-writer-mapping-apply');
    const originalOpen = fsPromises.open;
    let reached = false, originalInode;
    fsPromises.open = async (...values) => {
      const handle = await originalOpen(...values);
      if (values[0] === x.cache && await exists(root)) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (!reached) {
            reached = true;
            originalInode = (await lstat(root)).ino;
            await rename(root, `${root}-old`);
            await mkdir(root, { mode: 0o700 });
          }
          return sync();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try { await denied(() => bindWriterMappingOffline(x.input)); }
    finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
    assert.equal(reached, true);
    assert.notEqual((await lstat(root)).ino, originalInode);
    assert.equal(await exists(x.binding), false);
    assert.equal(await exists(x.lock), true);
  });

test('binding callback mutation cannot rebase approved result or file',
  { timeout: 60_000 }, async t => {
    const x = await fixture(t);
    let reached = false;
    process.env.STATION_WRITER_MAPPING_FIXTURE = '1';
    let result;
    try {
      result = await bindWriterMappingOffline({ ...x.input, fixture: {
        writeBinding: async (...values) => {
          const written = await writeWriterMappingBinding(...values);
          values[4].approvedSha256 = '0'.repeat(64);
          reached = true;
          return written;
        },
      } });
    } finally { delete process.env.STATION_WRITER_MAPPING_FIXTURE; }
    assert.equal(reached, true);
    assert.equal(result.approvedSha256, x.f.sealed.sha256);
    assert.equal(JSON.parse(await readFile(x.binding, 'utf8')).approvedSha256,
      x.f.sealed.sha256);
  });

test('four mapping record faults latch before I/O and deny immediate successor calls',
  { timeout: 60_000 }, async t => {
    process.env.STATION_JOB_LOCK_FIXTURE = '1';
    try {
      for (const kind of ['binding', 'preflight-failed']) {
        for (const when of ['append', 'file-sync']) {
          const parent = await mkdtemp(path.resolve('.cache/results/mapping-lock-fault-'));
          t.after(() => rm(parent, { recursive: true, force: true }));
          const repository = path.join(parent, 'stationfixture');
          const root = path.join(repository, '.cache/search-db');
          await mkdir(root, { recursive: true, mode: 0o700 });
          const known = { approvedSha256: 'a'.repeat(64),
            dispatchId: '11111111-1111-4111-8111-111111111111',
            ownerId: '22222222-2222-4222-8222-222222222222' };
          let reached = false, inode;
          await assert.rejects(() => withSearchAdminJobLock({ root, uid,
            fixtureFaultAt: `mapping-${kind}-after-${when}` }, async handle => {
            const operation = handle.beginWriterMappingApply({ ...known });
            inode = (await lstat(path.join(root, '.job-operation.lock'))).ino;
            await assert.rejects(() => kind === 'binding' ?
              operation.markBindingAttempted() : operation.retainPreflightFailure(),
            /Search admin job record fault/);
            reached = true;
            await assert.rejects(() => operation.markBindingAttempted());
            await assert.rejects(() => operation.retainPreflightFailure());
            await assert.rejects(() => writeWriterMappingBinding(repository, uid, gid,
              operation, { ...known }));
          }));
          assert.equal(reached, true);
          assert.equal((await lstat(path.join(root, '.job-operation.lock'))).ino, inode);
          assert.equal(await exists(path.join(repository,
            '.cache/search-writer-mapping-apply/binding.json')), false);
        }
      }
    } finally { delete process.env.STATION_JOB_LOCK_FIXTURE; }
  });

test('live writer-role and mapping binding tokens cannot cross modes', async t => {
  for (const mode of ['role', 'mapping']) {
    const parent = await mkdtemp(path.resolve('.cache/results/mapping-cross-mode-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const repository = path.join(parent, 'stationfixture');
    const root = path.join(repository, '.cache/search-db');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const known = { approvedSha256: 'a'.repeat(64),
      dispatchId: '11111111-1111-4111-8111-111111111111',
      ownerId: '22222222-2222-4222-8222-222222222222' };
    let reached = false;
    await withSearchAdminJobLock({ root, uid }, async handle => {
      const operation = mode === 'role' ? handle.beginWriterRoleApply({ ...known }) :
        handle.beginWriterMappingApply({ ...known });
      await operation.markBindingAttempted();
      await assert.rejects(() => (mode === 'role' ? writeWriterMappingBinding :
        writeWriterRoleBinding)(repository, uid, gid, operation, { ...known }));
      reached = true;
    });
    assert.equal(reached, true);
  }
});
