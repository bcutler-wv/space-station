import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';

const fail = () => { throw new Error('Private create intent pending file failed.'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode;
const sameFile = (a, b) => same(a, b) && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function syncDir(name) {
  const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function directory(name, uid, gid, mode, prior) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (mode === null ? (stat.mode & 0o022) !== 0 : (stat.mode & 0o777) !== mode) ||
      await realpath(name) !== name || prior && !same(stat, prior)) fail();
  return stat;
}

/** Establish the only fixed proposal path and refuse any existing proposal before dispatch. */
export async function prepareCreateIntentPending(repository, uid, gid) {
  try {
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.()) fail();
    const cache = path.join(repository, '.cache');
    const cacheStat = await directory(cache, uid, gid, null);
    const root = path.join(cache, 'search-create-intent');
    try { await mkdir(root, { mode: 0o700 }); await syncDir(cache); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const rootStat = await directory(root, uid, gid, 0o700);
    const name = path.join(root, 'pending.json');
    if ((await readdir(root)).length) fail();
    try { await lstat(name); fail(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const check = async () => {
      await directory(cache, uid, gid, null, cacheStat);
      await directory(root, uid, gid, 0o700, rootStat);
    };
    return Object.freeze({ root, name, check });
  } catch { fail(); }
}

/** Call only after the lock marks pending attempted before exclusive file I/O. */
export async function writeCreateIntentPending(prepared, intent, expectedSha, uid, gid, test = {}) {
  try {
    if (test.afterFileClose !== undefined &&
        (process.env.STATION_INTENT_PENDING_FIXTURE !== '1' ||
          typeof test.afterFileClose !== 'function')) fail();
    await prepared.check();
    if ((await readdir(prepared.root)).length) fail();
    const bytes = canonicalAttestorValue(intent, 256 * 1024).bytes;
    if (typeof expectedSha !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha) ||
        createHash('sha256').update(bytes).digest('hex') !== expectedSha) fail();
    const handle = await open(prepared.name, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    let original;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || before.gid !== gid ||
          (before.mode & 0o777) !== 0o400) fail();
      await handle.writeFile(bytes);
      await handle.sync();
      const after = await handle.stat();
      const named = await lstat(prepared.name);
      if (!same(before, after) || !sameFile(after, named) || after.size !== bytes.length ||
          after.nlink !== 1 || await realpath(prepared.name) !== prepared.name) fail();
      original = after;
    } finally { await handle.close(); }
    await test.afterFileClose?.(prepared.name);
    await syncDir(prepared.root);
    const recheck = async () => {
      await prepared.check();
      if ((await readdir(prepared.root)).join('|') !== 'pending.json') fail();
      const current = await open(prepared.name,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await current.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
            (stat.mode & 0o777) !== 0o400 || !sameFile(stat, original) ||
            stat.size !== bytes.length || !sameFile(stat, await lstat(prepared.name)) ||
            await realpath(prepared.name) !== prepared.name) fail();
        const found = Buffer.alloc(bytes.length + 1);
        const { bytesRead } = await current.read(found, 0, found.length, 0);
        if (bytesRead !== bytes.length || !found.subarray(0, bytesRead).equals(bytes) ||
            !sameFile(stat, await current.stat()) ||
            !sameFile(stat, await lstat(prepared.name))) fail();
        return true;
      } finally { await current.close(); }
    };
    await recheck();
    return { sha256: expectedSha, bytes: bytes.length, recheck };
  } catch { fail(); }
}
