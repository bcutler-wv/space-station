import { Buffer } from 'node:buffer';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { digestCreatePriorPublic } from './search-create-intent-pure.mjs';

const fail = () => { throw new Error('Private create intent public capture failed.'); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sameDir = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode;
const sameFile = (a, b) => sameDir(a, b) && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function directory(name, uid, gid, mode, prior) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (mode === null ? (stat.mode & 0o022) !== 0 : (stat.mode & 0o777) !== mode) ||
      await realpath(name) !== name || prior && !sameDir(stat, prior)) fail();
  return stat;
}
async function file(name, uid, gid, prior, max = 16_384) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
        (stat.mode & 0o777) !== 0o600 || stat.size < 100 || stat.size > max ||
        !sameFile(stat, await lstat(name)) || await realpath(name) !== name ||
        prior && !sameFile(stat, prior.stat)) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || !sameFile(stat, await handle.stat()) ||
        !sameFile(stat, await lstat(name))) fail();
    const bytes = buffer.subarray(0, bytesRead);
    if (prior && !bytes.equals(prior.bytes)) fail();
    return { name, stat, bytes };
  } finally { await handle.close(); }
}
function source(row, repository) {
  if (row.token === 'legacy-v1') {
    const names = { 'ca.pem': 'ca.pem', 'v1/admin.pem': 'admin.pem',
      'v1/indexer.pem': 'indexer.pem', 'v1/query.pem': 'query.pem' };
    if (!Object.hasOwn(names, row.path)) fail();
    return path.join(repository, '.cache/search-security', names[row.path]);
  }
  if (typeof row.token !== 'string' || !UUID.test(row.token) ||
      !['writer', 'query'].includes(row.role)) fail();
  const suffix = row.token.replaceAll('-', '');
  if (row.path !== `generations/${suffix}/${row.role}.pem`) fail();
  return path.join(repository, '.cache/search-generations', suffix, `${row.role}.pem`);
}

/** Capture only reviewed prior public certificates and the local admin-key match. */
export async function captureCreateIntentPublic({ repository, uid, gid, files, scratchRoot }) {
  try {
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || !Array.isArray(files) || files.length < 4 ||
        files.length > 1_028 || scratchRoot !== path.join(repository, '.cache/search-create-intent')) fail();
    const cache = path.join(repository, '.cache');
    const roots = [cache, path.join(cache, 'search-security'),
      path.join(cache, 'search-generations'), scratchRoot];
    const dirs = new Map();
    dirs.set(cache, await directory(cache, uid, gid, null));
    for (const root of [roots[1], scratchRoot]) dirs.set(root, await directory(root, uid, gid, 0o700));
    const sources = new Map(), bytes = new Map();
    for (const row of files) {
      const name = source(row, repository), parent = path.dirname(name);
      if (!dirs.has(parent)) {
        if (parent !== roots[2] && !dirs.has(roots[2]))
          dirs.set(roots[2], await directory(roots[2], uid, gid, 0o700));
        dirs.set(parent, await directory(parent, uid, gid, 0o700));
      }
      const item = await file(name, uid, gid);
      sources.set(row.path, item);
      bytes.set(row.path, item.bytes);
    }
    const key = await file(path.join(roots[1], 'admin.key'), uid, gid, undefined, 32_768);
    const match = () => new X509Certificate(bytes.get('v1/admin.pem')).publicKey
      .export({ type: 'spki', format: 'der' }).equals(
        createPublicKey(key.bytes).export({ type: 'spki', format: 'der' }));
    if (!match()) fail();
    const digests = await digestCreatePriorPublic(files, bytes, new Date(), scratchRoot);
    const recheck = async () => {
      try {
        for (const [name, stat] of dirs) await directory(name, uid, gid,
          name === cache ? null : 0o700, stat);
        for (const item of sources.values()) await file(item.name, uid, gid, item);
        await file(key.name, uid, gid, key, 32_768);
        if (!match()) fail();
        const current = await digestCreatePriorPublic(files, bytes, new Date(), scratchRoot);
        if (JSON.stringify(current) !== JSON.stringify(digests)) fail();
        return true;
      } catch { fail(); }
    };
    await recheck();
    return Object.freeze({ publicDigests: digests, recheck });
  } catch { fail(); }
}
