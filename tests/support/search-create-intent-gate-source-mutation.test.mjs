import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { sourceMutation } from './search-create-intent-gate-source-mutation.mjs';

test('missing and swapped public source restore exactly once despite repeated cleanup', async t => {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache/results/intent-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'admin.pem');
  await writeFile(original, 'original public bytes');
  await writeFile(path.join(root, 'query.pem'), 'swapped public bytes');
  const baseline = await lstat(original), bytes = await readFile(original);
  for (const replacement of [null, 'query.pem']) {
    const mutation = sourceMutation(root, 'admin.pem', replacement);
    await mutation.change();
    assert.equal(await lstat(original).then(() => true, () => false), Boolean(replacement));
    await mutation.restore();
    await mutation.restore();
    assert.equal((await lstat(original)).ino, baseline.ino);
    assert.deepEqual(await readFile(original), bytes);
  }
});

test('copy failure after rename leaves a restorable original inode and bytes', async t => {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache/results/intent-source-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'admin.pem');
  await writeFile(original, 'original public bytes');
  const baseline = await lstat(original), bytes = await readFile(original);
  const mutation = sourceMutation(root, 'admin.pem', 'missing.pem');
  await assert.rejects(mutation.change());
  await mutation.restore();
  await mutation.restore();
  assert.equal((await lstat(original)).ino, baseline.ino);
  assert.deepEqual(await readFile(original), bytes);
});
