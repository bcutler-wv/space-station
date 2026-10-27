import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { parseCreateBoundaryInvocation } from './search-create-boundary-invocation.mjs';

const password = /^[A-Za-z0-9_-]{43}$/;
const fail = () => { throw new Error('Private create boundary transfer failed.'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function fixedFile(file, owner, modes, max) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== owner || before.gid !== owner ||
        !modes.includes(before.mode & 0o777) || before.size < 1 || before.size > max ||
        !same(before, await lstat(file)) || await realpath(file) !== resolve(file)) fail();
    const bytes = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== before.size || !same(before, await handle.stat()) ||
        !same(before, await lstat(file))) fail();
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** Fixed transfer. The production wrapper supplies only fixed container paths. */
export async function transferCreateBoundaryPassword(input, test = {}) {
  try {
    const owner = test.ownerUid ?? (await lstat(input.invocationFile)).uid;
    const target = test.targetUid ?? 1000;
    const creator = test.creatorUid ?? 0;
    if (!Number.isSafeInteger(owner) || ![1000, 1001].includes(owner) && !test.fixture ||
        !Number.isSafeInteger(target) || target < 1 || !Number.isSafeInteger(creator) || creator < 0 ||
        Object.keys(input).sort().join('|') !== 'invocationFile|passwordFile|volumeRoot') fail();
    const invocation = await fixedFile(input.invocationFile, owner, [0o400], 256);
    const marker = parseCreateBoundaryInvocation(invocation);
    const secret = await fixedFile(input.passwordFile, owner, [0o400, 0o600], 43);
    if (!password.test(secret.toString('utf8')) || Buffer.from(secret.toString('utf8'), 'base64url').length !== 32) fail();
    for (const path of [dirname(input.passwordFile), dirname(input.invocationFile)]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== creator ||
          (stat.mode & 0o022) !== 0 || await realpath(path) !== resolve(path)) fail();
    }
    const root = await open(input.volumeRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const before = await root.stat();
      if (!before.isDirectory() || before.uid !== creator || before.gid !== creator ||
          (before.mode & 0o777) !== 0o755 ||
          (await readdir(input.volumeRoot)).length || await realpath(input.volumeRoot) !== resolve(input.volumeRoot)) fail();
      for (const [name, bytes] of [['invocation', invocation], ['transition.password', secret]]) {
        const filename = join(input.volumeRoot, name);
        const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.chmod(0o400);
          await handle.chown(target, target);
          await handle.sync();
          const stat = await handle.stat();
          if (!stat.isFile() || stat.uid !== target || stat.gid !== target ||
              (stat.mode & 0o777) !== 0o400 || !same(stat, await lstat(filename))) fail();
        } finally { await handle.close(); }
      }
      await root.chmod(0o700);
      await root.chown(target, target);
      await root.sync();
      const after = await root.stat();
      if (after.uid !== target || after.gid !== target || (after.mode & 0o777) !== 0o700 ||
          (await readdir(input.volumeRoot)).sort().join('|') !== 'invocation|transition.password') fail();
    } finally { await root.close(); }
    return marker.invocationId;
  } catch { fail(); }
}

export const productionCreateTransferPaths = Object.freeze({
  passwordFile: '/run/create-transfer-password/password',
  invocationFile: '/run/create-transfer-invocation/invocation',
  volumeRoot: '/run/create-boundary',
});
