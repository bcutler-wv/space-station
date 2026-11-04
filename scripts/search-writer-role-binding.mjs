import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { isWriterRoleBindingOperation } from './search-admin-job-lock.mjs';

const fail = () => { throw Error('Private writer role binding failed.'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode;
const sameFile = (a, b) => same(a, b) && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function directory(name, uid, gid, mode, prior) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (mode === null ? (stat.mode & 0o022) !== 0 : (stat.mode & 0o777) !== mode) ||
      await realpath(name) !== name || prior && !same(stat, prior)) fail();
  return stat;
}
async function syncDir(name) {
  const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Exclusive fixed binding. The writer role lock must already be durably attempted. */
export async function writeWriterRoleBinding(repository, uid, gid, operation, approved, test = {}) {
  try {
    approved = canonicalAttestorValue(approved).value;
    const hooks = Object.getOwnPropertyDescriptors(test);
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || !isWriterRoleBindingOperation(operation,
          path.join(repository, '.cache/search-db'), uid) ||
        typeof operation.invocationId !== 'string' ||
        typeof operation.assertBindingAttempted !== 'function' ||
        typeof operation.assertOwned !== 'function' ||
        Reflect.ownKeys(hooks).some(key => !['afterFileWrite', 'afterFileSync',
          'afterFileClose'].includes(key) || !Object.hasOwn(hooks[key], 'value') ||
          process.env.STATION_WRITER_ROLE_FIXTURE !== '1' ||
          typeof hooks[key].value !== 'function')) fail();
    const known = { approvedSha256: approved.approvedSha256,
      dispatchId: approved.dispatchId, ownerId: approved.ownerId };
    operation.assertBindingAttempted(known);
    await operation.assertOwned();
    const cache = path.join(repository, '.cache');
    const root = path.join(cache, 'search-writer-role-apply');
    const name = path.join(root, 'binding.json');
    const cacheStat = await directory(cache, uid, gid, null);
    try { await mkdir(root, { mode: 0o700 }); await syncDir(cache); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const rootStat = await directory(root, uid, gid, 0o700);
    if ((await readdir(root)).length) fail();
    const binding = { version: 1, invocationId: operation.invocationId, ...known };
    const bytes = canonicalAttestorValue(binding).bytes;
    if (bytes.length > 1024) fail();
    const handle = await open(name, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    let original;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || before.gid !== gid ||
          (before.mode & 0o777) !== 0o400) fail();
      await handle.writeFile(bytes);
      await hooks.afterFileWrite?.value(name);
      await handle.sync();
      await hooks.afterFileSync?.value(name);
      const after = await handle.stat();
      if (!same(before, after) || !sameFile(after, await lstat(name)) ||
          after.size !== bytes.length || await realpath(name) !== name) fail();
      original = after;
    } finally { await handle.close(); }
    await hooks.afterFileClose?.value(name);
    await syncDir(root);
    const recheck = async () => {
      try {
        await directory(cache, uid, gid, null, cacheStat);
        await directory(root, uid, gid, 0o700, rootStat);
        if ((await readdir(root)).join('|') !== 'binding.json') fail();
        const current = await open(name,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await current.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
              (stat.mode & 0o777) !== 0o400 || !sameFile(stat, original) ||
              !sameFile(stat, await lstat(name)) || await realpath(name) !== name) fail();
          const buffer = Buffer.alloc(bytes.length + 1);
          const { bytesRead } = await current.read(buffer, 0, buffer.length, 0);
          if (bytesRead !== bytes.length || !buffer.subarray(0, bytesRead).equals(bytes) ||
              !sameFile(stat, await current.stat()) ||
              !sameFile(stat, await lstat(name))) fail();
          return true;
        } finally { await current.close(); }
      } catch { fail(); }
    };
    await recheck();
    await operation.assertOwned();
    return Object.freeze({ invocationId: operation.invocationId, binding: () => ({ ...binding }),
      bytes: () => Buffer.from(bytes), recheck });
  } catch { fail(); }
}
