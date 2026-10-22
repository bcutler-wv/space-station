import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { ensureSearchGenerationIdentity } from '../../scripts/search-generation-identity.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const initV1 = fileURLToPath(new URL('../../scripts/init-search-security.mjs', import.meta.url));
const initGeneration = fileURLToPath(new URL('../../scripts/init-search-generation-identity.mjs', import.meta.url));
const run = (command, args, cwd, timeout = 30_000) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16_384 });
  assert.equal(result.error, undefined, `Fixture subprocess could not start: ${command}`);
  assert.equal(result.status, 0, `Fixture subprocess failed: ${command}`);
  return result.stdout;
};
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const tokenPath = token => token.replaceAll('-', '').toLowerCase();

await mkdir(join(repo, '.cache/results'), { recursive: true });
const fixture = await mkdtemp(join(repo, '.cache/results/p2b1-signer-'));
try {
  run(process.execPath, [initV1], fixture, 60_000);
  const v1Root = join(fixture, '.cache/search-security');
  const outputRoot = join(fixture, '.cache/search-generations');
  const v1Names = (await readdir(v1Root)).sort();
  const v1Digests = await Promise.all(v1Names.map(name => digest(join(v1Root, name))));
  const one = randomUUID(), two = randomUUID();
  const denyOverlap = async (outputRoot, label) => {
    await assert.rejects(ensureSearchGenerationIdentity(one, { v1Root, outputRoot }),
      /overlaps frozen v1 identity root/, label);
    assert.deepEqual((await readdir(v1Root)).sort(), v1Names, `${label}: complete frozen file list`);
    assert.deepEqual(await Promise.all(v1Names.map(name => digest(join(v1Root, name)))),
      v1Digests, `${label}: frozen files byte-identical`);
  };
  await denyOverlap(v1Root, 'same root');
  await denyOverlap(join(v1Root, 'generation-identities'), 'nested nonexistent output');
  await denyOverlap(`${v1Root}/../search-security`, 'normalized equivalent root');
  await denyOverlap(join(fixture, '.cache'), 'ancestor output');
  const v1Alias = join(fixture, 'v1-alias');
  await symlink(v1Root, v1Alias);
  await denyOverlap(join(v1Alias, 'generation-identities'), 'symlinked existing ancestor');
  await rm(v1Alias);
  const first = await ensureSearchGenerationIdentity(one, { v1Root, outputRoot });
  assert.equal(first.generationToken, one);
  assert.equal(first.writerPrincipal, `station-search-indexer-${tokenPath(one)}`);
  assert.equal(first.queryPrincipal, `station-search-query-${tokenPath(one)}`);
  assert.deepEqual(Object.keys(first).sort(), ['generationToken', 'writerPrincipal', 'writerCertFingerprint',
    'queryPrincipal', 'queryCertFingerprint'].sort(), 'result contains public metadata only');
  for (const key of ['writerCertFingerprint', 'queryCertFingerprint'])
    assert.match(first[key], /^[0-9a-f]{64}$/);
  const firstDir = join(outputRoot, tokenPath(one));
  const firstDigests = await Promise.all((await readdir(firstDir)).sort().map(name => digest(join(firstDir, name))));
  const uppercase = await ensureSearchGenerationIdentity(one.toUpperCase(), { v1Root, outputRoot });
  assert.equal(uppercase.generationToken, one.toUpperCase(), 'public token preserves P2a spelling');
  assert.equal(uppercase.writerPrincipal, first.writerPrincipal, 'uppercase names use lowercase suffix');
  assert.equal(uppercase.writerCertFingerprint, first.writerCertFingerprint);
  assert.deepEqual(await Promise.all((await readdir(firstDir)).sort().map(name => digest(join(firstDir, name)))),
    firstDigests, 'reverification cannot replace keys or certificates');
  const second = await ensureSearchGenerationIdentity(two, { v1Root, outputRoot });
  assert.notEqual(second.writerPrincipal, first.writerPrincipal);
  assert.notEqual(second.writerCertFingerprint, first.writerCertFingerprint);
  assert.deepEqual((await readdir(outputRoot)).sort(), [tokenPath(one), tokenPath(two)].sort());
  assert.deepEqual((await readdir(firstDir)).sort(), ['query.key', 'query.pem', 'writer.key', 'writer.pem']);
  for (const name of await readdir(firstDir)) {
    const info = await lstat(join(firstDir, name));
    assert.equal(info.mode & 0o777, 0o600);
  }
  assert.equal((await lstat(firstDir)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(v1Root)).sort(), v1Names, 'no CA serial or new frozen-root file');
  assert.deepEqual(await Promise.all(v1Names.map(name => digest(join(v1Root, name)))), v1Digests,
    'frozen v1 files remain byte-identical');
  await assert.rejects(ensureSearchGenerationIdentity('bad-token', { v1Root, outputRoot }), /Invalid generation UUID/);

  const third = randomUUID();
  const contenders = await Promise.allSettled(Array.from({ length: 3 }, () =>
    ensureSearchGenerationIdentity(third, { v1Root, outputRoot })));
  assert.ok(contenders.some(result => result.status === 'fulfilled'), 'one concurrent creator succeeds');
  const settled = await ensureSearchGenerationIdentity(third, { v1Root, outputRoot });
  assert.equal(settled.writerPrincipal, `station-search-indexer-${tokenPath(third)}`);
  for (const result of contenders) if (result.status === 'fulfilled') {
    assert.equal(result.value.writerCertFingerprint, settled.writerCertFingerprint,
      'concurrent accepted writers observe one immutable key pair');
    assert.equal(result.value.queryCertFingerprint, settled.queryCertFingerprint);
  }
  assert.deepEqual((await readdir(join(outputRoot, tokenPath(third)))).sort(),
    ['query.key', 'query.pem', 'writer.key', 'writer.pem']);
  assert.deepEqual((await readdir(outputRoot)).sort(),
    [tokenPath(one), tokenPath(two), tokenPath(third)].sort(), 'no staging files remain');
  const linkedRoot = join(fixture, 'linked-generations');
  await symlink(outputRoot, linkedRoot);
  await assert.rejects(ensureSearchGenerationIdentity(one, { v1Root, outputRoot: linkedRoot }),
    /Private certificate directory is invalid/, 'symlinked generation root is denied');
  await rm(linkedRoot);

  const file = join(firstDir, 'writer.pem');
  const original = await readFile(file);
  const originalKey = await readFile(join(firstDir, 'writer.key'));
  const deny = async (mutate, restore, label) => {
    try {
      await mutate();
      await assert.rejects(ensureSearchGenerationIdentity(one, { v1Root, outputRoot }),
        undefined, `${label} must fail closed`);
    } finally { await restore(); }
    assert.equal((await ensureSearchGenerationIdentity(one, { v1Root, outputRoot })).writerCertFingerprint,
      first.writerCertFingerprint, `${label} restoration verifies original identity`);
  };
  await deny(() => rm(file), () => writeFile(file, original, { mode: 0o600 }), 'partial set');
  await deny(async () => { await rm(file); await symlink('query.pem', file); },
    async () => { await rm(file); await writeFile(file, original, { mode: 0o600 }); }, 'symlink');
  await deny(() => chmod(file, 0o640), () => chmod(file, 0o600), 'file permissions');
  await deny(() => chmod(firstDir, 0o750), () => chmod(firstDir, 0o700), 'directory permissions');
  await deny(() => copyFile(join(firstDir, 'query.pem'), file),
    () => writeFile(file, original), 'wrong CN or key');
  await deny(() => copyFile(join(firstDir, 'query.key'), join(firstDir, 'writer.key')),
    () => writeFile(join(firstDir, 'writer.key'), originalKey), 'wrong private key');
  await deny(() => writeFile(join(firstDir, 'unexpected'), 'x', { mode: 0o600 }),
    () => rm(join(firstDir, 'unexpected')), 'unexpected artifact');

  const csr = join(fixture, 'tamper.csr');
  const ext = join(fixture, 'tamper.ext');
  run('openssl', ['req', '-new', '-key', join(firstDir, 'writer.key'),
    '-subj', `/CN=${first.writerPrincipal}`, '-out', csr], fixture);
  await writeFile(ext, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  const signed = (days) => run('openssl', ['x509', '-req', '-sha256', '-days', String(days),
    '-in', csr, '-CA', join(v1Root, 'ca.pem'), '-CAkey', join(v1Root, 'ca.key'),
    '-set_serial', `0x${randomUUID().replaceAll('-', '')}`, '-extfile', ext, '-out', file], fixture);
  await deny(() => signed(365), () => writeFile(file, original), 'server-only EKU');
  await writeFile(ext, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n');
  await deny(() => signed(1), () => writeFile(file, original), 'insufficient validity');
  await deny(() => run('openssl', ['req', '-new', '-x509', '-key', join(firstDir, 'writer.key'),
    '-subj', `/CN=${first.writerPrincipal}`, '-days', '365', '-out', file], fixture),
  () => writeFile(file, original), 'wrong issuer');
  const cliToken = randomUUID();
  const cliOutput = run(process.execPath, [initGeneration, cliToken], fixture, 60_000);
  assert.ok(cliOutput.trim().length > 0, 'offline CLI emits one public identity summary');
  assert.ok(Buffer.byteLength(cliOutput) < 2_048);
  assert.equal(JSON.parse(cliOutput).generationToken, cliToken);
  assert.ok(!cliOutput.includes('PRIVATE KEY'));
  assert.deepEqual((await readdir(v1Root)).sort(), v1Names);
  assert.deepEqual(await Promise.all(v1Names.map(name => digest(join(v1Root, name)))), v1Digests);
  console.info('Create-only generation signer, concurrency and adversarial identity fixture passed.');
} finally { await rm(fixture, { recursive: true, force: true }); }
