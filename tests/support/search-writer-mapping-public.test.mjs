import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm,
  symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { ensureSearchGenerationIdentity } from '../../scripts/search-generation-identity.mjs';
import { captureCandidateWriterPublic } from '../../scripts/search-writer-mapping-public.mjs';

const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const suffix = token.replaceAll('-', '');
const denied = work => assert.rejects(work,
  { message: 'Private writer mapping public capture failed.' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const command = (name, args, cwd) => {
  const result = spawnSync(name, args, { cwd, timeout: 30_000, maxBuffer: 16_384,
    stdio: 'ignore' });
  assert.equal(result.status, 0);
};

async function fixture(t) {
  await mkdir(path.resolve('.cache/results'), { recursive: true });
  const repository = await mkdtemp(path.resolve('.cache/results/writer-public-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  command(process.execPath, [path.resolve('scripts/init-search-security.mjs')], repository);
  const cache = path.join(repository, '.cache');
  const security = path.join(cache, 'search-security');
  const generations = path.join(cache, 'search-generations');
  const signerResult = await ensureSearchGenerationIdentity(token,
    { v1Root: security, outputRoot: generations });
  const candidate = path.join(generations, suffix);
  const scratch = path.join(cache, 'search-writer-mapping-public');
  await mkdir(scratch, { mode: 0o700 });
  const input = { repository, uid: process.getuid(), gid: process.getgid(),
    candidateToken: token, signerResult };
  return { input, cache, security, generations, candidate, scratch,
    writer: path.join(candidate, 'writer.pem'), ca: path.join(security, 'ca.pem') };
}

test('real signer public reader captures two immutable PEMs and never reads private keys',
  { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const sibling = path.join(f.generations, 'bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb');
  await mkdir(sibling, { mode: 0o700 });
  await writeFile(path.join(sibling, 'retained'), 'untouched');
  const writerKey = path.join(f.candidate, 'writer.key');
  const queryKey = path.join(f.candidate, 'query.key');
  const queryBytes = await readFile(path.join(f.candidate, 'query.pem'));
  const caBytes = await readFile(f.ca);
  await chmod(writerKey, 0o000);
  await chmod(queryKey, 0o000);
  try {
    await assert.rejects(readFile(writerKey), { code: 'EACCES' });
    await assert.rejects(readFile(queryKey), { code: 'EACCES' });
    const result = await captureCandidateWriterPublic(f.input);
    const logical = `generations/${suffix}/writer.pem`;
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.publicDigests), true);
    assert.equal(Object.isFrozen(result.publicDigests[0]), true);
    assert.equal(result.writerPrincipal, f.input.signerResult.writerPrincipal);
    assert.equal(result.writerCertFingerprint, f.input.signerResult.writerCertFingerprint);
    const originalWriter = await readFile(f.writer);
    assert.deepEqual(result.publicDigests, [
      { path: 'ca.pem', sha256: digest(caBytes) },
      { path: logical, sha256: digest(originalWriter) },
    ]);
    const returned = result.publicBytes();
    assert.deepEqual([...returned.keys()], ['ca.pem', logical]);
    returned.get(logical).fill(0);
    assert.deepEqual(result.publicBytes().get(logical), originalWriter);
    assert.equal(await result.recheck(), true);
    assert.deepEqual(await readFile(path.join(f.candidate, 'query.pem')), queryBytes);
    assert.deepEqual(await readFile(f.ca), caBytes);
    assert.deepEqual(await readdir(f.scratch), []);
    assert.deepEqual(await readdir(sibling), ['retained']);
    assert.equal(await readFile(path.join(sibling, 'retained'), 'utf8'), 'untouched');
  } finally {
    await chmod(writerKey, 0o600);
    await chmod(queryKey, 0o600);
  }
});

test('capture retains the original signer fields when caller input changes during a public read',
  { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const originalPrincipal = f.input.signerResult.writerPrincipal;
  const originalFingerprint = f.input.signerResult.writerCertFingerprint;
  const originalOpen = fs.promises.open;
  let reached = false;
  try {
    fs.promises.open = async (name, ...args) => {
      const handle = await originalOpen(name, ...args);
      if (name === f.ca && !reached) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          reached = true;
          f.input.candidateToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
          f.input.signerResult.writerPrincipal = 'changed';
          f.input.signerResult.writerCertFingerprint = '0'.repeat(64);
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const captured = await captureCandidateWriterPublic(f.input);
    assert.equal(reached, true);
    assert.equal(captured.candidateToken, token);
    assert.equal(captured.writerPrincipal, originalPrincipal);
    assert.equal(captured.writerCertFingerprint, originalFingerprint);
    assert.equal(await captured.recheck(), true);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('descriptor-safe signer binding rejects forged public identities before file access',
  { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  let getterCalls = 0;
  const hostile = { ...f.input };
  Object.defineProperty(hostile, 'signerResult', { enumerable: true,
    get() { getterCalls++; throw Error('private'); } });
  await denied(() => captureCandidateWriterPublic(hostile));
  assert.equal(getterCalls, 0);
  for (const input of [
    { ...f.input, candidateToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    { ...f.input, signerResult: { ...f.input.signerResult,
      writerPrincipal: 'station-search-indexer-wrong' } },
    { ...f.input, signerResult: { ...f.input.signerResult,
      writerCertFingerprint: '0'.repeat(64) } },
    { ...f.input, signerResult: { ...f.input.signerResult, extra: true } },
  ]) await denied(() => captureCandidateWriterPublic(input));
});

test('recheck pins original file and directory inodes, bytes and exact inventory',
  { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const writerBytes = await readFile(f.writer);
  const first = await captureCandidateWriterPublic(f.input);
  const moved = path.join(f.cache, 'original-writer.pem');
  await rename(f.writer, moved);
  await copyFile(moved, f.writer);
  await denied(() => first.recheck());
  await rm(f.writer); await rename(moved, f.writer);
  await denied(() => first.recheck());
  const afterFile = await captureCandidateWriterPublic(f.input);
  assert.equal(await afterFile.recheck(), true);

  const oldCandidate = path.join(f.cache, 'old-candidate');
  await rename(f.candidate, oldCandidate);
  await mkdir(f.candidate, { mode: 0o700 });
  for (const name of ['query.key', 'query.pem', 'writer.key', 'writer.pem'])
    await copyFile(path.join(oldCandidate, name), path.join(f.candidate, name));
  await denied(() => afterFile.recheck());
  await rm(f.candidate, { recursive: true }); await rename(oldCandidate, f.candidate);
  assert.equal(await afterFile.recheck(), true);
  const afterDirectory = await captureCandidateWriterPublic(f.input);
  assert.equal(await afterDirectory.recheck(), true);

  await writeFile(path.join(f.candidate, 'unexpected'), 'x');
  await denied(() => afterDirectory.recheck());
  await rm(path.join(f.candidate, 'unexpected'));
  assert.equal(await afterDirectory.recheck(), true);
  await chmod(f.input.repository, 0o770);
  await denied(() => afterDirectory.recheck());
  await chmod(f.input.repository, 0o700);
  assert.equal(await afterDirectory.recheck(), true);
  const oldCa = path.join(f.cache, 'old-ca.pem');
  await rename(f.ca, oldCa); await copyFile(oldCa, f.ca);
  await denied(() => afterDirectory.recheck());
  await rm(f.ca); await rename(oldCa, f.ca);
  assert.deepEqual(await readFile(f.writer), writerBytes);
});

test('recheck rejects inventory added after the CA read and before the writer read',
  { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const captured = await captureCandidateWriterPublic(f.input);
  const originalOpen = fs.promises.open;
  let reached = false;
  try {
    fs.promises.open = async (name, ...args) => {
      const handle = await originalOpen(name, ...args);
      if (name === f.ca && !reached) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          reached = true;
          await writeFile(path.join(f.candidate, 'unexpected'), 'x');
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    await denied(() => captured.recheck());
    assert.equal(reached, true);
    assert.equal((await readdir(f.candidate)).includes('unexpected'), true);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('unsafe PEM source, scratch and certificate evidence reject without key access',
  { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const original = await readFile(f.writer);
  const movedQuery = path.join(f.cache, 'saved-query.pem');
  await rename(path.join(f.candidate, 'query.pem'), movedQuery);
  await denied(() => captureCandidateWriterPublic(f.input));
  await rename(movedQuery, path.join(f.candidate, 'query.pem'));
  const old = path.join(f.cache, 'saved-writer.pem');
  const restore = async () => { await rm(f.writer, { force: true }); await rename(old, f.writer); };
  await rename(f.writer, old);
  await symlink('query.pem', f.writer);
  await denied(() => captureCandidateWriterPublic(f.input));
  await restore();
  await link(f.writer, path.join(f.candidate, 'extra'));
  await denied(() => captureCandidateWriterPublic(f.input));
  await rm(path.join(f.candidate, 'extra'));
  await link(f.writer, path.join(f.cache, 'outside-hardlink'));
  await denied(() => captureCandidateWriterPublic(f.input));
  await rm(path.join(f.cache, 'outside-hardlink'));
  await rename(f.writer, old); await writeFile(f.writer, Buffer.alloc(16_385), { mode: 0o600 });
  await denied(() => captureCandidateWriterPublic(f.input));
  await restore();
  await rename(f.writer, old); await copyFile(path.join(f.candidate, 'query.pem'), f.writer);
  await denied(() => captureCandidateWriterPublic(f.input));
  await restore();
  assert.deepEqual(await readFile(f.writer), original);
  await rm(f.scratch, { recursive: true });
  await denied(() => captureCandidateWriterPublic(f.input));
  await mkdir(f.scratch, { mode: 0o700 });
  await chmod(f.scratch, 0o755);
  await denied(() => captureCandidateWriterPublic(f.input));
  await chmod(f.scratch, 0o700);
  assert.equal((await captureCandidateWriterPublic(f.input)).writerPrincipal,
    f.input.signerResult.writerPrincipal);
});

test('real certificate policy rejects same-name server-only and wrong-issuer leaves',
  { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const saved = path.join(f.cache, 'saved-certificate.pem');
  const csr = path.join(f.cache, 'writer.csr');
  const ext = path.join(f.cache, 'writer.ext');
  const key = path.join(f.candidate, 'writer.key');
  command('openssl', ['req', '-new', '-key', key,
    '-subj', `/CN=${f.input.signerResult.writerPrincipal}`, '-out', csr], f.input.repository);
  await rename(f.writer, saved);
  const attempt = async () => {
    const certificate = new X509Certificate(await readFile(f.writer));
    const signerResult = { ...f.input.signerResult,
      writerCertFingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase() };
    await denied(() => captureCandidateWriterPublic({ ...f.input, signerResult }));
  };
  try {
    await writeFile(ext,
      'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    command('openssl', ['x509', '-req', '-sha256', '-days', '30', '-in', csr,
      '-CA', f.ca, '-CAkey', path.join(f.security, 'ca.key'), '-set_serial',
      '0x11223344556677889900', '-extfile', ext, '-out', f.writer], f.input.repository);
    await chmod(f.writer, 0o600);
    await attempt();
    await rm(f.writer);
    await writeFile(ext,
      'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n');
    command('openssl', ['x509', '-req', '-sha256', '-days', '0', '-in', csr,
      '-CA', f.ca, '-CAkey', path.join(f.security, 'ca.key'), '-set_serial',
      '0x11223344556677889901', '-extfile', ext, '-out', f.writer], f.input.repository);
    await chmod(f.writer, 0o600);
    await attempt();
    await rm(f.writer);
    command('openssl', ['req', '-new', '-x509', '-key', key,
      '-subj', `/CN=${f.input.signerResult.writerPrincipal}`, '-days', '30',
      '-out', f.writer], f.input.repository);
    await chmod(f.writer, 0o600);
    await attempt();
  } finally {
    await rm(f.writer, { force: true });
    await rename(saved, f.writer);
  }
  assert.equal((await captureCandidateWriterPublic(f.input)).writerPrincipal,
    f.input.signerResult.writerPrincipal);
});
