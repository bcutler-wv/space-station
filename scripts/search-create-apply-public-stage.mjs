import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { captureCreateIntentPublic } from './search-create-intent-public.mjs';

const fail = () => { throw Error('Private create apply public staging failed.'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const sameDir = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
async function syncDir(name) {
  const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function directory(name, uid, gid, original) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      stat.gid !== gid || (stat.mode & 0o777) !== 0o700 ||
      await realpath(name) !== name || original && !sameDir(stat, original)) fail();
  return stat;
}
async function file(name, uid, gid, bytes, original) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
        (stat.mode & 0o777) !== 0o400 || stat.size !== bytes.length ||
        original && !same(stat, original) || !same(stat, await lstat(name)) ||
        await realpath(name) !== name) fail();
    const buffer = Buffer.alloc(bytes.length + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== bytes.length || !buffer.subarray(0, bytesRead).equals(bytes) ||
        !same(stat, await handle.stat()) || !same(stat, await lstat(name))) fail();
    return stat;
  } finally { await handle.close(); }
}

/** Stage only the originally approved prior PEM bytes, with no CA signing key. */
export async function stageCreateApplyPublic({ repository, uid, gid, invocationId,
  files, publicDigests }, options = {}) {
  try {
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(invocationId) ||
        options.beforeWrite !== undefined &&
          (process.env.STATION_CREATE_APPLY_FIXTURE !== '1' ||
            typeof options.beforeWrite !== 'function')) fail();
    const original = await (options.capturePublic ?? captureCreateIntentPublic)({
      repository, uid, gid, files,
      scratchRoot: path.join(repository, '.cache/search-create-intent') });
    if (!canonicalAttestorValue(original.publicDigests).bytes.equals(
      canonicalAttestorValue(publicDigests).bytes)) fail();
    const publicBytes = original.publicBytes();
    if (!(publicBytes instanceof Map) || publicBytes.size !== files.length ||
        files.some(row => !Buffer.isBuffer(publicBytes.get(row.path)))) fail();
    const parent = path.join(repository, '.cache/search-create-apply-public');
    const cache = path.join(repository, '.cache');
    const cacheStat = await lstat(cache);
    if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink() || cacheStat.uid !== uid ||
        cacheStat.gid !== gid || (cacheStat.mode & 0o022) !== 0 ||
        await realpath(cache) !== cache) fail();
    try { await mkdir(parent, { mode: 0o700 }); await syncDir(cache); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const parentStat = await directory(parent, uid, gid);
    const root = path.join(parent, invocationId);
    await mkdir(root, { mode: 0o700 });
    const dirs = new Map([[root, await directory(root, uid, gid)]]);
    const relatives = new Set();
    for (const row of files) {
      const parts = row.path.split('/');
      if (!parts.length || parts.some(part => !/^[a-z0-9.-]+$/.test(part)) ||
          row.path.includes('..') || row.path.startsWith('/')) fail();
      for (let i = 1; i < parts.length; i++) relatives.add(parts.slice(0, i).join('/'));
    }
    for (const relative of [...relatives].sort((a, b) => a.split('/').length - b.split('/').length)) {
      const name = path.join(root, relative);
      await mkdir(name, { mode: 0o700 });
      dirs.set(name, await directory(name, uid, gid));
      await syncDir(path.dirname(name));
    }
    const written = new Map();
    for (const row of files) {
      await options.beforeWrite?.(row.path);
      const name = path.join(root, row.path), bytes = publicBytes.get(row.path);
      const handle = await open(name, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let originalStat;
      try {
        await handle.writeFile(bytes); await handle.chmod(0o400);
        await handle.sync();
        originalStat = await handle.stat();
        if (!same(originalStat, await lstat(name))) fail();
      } finally { await handle.close(); }
      await file(name, uid, gid, bytes, originalStat);
      written.set(row.path, { stat: originalStat, bytes });
      await syncDir(path.dirname(name));
    }
    await syncDir(root); await syncDir(parent);
    const verify = async () => {
      await original.recheck();
      const currentCache = await lstat(cache);
      if (!sameDir(currentCache, cacheStat) || await realpath(cache) !== cache) fail();
      await directory(parent, uid, gid, parentStat);
      for (const [name, stat] of dirs) {
        await directory(name, uid, gid, stat);
        const children = files.filter(row => path.dirname(path.join(root, row.path)) === name)
          .map(row => path.basename(row.path));
        const subdirs = [...dirs.keys()].filter(other => other !== name && path.dirname(other) === name)
          .map(other => path.basename(other));
        if ((await readdir(name)).sort().join('|') !== [...children, ...subdirs].sort().join('|')) fail();
      }
      for (const [relative, item] of written)
        await file(path.join(root, relative), uid, gid, item.bytes, item.stat);
      return true;
    };
    await verify();
    let cleanupAttempted = false;
    return Object.freeze({ root, recheck: verify,
      recheckSource: original.recheck, cleanup: async () => {
      try {
        if (cleanupAttempted) fail();
        cleanupAttempted = true;
        await verify();
        for (const [relative, item] of [...written].reverse()) {
          const name = path.join(root, relative);
          await file(name, uid, gid, item.bytes, item.stat);
          await unlink(name); await syncDir(path.dirname(name));
        }
        for (const name of [...dirs.keys()].reverse()) {
          await directory(name, uid, gid, dirs.get(name));
          if ((await readdir(name)).length) fail();
          await rmdir(name); await syncDir(path.dirname(name));
        }
        await directory(parent, uid, gid, parentStat);
        await original.recheck();
        return true;
      } catch { fail(); }
    } });
  } catch { fail(); }
}
