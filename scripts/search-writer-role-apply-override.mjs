import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';

const fail = () => { throw Error('Private writer role override failed.'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const sameDir = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode;
async function syncDir(name) {
  const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Private Compose transport bytes, never an approval or copied input. */
export async function stageWriterRoleApplyOverride({ repository, uid, gid, invocationId,
  transferName, applyName, transferCommand, applyCommand }) {
  try {
    if (path.resolve(repository) !== repository ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(invocationId) ||
        transferName !== `station_writer_transfer_${invocationId.replaceAll('-', '')}` ||
        applyName !== `station_writer_apply_${invocationId.replaceAll('-', '')}` ||
        JSON.stringify(transferCommand) !== JSON.stringify(['node',
          'scripts/search-writer-role-apply-transfer.mjs']) ||
        !Array.isArray(applyCommand) || applyCommand.length !== 15) fail();
    const cache = path.join(repository, '.cache');
    const parent = path.join(cache, 'search-writer-role-overrides');
    const root = path.join(parent, invocationId);
    const file = path.join(root, 'compose.json');
    const cacheStat = await lstat(cache);
    if (!cacheStat.isDirectory() || cacheStat.uid !== uid || cacheStat.gid !== gid ||
        (cacheStat.mode & 0o022) || await realpath(cache) !== cache) fail();
    try { await mkdir(parent, { mode: 0o700 }); await syncDir(cache); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.uid !== uid || parentStat.gid !== gid ||
        (parentStat.mode & 0o777) !== 0o700 || await realpath(parent) !== parent) fail();
    await mkdir(root, { mode: 0o700 }); await syncDir(parent);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.uid !== uid || rootStat.gid !== gid ||
        (rootStat.mode & 0o777) !== 0o700 || await realpath(root) !== root) fail();
    const payload = { services: {
      'search-writer-role-apply-transfer': { command: transferCommand,
        container_name: transferName },
      'search-writer-role-apply': { command: applyCommand, container_name: applyName },
    } };
    const bytes = canonicalAttestorValue(payload, 4096).bytes;
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let stat;
    try {
      await handle.writeFile(bytes); await handle.chmod(0o400);
        await handle.sync(); stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
          (stat.mode & 0o777) !== 0o400 || !same(stat, await lstat(file))) fail();
    } finally { await handle.close(); }
    await syncDir(root); await syncDir(parent);
    let cleaned = false;
    const recheck = async () => {
      if (cleaned) {
        const c = await lstat(cache), p = await lstat(parent);
        if (!sameDir(c, cacheStat) || !sameDir(p, parentStat) ||
            await realpath(parent) !== parent ||
            (await readdir(parent)).includes(invocationId)) fail();
        return true;
      }
      const c = await lstat(cache), p = await lstat(parent), r = await lstat(root);
      if (!sameDir(c, cacheStat) || !sameDir(p, parentStat) || !sameDir(r, rootStat) ||
          await realpath(root) !== root || await realpath(parent) !== parent ||
          JSON.stringify(await readdir(root)) !== JSON.stringify(['compose.json'])) fail();
      const reader = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW |
        constants.O_NONBLOCK);
      try {
        const f = await reader.stat();
        if (!same(f, stat) || !f.isFile() || f.nlink !== 1 ||
            !same(f, await lstat(file))) fail();
        const buffer = Buffer.alloc(bytes.length + 1);
        const { bytesRead } = await reader.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== bytes.length || !buffer.subarray(0, bytesRead).equals(bytes) ||
            !same(f, await reader.stat()) || !same(f, await lstat(file))) fail();
      } finally { await reader.close(); }
      return true;
    };
    await recheck();
    let attempted = false;
    return Object.freeze({ file, recheck, cleanup: async () => {
      if (attempted) fail(); attempted = true;
      await recheck(); await unlink(file); await syncDir(root);
      if ((await readdir(root)).length) fail();
      await rmdir(root); await syncDir(parent);
      cleaned = true;
      await recheck();
    } });
  } catch { fail(); }
}
