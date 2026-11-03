import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { parseCreateApplyApprovalArgs, readCreateApplyPending } from
  './search-create-apply-pending.mjs';
import { writeCreateApplyBinding } from './search-create-apply-binding.mjs';
import { stageCreateApplyPublic } from './search-create-apply-public-stage.mjs';

const fail = () => { throw Error('Private create apply owner failed.'); };

/** One approved file, one lock B, one transfer and one fixed create job. */
export async function runCreateApplyOwner({ repository, uid, gid, args, adapterFactory,
  lock = withSearchAdminJobLock, pendingReader = readCreateApplyPending,
  bindingWriter = writeCreateApplyBinding, publicStage = stageCreateApplyPublic }) {
  try {
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || uid < 1 || gid < 1 ||
        typeof adapterFactory !== 'function') fail();
    const approved = parseCreateApplyApprovalArgs(args);
    // The fixed consumer has a 300-second ceiling. Leave bounded time for
    // transfer, infrastructure checks and exact owned cleanup.
    const deadline = performance.now() + 480_000;
    const tick = () => { if (performance.now() >= deadline) fail(); };
    return await lock({ root: path.join(repository, '.cache/search-db'), uid }, async jobLock => {
      const pending = await pendingReader(repository, uid, gid, approved);
      const known = { approvedSha256: pending.approvedSha256,
        dispatchId: pending.dispatchId, ownerId: pending.ownerId };
      const operation = jobLock.beginCreateApply(known);
      await pending.recheck();
      // A failed append, file create or fsync consumes this lock B.
      await operation.markBindingAttempted();
      const binding = await bindingWriter(repository, uid, gid, operation, known);
      await pending.recheck(); await binding.recheck(); await operation.assertOwned(); tick();
      const intent = pending.intent();
      if (binding.invocationId !== operation.invocationId ||
          intent.dispatchId !== known.dispatchId || intent.ownerId !== known.ownerId) fail();
      const adapter = await adapterFactory({ repository, uid, gid, jobLock,
        invocationId: operation.invocationId, deadline, tick });
      await adapter.verifyOwner(); tick();
      const owner = await adapter.captureOwner();
      if (owner.project !== intent.project ||
          String(owner.databaseOid) !== String(intent.databaseOid) ||
          owner.systemIdentifier !== intent.systemIdentifier) fail();
      const stage = await publicStage({ repository, uid, gid,
        invocationId: operation.invocationId, files: intent.publicFiles,
        publicDigests: intent.publicDigests });
      const volumeName = `${owner.project}_search_create_apply_${operation.invocationId.replaceAll('-', '')}`;
      await adapter.preflight({ publicRoot: stage.root, volumeName }); tick();
      await adapter.volumeAbsent(volumeName);
      const recheck = async (volume = null) => {
        await operation.assertOwned(); await pending.recheck(); await binding.recheck();
        await stage.recheck(); await adapter.recheckOwner(owner);
        await adapter.recheckInfrastructure();
        if (volume) await adapter.checkVolume(volume);
        tick();
      };
      await recheck();
      await operation.markDispatched('transfer');
      const volume = await adapter.createVolume(volumeName); tick();
      await adapter.checkVolume(volume);
      const transfer = await adapter.runPhase('transfer'); tick();
      await recheck(volume);
      await operation.confirmCompletion('transfer');
      await recheck(volume);
      await operation.markDispatched('create');
      const created = await adapter.runPhase('create'); tick();
      await recheck(volume);
      await operation.confirmCompletion('create');
      await recheck(volume);
      await adapter.cleanupRemote([transfer, created], volume); tick();
      await recheck();
      await stage.cleanup(); tick();
      await operation.assertOwned(); await pending.recheck(); await binding.recheck();
      await stage.recheckSource();
      await adapter.recheckOwner(owner); await adapter.recheckInfrastructure(); tick();
      await operation.confirmOwnedCleanup();
      return Object.freeze({ state: 'uuid_bound', ready: false });
    });
  } catch { fail(); }
}
