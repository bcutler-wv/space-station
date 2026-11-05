import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { parseWriterMappingApprovalArgs } from './search-writer-mapping-offline.mjs';
import { readWriterMappingPending } from './search-writer-role-pending.mjs';
import { validateWriterRoleCopiedEvidence } from './search-writer-role-apply-evidence.mjs';
import { validateSerializedWriterMappingIntent } from './search-writer-mapping-intent-pure.mjs';
import { writeWriterMappingBinding } from './search-writer-role-binding.mjs';
import { captureCreateIntentPublic, capturePublicDirectory } from './search-create-intent-public.mjs';
import { captureApprovedWriterMappingPublic } from './search-writer-mapping-public.mjs';
import { captureOriginalWriterMappingCa, captureWriterMappingScratch,
  cleanupWriterMappingScratch } from './search-writer-mapping-prepare-owner-core.mjs';
import { cleanupWriterMappingLocal } from './search-writer-mapping-prepare-local.mjs';
import { stageWriterMappingApplyPublic } from './search-writer-mapping-apply-public-stage.mjs';
import { fixedWriterMappingApplyCommand } from './search-writer-mapping-apply-service-config.mjs';

const fail = () => { throw Error('Private writer mapping apply owner failed.'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id = /^[0-9a-f]{64}$/;
const transferText = 'Private writer mapping apply transfer completed.\n';
const applyText = 'Private writer mapping apply reached writer_attested; search remains disabled.\n';
const pin = value => canonicalAttestorValue(value, 256 * 1024).value;
const fields = (a, invocationId, owner) => Object.freeze([
  a.approvedSha256, String(a.revision), a.transitionToken, a.sourceToken,
  a.sourceIndex, a.sourceUuid, a.candidateToken, a.candidateIndex,
  a.candidateUuid, invocationId, owner.project, String(owner.databaseOid),
  owner.systemIdentifier]);
const exactInput = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail();
  const required = ['repository', 'uid', 'gid', 'args', 'adapterFactory'];
  const optional = ['lock', 'pendingReader', 'bindingWriter', 'publicCapture',
    'priorCapture', 'captureCa', 'captureScratch', 'cleanupScratch', 'publicStage'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (required.some(name => !Object.hasOwn(descriptors, name)) ||
      Reflect.ownKeys(descriptors).some(name => typeof name !== 'string' ||
        ![...required, ...optional].includes(name) ||
        !descriptors[name].enumerable ||
        !Object.hasOwn(descriptors[name], 'value'))) fail();
  return Object.fromEntries(Object.entries(descriptors).map(([key, row]) =>
    [key, row.value]));
};
async function scratchFence(item, uid, gid) {
  await capturePublicDirectory(item.cache, uid, gid, null, item.cacheStat);
  if (item.removed) {
    try { await lstat(item.name); fail(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    await capturePublicDirectory(item.name, uid, gid, 0o700, item.stat);
    if ((await readdir(item.name)).length) fail();
  }
  await capturePublicDirectory(item.cache, uid, gid, null, item.cacheStat);
}

/** One fresh, same-call mapping approval; the adapter is injected and separately reviewed. */
export async function runWriterMappingApplyOwner(input) {
  try {
    const value = exactInput(input);
    const { repository, uid, gid, adapterFactory } = value;
    if (typeof repository !== 'string' || path.resolve(repository) !== repository ||
        uid !== process.getuid?.() || gid !== process.getgid?.() || uid < 1 || gid < 1 ||
        typeof adapterFactory !== 'function') fail();
    const approved = parseWriterMappingApprovalArgs(value.args);
    const lock = value.lock ?? withSearchAdminJobLock;
    const readPending = value.pendingReader ?? readWriterMappingPending;
    const writeBinding = value.bindingWriter ?? writeWriterMappingBinding;
    const capturePublic = value.publicCapture ?? captureApprovedWriterMappingPublic;
    const capturePrior = value.priorCapture ?? captureCreateIntentPublic;
    const captureCa = value.captureCa ?? captureOriginalWriterMappingCa;
    const captureScratch = value.captureScratch ?? captureWriterMappingScratch;
    const cleanupScratch = value.cleanupScratch ?? cleanupWriterMappingScratch;
    const stagePublic = value.publicStage ?? stageWriterMappingApplyPublic;
    if ([lock, readPending, writeBinding, capturePublic, capturePrior, captureCa,
      captureScratch, cleanupScratch, stagePublic].some(fn => typeof fn !== 'function')) fail();
    const deadline = performance.now() + 480_000;
    const tick = () => { if (performance.now() >= deadline) fail(); };
    return await lock({ root: path.join(repository, '.cache/search-db'), uid },
      async jobLock => {
        const pending = await readPending(repository, uid, gid, approved);
        const files = pending.files();
        const old = validateWriterRoleCopiedEvidence(files, path.basename(repository));
        const intent = pin(pending.intent());
        const known = Object.freeze({ approvedSha256: approved.approvedSha256,
          dispatchId: intent.dispatchId, ownerId: intent.ownerId });
        if (pending.approvedSha256 !== known.approvedSha256 ||
            sha(files.createIntent) !== intent.createApprovedSha256 ||
            sha(files.intent) !== intent.roleApprovedSha256 ||
            old.createBinding.approvedSha256 !== intent.createApprovedSha256 ||
            old.binding.approvedSha256 !== intent.roleApprovedSha256 ||
            intent.project !== path.basename(repository)) fail();
        const operation = jobLock.beginWriterMappingApply({ ...known });
        const originalIds = [old.create.dispatchId, old.create.ownerId,
          old.createBinding.invocationId, old.intent.dispatchId,
          old.intent.ownerId, old.binding.invocationId,
          intent.dispatchId, intent.ownerId, operation.invocationId];
        if (new Set(originalIds).size !== 9) fail();
        let bindingAttempted = false, scratchStarted = false, publicStarted = false;
        let stageStarted = false, stage, scratchItem, prior, candidate, ca, binding;
        const scratchOwned = [], stageOwned = [];
        let scratchRemoved = false;
        try {
          await pending.recheck(); tick();
          ca = await captureCa(repository, uid, gid);
          const caBytes = ca.bytes();
          if (!Buffer.isBuffer(caBytes) ||
              sha(caBytes) !== old.intent.publicDigests.find(row =>
                row.path === 'ca.pem')?.sha256 ||
              sha(caBytes) !== old.create.publicDigests.find(row =>
                row.path === 'ca.pem')?.sha256) fail();
          prior = await capturePrior({ repository, uid, gid,
            files: pin(old.intent.publicFiles),
            scratchRoot: path.join(repository, '.cache/search-create-intent') });
          if (!canonicalAttestorValue(prior.publicDigests).bytes.equals(
            canonicalAttestorValue(old.intent.publicDigests).bytes)) fail();
          scratchStarted = true;
          scratchItem = await captureScratch(repository, uid, gid,
            item => scratchOwned.push(item));
          await scratchFence(scratchItem, uid, gid);
          publicStarted = true;
          candidate = await capturePublic({ repository, uid, gid,
            candidateToken: approved.candidateToken,
            approvedWriter: { writerPrincipal: intent.candidatePublic.writerPrincipal,
              writerCertFingerprint: intent.candidatePublic.writerFingerprint } });
          const candidateBytes = candidate.publicBytes();
          if (!candidateBytes.get('ca.pem')?.equals(caBytes) ||
              !canonicalAttestorValue(candidate.publicDigests).bytes.equals(
                canonicalAttestorValue(intent.candidatePublic.publicDigests).bytes)) fail();
          const writerPath = `generations/${approved.candidateToken.replaceAll('-', '')}/writer.pem`;
          const writerBytes = candidateBytes.get(writerPath);
          if (!Buffer.isBuffer(writerBytes)) fail();
          validateSerializedWriterMappingIntent(intent, {
            invocation: { version: 1, project: intent.project,
              databaseOid: intent.databaseOid,
              systemIdentifier: intent.systemIdentifier,
              invocationId: operation.invocationId,
              dispatchId: intent.dispatchId, ownerId: intent.ownerId },
            createEvidence: { intent: old.create, binding: old.createBinding,
              approvedSha256: sha(files.createIntent) },
            roleEvidence: { intent: old.intent, binding: old.binding,
              approvedSha256: sha(files.intent) },
            priorPublicDigests: pin(old.intent.publicDigests),
            publicEvidence: { originalCaPemHex: caBytes.toString('hex'),
              candidateCaPemHex: caBytes.toString('hex'),
              writerPemHex: writerBytes.toString('hex'),
              candidateDigests: pin(candidate.publicDigests),
              writerPrincipal: candidate.writerPrincipal,
              writerCertFingerprint: candidate.writerCertFingerprint } });
          const sourceFence = async () => {
            await pending.recheck(); await ca.recheck(); await prior.recheck();
            if (scratchItem) await scratchFence(scratchItem, uid, gid);
            if (candidate) {
              if (scratchRemoved) await candidate.recheckSourceOnly();
              else await candidate.recheck();
            }
            await pending.recheck(); await ca.recheck(); await prior.recheck();
          };
          await sourceFence(); tick();
          stage = await stagePublic({ repository, uid, gid,
            invocationId: operation.invocationId,
            priorFiles: pin(old.intent.publicFiles), priorBytes: prior.publicBytes(),
            candidateToken: approved.candidateToken, candidateBytes,
            recheckSource: sourceFence,
            onAttempt: () => { stageStarted = true; },
            onCreate: item => stageOwned.push(item) });
          await stage.recheck();
          if (scratchItem.owned) {
            await cleanupScratch(scratchItem, uid, gid);
            scratchRemoved = true;
            scratchItem = { ...scratchItem, removed: true };
          }
          await sourceFence(); await stage.recheck(); tick();
          bindingAttempted = true;
          await operation.markBindingAttempted();
          binding = await writeBinding(repository, uid, gid, operation,
            { ...known });
          await binding.recheck(); await operation.assertOwned();
          await sourceFence(); await stage.recheck(); tick();
          const adapter = await adapterFactory({ repository, uid, gid, jobLock,
            invocationId: operation.invocationId, deadline, tick });
          await adapter.verifyOwner(); tick();
          const owner = pin(await adapter.captureOwner());
          if (owner.project !== intent.project ||
              owner.databaseOid !== intent.databaseOid ||
              owner.systemIdentifier !== intent.systemIdentifier) fail();
          const command = fixedWriterMappingApplyCommand(fields(approved,
            operation.invocationId, owner));
          const stageRoot = stage.root;
          const volumeName = `${owner.project}_search_writer_mapping_apply_${operation.invocationId.replaceAll('-', '')}`;
          await adapter.preflight(Object.freeze({ publicRoot: stageRoot,
            volumeName, command })); tick();
          await adapter.volumeAbsent(volumeName);
          const phaseStates = [];
          const checkCallbackViolation = () => {
            if (phaseStates.some(state => state.violated)) fail();
          };
          const recheck = async (volume = null) => {
            await operation.assertOwned(); await pending.recheck();
            await binding.recheck(); await sourceFence(); await stage.recheck();
            await adapter.recheckOwner(pin(owner));
            await adapter.recheckInfrastructure();
            if (volume) await adapter.checkVolume(pin(volume));
            checkCallbackViolation();
            tick();
          };
          await recheck();
          await operation.markDispatched('transfer');
          const volume = pin(await adapter.createVolume(volumeName)); tick();
          await adapter.checkVolume(pin(volume));
          const checkPhaseCallbacks = () => {
            if (phaseStates.some(state => state.violated || !state.completed ||
              !state.closed)) fail();
          };
          const phase = async (name, expectedText, previousId) => {
            const state = { attempted: false, completed: false,
              violated: false, closed: false };
            phaseStates.push(state);
            const result = pin(await adapter.runPhase(name, async () => {
              if (state.attempted || state.closed) { state.violated = true; fail(); }
              state.attempted = true;
              await recheck(volume);
              state.completed = true;
            })); tick();
            state.closed = true;
            if (!state.attempted || !state.completed || state.violated ||
                typeof result.id !== 'string' || !id.test(result.id) ||
                result.id === previousId || result.phase !== name ||
                result.exitCode !== 0 || result.stdout !== expectedText ||
                result.stderr !== '') fail();
            await recheck(volume);
            checkPhaseCallbacks();
            return result;
          };
          const transfer = await phase('transfer', transferText, null);
          await operation.confirmCompletion('transfer');
          await recheck(volume);
          await operation.markDispatched('apply');
          const applied = await phase('apply', applyText, transfer.id);
          const originalOutput = Buffer.from(applied.stdout, 'utf8');
          await operation.confirmCompletion('apply');
          await recheck(volume);
          await adapter.cleanupRemote([pin(transfer), pin(applied)], pin(volume)); tick();
          checkPhaseCallbacks();
          await adapter.volumeAbsent(volumeName);
          await adapter.containersAbsent([transfer.id, applied.id]);
          await recheck();
          await stage.cleanup(); await stage.checkAbsent(); tick();
          await sourceFence(); await binding.recheck();
          await adapter.recheckOwner(pin(owner));
          await adapter.recheckInfrastructure();
          await adapter.cleanupPrivate(); tick();
          checkPhaseCallbacks();
          await operation.assertOwned(); await pending.recheck();
          await binding.recheck(); await sourceFence();
          await stage.checkAbsent();
          await adapter.recheckOwner(pin(owner));
          await adapter.recheckInfrastructure();
          checkPhaseCallbacks();
          if (!originalOutput.equals(Buffer.from(applyText, 'utf8')) ||
              applied.id === transfer.id) fail();
          await operation.confirmOwnedCleanup();
          await operation.assertOwned();
          checkPhaseCallbacks();
          tick();
          return Object.freeze({ state: 'writer_attested', ready: false });
        } catch (error) {
          if (!bindingAttempted) {
            let safe = true;
            try {
              if (stage) { await stage.cleanup(); await stage.checkAbsent(); }
              else if (stageStarted) {
                await cleanupWriterMappingLocal(stageOwned, uid, gid);
                // Unknown inode after a successful mkdir cannot be adopted for cleanup.
                if (!stageOwned.some(item => item.name?.endsWith(operation.invocationId)))
                  fail();
              }
              if (scratchItem?.owned && !scratchRemoved) {
                await cleanupScratch(scratchItem, uid, gid);
                scratchRemoved = true;
                scratchItem = { ...scratchItem, removed: true };
              } else if (scratchStarted && !scratchItem && scratchOwned.length)
                await cleanupScratch({ ...scratchOwned[0], owned: true }, uid, gid);
              if (scratchStarted && !scratchItem && !scratchOwned.length) fail();
              if (publicStarted && !candidate) fail();
              if (candidate) {
                if (scratchRemoved) await candidate.recheckSourceOnly();
                else await candidate.recheck();
              }
              if (scratchItem) await scratchFence(scratchItem, uid, gid);
              if (prior) await prior.recheck();
              if (ca) await ca.recheck();
              await pending.recheck();
              await operation.assertPreflightOwned();
            } catch { safe = false; }
            if (!safe) await operation.retainPreflightFailure();
          }
          throw error;
        }
      });
  } catch { fail(); }
}
