import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildAttestorPublicFiles, canonicalAttestorValue } from
  '../../scripts/search-attestor-pure.mjs';
import { sealCreateIntent } from '../../scripts/search-create-intent-pure.mjs';
import { transferCreateApplyInputs } from '../../scripts/search-create-apply-transfer-core.mjs';
import { openCreateApplyInput } from '../../scripts/search-create-apply-input.mjs';
import { captureCreateIntentAdminVolume } from '../../scripts/search-create-intent-admin-volume.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const token = '11111111-1111-4111-8111-111111111111';
const index = `station-mail-v2-g${token.replaceAll('-', '')}`;
const dispatchId = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const invocationId = '55555555-5555-4555-8555-555555555555';

async function fixture(t, realCert = false) {
  await mkdir(path.resolve('.cache/results'), { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/results/create-apply-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {};
  for (const [key, filename] of [['intentFile', 'intent.json'],
    ['bindingFile', 'binding.json'], ['passwordFile', 'password']]) {
    const parent = path.join(root, key);
    await mkdir(parent, { mode: 0o755 });
    paths[key] = path.join(parent, filename);
  }
  paths.publicRoot = path.join(root, 'public');
  paths.volumeRoot = path.join(root, 'volume');
  await mkdir(paths.publicRoot, { mode: 0o700 });
  await mkdir(paths.volumeRoot, { mode: 0o755 });
  if (realCert) execFileSync(process.execPath,
    [path.resolve('scripts/init-search-security.mjs')],
    { cwd: root, stdio: 'ignore', timeout: 30_000 });
  const publicFiles = buildAttestorPublicFiles({ generations: [
    { token: 'legacy-v1', presence: 'exact' }] });
  const publicDigests = [];
  for (const [i, row] of publicFiles.entries()) {
    const name = path.join(paths.publicRoot, row.path);
    await mkdir(path.dirname(name), { recursive: true, mode: 0o700 });
    const bytes = realCert ? await readFile(path.join(root, '.cache/search-security',
      row.path === 'ca.pem' ? 'ca.pem' : path.basename(row.path))) :
      Buffer.from(`-----BEGIN CERTIFICATE-----\n${'A'.repeat(200 + i)}\n-----END CERTIFICATE-----\n`);
    await writeFile(name, bytes, { mode: 0o400 });
    publicDigests.push({ path: row.path, sha256: hash(bytes) });
  }
  const candidate = { generationToken: token, physicalIndex: index, profileId: 'station-mail-v2',
    indexUuid: null, lifecycle: 'reserved',
    writerRole: `station_indexer_${token.replaceAll('-', '')}`,
    queryRole: `station_query_${token.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${token.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${token.replaceAll('-', '')}`,
    writerCertFingerprint: null, queryCertFingerprint: null };
  const spec = searchGenerationDispatchSpec(candidate, 'create_index');
  const sealed = sealCreateIntent({ version: 1, revision: 2, stage: 'disabled_intent',
    transitionToken: '22222222-2222-4222-8222-222222222222',
    sourceToken: 'legacy-v1', sourceIndex: 'station-mail-v1', sourceUuid: 'legacy_uuid',
    candidateToken: token, candidateIndex: index, databaseOid: 16384,
    priorObservationDigest: 'a'.repeat(64), publicFiles,
    target: spec.target, bodyIdentity: spec.bodyIdentity }, publicDigests,
  { project: 'fixture', systemIdentifier: '123', dispatchId, ownerId });
  const binding = { version: 1, invocationId, approvedSha256: sealed.sha256,
    dispatchId, ownerId };
  await writeFile(paths.intentFile, canonicalAttestorValue(sealed.intent).bytes, { mode: 0o400 });
  await writeFile(paths.bindingFile, canonicalAttestorValue(binding).bytes, { mode: 0o400 });
  await writeFile(paths.passwordFile, 'A'.repeat(43), { mode: 0o400 });
  return { paths, sealed, publicFiles, root };
}

const opts = { fixture: true, creatorUid: process.getuid(), targetUid: process.getuid() };

test('fixed transfer copies only sealed input and prior public PEMs as 0400 files', async t => {
  const f = await fixture(t);
  assert.deepEqual(await transferCreateApplyInputs(f.paths, opts),
    { approvedSha256: f.sealed.sha256, invocationId });
  assert.deepEqual((await readFile(path.join(f.paths.volumeRoot, 'intent.json'))),
    canonicalAttestorValue(f.sealed.intent).bytes);
  const entries = await readdir(f.paths.volumeRoot);
  assert.deepEqual(entries.sort(), ['binding.json', 'intent.json', 'public', 'transition.password']);
  for (const name of ['intent.json', 'binding.json', 'transition.password',
    ...f.publicFiles.map(row => `public/${row.path}`)]) {
    const stat = await lstat(path.join(f.paths.volumeRoot, name));
    assert.equal(stat.mode & 0o777, 0o400);
    assert.equal(stat.uid, process.getuid());
  }
  for (const name of ['', 'public', 'public/v1']) {
    const stat = await lstat(path.join(f.paths.volumeRoot, name));
    assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(stat.uid, process.getuid());
  }
});

test('real public certificates survive transfer and mounted input rejects inode drift', async t => {
  const f = await fixture(t, true);
  await transferCreateApplyInputs(f.paths, opts);
  const scratch = path.join(f.root, 'scratch/.cache/search-create-apply');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const fixtureOwner = { ownerUid: process.getuid(), ownerGid: process.getgid() };
  await assert.rejects(openCreateApplyInput(f.paths.volumeRoot, scratch,
    { ...fixtureOwner, ownerUid: fixtureOwner.ownerUid + 1 }));
  process.env.STATION_CREATE_APPLY_FIXTURE = '1';
  let mounted;
  try {
    await assert.rejects(openCreateApplyInput(f.paths.volumeRoot, scratch,
      { ...fixtureOwner, ownerUid: fixtureOwner.ownerUid + 1 }));
    mounted = await openCreateApplyInput(f.paths.volumeRoot, scratch, fixtureOwner);
  } finally { delete process.env.STATION_CREATE_APPLY_FIXTURE; }
  assert.equal(await mounted.recheck(), true);
  assert.deepEqual(await mounted.capturePriorPublic(f.sealed.intent.publicFiles),
    f.sealed.intent.publicDigests);
  const adminVolume = path.join(f.root, 'admin-volume');
  await mkdir(adminVolume, { mode: 0o700 });
  for (const name of ['ca.pem', 'admin.pem', 'admin.key']) {
    await copyFile(path.join(f.root, '.cache/search-security', name),
      path.join(adminVolume, name));
    await chmod(path.join(adminVolume, name), 0o600);
  }
  const admin = await captureCreateIntentAdminVolume(adminVolume,
    { uid: process.getuid(), gid: process.getgid(), dirMode: 0o700,
      fileMode: 0o600 }, f.root);
  assert.equal(await admin.recheck(), true);
  const publicName = path.join(f.paths.volumeRoot, 'public/ca.pem');
  const bytes = await readFile(publicName);
  const replacement = `${publicName}.replacement`;
  await writeFile(replacement, bytes, { mode: 0o400 });
  await rename(replacement, publicName);
  await assert.rejects(mounted.recheck());
  const adminName = path.join(adminVolume, 'admin.key');
  const key = await readFile(adminName);
  await writeFile(`${adminName}.replacement`, key, { mode: 0o600 });
  await rename(`${adminName}.replacement`, adminName);
  await assert.rejects(admin.recheck());
});

test('extra source file, replaced PEM inode, and wrong binding fail closed', async t => {
  const extra = await fixture(t);
  await writeFile(path.join(extra.paths.publicRoot, 'ca.key'), 'secret', { mode: 0o400 });
  await assert.rejects(transferCreateApplyInputs(extra.paths, opts));
  const changed = await fixture(t);
  await assert.rejects(transferCreateApplyInputs(changed.paths, { ...opts,
    beforeWrite: async relative => {
      if (relative === 'binding.json') {
        const name = path.join(changed.paths.publicRoot, 'ca.pem');
        const bytes = await readFile(name);
        const other = `${name}.replacement`;
        await writeFile(other, bytes, { mode: 0o400 });
        await rename(other, name);
      }
    } }));
  const wrong = await fixture(t);
  await chmod(wrong.paths.bindingFile, 0o600);
  await assert.rejects(transferCreateApplyInputs(wrong.paths, opts));
  const partial = await fixture(t);
  await assert.rejects(transferCreateApplyInputs(partial.paths, { ...opts,
    beforeWrite: relative => {
      if (relative === 'public/ca.pem') throw Error('partial write');
    } }));
  assert.ok((await readdir(partial.paths.volumeRoot)).length > 0);
  await assert.rejects(transferCreateApplyInputs(partial.paths, opts));
});
