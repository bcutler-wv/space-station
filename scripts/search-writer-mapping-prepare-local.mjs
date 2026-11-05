import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { parseWriterMappingPrepareInvocation } from './search-writer-mapping-prepare-reader.mjs';

const fail = () => { throw Error('Private writer mapping local preparation failed.'); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sameDir = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
const sameFile = (a, b) => sameDir(a, b) && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
async function syncDir(name) {
  const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function directory(name, uid, gid, mode, original) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      stat.gid !== gid || (mode === null ? (stat.mode & 0o022) !== 0 :
        (stat.mode & 0o777) !== mode) || await realpath(name) !== name ||
      original && !sameDir(stat, original)) fail();
  return stat;
}
async function capturedFile(name, uid, gid, bytes, original) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
        (stat.mode & 0o777) !== 0o400 || stat.size !== bytes.length ||
        original && !sameFile(stat, original) || !sameFile(stat, await lstat(name)) ||
        await realpath(name) !== name) fail();
    const data = Buffer.alloc(bytes.length + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== bytes.length || !data.subarray(0, bytesRead).equals(bytes) ||
        !sameFile(stat, await handle.stat()) || !sameFile(stat, await lstat(name))) fail();
    return stat;
  } finally { await handle.close(); }
}
function fixedBase(repository, invocationId, kind) {
  if (typeof repository !== 'string' || path.resolve(repository) !== repository ||
      typeof invocationId !== 'string' || !uuid.test(invocationId)) fail();
  const suffix = kind === 'invocation' ? 'search-writer-mapping-invocations' :
    'search-writer-mapping-prepare-public';
  return { cache: path.join(repository, '.cache'),
    parent: path.join(repository, '.cache', suffix),
    root: path.join(repository, '.cache', suffix, invocationId) };
}

