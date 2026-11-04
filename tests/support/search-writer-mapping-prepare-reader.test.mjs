import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { X509Certificate } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm,
  symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { ensureSearchGenerationIdentity } from '../../scripts/search-generation-identity.mjs';
import { openWriterMappingPrepareInput } from
  '../../scripts/search-writer-mapping-prepare-reader.mjs';
import { runFixedWriterMappingPrepareJob, readFixedWriterMappingObservation } from
  '../../scripts/search-writer-mapping-prepare-job.mjs';
import { fixedWriterMappingPrepareCore } from
  '../../scripts/search-writer-mapping-prepare-job.mjs';
import { parseWriterMappingPrepareInput } from
  '../../scripts/search-writer-mapping-prepare-input.mjs';
import { parseWriterMappingPrepareOutput } from
  '../../scripts/search-writer-mapping-prepare-output.mjs';
import { fixture as mappingFixture } from './search-writer-mapping-intent-pure.test.mjs';

const token = '11111111-1111-4111-8111-111111111111';
const suffix = token.replaceAll('-', '');
const denied = work => assert.rejects(work,
  { message: 'Private writer mapping preparation input failed.' });
const encoded = value => canonicalAttestorValue(value).bytes;
const command = (name, args, cwd) => {
  const result = spawnSync(name, args, { cwd, timeout: 30_000, maxBuffer: 16_384,
    stdio: 'ignore' });
  assert.equal(result.status, 0);
};

