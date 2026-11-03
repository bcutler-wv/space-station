import path from 'node:path';
import process from 'node:process';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { parseCreateApplyApprovalArgs,
  readCreateApplyPending } from './search-create-apply-pending.mjs';
import { writeCreateApplyBinding } from './search-create-apply-binding.mjs';

const fail = () => { throw Error('Private create apply binding failed.'); };

/** Offline source proof only. A bound lock stays held; no live apply CLI calls this. */
export async function bindCreateApplyOffline({ repository, uid, gid, args,
  lock = withSearchAdminJobLock, writeBinding = writeCreateApplyBinding }) {
  try {
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || typeof lock !== 'function' ||
        typeof writeBinding !== 'function') fail();
    const approved = parseCreateApplyApprovalArgs(args);
    return await lock({ root: path.join(repository, '.cache/search-db'), uid }, async jobLock => {
      const pending = await readCreateApplyPending(repository, uid, gid, approved);
      const operation = jobLock.beginCreateApply({ approvedSha256: pending.approvedSha256,
        dispatchId: pending.dispatchId, ownerId: pending.ownerId });
      await pending.recheck();
      await operation.markBindingAttempted();
      const binding = await writeBinding(repository, uid, gid, operation,
        { approvedSha256: pending.approvedSha256, dispatchId: pending.dispatchId,
          ownerId: pending.ownerId });
      await pending.recheck();
      await binding.recheck();
      await operation.assertOwned();
      return Object.freeze({ state: 'bound-offline', invocationId: operation.invocationId,
        approvedSha256: pending.approvedSha256,
        dispatchId: pending.dispatchId, ownerId: pending.ownerId });
    });
  } catch { fail(); }
}
