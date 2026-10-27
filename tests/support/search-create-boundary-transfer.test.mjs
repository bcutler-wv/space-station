import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { transferCreateBoundaryPassword } from '../../scripts/search-create-boundary-transfer-core.mjs';
import { parseCreateBoundaryInvocation } from '../../scripts/search-create-boundary-invocation.mjs';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const marker = { version: 1, invocationId: id, project: 'fixture', owner: 'station', databaseOid: '16384',
  systemIdentifier: '12345678901234567890' };
const secret = Buffer.alloc(32, 7).toString('base64url');
const uid = process.getuid();
async function fixture(work) {
  await mkdir(path.join(process.cwd(), '.cache/results'), { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(path.join(process.cwd(), '.cache/results/create-boundary-transfer-'));
  const passDir = path.join(parent, 'password'), idDir = path.join(parent, 'invocation');
  const volumeRoot = path.join(parent, 'volume');
  await mkdir(passDir, { mode: 0o700 }); await mkdir(idDir, { mode: 0o700 });
  await mkdir(volumeRoot, { mode: 0o755 });
  const input = { passwordFile: path.join(passDir, 'password'),
    invocationFile: path.join(idDir, 'invocation'), volumeRoot };
  await writeFile(input.passwordFile, secret, { mode: 0o600 });
  await writeFile(input.invocationFile, `${JSON.stringify(marker)}\n`, { mode: 0o400 });
  try { await work(input); } finally { await rm(parent, { recursive: true, force: true }); }
}
const options = { fixture: true, ownerUid: uid, targetUid: uid, creatorUid: uid };

test('marker rejects array-coerced identities and out-of-range PostgreSQL system identifiers', () => {
  const encode = value => Buffer.from(`${JSON.stringify(value)}\n`);
  assert.deepEqual(parseCreateBoundaryInvocation(encode(marker)), marker);
  for (const invalid of [{ ...marker, invocationId: [id] },
    { ...marker, project: ['fixture'] },
    { ...marker, systemIdentifier: '18446744073709551616' },
    { ...marker, systemIdentifier: 123 }]) {
    assert.throws(() => parseCreateBoundaryInvocation(encode(invalid)));
  }
});

test('offline transfer copies only transition password and lock UUID to fixed private volume', async () => fixture(async input => {
  assert.equal(await transferCreateBoundaryPassword(input, options), id);
  assert.equal(await readFile(path.join(input.volumeRoot, 'transition.password'), 'utf8'), secret);
  assert.equal(await readFile(path.join(input.volumeRoot, 'invocation'), 'utf8'), `${JSON.stringify(marker)}\n`);
  assert.equal((await stat(input.volumeRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(input.volumeRoot, 'transition.password'))).mode & 0o777, 0o400);
}));

test('wrong source, extra volume entry and duplicate transfer fail closed', async () => {
  await fixture(async input => {
    await rm(input.passwordFile);
    await symlink(input.invocationFile, input.passwordFile);
    await assert.rejects(transferCreateBoundaryPassword(input, options));
  });
  await fixture(async input => {
    await writeFile(input.passwordFile, 'not-a-password', { mode: 0o600 });
    await assert.rejects(transferCreateBoundaryPassword(input, options));
  });
  await fixture(async input => {
    await writeFile(path.join(input.volumeRoot, 'extra'), 'x');
    await assert.rejects(transferCreateBoundaryPassword(input, options));
  });
  await fixture(async input => {
    await transferCreateBoundaryPassword(input, options);
    await assert.rejects(transferCreateBoundaryPassword(input, options));
  });
});