async function make(t, options = {}) {
  await mkdir(path.resolve('.cache/results'), { recursive: true });
  const repository = await mkdtemp(path.resolve('.cache/results/writer-mapping-read-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  command(process.execPath, [path.resolve('scripts/init-search-security.mjs')], repository);
  const source = path.join(repository, '.cache/search-security');
  const generations = path.join(repository, '.cache/search-generations');
  const signerResult = await ensureSearchGenerationIdentity(token,
    { v1Root: source, outputRoot: generations });
  const caPem = await readFile(path.join(source, 'ca.pem'));
  const writerPem = await readFile(path.join(generations, suffix, 'writer.pem'));
  const original = mappingFixture({ ...options, caPem, writerPem });
  const root = path.join(repository, '.cache/results/copied');
  const publicRoot = path.join(root, 'public');
  const candidate = path.join(publicRoot, 'generations', suffix);
  const scratchParent = path.join(repository, '.cache/results/scratch-parent');
  const scratch = path.join(scratchParent, 'search-writer-mapping-prepare');
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const invocation = { version: 1, project: original.roleEvidence.intent.project,
    databaseOid: original.roleEvidence.intent.databaseOid,
    systemIdentifier: original.roleEvidence.intent.systemIdentifier,
    invocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    dispatchId: original.sealed.intent.dispatchId,
    ownerId: original.sealed.intent.ownerId,
    createApprovedSha256: original.createEvidence.approvedSha256,
    roleApprovedSha256: original.roleEvidence.approvedSha256,
    signerResult };
  const bytes = new Map([
    ['create-intent.json', encoded(original.createEvidence.intent)],
    ['create-binding.json', encoded(original.createEvidence.binding)],
    ['role-intent.json', encoded(original.roleEvidence.intent)],
    ['role-binding.json', encoded(original.roleEvidence.binding)],
    ['invocation.json', encoded(invocation)],
    ['transition.password', Buffer.from(Buffer.alloc(32, 7).toString('base64url'))],
    ['public/ca.pem', caPem],
    [`public/generations/${suffix}/writer.pem`, writerPem],
  ]);
  for (const [name, content] of bytes) {
    const target = path.join(root, name);
    await writeFile(target, content, { mode: 0o400 });
    await chmod(target, 0o400);
  }
  for (const dir of [root, publicRoot, path.join(publicRoot, 'generations'),
    candidate, scratchParent, scratch]) await chmod(dir, 0o700);
  const fixture = { uid: process.getuid(), gid: process.getgid() };
  const open = () => openWriterMappingPrepareInput(root, scratch, fixture);
  return { repository, source, generations, root, publicRoot, candidate,
    scratchParent, scratch, original, invocation, signerResult, bytes, open };
}

test('real copied legacy/retained public evidence passes with no candidate key read',
  { timeout: 90_000 }, async t => {
  process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE = '1';
  for (const options of [{}, { retainedSource: true, absent: true }]) {
    const f = await make(t, options);
    const key = path.join(f.generations, suffix, 'writer.key');
    await chmod(key, 0o000);
    try {
      await assert.rejects(readFile(key), { code: 'EACCES' });
      const input = await f.open();
      const parsed = parseWriterMappingPrepareInput(input.inputBytes, input.expected);
      assert.equal(parsed.publicEvidence.writerPrincipal, f.signerResult.writerPrincipal);
      assert.equal(parsed.publicEvidence.writerCertFingerprint,
        f.signerResult.writerCertFingerprint);
      assert.equal(await input.recheckInput(), true);
      assert.deepEqual(await input.readInputBytes(), input.inputBytes);
      assert.deepEqual(await readdir(f.scratch), []);
      assert.deepEqual(await readdir(f.candidate), ['writer.pem']);
    } finally { await chmod(key, 0o600); }
  }
});

test('copied input rejects original byte, inode, inventory, permission and link drift',
  { timeout: 90_000 }, async t => {
  process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE = '1';
  for (const kind of ['bytes', 'same-inode', 'extra', 'missing', 'mode', 'link',
    'public-parent', 'scratch-extra', 'scratch-parent']) {
    const f = await make(t);
    const input = await f.open();
    const role = path.join(f.root, 'role-intent.json');
    if (kind === 'bytes') {
      await chmod(role, 0o600);
      await writeFile(role, '{}');
      await chmod(role, 0o400);
    }
    if (kind === 'same-inode') {
      const old = path.join(f.repository, 'role-original');
      await rename(role, old);
      await copyFile(old, role);
      await chmod(role, 0o400);
    }
    if (kind === 'extra') await writeFile(path.join(f.candidate, 'extra'), 'x');
    if (kind === 'missing') await rename(path.join(f.candidate, 'writer.pem'),
      path.join(f.repository, 'writer-original'));
    if (kind === 'mode') await chmod(role, 0o600);
    if (kind === 'link') await link(role, path.join(f.repository, 'role-link'));
    if (kind === 'public-parent') {
      const old = path.join(f.repository, 'public-original');
      await rename(f.publicRoot, old);
      await mkdir(path.join(f.publicRoot, 'generations', suffix),
        { recursive: true, mode: 0o700 });
      await copyFile(path.join(old, 'ca.pem'), path.join(f.publicRoot, 'ca.pem'));
      await copyFile(path.join(old, 'generations', suffix, 'writer.pem'),
        path.join(f.publicRoot, 'generations', suffix, 'writer.pem'));
    }
    if (kind === 'scratch-extra') await writeFile(path.join(f.scratch, 'extra'), 'x');
    if (kind === 'scratch-parent') {
      const child = await lstat(f.scratch);
      const old = path.join(f.repository, 'scratch-parent-original');
      await rename(f.scratchParent, old);
      await mkdir(f.scratchParent, { mode: 0o700 });
      await rename(path.join(old, path.basename(f.scratch)), f.scratch);
      assert.deepEqual(await readdir(f.scratch), []);
      assert.equal((await lstat(f.scratch)).ino, child.ino);
    }
    await denied(input.recheckInput);
  }
});

test('copied reader refuses malformed old SHA, signer and scratch or public tree before reads',
  { timeout: 90_000 }, async t => {
  process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE = '1';
  for (const kind of ['old-sha', 'binding', 'signer', 'ca-mismatch', 'scratch',
    'public-extra', 'symlink']) {
    const f = await make(t);
    if (kind === 'old-sha' || kind === 'signer') {
      const changed = { ...f.invocation };
      if (kind === 'old-sha') changed.roleApprovedSha256 = '0'.repeat(64);
      else changed.signerResult = { ...f.signerResult, writerCertFingerprint: '0'.repeat(64) };
      await chmod(path.join(f.root, 'invocation.json'), 0o600);
      await writeFile(path.join(f.root, 'invocation.json'), encoded(changed));
      await chmod(path.join(f.root, 'invocation.json'), 0o400);
    }
    if (kind === 'scratch') await writeFile(path.join(f.scratch, 'extra'), 'x');
    if (kind === 'binding') {
      const name = path.join(f.root, 'role-binding.json');
      await rm(name);
      await copyFile(path.join(f.root, 'create-binding.json'), name);
      await chmod(name, 0o400);
    }
    if (kind === 'ca-mismatch') {
      const name = path.join(f.publicRoot, 'ca.pem');
      await rm(name);
      await copyFile(path.join(f.candidate, 'writer.pem'), name);
      await chmod(name, 0o400);
    }
    if (kind === 'public-extra') await writeFile(path.join(f.publicRoot, 'extra'), 'x');
    if (kind === 'symlink') {
      const old = path.join(f.repository, 'ca-original');
      await rename(path.join(f.publicRoot, 'ca.pem'), old);
      await symlink(old, path.join(f.publicRoot, 'ca.pem'));
    }
    await denied(f.open);
  }
});

test('a public leaf or inventory changed during the real purpose subprocess is rejected',
  { timeout: 90_000 }, async t => {
  process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE = '1';
  for (const kind of ['leaf', 'inventory']) {
    const f = await make(t);
    let reached = false;
    const purposeExec = async (...args) => {
      reached = true;
      const result = await promisify(execFile)(...args);
      if (kind === 'leaf') {
        const writer = path.join(f.candidate, 'writer.pem');
        const old = path.join(f.repository, 'writer-original');
        await rename(writer, old);
        await copyFile(old, writer);
        await chmod(writer, 0o400);
      } else await writeFile(path.join(f.candidate, 'extra'), 'x');
      return result;
    };
    await denied(() => openWriterMappingPrepareInput(f.root, f.scratch,
      { uid: process.getuid(), gid: process.getgid(), purposeExec }));
    assert.equal(reached, true);
  }
});

test('real signer-shaped certificates with wrong issuer, server purpose or expired validity are refused',
  { timeout: 90_000 }, async t => {
  process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE = '1';
  for (const kind of ['serverAuth', 'expired', 'wrongIssuer']) {
    const f = await make(t);
    const csr = path.join(f.repository, 'writer.csr');
    const ext = path.join(f.repository, 'writer.ext');
    const key = path.join(f.generations, suffix, 'writer.key');
    command('openssl', ['req', '-new', '-key', key,
      '-subj', `/CN=${f.signerResult.writerPrincipal}`, '-out', csr], f.repository);
    await writeFile(ext, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n' +
      `extendedKeyUsage=${kind === 'serverAuth' ? 'serverAuth' : 'clientAuth'}\n`);
    let signingCa = path.join(f.source, 'ca.pem');
    let signingKey = path.join(f.source, 'ca.key');
    if (kind === 'wrongIssuer') {
      signingCa = path.join(f.repository, 'other-ca.pem');
      signingKey = path.join(f.repository, 'other-ca.key');
      command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
        '-subj', '/CN=other-ca', '-keyout', signingKey, '-out', signingCa], f.repository);
    }
    const replacement = path.join(f.repository, 'replacement.pem');
    command('openssl', ['x509', '-req', '-sha256', '-days',
      kind === 'expired' ? '0' : '30', '-in', csr,
      '-CA', signingCa, '-CAkey', signingKey,
      '-set_serial', kind === 'expired' ? '0x11223344556677889902' :
        '0x11223344556677889901', '-extfile', ext, '-out', replacement], f.repository);
    const pem = await readFile(replacement);
    const originalWriter = path.join(f.candidate, 'writer.pem');
    await rm(originalWriter);
    await copyFile(replacement, originalWriter);
    await chmod(originalWriter, 0o400);
    const updated = { ...f.invocation, signerResult: { ...f.signerResult,
      writerCertFingerprint: new X509Certificate(pem).fingerprint256
        .replaceAll(':', '').toLowerCase() } };
    const invocationFile = path.join(f.root, 'invocation.json');
    await chmod(invocationFile, 0o600);
    await writeFile(invocationFile, encoded(updated));
    await chmod(invocationFile, 0o400);
    await denied(f.open);
  }
});

