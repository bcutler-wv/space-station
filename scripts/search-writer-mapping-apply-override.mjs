import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { fixedWriterMappingApplyCommand } from './search-writer-mapping-apply-service-config.mjs';
import { parseWriterMappingConsumerArgs } from './search-writer-mapping-consumer-wrapper.mjs';

const fail = () => { throw Error('Private writer mapping override failed.'); };
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
export async function stageWriterMappingApplyOverride({ repository, uid, gid, invocationId,
  transferName, applyName, transferCommand, applyCommand }) {
  try {
    if (path.resolve(repository) !== repository ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(invocationId) ||
        transferName !== `station_mapping_apply_transfer_${invocationId.replaceAll('-', '')}` ||
        applyName !== `station_mapping_apply_${invocationId.replaceAll('-', '')}` ||
        JSON.stringify(transferCommand) !== JSON.stringify(['node',
          'scripts/search-writer-mapping-apply-transfer.mjs']) ||
        !Array.isArray(applyCommand) || applyCommand.length !== 15 ||
        JSON.stringify(applyCommand) !== JSON.stringify(
          fixedWriterMappingApplyCommand(applyCommand.slice(2))) ||
        parseWriterMappingConsumerArgs(applyCommand.slice(2)).invocationId !== invocationId) fail();
    const cache = path.join(repository, '.cache');
    const parent = path.join(cache, 'search-writer-mapping-apply-overrides');
    const root = path.join(parent, invocationId);
    const file = path.join(root, 'compose.json');
    const cacheStat = await lstat(cache);
    if (!cacheStat.isDirectory() || cacheStat.uid !== uid || cacheStat.gid !== gid ||
        (cacheStat.mode & 0o022) || await realpath(cache) !== cache) fail();
    let parentOwned = false;
    try { await mkdir(parent, { mode: 0o700 }); parentOwned = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.uid !== uid || parentStat.gid !== gid ||
        (parentStat.mode & 0o777) !== 0o700 || await realpath(parent) !== parent) fail();
    if (parentOwned) await syncDir(cache);
    await mkdir(root, { mode: 0o700 });
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.uid !== uid || rootStat.gid !== gid ||
        (rootStat.mode & 0o777) !== 0o700 || await realpath(root) !== root) fail();
    await syncDir(parent);
    const payload = { services: {
      'search-writer-mapping-apply-transfer': { command: transferCommand,
        container_name: transferName },
      'search-writer-mapping-apply': { command: applyCommand, container_name: applyName },
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
        const c = await lstat(cache);
        if (!sameDir(c, cacheStat)) fail();
        if (parentOwned) {
          try { await lstat(parent); fail(); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else {
          const p = await lstat(parent);
          if (!sameDir(p, parentStat) || await realpath(parent) !== parent ||
              (await readdir(parent)).length) fail();
        }
        try { await lstat(root); fail(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const finalCache = await lstat(cache);
        if (!sameDir(finalCache, cacheStat)) fail();
        if (parentOwned) {
          try { await lstat(parent); fail(); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else {
          const finalParent = await lstat(parent);
          if (!sameDir(finalParent, parentStat)) fail();
        }
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
      if (JSON.stringify((await readdir(parent)).sort()) !== JSON.stringify([invocationId])) fail();
      if (JSON.stringify(await readdir(root)) !== JSON.stringify(['compose.json']) ||
          await realpath(root) !== root) fail();
      const c2 = await lstat(cache), p2 = await lstat(parent), r2 = await lstat(root);
      if (!sameDir(c2, cacheStat) || !sameDir(p2, parentStat) ||
          !sameDir(r2, rootStat)) fail();
      return true;
    };
    await recheck();
    let attempted = false;
    const originalDirs = async () => {
      const c = await lstat(cache), p = await lstat(parent), r = await lstat(root);
      if (!sameDir(c, cacheStat) || !sameDir(p, parentStat) ||
          !sameDir(r, rootStat) || await realpath(root) !== root) fail();
    };
    return Object.freeze({ file, recheck, cleanup: async () => {
      if (attempted) fail(); attempted = true;
      await recheck(); await originalDirs(); await unlink(file);
      await originalDirs(); await syncDir(root);
      await originalDirs();
      if ((await readdir(root)).length) fail();
      await originalDirs();
      await rmdir(root); await syncDir(parent);
      const c = await lstat(cache), p = await lstat(parent);
      if (!sameDir(c, cacheStat) || !sameDir(p, parentStat) ||
          await realpath(parent) !== parent) fail();
      if (parentOwned) { await rmdir(parent); await syncDir(cache); }
      cleaned = true;
      await recheck();
    } });
  } catch { fail(); }
}
