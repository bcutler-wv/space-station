import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
const held = new WeakSet();
const fail = kind => { throw new Error(`Search admin ${kind}.`); };
const filename = '.job-operation.lock';

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export function isSearchAdminJobLock(lock, root, uid) {
  return held.has(lock) && lock.root === root && lock.uid === uid;
}

/** One owner-local lock for both stopped inspectors and credential commands. */
export async function withSearchAdminJobLock({ root, uid }, work) {
  if (path.resolve(root) !== root || !root.endsWith('/.cache/search-db') ||
      !Number.isSafeInteger(uid) || uid < 1 || uid !== process.getuid?.() ||
      await realpath(path.dirname(root)) !== path.dirname(root) ||
      await realpath(root) !== root) fail('job lock configuration');
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      directory.uid !== uid || (directory.mode & 0o777) !== 0o700) fail('private directory');

  const lockPath = path.join(root, filename);
  let handle;
  try { handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { fail('job locked'); }
  let dispatched = false, confirmed = false, prepared = false;
  const operationId = randomUUID();
  const token = Object.freeze({
    root, uid,
    async markDispatched(role) {
      if (dispatched || !['verifier', 'transition'].includes(role)) fail('job dispatch');
      const record = JSON.stringify({ version: 1, operationId, pid: process.pid, role, state: 'dispatched' });
      await handle.writeFile(`\n${record}\n`);
      await handle.sync();
      await syncDirectory(root);
      dispatched = true;
    },
    confirmCompletion() {
      if (!dispatched || confirmed) fail('job completion');
      confirmed = true;
    },
  });
  held.add(token);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, operationId, pid: process.pid, state: 'preflight' }));
    await handle.sync();
    await syncDirectory(root);
    prepared = true;
    return await work(token);
  } finally {
    held.delete(token);
    const original = await handle.stat().catch(() => null);
    await handle.close().catch(() => {});
    if (prepared && (!dispatched || confirmed) && original) {
      const current = await lstat(lockPath).catch(() => null);
      if (current?.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
          current.uid === uid && (current.mode & 0o777) === 0o600 &&
          current.dev === original.dev && current.ino === original.ino) {
        await rm(lockPath);
        await syncDirectory(root);
      }
    }
  }
}
