import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { validateOfflineAttestorManifest, matchOwnerDatabaseOid } from './search-attestor-pure.mjs';
import { stageAttestorPublic } from './search-attestor-public-staging.mjs';
import { AttestorOwnerDiagnosticError, ownerDiagnostic } from './search-attestor-owner-diagnostic.mjs';

const fail = () => { throw new AttestorOwnerDiagnosticError('input', 'invariant'); };
const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
const sameFile = (a, b) => sameDirectory(a, b) && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const ordered = entries => [...entries].sort().join('\0');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WHOLE_MS = 240_000;

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function directory(directory, uid, gid, mode, original) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (stat.mode & 0o777) !== mode || await realpath(directory) !== directory ||
      original && !sameDirectory(stat, original)) fail();
  return stat;
}
async function captured(file, uid, gid, mode, minimum, maximum, original) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
        (stat.mode & 0o777) !== mode || stat.size < minimum || stat.size > maximum ||
        !sameFile(stat, await lstat(file)) || await realpath(file) !== file ||
        original && !sameFile(stat, original.stat)) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || !sameFile(stat, await handle.stat()) ||
        !sameFile(stat, await lstat(file))) fail();
    const bytes = buffer.subarray(0, bytesRead);
    if (original && !bytes.equals(original.bytes)) fail();
    return { stat, bytes };
  } finally { await handle.close(); }
}
async function createParent(parent, cache, uid, gid) {
  const cacheStat = await lstat(cache);
  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink() || cacheStat.uid !== uid ||
      cacheStat.gid !== gid || (cacheStat.mode & 0o022) !== 0 ||
      await realpath(cache) !== cache) fail();
  try { await mkdir(parent, { mode: 0o700 }); await syncDirectory(cache); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return { cacheStat, parentStat: await directory(parent, uid, gid, 0o700) };
}
async function makeInvocation(repository, invocationId, uid, gid, onRootCreated) {
  const cache = path.join(repository, '.cache');
  const parent = path.join(cache, 'search-attestor-invocations');
  const { cacheStat, parentStat } = await createParent(parent, cache, uid, gid);
  const root = path.join(parent, invocationId), manifestDir = path.join(root, 'manifest');
  await mkdir(root, { mode: 0o700 });
  onRootCreated();
  const rootStat = await directory(root, uid, gid, 0o700);
  await mkdir(manifestDir, { mode: 0o700 });
  const manifestDirStat = await directory(manifestDir, uid, gid, 0o700);
  const invocationFile = path.join(root, 'invocation');
  const handle = await open(invocationFile, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { await handle.writeFile(`${invocationId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(manifestDir); await syncDirectory(root); await syncDirectory(parent);
  const invocation = await captured(invocationFile, uid, gid, 0o400, 37, 37);
  return { cache, cacheStat, parent, parentStat, root, rootStat, manifestDir, manifestDirStat,
    invocationFile, invocation, manifestFile: path.join(manifestDir, 'manifest.json') };
}
async function checkInvocation(item, uid, gid, manifest) {
  await checkAncestors(item, uid, gid);
  await directory(item.manifestDir, uid, gid, 0o700, item.manifestDirStat);
  if (ordered(await readdir(item.root)) !== 'invocation\0manifest') fail();
  if (ordered(await readdir(item.manifestDir)) !== (manifest || manifest === null ? 'manifest.json' : '')) fail();
  await captured(item.invocationFile, uid, gid, 0o400, 37, 37, item.invocation);
  if (manifest) await captured(item.manifestFile, uid, gid, 0o600, 2, 256 * 1024, manifest);
}
async function checkAncestors(item, uid, gid) {
  const cache = await lstat(item.cache);
  if (!sameDirectory(cache, item.cacheStat) || await realpath(item.cache) !== item.cache) fail();
  await directory(item.parent, uid, gid, 0o700, item.parentStat);
  await directory(item.root, uid, gid, 0o700, item.rootStat);
}
async function readManifest(item, uid, gid, invocationId) {
  await checkInvocation(item, uid, gid, null);
  const file = await captured(item.manifestFile, uid, gid, 0o600, 2, 256 * 1024);
  if (file.bytes.at(-1) !== 10) fail();
  const value = JSON.parse(file.bytes.subarray(0, -1).toString('utf8'));
  if (!file.bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) fail();
  const manifest = validateOfflineAttestorManifest(invocationId, value);
  if (!matchOwnerDatabaseOid(manifest.identity, item.databaseOid)) fail();
  await checkInvocation(item, uid, gid, file);
  return { file, manifest };
}
async function cleanupInvocation(item, uid, gid, manifest) {
  await checkInvocation(item, uid, gid, manifest);
  if (manifest) {
    await checkInvocation(item, uid, gid, manifest);
    await unlink(item.manifestFile);
    await syncDirectory(item.manifestDir);
  }
  await checkAncestors(item, uid, gid);
  await directory(item.manifestDir, uid, gid, 0o700, item.manifestDirStat);
  if ((await readdir(item.manifestDir)).length) fail();
  await rmdir(item.manifestDir); await syncDirectory(item.root);
  await checkAncestors(item, uid, gid);
  await captured(item.invocationFile, uid, gid, 0o400, 37, 37, item.invocation);
  await unlink(item.invocationFile); await syncDirectory(item.root);
  await checkAncestors(item, uid, gid);
  if ((await readdir(item.root)).length) fail();
  await rmdir(item.root); await syncDirectory(item.parent);
}

/** Three fixed dispatches. Dependencies are a private deterministic test seam. */
export async function runAttestorOwner({ repository, uid, gid, adapterFactory,
  stage = stageAttestorPublic, lock = withSearchAdminJobLock }) {
  let diagnosticStage = 'input';
  const at = async (name, operation) => {
    diagnosticStage = name;
    return await operation();
  };
  try {
    if (path.resolve(repository) !== repository || !Number.isSafeInteger(uid) ||
        !Number.isSafeInteger(gid) || uid !== process.getuid?.() || gid !== process.getgid?.() ||
        uid < 1 || gid < 1 || typeof adapterFactory !== 'function') fail();
    const deadline = performance.now() + WHOLE_MS;
    const tick = () => { if (performance.now() >= deadline)
      throw new AttestorOwnerDiagnosticError('deadline', 'deadline'); };
    const root = path.join(repository, '.cache/search-db');
    diagnosticStage = 'lock';
    return await lock({ root, uid }, async jobLock => {
      const attestor = jobLock.beginAttestor();
      const invocationId = attestor.invocationId;
      if (!UUID.test(invocationId)) fail();
      let local, localRootCreated = false, prepareAttempted = false;
      try {
      const adapter = await at('owner-verify', () => adapterFactory({ repository, uid, gid, jobLock, invocationId,
        deadline, tick }));
      await at('owner-verify', () => adapter.verifyOwner()); tick();
      const owner = await at('owner-capture', () => adapter.captureOwner()); tick();
      local = await at('invocation', () => makeInvocation(repository, invocationId, uid, gid,
        () => { localRootCreated = true; }));
      local.databaseOid = owner.databaseOid;
      const publicParent = path.join(repository, '.cache/search-attestor-public');
      await createParent(publicParent, path.join(repository, '.cache'), uid, gid);
      const volumeName = `${owner.project}_search_attestor_${invocationId.replaceAll('-', '')}`;
      await at('preflight', () => adapter.preflight({ invocationRoot: local.root,
        publicRoot: path.join(publicParent, invocationId), volumeName })); tick();
      await checkInvocation(local, uid, gid);
      await at('preflight', () => adapter.recheckOwner(owner)); tick();
      prepareAttempted = true;
      await at('prepare-dispatch', () => attestor.markDispatched('prepare'));
      const prepare = await at('prepare-run', () => adapter.runPhase('prepare')); tick();
      await at('prepare-confirm', () => adapter.recheckOwner(owner));
      await at('prepare-confirm', () => attestor.confirmCompletion('prepare'));
      const prepared = await at('prepare-manifest', () => readManifest(local, uid, gid, invocationId));
      const publicStage = await at('public-stage', () => stage({ v1Root: path.join(repository, '.cache/search-security'),
        generationsRoot: path.join(repository, '.cache/search-generations'),
        destinationParent: publicParent, invocationId, manifest: prepared.manifest }));
      await at('volume-absence', () => adapter.volumeAbsent(volumeName)); tick();
      await checkInvocation(local, uid, gid, prepared.file);
      await at('transfer-dispatch', () => publicStage.recheck());
      await at('transfer-dispatch', () => adapter.recheckOwner(owner)); tick();
      await at('transfer-dispatch', () => attestor.markDispatched('transfer'));
      const volume = await at('volume-create', () => adapter.createVolume(volumeName)); tick();
      await at('transfer-volume', () => adapter.checkVolume(volume)); tick();
      const transfer = await at('transfer-run', () => adapter.runPhase('transfer')); tick();
      await at('transfer-postflight', () => adapter.checkVolume(volume));
      await at('transfer-postflight', () => adapter.recheckOwner(owner));
      await at('transfer-confirm', () => attestor.confirmCompletion('transfer'));
      await checkInvocation(local, uid, gid, prepared.file);
      await at('attestor-dispatch', () => publicStage.recheck());
      await at('attestor-dispatch', () => adapter.checkVolume(volume));
      await at('attestor-dispatch', () => adapter.recheckOwner(owner)); tick();
      await at('attestor-dispatch', () => attestor.markDispatched('attestor'));
      const final = await at('attestor-run', () => adapter.runPhase('attestor')); tick();
      await at('attestor-postflight', () => adapter.recheckOwner(owner));
      await at('attestor-postflight', () => adapter.checkVolume(volume));
      await checkInvocation(local, uid, gid, prepared.file);
      await at('attestor-postflight', () => publicStage.recheck());
      await at('attestor-confirm', () => attestor.confirmCompletion('attestor'));
      await at('remote-cleanup', () => adapter.cleanupRemote([prepare, transfer, final], volume)); tick();
      await at('local-cleanup', () => publicStage.cleanup()); tick();
      await at('local-cleanup', () => cleanupInvocation(local, uid, gid, prepared.file)); tick();
      await at('local-cleanup', () => attestor.confirmOwnedCleanup());
      tick();
      return { state: 'verified', invocationId };
      } catch (error) {
        if (!prepareAttempted && localRootCreated) {
          let cleaned = false;
          if (local) {
            try { await cleanupInvocation(local, uid, gid); cleaned = true; }
            catch { /* An uncertain local tree retains the global lock. */ }
          }
          if (!cleaned) {
            try { await attestor.markDispatched('prepare'); }
            catch { /* Retain the first failure category; the lock remains uncertain. */ }
          }
        }
        throw error;
      }
    });
  } catch (error) { throw ownerDiagnostic(error, diagnosticStage); }
}