test('fixed job wires the real copied reader once and closes the observer on both outcomes',
  { timeout: 90_000 }, async t => {
  process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE = '1';
  const f = await make(t);
  const fixture = { uid: process.getuid(), gid: process.getgid(), root: f.root,
    scratchParent: f.scratchParent, scratch: f.scratch };
  await rm(f.scratchParent, { recursive: true });
  const calls = [];
  const deps = {
    openInput: (...args) => { calls.push('input');
      return openWriterMappingPrepareInput(...args); },
    runCore: async (bytes, expected, methods) => {
      calls.push('core');
      assert.equal(parseWriterMappingPrepareInput(bytes, expected).invocation.project,
        f.invocation.project);
      assert.deepEqual(await methods.readInputBytes(), bytes);
      assert.equal(await methods.recheckInput(), true);
      await methods.observe();
      return Buffer.from('fixed-output\n');
    },
    readState: async () => { calls.push('state'); return {}; },
    readSnapshot: async () => { calls.push('snapshot'); return {}; },
    recheckSnapshot: async () => { calls.push('recheck'); return true; },
    observe: () => readFixedWriterMappingObservation(async () => {
      calls.push('open-observer');
      return { observe: async () => { calls.push('observe'); return {}; },
        close: async () => { calls.push('close-observer'); } };
    }),
    captureAdminPublic: async () => { calls.push('admin'); return {}; },
  };
  assert.deepEqual(await runFixedWriterMappingPrepareJob(deps, fixture),
    Buffer.from('fixed-output\n'));
  assert.deepEqual(calls, ['input', 'core', 'open-observer', 'observe', 'close-observer']);
  calls.length = 0;
  await rm(f.scratchParent, { recursive: true });
  const prior = deps.runCore;
  deps.runCore = async (...args) => { await prior(...args); throw Error('private'); };
  await assert.rejects(runFixedWriterMappingPrepareJob(deps, fixture),
    { message: 'Private writer mapping preparation failed.' });
  assert.deepEqual(calls, ['input', 'core', 'open-observer', 'observe', 'close-observer']);
  calls.length = 0;
  await assert.rejects(readFixedWriterMappingObservation(async () => ({
    observe: async () => { calls.push('observe-failed'); throw Error('private'); },
    close: async () => { calls.push('close-after-failure'); },
  })), /private/);
  assert.deepEqual(calls, ['observe-failed', 'close-after-failure']);
  calls.length = 0;
  const argv = process.argv;
  process.argv = [...argv, 'extra'];
  try { await assert.rejects(runFixedWriterMappingPrepareJob(deps, fixture)); }
  finally { process.argv = argv; }
  assert.deepEqual(calls, []);
  await assert.rejects(runFixedWriterMappingPrepareJob(deps,
    { ...fixture, uid: fixture.uid + 1 }));
  assert.deepEqual(calls, []);
  await assert.rejects(runFixedWriterMappingPrepareJob(deps, fixture));
  assert.deepEqual(calls, []);
  await rm(f.scratchParent, { recursive: true });
  let parentReplaced = false;
  deps.runCore = async () => {
    calls.push('core');
    const child = await lstat(f.scratch);
    const old = path.join(f.repository, 'job-scratch-parent-original');
    await rename(f.scratchParent, old);
    await mkdir(f.scratchParent, { mode: 0o700 });
    await rename(path.join(old, path.basename(f.scratch)), f.scratch);
    assert.equal((await lstat(f.scratch)).ino, child.ino);
    parentReplaced = true;
    return Buffer.from('fixed-output\n');
  };
  await assert.rejects(runFixedWriterMappingPrepareJob(deps, fixture),
    { message: 'Private writer mapping preparation failed.' });
  assert.equal(parentReplaced, true);
  assert.deepEqual(calls, ['input', 'core']);
});

