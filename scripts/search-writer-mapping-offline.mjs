import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { capturePublicDirectory } from './search-create-intent-public.mjs';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { parseWriterRoleApprovalArgs,
  readWriterMappingPending } from './search-writer-role-pending.mjs';
import { validateWriterRoleCopiedEvidence } from './search-writer-role-apply-evidence.mjs';
import { validateSerializedWriterMappingIntent } from './search-writer-mapping-intent-pure.mjs';
import { captureApprovedWriterMappingPublic } from './search-writer-mapping-public.mjs';
import { captureWriterMappingScratch,
  cleanupWriterMappingScratch } from './search-writer-mapping-prepare-owner-core.mjs';
import { writeWriterMappingBinding } from './search-writer-role-binding.mjs';

const fail = () => { throw Error('Private writer mapping binding failed.'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
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

/** External nine-field approval, copied before any awaited acquisition. */
export function parseWriterMappingApprovalArgs(input) {
  try { return Object.freeze({ ...parseWriterRoleApprovalArgs(input) }); }
  catch { fail(); }
}

/** Offline binding only; successful original lock remains retained. */
export async function bindWriterMappingOffline(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).some(key => typeof key !== 'string' ||
          !['repository', 'uid', 'gid', 'args', 'fixture'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) fail();
    const { repository, uid, gid } = input;
    const approved = parseWriterMappingApprovalArgs(input.args);
    const fixture = input.fixture ?? {};
    if (typeof repository !== 'string' || path.resolve(repository) !== repository ||
        uid !== process.getuid?.() || gid !== process.getgid?.() ||
        uid < 1 || gid < 1 ||
        (input.fixture !== undefined && process.env.STATION_WRITER_MAPPING_FIXTURE !== '1')) fail();
    const lock = fixture.lock ?? withSearchAdminJobLock;
    const readPending = fixture.readPending ?? readWriterMappingPending;
    const capturePublic = fixture.capturePublic ?? captureApprovedWriterMappingPublic;
    const captureScratch = fixture.captureScratch ?? captureWriterMappingScratch;
    const cleanupScratch = fixture.cleanupScratch ?? cleanupWriterMappingScratch;
    const writeBinding = fixture.writeBinding ?? writeWriterMappingBinding;
    if ([lock, readPending, capturePublic, captureScratch, cleanupScratch,
      writeBinding].some(value => typeof value !== 'function')) fail();
    return await lock({ root: path.join(repository, '.cache/search-db'), uid }, async jobLock => {
      const pending = await readPending(repository, uid, gid, approved);
      const files = pending.files();
      const old = validateWriterRoleCopiedEvidence(files, path.basename(repository));
      const intent = pending.intent();
      const known = Object.freeze({ approvedSha256: approved.approvedSha256,
        dispatchId: intent.dispatchId, ownerId: intent.ownerId });
      const operation = jobLock.beginWriterMappingApply({ ...known });
      const originals = [old.create.dispatchId, old.create.ownerId,
        old.createBinding.invocationId, old.intent.dispatchId, old.intent.ownerId,
        old.binding.invocationId, intent.dispatchId, intent.ownerId,
        operation.invocationId];
      if (new Set(originals).size !== 9) fail();
      let scratchStarted = false, publicStarted = false;
      let scratchItem, publicCapture, bindingAttempted = false;
      const owned = [];
      try {
        await pending.recheck();
        scratchStarted = true;
        scratchItem = await captureScratch(repository, uid, gid, item => owned.push(item));
        await scratchFence(scratchItem, uid, gid);
        publicStarted = true;
        publicCapture = await capturePublic({ repository, uid, gid,
          candidateToken: approved.candidateToken,
          approvedWriter: { writerPrincipal: intent.candidatePublic.writerPrincipal,
            writerCertFingerprint: intent.candidatePublic.writerFingerprint } });
        const publicBytes = publicCapture.publicBytes();
        const ca = publicBytes.get('ca.pem');
        const writerPath = `generations/${approved.candidateToken.replaceAll('-', '')}/writer.pem`;
        const writer = publicBytes.get(writerPath);
        if (!Buffer.isBuffer(ca) || !Buffer.isBuffer(writer) ||
            sha(ca) !== old.create.publicDigests.find(row => row.path === 'ca.pem')?.sha256 ||
            sha(ca) !== old.intent.publicDigests.find(row => row.path === 'ca.pem')?.sha256) fail();
        const context = { invocation: { version: 1, project: old.intent.project,
          databaseOid: old.intent.databaseOid,
          systemIdentifier: old.intent.systemIdentifier,
          invocationId: operation.invocationId,
          dispatchId: intent.dispatchId, ownerId: intent.ownerId },
        createEvidence: { intent: old.create, binding: old.createBinding,
          approvedSha256: sha(files.createIntent) },
        roleEvidence: { intent: old.intent, binding: old.binding,
          approvedSha256: sha(files.intent) },
        priorPublicDigests: canonicalAttestorValue(old.intent.publicDigests).value,
        publicEvidence: { originalCaPemHex: ca.toString('hex'),
          candidateCaPemHex: ca.toString('hex'), writerPemHex: writer.toString('hex'),
          candidateDigests: publicCapture.publicDigests,
          writerPrincipal: publicCapture.writerPrincipal,
          writerCertFingerprint: publicCapture.writerCertFingerprint } };
        validateSerializedWriterMappingIntent(intent, context);
        if (sha(canonicalAttestorValue(intent, 256 * 1024).bytes) !== approved.approvedSha256)
          fail();
        await pending.recheck(); await publicCapture.recheck();
        if (scratchItem.owned) {
          await cleanupScratch(scratchItem, uid, gid);
          scratchItem = { ...scratchItem, removed: true };
          await scratchFence(scratchItem, uid, gid);
          await publicCapture.recheckSourceOnly();
        }
        await pending.recheck();
        await scratchFence(scratchItem, uid, gid);
        if (!scratchItem.owned) await publicCapture.recheck();
        else await publicCapture.recheckSourceOnly();
        bindingAttempted = true;
        await operation.markBindingAttempted();
        const binding = await writeBinding(repository, uid, gid, operation, { ...known });
        await pending.recheck();
        await scratchFence(scratchItem, uid, gid);
        if (!scratchItem.owned) await publicCapture.recheck();
        else await publicCapture.recheckSourceOnly();
        await binding.recheck(); await operation.assertOwned();
        return Object.freeze({ state: 'bound-offline', invocationId: operation.invocationId,
          ...known });
      } catch (error) {
        if (!bindingAttempted) {
          let safe;
          try {
            if (scratchStarted && !scratchItem && owned.length === 0) fail();
            if (scratchItem?.owned && !scratchItem.removed)
              { await cleanupScratch(scratchItem, uid, gid);
                scratchItem = { ...scratchItem, removed: true }; }
            else if (owned.length && !scratchItem)
              await cleanupScratch({ ...owned[0], owned: true }, uid, gid);
            await pending.recheck();
            if (scratchItem) await scratchFence(scratchItem, uid, gid);
            if (publicStarted && !publicCapture) fail();
            if (publicCapture) {
              if (scratchItem?.owned || owned.length) await publicCapture.recheckSourceOnly();
              else await publicCapture.recheck();
            }
            safe = true;
          } catch { safe = false; }
          if (!safe) await operation.retainPreflightFailure();
        }
        throw error;
      }
    });
  } catch { fail(); }
}
