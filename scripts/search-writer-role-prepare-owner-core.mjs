import { randomUUID, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { readOriginalCreateFiles } from './search-writer-role-pending.mjs';
import { stageCreateApplyPublic } from './search-create-apply-public-stage.mjs';
import { prepareWriterRolePending, writeWriterRolePending } from
  './search-create-intent-pending.mjs';
import { makeWriterRolePrepareInvocation, checkWriterRolePrepareInvocation,
  cleanupWriterRolePrepareInvocation } from './search-writer-role-prepare-invocation.mjs';
import { parseWriterRolePrepareOutput } from './search-writer-role-prepare-output.mjs';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';

const fail = () => { throw Error('Private writer role preparation owner failed.'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** One fixed, read-only job; checked cleanup precedes the exclusive proposal write. */
export async function runWriterRolePrepareOwner({ repository, uid, gid, adapterFactory,
  lock = withSearchAdminJobLock, originalReader = readOriginalCreateFiles,
  publicStage = stageCreateApplyPublic, pendingFactory = prepareWriterRolePending,
  writePending = writeWriterRolePending, makeInvocation = makeWriterRolePrepareInvocation,
  checkInvocation = checkWriterRolePrepareInvocation,
  cleanupInvocation = cleanupWriterRolePrepareInvocation,
  newId = randomUUID }) {
  try {
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || uid < 1 || gid < 1 ||
        typeof adapterFactory !== 'function' || typeof newId !== 'function') fail();
    const deadline = performance.now() + 360_000;
    const tick = () => { if (performance.now() >= deadline) fail(); };
    return await lock({ root: path.join(repository, '.cache/search-db'), uid }, async jobLock => {
      const operation = jobLock.beginWriterRolePrepare();
      let local, stage, attempted = false, localCreated = false, stageAttempted = false;
      try {
        const old = await originalReader(repository, uid, gid);
        const pending = await pendingFactory(repository, uid, gid);
        await old.recheck(); await pending.check(); await operation.assertOwned();
        const adapter = await adapterFactory({ repository, uid, gid, jobLock,
          invocationId: operation.invocationId, deadline, tick });
        await adapter.verifyOwner(); tick();
        const owner = await adapter.captureOwner();
        const oldIntentBytes = old.createBytes(), oldBindingBytes = old.bindingBytes();
        const oldIntent = freeze(old.intent()), oldBinding = freeze(old.binding());
        if (!canonicalAttestorValue(oldIntent, 256 * 1024).bytes.equals(oldIntentBytes) ||
            !canonicalAttestorValue(oldBinding).bytes.equals(oldBindingBytes)) fail();
        if (owner.project !== oldIntent.project ||
            String(owner.databaseOid) !== String(oldIntent.databaseOid) ||
            owner.systemIdentifier !== oldIntent.systemIdentifier) fail();
        const dispatchId = newId(), ownerId = newId();
        const forbidden = new Set([operation.invocationId, oldIntent.dispatchId,
          oldIntent.ownerId, oldBinding.invocationId]);
        if (dispatchId === ownerId || forbidden.has(dispatchId) || forbidden.has(ownerId)) fail();
        const invocation = Object.freeze({ version: 1, invocationId: operation.invocationId,
          project: owner.project, databaseOid: Number(owner.databaseOid),
          systemIdentifier: owner.systemIdentifier,
          createApprovedSha256: old.approvedSha256,
          originalCreateBindingSha256: old.originalCreateBindingSha256,
          dispatchId, ownerId });
        local = await makeInvocation(repository, uid, gid, invocation,
          () => { localCreated = true; });
        stageAttempted = true;
        stage = await publicStage({ repository, uid, gid,
          invocationId: operation.invocationId, files: oldIntent.publicFiles,
          publicDigests: oldIntent.publicDigests });
        const volumeName = `${owner.project}_search_writer_prepare_${operation.invocationId.replaceAll('-', '')}`;
        await adapter.preflight({ invocationRoot: local.root, publicRoot: stage.root,
          volumeName }); tick();
        await adapter.volumeAbsent(volumeName);
        const recheck = async (volume = null) => {
          await operation.assertOwned(); await old.recheck(); await pending.check();
          if (!canonicalAttestorValue(oldIntent, 256 * 1024).bytes.equals(oldIntentBytes) ||
              !canonicalAttestorValue(oldBinding).bytes.equals(oldBindingBytes)) fail();
          await checkInvocation(local, uid, gid); await stage.recheck();
          await adapter.recheckOwner(owner); await adapter.recheckInfrastructure();
          if (volume) await adapter.checkVolume(volume);
          tick();
        };
        await recheck();
        attempted = true;
        await operation.markDispatched('transfer');
        const volume = await adapter.createVolume(volumeName); tick();
        await adapter.checkVolume(volume);
        const transfer = await adapter.runPhase('transfer'); tick();
        await recheck(volume);
        await operation.confirmCompletion('transfer');
        await recheck(volume);
        await operation.markDispatched('prepare');
        const prepared = await adapter.runPhase('prepare'); tick();
        if (typeof prepared.rawOutput !== 'string') fail();
        const originalBytes = Buffer.from(prepared.rawOutput, 'utf8');
        const outputSha = sha(originalBytes);
        const adminPublic = { caSha256: oldIntent.publicDigests.find(row =>
          row.path === 'ca.pem')?.sha256,
        adminSha256: oldIntent.publicDigests.find(row =>
          row.path === 'v1/admin.pem')?.sha256 };
        const sealed = parseWriterRolePrepareOutput(originalBytes, {
          invocation, createEvidence: { intent: oldIntent,
            approvedSha256: old.approvedSha256, binding: oldBinding },
          publicDigests: oldIntent.publicDigests, adminPublic });
        await recheck(volume);
        await operation.confirmCompletion('prepare');
        await recheck(volume);
        await adapter.cleanupRemote([transfer, prepared], volume); tick();
        await adapter.recheckInfrastructure(); await adapter.recheckOwner(owner);
        await stage.cleanup(); tick();
        await cleanupInvocation(local, uid, gid); tick();
        await old.recheck(); await stage.recheckSource(); await pending.check();
        await adapter.recheckOwner(owner); await adapter.recheckInfrastructure();
        await operation.assertOwned();
        await operation.confirmOwnedCleanup();
        if (sha(originalBytes) !== outputSha ||
            sealed.sha256 !== parseWriterRolePrepareOutput(originalBytes, {
              invocation, createEvidence: { intent: oldIntent,
                approvedSha256: old.approvedSha256, binding: oldBinding },
              publicDigests: oldIntent.publicDigests, adminPublic }).sha256) fail();
        await old.recheck(); await stage.recheckSource(); await pending.check();
        await operation.markPendingAttempted();
        const saved = await writePending(pending, sealed.intent, sealed.sha256, uid, gid);
        await saved.recheck(); await old.recheck(); await stage.recheckSource();
        await adapter.recheckOwner(owner); await adapter.recheckInfrastructure();
        await operation.assertOwned(); tick();
        await operation.confirmPrepared();
        return Object.freeze({ state: 'prepared', sha256: saved.sha256 });
      } catch (error) {
        if (!attempted && localCreated) {
          let cleaned = false;
          try {
            if (!local || stageAttempted && !stage) fail();
            if (stage) await stage.cleanup();
            await cleanupInvocation(local, uid, gid);
            cleaned = true;
          } catch { /* Keep the lock when local cleanup is uncertain. */ }
          if (!cleaned) {
            try { await operation.markDispatched('transfer'); }
            catch { /* Preserve the original failure and retained lock. */ }
          }
        }
        throw error;
      }
    });
  } catch { fail(); }
}
