import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { swapCreateApplyGateFile } from './search-create-apply-gate-file.mjs';

const cache = path.resolve('.cache/results');
async function fixture(t, mode) {
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'create-apply-gate-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = path.join(root, 'original'), backup = path.join(root, 'backup');
  const bytes = Buffer.from('fixture public certificate bytes\n');
  await writeFile(name, bytes, { mode, flag: 'wx' });
  return { name, backup, bytes, root, original: await lstat(name) };
}

test('fixture swap preserves original inode, bytes and mode through repeated restoration', async t => {
  const item = await fixture(t, 0o400);
  assert.equal((await lstat(item.name)).uid, process.getuid());
  const swapped = await swapCreateApplyGateFile(item.name, item.backup, item.bytes);
  assert.notEqual((await lstat(item.name)).ino, item.original.ino);
  assert.equal((await lstat(item.name)).mode & 0o777, 0o400);
  assert.deepEqual(await readFile(item.backup), item.bytes);
  await swapped.restore();
  await swapped.restore();
  assert.equal((await lstat(item.name)).ino, item.original.ino);
  assert.deepEqual(await readFile(item.name), item.bytes);
  await assert.rejects(lstat(item.backup), { code: 'ENOENT' });
});

test('partial replacement failure restores original and leaves no backup', async t => {
  const item = await fixture(t, 0o600);
  await assert.rejects(swapCreateApplyGateFile(item.name, item.backup, item.bytes, {
    write: async (name, _bytes, options) => {
      await writeFile(name, 'partial', options);
      throw Error('fixture write interrupted');
    },
  }));
  assert.equal((await lstat(item.name)).ino, item.original.ino);
  assert.equal((await lstat(item.name)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(item.name), item.bytes);
  await assert.rejects(lstat(item.backup), { code: 'ENOENT' });
});
