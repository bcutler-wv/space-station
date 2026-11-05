import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { capturePublicDirectory } from './search-create-intent-public.mjs';
import { cleanupWriterMappingLocal } from './search-writer-mapping-prepare-local.mjs';

const fail = () => { throw Error('Private writer mapping apply public staging failed.'); };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode;
const fileSame = (a, b) => same(a, b) && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function directory(name, uid, gid, original) {
  const item = await capturePublicDirectory(name, uid, gid, 0o700, original);
  if (original && !same(item, original)) fail();
  return item;
}
async function syncDir(name) {
  const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY |
    constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function checkedFile(name, uid, gid, bytes, original) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid ||
        stat.gid !== gid || (stat.mode & 0o777) !== 0o400 ||
        !fileSame(stat, original) || !fileSame(stat, await lstat(name)) ||
        await realpath(name) !== name) fail();
    const data = Buffer.alloc(bytes.length + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== bytes.length || !data.subarray(0, bytesRead).equals(bytes) ||
        !fileSame(stat, await handle.stat()) || !fileSame(stat, await lstat(name))) fail();
  } finally { await handle.close(); }
}

/** Stage the two original public trees; the caller owns external approval and source capture. */
export async function stageWriterMappingApplyPublic(input) {
  try {
    const { repository, uid, gid, invocationId, priorFiles, priorBytes,
      candidateToken, candidateBytes, recheckSource, onAttempt, onCreate } = input;
    if (typeof repository !== 'string' || path.resolve(repository) !== repository ||
        uid !== process.getuid?.() || gid !== process.getgid?.() || uid < 1 || gid < 1 ||
        typeof invocationId !== 'string' || !uuid.test(invocationId) ||
        typeof candidateToken !== 'string' || !uuid.test(candidateToken) ||
        !Array.isArray(priorFiles) || !(priorBytes instanceof Map) ||
        !(candidateBytes instanceof Map) || typeof recheckSource !== 'function' ||
        typeof onAttempt !== 'function' || typeof onCreate !== 'function') fail();
    const suffix = candidateToken.replaceAll('-', '');
    const writer = `generations/${suffix}/writer.pem`;
    if (candidateBytes.size !== 2 || !candidateBytes.has('ca.pem') ||
        !candidateBytes.has(writer) || priorBytes.size !== priorFiles.length ||
        priorFiles.some(row => typeof row.path !== 'string' ||
          !priorBytes.has(row.path))) fail();
    const bytes = new Map();
    for (const row of priorFiles) bytes.set(`prior-public/${row.path}`,
      Buffer.from(priorBytes.get(row.path)));
    for (const [name, value] of candidateBytes)
      bytes.set(`candidate-public/${name}`, Buffer.from(value));
    for (const [name, value] of bytes) {
      if (!Buffer.isBuffer(value) || value.length < 2 || value.length > 16_384 ||
          name.startsWith('/') || name.split('/').some(part =>
            !/^[a-z0-9.-]+$/.test(part) || part === '..')) fail();
    }
    const cache = path.join(repository, '.cache');
    const cacheStat = await capturePublicDirectory(cache, uid, gid, null);
    const parent = path.join(cache, 'search-writer-mapping-apply-public');
    const root = path.join(parent, invocationId);
    const records = [{ kind: 'dir', name: cache, stat: cacheStat, mode: null,
      owned: false }];
    onCreate(records[0]);
    onAttempt('parent');
    let parentOwned = false;
    try { await mkdir(parent, { mode: 0o700 }); parentOwned = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const parentStat = await directory(parent, uid, gid);
    const parentRecord = { kind: 'dir', name: parent, stat: parentStat,
      mode: 0o700, owned: parentOwned };
    records.push(parentRecord);
    onCreate(parentRecord);
    if ((await readdir(parent)).length) fail();
    if (parentOwned) await syncDir(cache);
    await capturePublicDirectory(cache, uid, gid, null, cacheStat);
    onAttempt('root');
    await mkdir(root, { mode: 0o700 });
    const rootStat = await directory(root, uid, gid);
    const rootRecord = { kind: 'dir', name: root, stat: rootStat,
      mode: 0o700, owned: true };
    records.push(rootRecord); onCreate(rootRecord);
    await directory(parent, uid, gid, parentStat);
    const dirNames = new Set(['prior-public', 'candidate-public']);
    for (const name of bytes.keys()) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++)
        dirNames.add(parts.slice(0, i).join('/'));
    }
    const sortedDirs = [...dirNames].sort((a, b) =>
      a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const relative of sortedDirs) {
      const name = path.join(root, relative);
      onAttempt('directory');
      await mkdir(name, { mode: 0o700 });
      const stat = await directory(name, uid, gid);
      const record = { kind: 'dir', name, stat, mode: 0o700, owned: true };
      records.push(record); onCreate(record);
      await syncDir(path.dirname(name));
    }
    for (const [relative, value] of bytes) {
      const name = path.join(root, relative);
      onAttempt('file');
      const handle = await open(name, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== uid ||
            opened.gid !== gid || (opened.mode & 0o777) !== 0o400 ||
            !same(opened, await lstat(name))) fail();
        onCreate({ kind: 'file', name, stat: opened, owned: true });
        await handle.writeFile(value);
        await handle.sync();
        const stat = await handle.stat();
        if (!same(opened, stat) || !fileSame(stat, await lstat(name))) fail();
        records.push({ kind: 'file', name, stat, bytes: value, owned: true });
      } finally { await handle.close(); }
      await syncDir(path.dirname(name));
    }
    await syncDir(root); await syncDir(parent);
    const inventory = new Map([[parent, invocationId]]);
    for (const item of records.filter(row => row.kind === 'dir' &&
      (row.name.startsWith(`${root}/`) || row.name === root))) {
      const children = records.filter(row => path.dirname(row.name) === item.name)
        .map(row => path.basename(row.name)).sort().join('|');
      inventory.set(item.name, children);
    }
    const liveFence = async () => {
      await capturePublicDirectory(cache, uid, gid, null, cacheStat);
      for (const item of records) {
        if (item.kind === 'dir' && item.name !== cache)
          await directory(item.name, uid, gid, item.stat);
        if (item.kind === 'file')
          await checkedFile(item.name, uid, gid, item.bytes, item.stat);
      }
      for (const [name, children] of inventory)
        if ((await readdir(name)).sort().join('|') !== children) fail();
      for (const item of records.filter(row => row.kind === 'dir' && row.name !== cache))
        await directory(item.name, uid, gid, item.stat);
      await capturePublicDirectory(cache, uid, gid, null, cacheStat);
    };
    const recheck = async () => {
      await recheckSource();
      await liveFence();
      await recheckSource();
      await liveFence();
      return true;
    };
    await recheck();
    let cleaned = false;
    return Object.freeze({ root, recheck, recheckSource,
      async cleanup() {
        if (cleaned) fail();
        await recheck();
        await cleanupWriterMappingLocal(records, uid, gid);
        cleaned = true;
        return true;
      }, async checkAbsent() {
        if (!cleaned) fail();
        const absentFence = async () => {
          await capturePublicDirectory(cache, uid, gid, null, cacheStat);
          if (parentOwned) {
            try { await lstat(parent); fail(); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          } else {
            await directory(parent, uid, gid, parentStat);
            if ((await readdir(parent)).length) fail();
          }
          try { await lstat(root); fail(); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          await capturePublicDirectory(cache, uid, gid, null, cacheStat);
        };
        await absentFence();
        await recheckSource();
        await absentFence();
        return true;
      } });
  } catch { fail(); }
}
