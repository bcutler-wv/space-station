import path from 'node:path';
import process from 'node:process';
import { withSearchAdminJobLock } from './search-admin-job-lock.mjs';
import { parseWriterRoleApprovalArgs,
  readWriterRolePending } from './search-writer-role-pending.mjs';
import { writeWriterRoleBinding } from './search-writer-role-binding.mjs';

const fail = () => { throw Error('Private writer role binding failed.'); };

/** Disposable offline binding only. A successful role lock remains retained. */
export async function bindWriterRoleOffline({ repository, uid, gid, args,
  lock = withSearchAdminJobLock, writeBinding = writeWriterRoleBinding }) {
  try {
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || typeof lock !== 'function' ||
        typeof writeBinding !== 'function') fail();
    const approved = parseWriterRoleApprovalArgs(args);
    return await lock({ root: path.join(repository, '.cache/search-db'), uid }, async jobLock => {
      const pending = await readWriterRolePending(repository, uid, gid, approved);
      const known = { approvedSha256: pending.approvedSha256,
        dispatchId: pending.dispatchId, ownerId: pending.ownerId };
      const operation = jobLock.beginWriterRoleApply(known);
      await pending.recheck();
      await operation.markBindingAttempted();
      const binding = await writeBinding(repository, uid, gid, operation, known);
      await pending.recheck();
      await binding.recheck();
      await operation.assertOwned();
      return Object.freeze({ state: 'bound-offline', invocationId: operation.invocationId,
        ...known });
    });
  } catch { fail(); }
}
