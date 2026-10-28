import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { setTimeout } from 'node:timers';
import { buildAttestorPublicFiles } from '../../scripts/search-attestor-pure.mjs';
import { captureCreateIntentPublic } from '../../scripts/search-create-intent-public.mjs';
import { issueExpiredAdmin } from './search-create-intent-gate-expired-admin.mjs';

test('disposable expired admin leaf keeps CA signature, admin key and client profile', async t => {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache/results/intent-expired-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setup = spawnSync(process.execPath, [path.resolve('scripts/init-search-security.mjs')],
    { cwd: root, stdio: 'ignore', timeout: 30_000 });
  assert.equal(setup.status, 0);
  const source = path.join(root, '.cache/search-security');
  const scratch = path.join(root, '.cache/search-create-intent-fixture');
  await mkdir(scratch, { mode: 0o700 });
  const run = async args => {
    const result = spawnSync('openssl', args, { stdio: 'ignore', timeout: 30_000 });
    assert.equal(result.status, 0);
  };
  const expired = await issueExpiredAdmin(source, scratch, run);
  const certificate = new X509Certificate(await readFile(expired));
  const ca = new X509Certificate(await readFile(path.join(source, 'ca.pem')));
  assert.equal(certificate.subject, 'CN=station-search-admin');
  assert.equal(certificate.issuer, 'CN=station-search-ca');
  assert.equal(certificate.verify(ca.publicKey), true);
  assert.equal(certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(
    createPublicKey(await readFile(path.join(source, 'admin.key')))
      .export({ type: 'spki', format: 'der' })), true);
  for (const [extension, expected] of [
    ['basicConstraints', 'CA:FALSE'],
    ['keyUsage', 'Digital Signature'],
    ['extendedKeyUsage', 'TLS Web Client Authentication'],
  ]) {
    const result = spawnSync('openssl', ['x509', '-in', expired, '-noout', '-ext', extension],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes(expected), true);
  }
  const check = spawnSync('openssl', ['x509', '-in', expired, '-checkend', '1', '-noout'],
    { stdio: 'ignore', timeout: 30_000 });
  assert.notEqual(check.status, 0);
  if (Date.parse(certificate.validTo) >= Date.now())
    await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.ok(Date.parse(certificate.validTo) < Date.now());
  assert.deepEqual(await readdir(scratch), ['intent-expired-admin.pem']);
  const pendingRoot = path.join(root, '.cache/search-create-intent');
  await mkdir(pendingRoot, { mode: 0o700 });
  const files = buildAttestorPublicFiles({ generations: [{ token: 'legacy-v1', presence: 'exact' }] });
  const valid = await captureCreateIntentPublic({ repository: root,
    uid: process.getuid(), gid: process.getgid(), files, scratchRoot: pendingRoot });
  assert.equal(await valid.recheck(), true);
  const name = path.join(source, 'admin.pem'), moved = `${name}.original`;
  await rename(name, moved);
  await copyFile(expired, name);
  await assert.rejects(() => captureCreateIntentPublic({ repository: root,
    uid: process.getuid(), gid: process.getgid(), files, scratchRoot: pendingRoot }),
  { message: 'Private create intent public capture failed.' });
});