async function writeLocal(repository, uid, gid, invocationId, kind, content, onCreate) {
  try {
    if (uid !== process.getuid?.() || gid !== process.getgid?.() ||
        typeof onCreate !== 'function') fail();
    const { cache, parent, root } = fixedBase(repository, invocationId, kind);
    const cacheStat = await directory(cache, uid, gid, null);
    onCreate(Object.freeze({ kind: 'dir', name: cache,
      stat: cacheStat, mode: null, owned: false }));
    let parentOwned = false;
    try { await mkdir(parent, { mode: 0o700 }); parentOwned = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const parentStat = await directory(parent, uid, gid, 0o700);
    onCreate(Object.freeze({ kind: 'dir', name: parent,
      stat: parentStat, mode: 0o700, owned: parentOwned }));
    if ((await readdir(parent)).length) fail();
    if (parentOwned) await syncDir(cache);
    const records = [{ kind: 'dir', name: cache, stat: cacheStat, mode: null,
      owned: false }, { kind: 'dir', name: parent, stat: parentStat,
      mode: 0o700, owned: parentOwned }];
    await mkdir(root, { mode: 0o700 });
    const rootStat = await directory(root, uid, gid, 0o700);
    const rootRecord = Object.freeze({ kind: 'dir', name: root, stat: rootStat, owned: true });
    records.push(rootRecord); onCreate(rootRecord);
    const dirs = kind === 'stage' ? ['generations',
      `generations/${content.candidateToken.replaceAll('-', '')}`] : [];
    for (const relative of dirs) {
      const name = path.join(root, relative);
      await mkdir(name, { mode: 0o700 });
      const stat = await directory(name, uid, gid, 0o700);
      const record = Object.freeze({ kind: 'dir', name, stat, owned: true });
      records.push(record); onCreate(record);
      await syncDir(path.dirname(name));
    }
    const files = kind === 'stage' ? new Map([
      ['ca.pem', Buffer.from(content.bytes.get('ca.pem'))],
      [`generations/${content.candidateToken.replaceAll('-', '')}/writer.pem`,
        Buffer.from(content.bytes.get(`generations/${content.candidateToken.replaceAll('-', '')}/writer.pem`))],
    ]) : new Map([['invocation.json', Buffer.from(content.bytes)]]);
    for (const [relative, bytes] of files) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 16_384 &&
          kind === 'stage' || bytes.length > 4096 && kind === 'invocation') fail();
      const name = path.join(root, relative);
      const handle = await open(name, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
      let stat;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== uid ||
            opened.gid !== gid || (opened.mode & 0o777) !== 0o400) fail();
        onCreate(Object.freeze({ kind: 'file', name, stat: opened, owned: true }));
        await handle.writeFile(bytes); await handle.sync();
        stat = await handle.stat();
        if (!sameInode(opened, stat) || !sameFile(stat, await lstat(name))) fail();
      } finally { await handle.close(); }
      records.push(Object.freeze({ kind: 'file', name, stat, bytes, owned: true }));
      await syncDir(path.dirname(name));
    }
    await syncDir(root); await syncDir(parent);
    const recheck = async () => {
      await directory(cache, uid, gid, null, cacheStat);
      await directory(parent, uid, gid, 0o700, parentStat);
      if ((await readdir(parent)).join('|') !== invocationId) fail();
      for (const record of records) {
        if (record.kind === 'dir') await directory(record.name, uid, gid,
          record.mode ?? null, record.stat);
        else await capturedFile(record.name, uid, gid, record.bytes, record.stat);
      }
      const inventory = kind === 'stage' ? new Map([
        [root, 'ca.pem|generations'],
        [path.join(root, 'generations'), content.candidateToken.replaceAll('-', '')],
        [path.join(root, 'generations', content.candidateToken.replaceAll('-', '')), 'writer.pem'],
      ]) : new Map([[root, 'invocation.json']]);
      for (const [name, names] of inventory)
        if ((await readdir(name)).sort().join('|') !== names) fail();
      for (const record of records)
        if (record.kind === 'dir')
          await directory(record.name, uid, gid, record.mode ?? null, record.stat);
      await directory(cache, uid, gid, null, cacheStat);
      await directory(parent, uid, gid, 0o700, parentStat);
      return true;
    };
    await recheck();
    let cleaned = false;
    return Object.freeze({ root, recheck, async cleanup() {
      try {
        if (cleaned) fail();
        await recheck();
        await cleanupWriterMappingLocal(records, uid, gid);
        cleaned = true;
        return true;
      } catch { fail(); }
    }, async checkAbsent() {
      if (!cleaned) fail();
      await directory(cache, uid, gid, null, cacheStat);
      if (parentOwned) {
        try { await lstat(parent); fail(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      } else {
        await directory(parent, uid, gid, 0o700, parentStat);
        if ((await readdir(parent)).length) fail();
      }
      try { await lstat(root); fail(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return true;
    } });
  } catch { fail(); }
}

/** Remove only records captured at creation; unknown or replaced paths remain untouched. */
export async function cleanupWriterMappingLocal(records, uid, gid) {
  try {
    if (!Array.isArray(records) || uid !== process.getuid?.() || gid !== process.getgid?.()) fail();
    for (const record of records.slice().reverse()) {
      if (!record.owned) continue;
      const parent = records.find(item => item.kind === 'dir' &&
        item.name === path.dirname(record.name));
      if (parent) await directory(parent.name, uid, gid, parent.mode ?? null, parent.stat);
      const stat = await lstat(record.name);
      if (!sameInode(stat, record.stat) || (record.kind === 'dir' ?
        !stat.isDirectory() || !sameDir(stat, record.stat) :
        !stat.isFile() || stat.nlink !== 1)) fail();
      if (record.kind === 'dir') {
        if ((await readdir(record.name)).length) fail();
        await rmdir(record.name);
      } else await unlink(record.name);
      await syncDir(path.dirname(record.name));
    }
    return true;
  } catch { fail(); }
}

export async function makeWriterMappingPrepareInvocation(repository, uid, gid, marker, created) {
  const bytes = canonicalAttestorValue(marker, 4096).bytes;
  parseWriterMappingPrepareInvocation(bytes);
  return writeLocal(repository, uid, gid, marker.invocationId, 'invocation', { bytes }, created);
}

export function stageWriterMappingPreparePublic(repository, uid, gid, invocationId,
  candidateToken, publicBytes, created) {
  if (typeof candidateToken !== 'string' || !uuid.test(candidateToken)) fail();
  const suffix = candidateToken.replaceAll('-', '');
  if (!(publicBytes instanceof Map) || publicBytes.size !== 2 ||
      !Buffer.isBuffer(publicBytes.get('ca.pem')) ||
      !Buffer.isBuffer(publicBytes.get(`generations/${suffix}/writer.pem`))) fail();
  const bytes = new Map([['ca.pem', Buffer.from(publicBytes.get('ca.pem'))],
    [`generations/${suffix}/writer.pem`,
      Buffer.from(publicBytes.get(`generations/${suffix}/writer.pem`))]]);
  return writeLocal(repository, uid, gid, invocationId, 'stage',
    { candidateToken, bytes }, created);
}
