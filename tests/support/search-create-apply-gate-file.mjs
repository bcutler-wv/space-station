import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const absent = name => lstat(name).then(() => false, error => {
  if (error?.code === 'ENOENT') return true;
  throw error;
});
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs;

/** Disposable fixture only: replace one original inode and later restore it exactly. */
export async function swapCreateApplyGateFile(name, backup, replacementBytes,
  { write = writeFile } = {}) {
  assert.equal(path.isAbsolute(name) && path.isAbsolute(backup), true);
  assert.notEqual(name, backup);
  assert.equal(await absent(backup), true);
  const original = await lstat(name);
  assert.equal(original.isFile() && !original.isSymbolicLink() && original.nlink === 1, true);
  assert.equal(await realpath(name), name);
  const bytes = await readFile(name);
  assert.equal(bytes.length, original.size);
  assert.deepEqual(Buffer.from(replacementBytes), bytes);
  await rename(name, backup);
  try {
    await write(name, replacementBytes, { mode: original.mode & 0o777, flag: 'wx' });
  } catch (error) {
    if (!(await absent(name))) await rm(name);
    await rename(backup, name);
    assert.equal(same(await lstat(name), original), true);
    assert.deepEqual(await readFile(name), bytes);
    throw error;
  }
  const changed = await lstat(name);
  assert.equal(changed.isFile() && changed.nlink === 1, true);
  assert.notEqual(changed.ino, original.ino);
  assert.equal(changed.mode & 0o777, original.mode & 0o777);
  assert.deepEqual(await readFile(name), bytes);
  let restored = false;
  const restore = async () => {
    if (!restored) {
      assert.equal(same(await lstat(name), changed), true);
      assert.deepEqual(await readFile(name), bytes);
      assert.equal(same(await lstat(backup), original), true);
      await rm(name);
      await rename(backup, name);
      restored = true;
    }
    assert.equal(await absent(backup), true);
    assert.equal(same(await lstat(name), original), true);
    assert.deepEqual(await readFile(name), bytes);
  };
  return { original, changed, restore };
}
