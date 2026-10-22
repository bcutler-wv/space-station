import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { transferAttestorInputs, productionTransferPaths } from '../../scripts/search-attestor-transfer-core.mjs';
import { validateOfflineAttestorManifest } from '../../scripts/search-attestor-pure.mjs';

const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const names = ['ca.pem', 'v1/admin.pem', 'v1/indexer.pem', 'v1/query.pem'];
const identity = { sessionUser: 'station_search_verifier', currentUser: 'station_search_verifier',
  database: 'station', databaseOid: 1, databaseOwner: 'station' };
const legacy = { token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
  presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
  writerPrincipal: null, queryPrincipal: null, writerCertFingerprint: null, queryCertFingerprint: null };
const publicFiles = [
  { path: 'ca.pem', token: 'legacy-v1', role: 'ca', principal: 'station-search-ca', fingerprint: null },
  { path: 'v1/admin.pem', token: 'legacy-v1', role: 'admin', principal: 'station-search-admin', fingerprint: null },
  { path: 'v1/indexer.pem', token: 'legacy-v1', role: 'indexer', principal: 'station-search-indexer', fingerprint: null },
  { path: 'v1/query.pem', token: 'legacy-v1', role: 'query', principal: 'station-search-query', fingerprint: null },
];
const manifest = () => ({ version: 'station-attestor-manifest-v1', invocationId,
  rawDigest: 'a'.repeat(64), identity, expected: { version: 'station-generation-registry-v1',
    generations: [legacy] }, publicFiles });

