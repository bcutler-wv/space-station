import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { makeInvocation, checkInvocation, cleanupInvocation } from './search-create-boundary-owner-core.mjs';
import { parseCreateBoundaryInvocation } from './search-create-boundary-invocation.mjs';
import { captureCreateIntentPublic } from './search-create-intent-public.mjs';
import { prepareCreateIntentPending, writeCreateIntentPending } from './search-create-intent-pending.mjs';
import { sealCreateIntent } from './search-create-intent-pure.mjs';

const fail = () => { throw new Error('Private create intent owner preparation failed.'); };

/** Fixed two-phase read-only prepare with a durable, exclusive owner-local proposal. */
export async function runCreateIntentPrepareOwner({ repository, uid, gid, adapterFactory,
  lock = withSearchAdminJobLock, capturePublic = captureCreateIntentPublic,
  pendingFactory = prepareCreateIntentPending,
  writePending = writeCreateIntentPending }) {
  try {
    if (path.resolve(repository) !== repository || !Number.isSafeInteger(uid) ||
        !Number.isSafeInteger(gid) || uid < 1 || gid < 1 ||
        uid !== process.getuid?.() || gid !== process.getgid?.() ||
        typeof adapterFactory !== 'function') fail();
    const deadline = performance.now() + 240_000;
    const tick = () => { if (performance.now() >= deadline) fail(); };
    return await lock({ root: path.join(repository, '.cache/search-db'), uid }, async jobLock => {
      const operation = jobLock.beginCreateIntentPrepare();
      const invocationId = operation.invocationId;
      let local, localCreated = false, attempted = false;
      try {
        const pending = await pendingFactory(repository, uid, gid);
        const adapter = await adapterFactory({ repository, uid, gid, jobLock,
          invocationId, deadline, tick });
        await adapter.verifyOwner(); tick();
        const owner = await adapter.captureOwner(); tick();
        const marker = { version: 1, invocationId, project: owner.project,
          databaseOid: owner.databaseOid, owner: 'station',
          systemIdentifier: owner.systemIdentifier };
        parseCreateBoundaryInvocation(Buffer.from(`${JSON.stringify(marker)}\n`));
        local = await makeInvocation(repository, uid, gid, marker,
          () => { localCreated = true; });
        const volumeName = `${owner.project}_search_create_${invocationId.replaceAll('-', '')}`;
        await adapter.preflight({ invocationRoot: local.root, volumeName }); tick();
        await adapter.volumeAbsent(volumeName);
        await pending.check();
        await checkInvocation(local, uid, gid);
        await adapter.recheckOwner(owner);
        attempted = true;
        await operation.markDispatched('transfer');
        const volume = await adapter.createVolume(volumeName); tick();
        await adapter.checkVolume(volume);
        const transfer = await adapter.runPhase('transfer'); tick();
        await adapter.checkVolume(volume);
        await adapter.recheckInfrastructure();
        await adapter.recheckOwner(owner);
        await checkInvocation(local, uid, gid);
        await operation.confirmCompletion('transfer');
        await adapter.checkVolume(volume);
        await adapter.recheckInfrastructure();
        await adapter.recheckOwner(owner);
        await checkInvocation(local, uid, gid);
        await operation.markDispatched('prepare');
        const prepared = await adapter.runPhase('prepare'); tick();
        await adapter.checkVolume(volume);
        await adapter.recheckInfrastructure();
        await adapter.recheckOwner(owner);
        await checkInvocation(local, uid, gid);
        await operation.confirmCompletion('prepare');
        const output = prepared.projection;
        if (!output || Object.keys(output).sort().join('|') !== 'adminPublic|projection') fail();
        const { projection, adminPublic } = output;
        if (!projection || String(projection.databaseOid) !== owner.databaseOid ||
            !adminPublic || Object.keys(adminPublic).sort().join('|') !== 'adminSha256|caSha256') fail();
        const publicCapture = await capturePublic({ repository, uid, gid,
          files: projection.publicFiles, scratchRoot: pending.root });
        tick();
        if (publicCapture.publicDigests.find(row => row.path === 'ca.pem')?.sha256 !== adminPublic.caSha256 ||
            publicCapture.publicDigests.find(row => row.path === 'v1/admin.pem')?.sha256 !==
              adminPublic.adminSha256) fail();
        await publicCapture.recheck();
        await adapter.recheckOwner(owner);
        await adapter.recheckInfrastructure();
        await pending.check();
        const dispatchId = randomUUID(), ownerId = randomUUID();
        if (dispatchId === invocationId || ownerId === invocationId || dispatchId === ownerId) fail();
        const seal = sealCreateIntent(projection, publicCapture.publicDigests,
          { project: owner.project, systemIdentifier: owner.systemIdentifier, dispatchId, ownerId });
        await operation.markPendingAttempted();
        const saved = await writePending(pending, seal.intent, seal.sha256, uid, gid);
        await saved.recheck();
        await publicCapture.recheck();
        tick();
        await adapter.recheckOwner(owner);
        await adapter.recheckInfrastructure();
        await adapter.cleanupRemote([transfer, prepared], volume); tick();
        await adapter.recheckInfrastructure();
        await adapter.recheckOwner(owner);
        await cleanupInvocation(local, uid, gid); tick();
        await publicCapture.recheck();
        await saved.recheck();
        tick();
        await operation.confirmOwnedCleanup();
        return { state: 'prepared', sha256: saved.sha256 };
      } catch (error) {
        if (!attempted && localCreated) {
          let cleaned = false;
          if (local) {
            try { await cleanupInvocation(local, uid, gid); cleaned = true; }
            catch { /* An incomplete local tree retains the lock. */ }
          }
          if (!cleaned) {
            try { await operation.markDispatched('transfer'); }
            catch { /* Retain original failure and uncertain lock. */ }
          }
        }
        throw error;
      }
    });
  } catch { fail(); }
}
