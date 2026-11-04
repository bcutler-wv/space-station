import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { parseWriterRolePrepareInvocation } from './search-writer-role-prepare-input.mjs';

const fail = () => { throw Error('Private writer role invocation failed.'); };
const sameDir = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
const sameFile = (a, b) => sameDir(a, b) && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function syncDir(name) {
  const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function dir(name, uid, gid, mode, previous) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      stat.gid !== gid || (mode === null ? (stat.mode & 0o022) !== 0 :
        (stat.mode & 0o777) !== mode) || await realpath(name) !== name ||
      previous && !sameDir(stat, previous)) fail();
  return stat;
}
async function file(name, uid, gid, bytes, previous) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
        (stat.mode & 0o777) !== 0o400 || stat.size !== bytes.length ||
        previous && !sameFile(stat, previous) || !sameFile(stat, await lstat(name)) ||
        await realpath(name) !== name) fail();
    const data = Buffer.alloc(bytes.length + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== bytes.length || !data.subarray(0, bytesRead).equals(bytes) ||
        !sameFile(stat, await handle.stat()) || !sameFile(stat, await lstat(name))) fail();
    return stat;
  } finally { await handle.close(); }
}

/** Exclusive host-local fixed invocation, removed only after checked remote cleanup. */
export async function makeWriterRolePrepareInvocation(repository, uid, gid, marker, created) {
  try {
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || typeof created !== 'function') fail();
    const bytes = canonicalAttestorValue(marker, 2048).bytes;
    parseWriterRolePrepareInvocation(bytes);
    const cache = path.join(repository, '.cache');
    const cacheStat = await dir(cache, uid, gid, null);
    const parent = path.join(cache, 'search-writer-role-invocations');
    try { await mkdir(parent, { mode: 0o700 }); await syncDir(cache); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const parentStat = await dir(parent, uid, gid, 0o700);
    const root = path.join(parent, marker.invocationId);
    await mkdir(root, { mode: 0o700 });
    created();
    const rootStat = await dir(root, uid, gid, 0o700);
    const name = path.join(root, 'invocation.json');
    const handle = await open(name, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    let original;
    try {
      await handle.writeFile(bytes); await handle.sync();
      original = await handle.stat();
      if (!sameFile(original, await lstat(name))) fail();
    } finally { await handle.close(); }
    await syncDir(root); await syncDir(parent);
    const capture = { cache, cacheStat, parent, parentStat, root, rootStat,
      name, bytes, stat: original };
    await checkWriterRolePrepareInvocation(capture, uid, gid);
    return capture;
  } catch { fail(); }
}

export async function checkWriterRolePrepareInvocation(item, uid, gid) {
  try {
    await dir(item.cache, uid, gid, null, item.cacheStat);
    await dir(item.parent, uid, gid, 0o700, item.parentStat);
    await dir(item.root, uid, gid, 0o700, item.rootStat);
    if ((await readdir(item.root)).join('|') !== 'invocation.json') fail();
    await file(item.name, uid, gid, item.bytes, item.stat);
    return true;
  } catch { fail(); }
}

export async function cleanupWriterRolePrepareInvocation(item, uid, gid) {
  try {
    await checkWriterRolePrepareInvocation(item, uid, gid);
    await unlink(item.name); await syncDir(item.root);
    if ((await readdir(item.root)).length) fail();
    await rmdir(item.root); await syncDir(item.parent);
    return true;
  } catch { fail(); }
}
