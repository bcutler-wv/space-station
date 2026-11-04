import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { parseWriterRoleApprovalArgs, readWriterRolePending } from './search-writer-role-pending.mjs';
import { writeWriterRoleBinding } from './search-writer-role-binding.mjs';
import { stageCreateApplyPublic } from './search-create-apply-public-stage.mjs';
import { fixedWriterRoleApplyCommand } from './search-writer-role-apply-service-config.mjs';

const fail = () => { throw Error('Private writer role apply owner failed.'); };
const transferText = 'Private writer role apply transfer completed.\n';
const applyText = 'Private writer role apply reached writer_role_attested; search remains disabled.\n';
const id = /^[0-9a-f]{64}$/;
const pin = value => canonicalAttestorValue(value, 256 * 1024).value;
const fields = (approved, invocationId, owner) => Object.freeze([
  approved.approvedSha256, String(approved.revision), approved.transitionToken,
  approved.sourceToken, approved.sourceIndex, approved.sourceUuid,
  approved.candidateToken, approved.candidateIndex, approved.candidateUuid,
  invocationId, owner.project, String(owner.databaseOid), owner.systemIdentifier,
]);

/** One independently approved role operation, one transfer and one apply. */
export async function runWriterRoleApplyOwner(input) {
  try {
    const required = ['repository', 'uid', 'gid', 'args', 'adapterFactory'];
    const optional = ['lock', 'pendingReader', 'bindingWriter', 'publicStage'];
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype) fail();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const names = Reflect.ownKeys(descriptors);
    if (required.some(name => !names.includes(name)) ||
        names.some(name => typeof name !== 'string' ||
          ![...required, ...optional].includes(name) ||
          !descriptors[name].enumerable || !Object.hasOwn(descriptors[name], 'value'))) fail();
    const { repository, uid, gid, args, adapterFactory,
      lock = withSearchAdminJobLock, pendingReader = readWriterRolePending,
      bindingWriter = writeWriterRoleBinding, publicStage = stageCreateApplyPublic } = input;
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || uid < 1 || gid < 1 ||
        typeof adapterFactory !== 'function' || typeof lock !== 'function' ||
        typeof pendingReader !== 'function' || typeof bindingWriter !== 'function' ||
        typeof publicStage !== 'function') fail();
    const approved = parseWriterRoleApprovalArgs(args);
    const deadline = performance.now() + 480_000;
    const tick = () => { if (performance.now() >= deadline) fail(); };
    return await lock({ root: path.join(repository, '.cache/search-db'), uid }, async jobLock => {
      const pending = await pendingReader(repository, uid, gid, approved);
      const known = { approvedSha256: pending.approvedSha256,
        dispatchId: pending.dispatchId, ownerId: pending.ownerId };
      const operation = jobLock.beginWriterRoleApply(known);
      await pending.recheck();
      await operation.markBindingAttempted();
      const binding = await bindingWriter(repository, uid, gid, operation, known);
      await pending.recheck(); await binding.recheck(); await operation.assertOwned(); tick();
      const intent = pin(pending.intent());
      if (binding.invocationId !== operation.invocationId ||
          intent.dispatchId !== known.dispatchId || intent.ownerId !== known.ownerId ||
          intent.project !== path.basename(repository)) fail();
      const adapter = await adapterFactory({ repository, uid, gid, jobLock,
        invocationId: operation.invocationId, deadline, tick });
      await adapter.verifyOwner(); tick();
      const owner = pin(await adapter.captureOwner());
      if (owner.project !== intent.project ||
          String(owner.databaseOid) !== String(intent.databaseOid) ||
          owner.systemIdentifier !== intent.systemIdentifier) fail();
      const authority = fields(approved, operation.invocationId, owner);
      const command = fixedWriterRoleApplyCommand(authority);
      const stage = await publicStage({ repository, uid, gid,
        invocationId: operation.invocationId, files: pin(intent.publicFiles),
        publicDigests: pin(intent.publicDigests) });
      const stageRoot = stage.root;
      const volumeName = `${owner.project}_search_writer_apply_${operation.invocationId.replaceAll('-', '')}`;
      await adapter.preflight(Object.freeze({ publicRoot: stageRoot, volumeName, command })); tick();
      await adapter.volumeAbsent(volumeName);
      const recheck = async (volume = null) => {
        await operation.assertOwned(); await pending.recheck(); await binding.recheck();
        await stage.recheck(); await adapter.recheckOwner(pin(owner));
        await adapter.recheckInfrastructure();
        if (volume) await adapter.checkVolume(pin(volume));
        tick();
      };
      await recheck();
      await operation.markDispatched('transfer');
      const volume = pin(await adapter.createVolume(volumeName)); tick();
      await adapter.checkVolume(pin(volume));
      let transferBeforeStart = false, transferFenceComplete = false;
      const transfer = pin(await adapter.runPhase('transfer', async () => {
        if (transferBeforeStart) fail();
        transferBeforeStart = true;
        await recheck(volume);
        transferFenceComplete = true;
      })); tick();
      if (!transferFenceComplete) fail();
      if (typeof transfer.id !== 'string' || !id.test(transfer.id) ||
          transfer.phase !== 'transfer' ||
          transfer.exitCode !== 0 || transfer.stdout !== transferText ||
          transfer.stderr !== '') fail();
      await recheck(volume);
      await operation.confirmCompletion('transfer');
      await recheck(volume);
      await operation.markDispatched('apply');
      let applyBeforeStart = false, applyFenceComplete = false;
      const applied = pin(await adapter.runPhase('apply', async () => {
        if (applyBeforeStart) fail();
        applyBeforeStart = true;
        await recheck(volume);
        applyFenceComplete = true;
      })); tick();
      if (!applyFenceComplete) fail();
      if (typeof applied.id !== 'string' || !id.test(applied.id) ||
          applied.id === transfer.id || applied.phase !== 'apply' ||
          applied.exitCode !== 0 || applied.stdout !== applyText ||
          applied.stderr !== '') fail();
      await recheck(volume);
      await operation.confirmCompletion('apply');
      await recheck(volume);
      await adapter.cleanupRemote([pin(transfer), pin(applied)], pin(volume)); tick();
      await recheck();
      await stage.cleanup(); tick();
      await operation.assertOwned(); await pending.recheck(); await binding.recheck();
      await stage.recheckSource();
      await adapter.recheckOwner(pin(owner)); await adapter.recheckInfrastructure(); tick();
      await adapter.cleanupPrivate(); tick();
      await operation.assertOwned(); await pending.recheck(); await binding.recheck();
      await stage.recheckSource();
      await adapter.recheckOwner(pin(owner)); await adapter.recheckInfrastructure(); tick();
      await operation.confirmOwnedCleanup();
      return Object.freeze({ state: 'writer_role_attested', ready: false });
    });
  } catch { fail(); }
}
