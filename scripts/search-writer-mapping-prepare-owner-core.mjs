import { randomUUID, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, open, readdir, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { readOriginalWriterMappingFiles } from './search-writer-role-pending.mjs';
import { validateWriterRoleCopiedEvidence } from './search-writer-role-apply-evidence.mjs';
import { capturePublicDirectory, capturePublicFile } from './search-create-intent-public.mjs';
import { captureCandidateWriterPublic } from './search-writer-mapping-public.mjs';
import { prepareWriterMappingPending, cleanupEmptyWriterMappingPendingParent,
  writeWriterMappingPending } from './search-create-intent-pending.mjs';
import { makeWriterMappingPrepareInvocation, stageWriterMappingPreparePublic,
  cleanupWriterMappingLocal } from './search-writer-mapping-prepare-local.mjs';
import { parseWriterMappingPrepareInput } from './search-writer-mapping-prepare-input.mjs';
import { parseWriterMappingPrepareOutput } from './search-writer-mapping-prepare-output.mjs';

const fail = () => { throw Error('Private writer mapping preparation owner failed.'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exact = (value, names) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === names.length && names.every(name =>
    Object.getOwnPropertyDescriptor(value, name)?.enumerable &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, name), 'value'));

/** The two hashes are external prior-approval assertions, never derived from current files. */
export function parseWriterMappingPrepareArgs(input) {
  try {
    const values = canonicalAttestorValue(input, 4096).value;
    if (!Array.isArray(values) || values.length !== 7 ||
        values.some(value => typeof value !== 'string')) fail();
    const [createApprovedSha256, roleApprovedSha256, generationToken,
      writerPrincipal, queryPrincipal, writerCertFingerprint,
      queryCertFingerprint] = values;
    if (![createApprovedSha256, roleApprovedSha256, writerCertFingerprint,
      queryCertFingerprint].every(value => sha.test(value)) ||
        !uuid.test(generationToken)) fail();
    const suffix = generationToken.replaceAll('-', '');
    if (writerPrincipal !== `station-search-indexer-${suffix}` ||
        queryPrincipal !== `station-search-query-${suffix}`) fail();
    return Object.freeze({ createApprovedSha256, roleApprovedSha256,
      signerResult: Object.freeze({ generationToken, writerPrincipal, queryPrincipal,
        writerCertFingerprint, queryCertFingerprint }) });
  } catch { fail(); }
}

async function originalCa(repository, uid, gid) {
  const cache = path.join(repository, '.cache');
  const security = path.join(cache, 'search-security');
  const dirs = [[repository, null], [cache, null], [security, 0o700]];
  const original = new Map();
  for (const [name, mode] of dirs)
    original.set(name, await capturePublicDirectory(name, uid, gid, mode));
  const name = path.join(security, 'ca.pem');
  const ca = await capturePublicFile(name, uid, gid);
  const bytes = Buffer.from(ca.bytes);
  const recheck = async () => {
    for (const [name, mode] of dirs)
      await capturePublicDirectory(name, uid, gid, mode, original.get(name));
    await capturePublicFile(name, uid, gid, ca);
    for (const [name, mode] of dirs)
      await capturePublicDirectory(name, uid, gid, mode, original.get(name));
    return true;
  };
  await recheck();
  return Object.freeze({ bytes: () => Buffer.from(bytes), recheck });
}

async function scratch(repository, uid, gid, created) {
  const name = path.join(repository, '.cache/search-writer-mapping-public');
  const cache = path.dirname(name);
  const cacheStat = await capturePublicDirectory(cache, uid, gid, null);
  let owned = false;
  try { await mkdir(name, { mode: 0o700 }); owned = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await capturePublicDirectory(name, uid, gid, 0o700);
  if (owned) created(Object.freeze({ name, stat, cache, cacheStat }));
  await capturePublicDirectory(cache, uid, gid, null, cacheStat);
  if ((await readdir(name)).length) fail();
  return Object.freeze({ name, stat, cache, cacheStat, owned });
}
async function cleanupScratch(item, uid, gid) {
  if (!item?.owned) return true;
  await capturePublicDirectory(item.cache, uid, gid, null, item.cacheStat);
  await capturePublicDirectory(item.name, uid, gid, 0o700, item.stat);
  if ((await readdir(item.name)).length) fail();
  await rmdir(item.name);
  const handle = await open(item.cache, constants.O_RDONLY | constants.O_DIRECTORY |
    constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
  try { await lstat(item.name); fail(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await capturePublicDirectory(item.cache, uid, gid, null, item.cacheStat);
  return true;
}
export const captureWriterMappingScratch = scratch;
export const cleanupWriterMappingScratch = cleanupScratch;

function inputBytes(invocation, files, role, publicCapture, caBytes, expected) {
  const writerPath = `generations/${role.candidateToken.replaceAll('-', '')}/writer.pem`;
  const publicBytes = publicCapture.publicBytes();
  const writer = publicBytes.get(writerPath);
  if (!Buffer.isBuffer(writer) || !publicBytes.get('ca.pem')?.equals(caBytes)) fail();
  const value = { invocation: { version: 1, project: invocation.project,
    databaseOid: invocation.databaseOid,
    systemIdentifier: invocation.systemIdentifier,
    invocationId: invocation.invocationId, dispatchId: invocation.dispatchId,
    ownerId: invocation.ownerId },
  files: Object.fromEntries(Object.entries(files).map(([name, bytes]) =>
    [name, bytes.toString('hex')])),
  priorPublicDigests: role.publicDigests,
  publicEvidence: { originalCaPemHex: caBytes.toString('hex'),
    candidateCaPemHex: caBytes.toString('hex'), writerPemHex: writer.toString('hex'),
    candidateDigests: publicCapture.publicDigests,
    writerPrincipal: invocation.signerResult.writerPrincipal,
    writerCertFingerprint: invocation.signerResult.writerCertFingerprint } };
  const bytes = Buffer.from(canonicalAttestorValue(value, 512 * 1024).bytes);
  parseWriterMappingPrepareInput(bytes, expected);
  return bytes;
}

/** One proposal preparation. The injected adapter is trusted, fixed and separately reviewed. */
export async function runWriterMappingPrepareOwner(input) {
  let args;
  try {
    const allowed = ['repository', 'uid', 'gid', 'args', 'adapterFactory', 'lock',
      'newId', 'originalReader', 'publicCapture', 'pendingFactory', 'pendingWriter',
      'makeInvocation', 'publicStage'];
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).some(key => typeof key !== 'string' ||
          !allowed.includes(key) || !Object.getOwnPropertyDescriptor(input, key)?.enumerable ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) ||
        !['repository', 'uid', 'gid', 'args', 'adapterFactory'].every(key =>
          Object.hasOwn(input, key))) fail();
    args = parseWriterMappingPrepareArgs(input.args);
    const { repository, uid, gid } = input;
    if (typeof repository !== 'string' || path.resolve(repository) !== repository ||
        uid !== process.getuid?.() || gid !== process.getgid?.() ||
        uid < 1 || gid < 1 || typeof input.adapterFactory !== 'function') fail();
    const lock = input.lock ?? withSearchAdminJobLock;
    const readOriginal = input.originalReader ?? readOriginalWriterMappingFiles;
    const readPublic = input.publicCapture ?? captureCandidateWriterPublic;
    const pendingFactory = input.pendingFactory ?? prepareWriterMappingPending;
    const pendingWriter = input.pendingWriter ?? writeWriterMappingPending;
    const makeInvocation = input.makeInvocation ?? makeWriterMappingPrepareInvocation;
    const publicStage = input.publicStage ?? stageWriterMappingPreparePublic;
    const newId = input.newId ?? randomUUID;
    const adapterFactory = input.adapterFactory;
    if ([lock, readOriginal, readPublic, pendingFactory, pendingWriter,
      makeInvocation, publicStage, newId].some(value => typeof value !== 'function')) fail();
    const deadline = performance.now() + 480_000;
    const tick = () => { if (performance.now() >= deadline) fail(); };
    return await lock({ root: path.join(repository, '.cache/search-db'), uid }, async jobLock => {
      const operation = jobLock.beginWriterMappingPrepare();
      let dispatched = false, pendingStarted = false, scratchStarted = false;
      let pendingItem, scratchItem, stage, invocationLocal, originals, ca, saved;
      let publicCapture, adapter, owner;
      let scratchRemoved = false;
      let stageStarted = false, invocationStarted = false;
      const pendingOwned = [], scratchOwned = [], stageOwned = [], invocationOwned = [];
      try {
        originals = await readOriginal(repository, uid, gid);
        const files = originals.files();
        if (!exact(files, ['createIntent', 'createBinding', 'intent', 'binding']) ||
          Object.values(files).some(value => !Buffer.isBuffer(value))) fail();
        const pinnedFiles = Object.fromEntries(Object.entries(files).map(([key, value]) =>
          [key, Buffer.from(value)]));
        const old = validateWriterRoleCopiedEvidence(pinnedFiles, path.basename(repository));
        if (hash(pinnedFiles.createIntent) !== args.createApprovedSha256 ||
          hash(pinnedFiles.intent) !== args.roleApprovedSha256 ||
          old.createBinding.approvedSha256 !== args.createApprovedSha256 ||
          old.binding.approvedSha256 !== args.roleApprovedSha256) fail();
        await originals.recheck(); tick();
        pendingStarted = true;
        pendingItem = await pendingFactory(repository, uid, gid, item => pendingOwned.push(item));
        await pendingItem.checkEmpty();
        ca = await originalCa(repository, uid, gid);
        const caBytes = ca.bytes();
        if (hash(caBytes) !== old.intent.publicDigests.find(row =>
          row.path === 'ca.pem')?.sha256 ||
          hash(caBytes) !== old.create.publicDigests.find(row =>
            row.path === 'ca.pem')?.sha256) fail();
        scratchStarted = true;
        scratchItem = await scratch(repository, uid, gid, item => scratchOwned.push(item));
        publicCapture = await readPublic({ repository, uid, gid,
          candidateToken: old.intent.candidateToken,
          signerResult: args.signerResult });
        const publicBytes = publicCapture.publicBytes();
        if (!publicBytes.get('ca.pem')?.equals(caBytes)) fail();
        await ca.recheck(); await publicCapture.recheck();
        adapter = await adapterFactory({ repository, uid, gid, jobLock,
          invocationId: operation.invocationId, deadline, tick });
        await adapter.verifyOwner(); tick();
        owner = canonicalAttestorValue(await adapter.captureOwner(), 4096).value;
        if (owner.project !== old.intent.project ||
          Number(owner.databaseOid) !== old.intent.databaseOid ||
          owner.systemIdentifier !== old.intent.systemIdentifier) fail();
        const dispatchId = newId(), ownerId = newId();
        const forbidden = new Set([operation.invocationId, old.intent.dispatchId,
          old.intent.ownerId, old.binding.invocationId, old.create.dispatchId,
          old.create.ownerId, old.createBinding.invocationId]);
        if (![dispatchId, ownerId].every(id => typeof id === 'string' && uuid.test(id) &&
          !forbidden.has(id)) || dispatchId === ownerId) fail();
        const marker = Object.freeze({ version: 1, project: owner.project,
          databaseOid: old.intent.databaseOid,
          systemIdentifier: old.intent.systemIdentifier,
          invocationId: operation.invocationId, dispatchId, ownerId,
          createApprovedSha256: args.createApprovedSha256,
          roleApprovedSha256: args.roleApprovedSha256,
          signerResult: args.signerResult });
        invocationStarted = true;
        invocationLocal = await makeInvocation(repository, uid, gid, marker,
          item => invocationOwned.push(item));
        stageStarted = true;
        stage = await publicStage(repository, uid, gid, operation.invocationId,
          old.intent.candidateToken, publicBytes, item => stageOwned.push(item));
        const expected = Object.freeze({ project: marker.project,
          databaseOid: marker.databaseOid, systemIdentifier: marker.systemIdentifier,
          invocationId: marker.invocationId, dispatchId, ownerId,
          createApprovedSha256: args.createApprovedSha256,
          roleApprovedSha256: args.roleApprovedSha256 });
        const originalInputBytes = inputBytes(marker, pinnedFiles, old.intent,
          publicCapture, caBytes, expected);
        const volumeName = `${owner.project}_search_writer_mapping_prepare_${operation.invocationId.replaceAll('-', '')}`;
        await adapter.preflight({ invocationRoot: invocationLocal.root,
          publicRoot: stage.root, volumeName }); tick();
        await adapter.volumeAbsent(volumeName);
        const recheck = async (volume = null, local = true) => {
          await operation.assertOwned(); await originals.recheck();
          if (saved) await saved.recheck(); else await pendingItem.checkEmpty();
          await ca.recheck();
          if (scratchRemoved) {
            await publicCapture.recheckSourceOnly();
            try { await lstat(scratchItem.name); fail(); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          } else await publicCapture.recheck();
          if (local) { await invocationLocal.recheck(); await stage.recheck(); }
          else { await invocationLocal.checkAbsent(); await stage.checkAbsent(); }
          await adapter.recheckOwner(canonicalAttestorValue(owner, 4096).value);
          await adapter.recheckInfrastructure();
          if (volume) await adapter.checkVolume(volume);
          tick();
        };
        await recheck();
        dispatched = true;
        await operation.markDispatched('transfer');
        const volume = await adapter.createVolume(volumeName); tick();
        await adapter.checkVolume(volume);
        const phase = async name => {
          let attempted = false, completed = false, invalid = false;
          const beforeStart = async () => {
            if (attempted) { invalid = true; fail(); }
            attempted = true;
            await recheck(volume);
            completed = true;
          };
          const result = await adapter.runPhase(name, beforeStart); tick();
          if (!attempted || !completed || invalid || !result ||
              typeof result.id !== 'string' ||
              result.id.length < 1 || result.phase !== name) fail();
          return result;
        };
        const transfer = await phase('transfer');
        await recheck(volume); await operation.confirmCompletion('transfer');
        await recheck(volume); await operation.markDispatched('prepare');
        const prepared = await phase('prepare');
        if (prepared.id === transfer.id) fail();
        if (typeof prepared.rawOutput !== 'string' ||
            Buffer.byteLength(prepared.rawOutput, 'utf8') > 256 * 1024) fail();
        const raw = Buffer.from(prepared.rawOutput, 'utf8'), rawHash = hash(raw);
        const adminPublic = Object.freeze({
          caSha256: old.intent.publicDigests.find(row => row.path === 'ca.pem')?.sha256,
          adminSha256: old.intent.publicDigests.find(row => row.path === 'v1/admin.pem')?.sha256 });
        const sealed = parseWriterMappingPrepareOutput(raw, originalInputBytes,
          expected, adminPublic);
        await recheck(volume); await operation.confirmCompletion('prepare');
        await recheck(volume);
        await adapter.cleanupRemote([transfer, prepared], volume); tick();
        await adapter.volumeAbsent(volumeName);
        await adapter.recheckOwner(canonicalAttestorValue(owner, 4096).value);
        await adapter.recheckInfrastructure();
        await stage.cleanup();
        await invocationLocal.cleanup(); tick();
        if (scratchItem.owned) {
          await publicCapture.recheck();
          await cleanupScratch(scratchItem, uid, gid);
          scratchRemoved = true;
        }
        await recheck(null, false);
        await operation.confirmOwnedCleanup();
        if (hash(raw) !== rawHash ||
            parseWriterMappingPrepareOutput(raw, originalInputBytes,
              expected, adminPublic).sha256 !== sealed.sha256) fail();
        await recheck(null, false);
        await operation.markPendingAttempted();
        saved = await pendingWriter(pendingItem, sealed.intent, sealed.sha256, uid, gid);
        await saved.recheck(); await recheck(null, false);
        await operation.confirmPrepared();
        return Object.freeze({ state: 'prepared', sha256: saved.sha256 });
      } catch (error) {
        if (!dispatched) {
          let cleaned = true;
          try {
            if (stageStarted && !stage &&
                !stageOwned.some(item => item.owned)) fail();
            if (stage) await stage.cleanup();
            else if (stageOwned.length) await cleanupWriterMappingLocal(stageOwned, uid, gid);
            if (invocationStarted && !invocationLocal &&
                !invocationOwned.some(item => item.owned)) fail();
            if (invocationLocal) await invocationLocal.cleanup();
            else if (invocationOwned.length)
              await cleanupWriterMappingLocal(invocationOwned, uid, gid);
            if (pendingStarted && !pendingItem && !pendingOwned.length) fail();
            if (pendingOwned.length)
              await cleanupEmptyWriterMappingPendingParent(pendingOwned[0], uid, gid);
            if (scratchStarted && !scratchItem && !scratchOwned.length) fail();
            if (scratchItem) {
              await ca?.recheck();
              await cleanupScratch(scratchItem, uid, gid);
              if (scratchItem.owned) scratchRemoved = true;
            }
            else if (scratchOwned.length) {
              await cleanupScratch({ ...scratchOwned[0], owned: true }, uid, gid);
              scratchRemoved = true;
            }
            await originals?.recheck(); await ca?.recheck();
            if (publicCapture) {
              if (scratchRemoved) await publicCapture.recheckSourceOnly();
              else await publicCapture.recheck();
            }
            if (adapter) {
              if (!owner) fail();
              await adapter.recheckOwner(canonicalAttestorValue(owner, 4096).value);
              await adapter.recheckInfrastructure();
            }
            await operation.assertOwned();
          } catch { cleaned = false; }
          if (!cleaned) {
            try { await operation.retainPreflightFailure(); }
            catch { /* The latch is already attempted; retain the original failure. */ }
          }
        }
        throw error;
      }
    });
  } catch { fail(); }
}