async function fixture(t) {
  await mkdir(resolve('.cache/results'), { recursive: true });
  const root = await mkdtemp(resolve('.cache/results/search-attestor-transfer-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const dirs = ['password', 'invocation', 'manifest', 'public', 'public/v1', 'output'];
  for (const name of dirs) await mkdir(join(root, name), { mode: name === 'output' ? 0o755 : 0o700 });
  const input = { passwordFile: join(root, 'password', 'password'),
    invocationFile: join(root, 'invocation', 'invocation'),
    manifestFile: join(root, 'manifest', 'manifest.json'),
    publicDirectory: join(root, 'public'), outputDirectory: join(root, 'output') };
  const password = randomBytes(32).toString('base64url');
  await writeFile(input.passwordFile, password, { mode: 0o600 });
  await writeFile(input.invocationFile, `${invocationId}\n`, { mode: 0o400 });
  await writeFile(input.manifestFile, `${JSON.stringify(manifest())}\n`, { mode: 0o600 });
  for (const name of names) await writeFile(join(input.publicDirectory, name),
    `-----BEGIN CERTIFICATE-----\n${'A'.repeat(120)}\n-----END CERTIFICATE-----\n`, { mode: 0o400 });
  return { input, password, options: { initialUid: process.getuid(), initialGid: process.getgid(),
    inputParentUid: process.getuid(), inputParentGid: process.getgid(), inputParentMode: 0o700,
    targetUid: process.getuid(), targetGid: process.getgid() } };
}
async function denied(work, secret) {
  await assert.rejects(work, error => error.message === 'Private search attestor transfer failed.' &&
    !error.message.includes(secret));
}

test('fixed offline copy preserves sources and creates exact private consumer layout', async t => {
  const { input, password, options } = await fixture(t);
  const before = await Promise.all([input.passwordFile, input.invocationFile, input.manifestFile,
    ...names.map(name => join(input.publicDirectory, name))]
    .map(async path => ({ path, stat: await lstat(path), bytes: await readFile(path) })));
  await denied(() => transferAttestorInputs(input), password); // production requires root-owned single-file mount parents
  assert.equal(await transferAttestorInputs(input, options), true);
  assert.deepEqual((await readdir(input.outputDirectory)).sort(), ['invocation', 'manifest', 'password', 'public']);
  for (const name of ['password', 'invocation', 'manifest/manifest.json', ...names.map(x => `public/${x}`)]) {
    const path = join(input.outputDirectory, name);
    assert.equal((await lstat(path)).mode & 0o777, name === 'manifest/manifest.json' ? 0o600 : 0o400);
    assert.equal((await lstat(path)).uid, process.getuid());
  }
  for (const name of ['.', 'manifest', 'public', 'public/v1'])
    assert.equal((await lstat(join(input.outputDirectory, name))).mode & 0o777, 0o700);
  assert.ok((await readFile(join(input.outputDirectory, 'password'))).equals(Buffer.from(password)),
    'copied verifier password bytes changed');
  for (const item of before) {
    const after = await lstat(item.path);
    assert.equal(after.ino, item.stat.ino);
    assert.equal(after.mode, item.stat.mode);
    assert.ok((await readFile(item.path)).equals(item.bytes), 'source bytes changed');
  }
  await denied(() => transferAttestorInputs(input, options), password);
});

test('offline shape helper binds invocation, digest spelling and derived public list', () => {
  assert.equal(validateOfflineAttestorManifest(invocationId, manifest()).invocationId, invocationId);
  for (const mutate of [
    value => { value.invocationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; },
    value => { value.rawDigest = value.rawDigest.toUpperCase(); },
    value => { value.publicFiles.pop(); },
    value => { value.publicFiles.push({ ...value.publicFiles[0], path: 'extra.pem' }); },
    value => { value.expected.generations[0].presence = 'absent'; },
  ]) {
    const changed = JSON.parse(JSON.stringify(manifest()));
    mutate(changed);
    assert.throws(() => validateOfflineAttestorManifest(invocationId, changed));
  }
});

test('offline transfer rejects unexpected input, mode, link and type without cleaning unknown output', async t => {
  for (const kind of ['extra', 'input-extra', 'missing', 'mode', 'symlink', 'hardlink', 'fifo', 'oversize', 'invocation']) {
    const { input, password, options } = await fixture(t);
    const target = join(input.publicDirectory, 'v1/query.pem');
    if (kind === 'extra') await writeFile(join(input.publicDirectory, 'secret.key'), 'unexpected');
    if (kind === 'input-extra') await writeFile(join(dirname(input.invocationFile), 'extra'), 'unexpected');
    if (kind === 'missing') await rm(target);
    if (kind === 'mode') await chmod(target, 0o644);
    if (kind === 'symlink') { await rm(target); await symlink(input.passwordFile, target); }
    if (kind === 'hardlink') await link(target, join(dirname(input.publicDirectory), 'linked.pem'));
    if (kind === 'fifo') { await rm(target); execFileSync('mkfifo', [target]); }
    if (kind === 'oversize') { await chmod(target, 0o600); await writeFile(target, 'A'.repeat(16_385)); await chmod(target, 0o400); }
    if (kind === 'invocation') { await chmod(input.invocationFile, 0o600);
      await writeFile(input.invocationFile, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\n'); await chmod(input.invocationFile, 0o400); }
    await denied(() => transferAttestorInputs(input, options), password);
    assert.deepEqual(await readdir(input.outputDirectory), []);
  }
});

test('partial write remains owned evidence and source replacement is rejected', async t => {
  const { input, password, options } = await fixture(t);
  await denied(() => transferAttestorInputs(input, { ...options,
    beforeWrite: relative => { if (relative === 'invocation') throw new Error('injected secret marker'); } }), password);
  assert.ok((await readdir(input.outputDirectory)).length > 0);
  await denied(() => transferAttestorInputs(input, options), password);
  const second = await fixture(t);
  let replacement;
  await denied(() => transferAttestorInputs(second.input, { ...second.options,
    beforeWrite: async relative => {
      if (relative === 'public/ca.pem') {
        replacement = join(second.input.publicDirectory, 'ca.old');
        await rename(join(second.input.publicDirectory, 'ca.pem'), replacement);
        await writeFile(join(second.input.publicDirectory, 'ca.pem'),
          `-----BEGIN CERTIFICATE-----\n${'B'.repeat(120)}\n-----END CERTIFICATE-----\n`, { mode: 0o400 });
      }
    } }), second.password);
  assert.ok(replacement);
});

test('production wrapper has no caller path, owner or destination options', () => {
  assert.deepEqual(productionTransferPaths, {
    passwordFile: '/run/search-transfer-password/password',
    invocationFile: '/run/search-transfer-invocation/invocation',
    manifestFile: '/run/search-transfer-manifest/manifest.json',
    publicDirectory: '/run/search-transfer-public', outputDirectory: '/run/search-attestor',
  });
  const wrapper = spawnSync(process.execPath, ['scripts/search-attestor-transfer.mjs', '--destination', '/tmp'],
    { encoding: 'utf8', timeout: 5_000 });
  assert.equal(wrapper.status, 1);
  assert.equal(wrapper.stderr, 'Private search attestor transfer failed.\n');
  assert.equal(wrapper.stdout, '');
});

test('injected generated secret cannot escape child failure diagnostics', async t => {
  const { input, password, options } = await fixture(t);
  const childCode = `
    import { transferAttestorInputs } from './scripts/search-attestor-transfer-core.mjs';
    try {
      await transferAttestorInputs(JSON.parse(process.argv[1]), {
        ...JSON.parse(process.argv[2]),
        beforeWrite: relative => {
          if (relative === 'invocation') throw new Error(process.env.FIXTURE_GENERATED_SECRET);
        },
      });
    } catch (error) {
      process.stderr.write(error.message + '\\n');
      process.exitCode = 1;
    }
  `;
  const child = spawnSync(process.execPath,
    ['--input-type=module', '--eval', childCode, JSON.stringify(input), JSON.stringify(options)],
    { encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, FIXTURE_GENERATED_SECRET: password } });
  const emitted = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  assert.ok(child.status === 1, 'injected child must fail');
  assert.ok(!emitted.includes(password), 'generated verifier secret reached diagnostics');
  assert.ok(!emitted.includes(Buffer.from(password).toString('hex')),
    'encoded generated verifier secret reached diagnostics');
  assert.ok(child.stdout === '', 'failure emitted stdout');
  assert.ok(child.stderr === 'Private search attestor transfer failed.\n',
    'failure diagnostics changed');
});
