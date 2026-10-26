import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm,
  symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { ensureSearchGenerationIdentity } from '../../scripts/search-generation-identity.mjs';
import { stageAttestorPublic } from '../../scripts/search-attestor-public-staging.mjs';

const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const suffix = token.replaceAll('-', '');
const legacy = { token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
  presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
  writerPrincipal: null, queryPrincipal: null, writerCertFingerprint: null, queryCertFingerprint: null };
const fixedFiles = [
  { path: 'ca.pem', token: 'legacy-v1', role: 'ca', principal: 'station-search-ca', fingerprint: null },
  { path: 'v1/admin.pem', token: 'legacy-v1', role: 'admin', principal: 'station-search-admin', fingerprint: null },
  { path: 'v1/indexer.pem', token: 'legacy-v1', role: 'indexer', principal: 'station-search-indexer', fingerprint: null },
  { path: 'v1/query.pem', token: 'legacy-v1', role: 'query', principal: 'station-search-query', fingerprint: null },
];
const denied = work => assert.rejects(work, { message: 'Private search attestor public staging failed.' });

async function fixture(t, v2 = false) {
  await mkdir(resolve('.cache/results'), { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(resolve('.cache/results/search-attestor-stage-'));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const cache = join(parent, '.cache');
  await mkdir(cache, { mode: 0o700 });
  execFileSync(process.execPath, [resolve('scripts/init-search-security.mjs')],
    { cwd: parent, stdio: 'ignore', timeout: 30_000 });
  await chmod(cache, 0o755); // Existing owner cache may be traversable.
  const v1Root = join(cache, 'search-security');
  const generationsRoot = join(cache, 'search-generations');
  const destinationParent = join(cache, 'search-attestor-public');
  await mkdir(destinationParent, { mode: 0o700 });
  const expected = { version: 'station-generation-registry-v1', generations: [legacy] };
  const files = [...fixedFiles];
  if (v2) {
    const certs = await ensureSearchGenerationIdentity(token,
      { v1Root, outputRoot: generationsRoot });
    expected.generations.push({ token, index: `station-mail-v2-g${suffix}`,
      profile: 'station-mail-v2', presence: 'exact', uuid: 'v2_uuid',
      writerRole: `station_indexer_${suffix}`, queryRole: `station_query_${suffix}`,
      writerPrincipal: certs.writerPrincipal, queryPrincipal: certs.queryPrincipal,
      writerCertFingerprint: certs.writerCertFingerprint,
      queryCertFingerprint: certs.queryCertFingerprint });
    files.push({ path: `generations/${suffix}/writer.pem`, token, role: 'writer',
      principal: certs.writerPrincipal, fingerprint: certs.writerCertFingerprint });
    files.push({ path: `generations/${suffix}/query.pem`, token, role: 'query',
      principal: certs.queryPrincipal, fingerprint: certs.queryCertFingerprint });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { version: 'station-attestor-manifest-v1', invocationId,
    rawDigest: 'a'.repeat(64), identity: { sessionUser: 'station_search_verifier',
      currentUser: 'station_search_verifier', database: 'station', databaseOid: 1,
      databaseOwner: 'station' }, expected, publicFiles: files };
  const input = { v1Root, generationsRoot, destinationParent, invocationId, manifest };
  return { parent, input };
}

test('stages only public v1 and exact v2 files, rechecks and cleans owned output', async t => {
  const { input } = await fixture(t, true);
  for (const name of ['ca', 'node', 'admin', 'query', 'indexer', 'outsider'])
    await chmod(join(input.v1Root, `${name}.key`), 0o000);
  for (const name of ['writer', 'query'])
    await chmod(join(input.generationsRoot, suffix, `${name}.key`), 0o000);
  const staged = await stageAttestorPublic(input);
  assert.deepEqual((await readdir(staged.root)).sort(), ['ca.pem', 'generations', 'v1']);
  assert.deepEqual((await readdir(join(staged.root, 'generations', suffix))).sort(),
    ['query.pem', 'writer.pem']);
  for (const row of input.manifest.publicFiles) {
    const output = join(staged.root, row.path);
    assert.equal((await lstat(output)).mode & 0o777, 0o400);
  }
  assert.equal(await staged.recheck(), true);
  assert.equal(await staged.cleanup(), true);
  await denied(() => staged.recheck());
  assert.deepEqual(await readdir(input.destinationParent), []);
});

test('legacy and absent generation contribute only fixed v1 public paths', async t => {
  const { input } = await fixture(t);
  input.manifest.expected.generations.push({ token, index: `station-mail-v2-g${suffix}`,
    profile: 'station-mail-v2', presence: 'absent', uuid: null,
    writerRole: `station_indexer_${suffix}`, queryRole: `station_query_${suffix}`,
    writerPrincipal: `station-search-indexer-${suffix}`,
    queryPrincipal: `station-search-query-${suffix}`,
    writerCertFingerprint: null, queryCertFingerprint: null });
  const staged = await stageAttestorPublic(input);
  assert.deepEqual((await readdir(staged.root)).sort(), ['ca.pem', 'v1']);
  await staged.cleanup();
});

test('bad fingerprints, missing source and unsafe source types fail before destination', async t => {
  for (const kind of ['fingerprint', 'missing', 'symlink', 'hardlink', 'fifo', 'oversize']) {
    const { input, parent } = await fixture(t, true);
    const source = join(input.generationsRoot, suffix, 'writer.pem');
    if (kind === 'fingerprint') {
      input.manifest.expected.generations[1].writerCertFingerprint = '0'.repeat(64);
      input.manifest.publicFiles.find(row => row.role === 'writer').fingerprint = '0'.repeat(64);
    }
    if (kind === 'missing') await rm(source);
    if (kind === 'symlink') { await rm(source); await symlink(join(input.v1Root, 'ca.key'), source); }
    if (kind === 'hardlink') await link(source, join(parent, 'linked.pem'));
    if (kind === 'fifo') { await rm(source); execFileSync('mkfifo', [source]); }
    if (kind === 'oversize') { await writeFile(source, 'A'.repeat(16_385)); }
    await denied(() => stageAttestorPublic(input));
    assert.deepEqual(await readdir(input.destinationParent), []);
  }
});

test('source drift and destination collisions remain explicit failures', async t => {
  const { input, parent } = await fixture(t);
  const source = join(input.v1Root, 'query.pem');
  const original = await readFile(source);
  await denied(() => stageAttestorPublic(input, { beforeWrite: async name => {
    if (name === 'ca.pem') { await rename(source, join(parent, 'old-query.pem'));
      await writeFile(source, original, { mode: 0o600 }); }
  } }));
  assert.ok((await readdir(input.destinationParent)).length, 'uncertain partial tree retained');
  await denied(() => stageAttestorPublic(input));
  const second = await fixture(t);
  const staged = await stageAttestorPublic(second.input);
  await writeFile(join(staged.root, 'extra'), 'extra', { mode: 0o400 });
  await denied(() => staged.recheck());
  await denied(() => staged.cleanup());
  assert.ok((await lstat(join(staged.root, 'extra'))).isFile());
  const third = await fixture(t);
  const local = await stageAttestorPublic(third.input);
  await rm(join(third.input.v1Root, 'query.pem'));
  await denied(() => local.recheck());
  assert.equal(await local.cleanup(), true, 'owned output cleanup tolerates source loss');
  const fourth = await fixture(t);
  const replaced = await stageAttestorPublic(fourth.input);
  const movedOriginal = join(fourth.parent, 'original-staged');
  await rename(replaced.root, movedOriginal);
  await mkdir(replaced.root, { mode: 0o700 });
  await denied(() => replaced.cleanup());
  assert.ok((await readdir(movedOriginal)).includes('ca.pem'), 'original evidence retained');
  assert.deepEqual(await readdir(replaced.root), [], 'replacement path retained');
});

test('wrong client purpose, expired certificate and output byte drift fail closed', async t => {
  const { input, parent } = await fixture(t);
  const makeLeaf = (name, days) => {
    const key = join(parent, `${name}.key`), csr = join(parent, `${name}.csr`);
    const pem = join(parent, `${name}.pem`), ext = join(parent, `${name}.ext`);
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj',
      '/CN=station-search-query', '-keyout', key, '-out', csr], { stdio: 'ignore' });
    execFileSync('openssl', ['x509', '-req', '-sha256', '-days', String(days), '-in', csr,
      '-CA', join(input.v1Root, 'ca.pem'), '-CAkey', join(input.v1Root, 'ca.key'),
      '-set_serial', '0x12345678', '-extfile', ext, '-out', pem], { stdio: 'ignore' });
    return pem;
  };
  const source = join(input.v1Root, 'query.pem');
  const original = await readFile(source);
  const ext = join(parent, 'purpose.ext');
  await writeFile(ext, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  const purpose = makeLeaf('purpose', 365);
  await writeFile(source, await readFile(purpose));
  await denied(() => stageAttestorPublic(input));
  await writeFile(source, original);
  await writeFile(join(parent, 'expired.ext'),
    'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n');
  // OpenSSL -days 0 creates a certificate whose validity ends immediately.
  const expired = makeLeaf('expired', 0);
  await writeFile(source, await readFile(expired));
  await denied(() => stageAttestorPublic(input));
  await writeFile(source, original);
  const staged = await stageAttestorPublic(input);
  await chmod(join(staged.root, 'ca.pem'), 0o600);
  await writeFile(join(staged.root, 'ca.pem'), Buffer.alloc(original.length, 0));
  await chmod(join(staged.root, 'ca.pem'), 0o400);
  await denied(() => staged.recheck());
  await denied(() => staged.cleanup());
});

test('source or staged output mutation during final purpose check cannot report success', async t => {
  for (const target of ['source', 'output']) {
    const { input } = await fixture(t);
    let calls = 0;
    const output = join(input.destinationParent, invocationId, 'ca.pem');
    const source = join(input.v1Root, 'ca.pem');
    await denied(() => stageAttestorPublic(input, { purposeExec: async () => {
      calls++;
      if (calls === 2) {
        const path = target === 'source' ? source : output;
        await chmod(path, 0o600);
        await writeFile(path, Buffer.alloc((await readFile(path)).length, 0));
        if (target === 'output') await chmod(path, 0o400);
      }
      return { stdout: '', stderr: '' };
    } }));
    assert.equal(calls, 2);
    assert.ok((await readdir(input.destinationParent)).includes(invocationId));
  }
});

test('initial staging keeps one monotonic deadline; later operations get fresh budgets', async t => {
  process.env.STATION_ATTESTOR_STAGING_FIXTURE = '1';
  try {
    const { input } = await fixture(t);
    let elapsed = 0, purposeCalls = 0;
    await denied(() => stageAttestorPublic(input, {
      fixtureNow: () => elapsed,
      beforeWrite: name => { if (name === 'v1/query.pem') elapsed = 20_000; },
      purposeExec: async () => {
        if (++purposeCalls === 2) elapsed = 30_000;
        return { stdout: '', stderr: '' };
      },
    }));
    assert.equal(purposeCalls, 2, 'final purpose check crossed the original deadline');
    assert.ok((await readdir(input.destinationParent)).includes(invocationId),
      'expired staged tree is retained for diagnosis');

    const later = await fixture(t);
    elapsed = 0;
    const staged = await stageAttestorPublic(later.input, { fixtureNow: () => elapsed });
    elapsed = 1_000_000;
    assert.equal(await staged.recheck(), true);
    elapsed = 2_000_000;
    assert.equal(await staged.cleanup(), true);
  } finally { delete process.env.STATION_ATTESTOR_STAGING_FIXTURE; }
});