test('real copied reader feeds the original mapping core and rejects late original-file replacement',
  { timeout: 90_000 }, async t => {
  process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE = '1';
  for (const mutate of [false, true]) {
    const f = await make(t, mutate ? { retainedSource: true, absent: true } : {});
    const fixture = { uid: process.getuid(), gid: process.getgid(), root: f.root,
      scratchParent: f.scratchParent, scratch: f.scratch };
    await rm(f.scratchParent, { recursive: true });
    const adminPublic = { caSha256: f.original.priorDigests.find(row =>
      row.path === 'ca.pem').sha256,
    adminSha256: f.original.priorDigests.find(row =>
      row.path === 'v1/admin.pem').sha256 };
    const counts = { core: 0, state: 0, snapshot: 0, recheck: 0,
      observer: 0, close: 0, admin: 0 };
    let inputBytes, expected, reached = false;
    const deps = {
      openInput: openWriterMappingPrepareInput,
      runCore: async (bytes, values, methods) => {
        counts.core++;
        inputBytes = Buffer.from(bytes);
        expected = values;
        return fixedWriterMappingPrepareCore(bytes, values, methods);
      },
      readState: async () => { counts.state++; return f.original.state; },
      readSnapshot: async () => { counts.snapshot++; return f.original.attested; },
      recheckSnapshot: async baseline => {
        counts.recheck++;
        assert.deepEqual(baseline, f.original.attested);
        if (mutate && counts.recheck === 8) {
          reached = true;
          const name = path.join(f.root, 'role-binding.json');
          const old = path.join(f.repository, 'role-binding-original');
          await rename(name, old);
          await copyFile(old, name);
          await chmod(name, 0o400);
          assert.deepEqual(await readFile(name), await readFile(old));
        }
        return true;
      },
      observe: () => readFixedWriterMappingObservation(async () => ({
        observe: async () => { counts.observer++; return f.original.pre; },
        close: async () => { counts.close++; },
      })),
      captureAdminPublic: async () => { counts.admin++; return {
        public: { ...adminPublic }, recheck: async () => true }; },
    };
    if (mutate) {
      await assert.rejects(() => runFixedWriterMappingPrepareJob(deps, fixture),
        { message: 'Private writer mapping preparation failed.' });
      assert.equal(reached, true);
      assert.equal(counts.recheck, 8);
    } else {
      const output = await runFixedWriterMappingPrepareJob(deps, fixture);
      const parsed = parseWriterMappingPrepareOutput(output, inputBytes, expected, adminPublic);
      assert.equal(parsed.sha256, f.original.sealed.sha256);
      assert.equal(counts.core, 1);
      assert.equal(counts.state, 5);
      assert.equal(counts.snapshot, 5);
      assert.equal(counts.observer, 5);
      assert.equal(counts.close, 5);
      assert.equal(counts.admin, 5);
      assert.equal(await (await f.open()).recheckInput(), true);
    }
  }
});
