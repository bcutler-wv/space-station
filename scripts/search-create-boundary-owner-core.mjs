import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { parseCreateBoundaryInvocation } from './search-create-boundary-invocation.mjs';
import { CreateBoundaryOwnerDiagnosticError, createBoundaryDiagnostic } from './search-create-boundary-owner-diagnostic.mjs';

const fail = () => { throw new CreateBoundaryOwnerDiagnosticError('input', 'invariant'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const sameDir = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode;

async function syncDir(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function directory(name, uid, gid, original) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (stat.mode & 0o777) !== 0o700 || await realpath(name) !== name ||
      original && !sameDir(stat, original)) fail();
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
    const found = Buffer.alloc(bytes.length + 1);
    const { bytesRead } = await handle.read(found, 0, found.length, 0);
    if (bytesRead !== bytes.length || !found.subarray(0, bytesRead).equals(bytes) ||
        !same(stat, await handle.stat()) || !same(stat, await lstat(name))) fail();
    return stat;
  } finally { await handle.close(); }
}
export async function makeInvocation(repository, uid, gid, marker, created) {
  const cache = path.join(repository, '.cache');
  const cacheStat = await lstat(cache);
  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink() || cacheStat.uid !== uid ||
      cacheStat.gid !== gid || (cacheStat.mode & 0o022) !== 0 ||
      await realpath(cache) !== cache) fail();
  const parent = path.join(cache, 'search-create-invocations');
  try { await mkdir(parent, { mode: 0o700 }); await syncDir(cache); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const parentStat = await directory(parent, uid, gid);
  const root = path.join(parent, marker.invocationId);
  await mkdir(root, { mode: 0o700 });
  created();
  const rootStat = await directory(root, uid, gid);
  const bytes = Buffer.from(`${JSON.stringify(marker)}\n`);
  parseCreateBoundaryInvocation(bytes);
  const name = path.join(root, 'invocation');
  const handle = await open(name, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDir(root); await syncDir(parent);
  const stat = await file(name, uid, gid, bytes);
  return { cache, cacheStat, parent, parentStat, root, rootStat, name, stat, bytes };
}
export async function checkInvocation(local, uid, gid) {
  const cache = await lstat(local.cache);
  if (!cache.isDirectory() || cache.isSymbolicLink() ||
      !sameDir(cache, local.cacheStat) || await realpath(local.cache) !== local.cache) fail();
  await directory(local.parent, uid, gid, local.parentStat);
  await directory(local.root, uid, gid, local.rootStat);
  if ((await readdir(local.root)).join('|') !== 'invocation') fail();
  await file(local.name, uid, gid, local.bytes, local.stat);
}
export async function cleanupInvocation(local, uid, gid) {
  await checkInvocation(local, uid, gid);
  await unlink(local.name); await syncDir(local.root);
  if ((await readdir(local.root)).length) fail();
  await rmdir(local.root); await syncDir(local.parent);
}

/** Fixed two-phase read-only delivery; adapter methods are a private test seam. */
export async function runCreateBoundaryOwner({ repository, uid, gid, adapterFactory,
  lock = withSearchAdminJobLock }) {
  let stage = 'input';
  const at = async (name, operation) => { stage = name; return await operation(); };
  try {
    if (path.resolve(repository) !== repository || !Number.isSafeInteger(uid) ||
        !Number.isSafeInteger(gid) || uid < 1 || gid < 1 ||
        uid !== process.getuid?.() || gid !== process.getgid?.() ||
        typeof adapterFactory !== 'function') fail();
    const deadline = performance.now() + 240_000;
    const tick = () => { if (performance.now() >= deadline)
      throw new CreateBoundaryOwnerDiagnosticError('deadline', 'deadline'); };
    stage = 'lock';
    return await lock({ root: path.join(repository, '.cache/search-db'), uid }, async jobLock => {
      const boundary = jobLock.beginCreateBoundary();
      const invocationId = boundary.invocationId;
      let local, localCreated = false, attempted = false;
      try {
        const adapter = await at('owner-verify', () => adapterFactory({ repository, uid, gid,
          jobLock, invocationId, deadline, tick }));
        await at('owner-verify', () => adapter.verifyOwner()); tick();
        const owner = await at('owner-capture', () => adapter.captureOwner()); tick();
        const marker = { version: 1, invocationId, project: owner.project,
          databaseOid: owner.databaseOid, owner: 'station',
          systemIdentifier: owner.systemIdentifier };
        parseCreateBoundaryInvocation(Buffer.from(`${JSON.stringify(marker)}\n`));
        local = await at('invocation', () => makeInvocation(repository, uid, gid, marker,
          () => { localCreated = true; }));
        const volumeName = `${owner.project}_search_create_${invocationId.replaceAll('-', '')}`;
        await at('preflight', () => adapter.preflight({ invocationRoot: local.root, volumeName })); tick();
        await at('volume-absence', () => adapter.volumeAbsent(volumeName));
        await at('transfer-dispatch', () => checkInvocation(local, uid, gid));
        await at('transfer-dispatch', () => adapter.recheckOwner(owner)); tick();
        attempted = true;
        await at('transfer-dispatch', () => boundary.markDispatched('transfer'));
        const volume = await at('volume-create', () => adapter.createVolume(volumeName)); tick();
        await at('transfer-volume', () => adapter.checkVolume(volume));
        const transfer = await at('transfer-run', () => adapter.runPhase('transfer')); tick();
        await at('transfer-postflight', () => adapter.checkVolume(volume));
        await at('transfer-postflight', () => adapter.recheckInfrastructure());
        await at('transfer-postflight', () => adapter.recheckOwner(owner));
        await at('transfer-postflight', () => checkInvocation(local, uid, gid));
        await at('transfer-confirm', () => boundary.confirmCompletion('transfer'));
        await at('inspect-dispatch', () => adapter.checkVolume(volume));
        await at('inspect-dispatch', () => adapter.recheckInfrastructure());
        await at('inspect-dispatch', () => adapter.recheckOwner(owner));
        await at('inspect-dispatch', () => checkInvocation(local, uid, gid)); tick();
        await at('inspect-dispatch', () => boundary.markDispatched('inspect'));
        const inspect = await at('inspect-run', () => adapter.runPhase('inspect')); tick();
        await at('inspect-postflight', () => adapter.checkVolume(volume));
        await at('inspect-postflight', () => adapter.recheckInfrastructure());
        await at('inspect-postflight', () => adapter.recheckOwner(owner));
        await at('inspect-postflight', () => checkInvocation(local, uid, gid));
        await at('inspect-confirm', () => boundary.confirmCompletion('inspect'));
        await at('remote-cleanup', () => adapter.cleanupRemote([transfer, inspect], volume)); tick();
        await at('remote-cleanup', () => adapter.recheckInfrastructure());
        await at('remote-cleanup', () => adapter.recheckOwner(owner));
        await at('local-cleanup', () => cleanupInvocation(local, uid, gid)); tick();
        await at('local-cleanup', () => boundary.confirmOwnedCleanup());
        return { state: 'observed', invocationId };
      } catch (error) {
        if (!attempted && localCreated) {
          let cleaned = false;
          if (local) {
            try { await cleanupInvocation(local, uid, gid); cleaned = true; }
            catch { /* The incomplete local tree must retain the lock. */ }
          }
          if (!cleaned) {
            try { await boundary.markDispatched('transfer'); }
            catch { /* Preserve the original failure; the lock is uncertain. */ }
          }
        }
        throw error;
      }
    });
  } catch (error) { throw createBoundaryDiagnostic(error, stage); }
}
