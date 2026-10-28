import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateCapturedAttestorPublic,
  validateCapturedAttestorPublicAtTime } from './search-attestor-command-core.mjs';

const fail = () => { throw new Error('Private create intent admin identity failed.'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function captured(name, uid, gid, mode) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
        (stat.mode & 0o777) !== mode || stat.size < 100 || stat.size > 16_384 ||
        !same(stat, await lstat(name)) || await realpath(name) !== name) fail();
    const data = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== stat.size || !same(stat, await handle.stat()) ||
        !same(stat, await lstat(name))) fail();
    return { bytes: data.subarray(0, bytesRead), stat };
  } finally { await handle.close(); }
}

/** Fixed UID-1000 job proves its mounted TLS key and public identity without emitting bytes. */
export async function captureCreateIntentAdminVolume(root = '/run/station-admin',
  ownership = { uid: 0, gid: 1000, dirMode: 0o750, fileMode: 0o440 }, scratchRoot = '/tmp', test = {}) {
  try {
    if (test.fixtureFinalNow !== undefined &&
        (process.env.STATION_INTENT_CERT_FIXTURE !== '1' ||
          typeof test.fixtureFinalNow !== 'function')) fail();
    if (path.resolve(root) !== root || path.resolve(scratchRoot) !== scratchRoot) fail();
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownership.uid ||
        stat.gid !== ownership.gid || (stat.mode & 0o777) !== ownership.dirMode ||
        await realpath(root) !== root ||
        (await readdir(root)).sort().join('|') !== 'admin.key|admin.pem|ca.pem') fail();
    const names = ['ca.pem', 'admin.pem', 'admin.key'];
    const files = new Map();
    for (const name of names) files.set(name,
      await captured(path.join(root, name), ownership.uid, ownership.gid, ownership.fileMode));
    const ca = files.get('ca.pem').bytes, admin = files.get('admin.pem').bytes;
    const key = files.get('admin.key').bytes;
    const validate = () => {
      if (!new X509Certificate(admin).publicKey.export({ type: 'spki', format: 'der' })
        .equals(createPublicKey(key).export({ type: 'spki', format: 'der' }))) fail();
    };
    validate();
    const publicFiles = { publicFiles: [
      { path: 'ca.pem', role: 'ca', principal: 'station-search-ca', fingerprint: null },
      { path: 'v1/admin.pem', role: 'admin', principal: 'station-search-admin', fingerprint: null },
    ] };
    const publicBytes = new Map([['ca.pem', ca], ['v1/admin.pem', admin]]);
    await validateCapturedAttestorPublic(publicFiles, publicBytes, new Date(), scratchRoot);
    validateCapturedAttestorPublicAtTime(publicFiles, publicBytes,
      test.fixtureFinalNow?.() ?? new Date());
    const recheck = async () => {
      try {
        const current = await lstat(root);
        if (!same(current, stat) || await realpath(root) !== root ||
            (await readdir(root)).sort().join('|') !== 'admin.key|admin.pem|ca.pem') fail();
        for (const [name, item] of files) {
          const next = await captured(path.join(root, name), ownership.uid, ownership.gid,
            ownership.fileMode);
          if (!same(item.stat, next.stat) || !item.bytes.equals(next.bytes)) fail();
        }
        validate();
        await validateCapturedAttestorPublic(publicFiles, publicBytes, new Date(), scratchRoot);
        validateCapturedAttestorPublicAtTime(publicFiles, publicBytes,
          test.fixtureFinalNow?.() ?? new Date());
        return true;
      } catch { fail(); }
    };
    await recheck();
    return Object.freeze({ public: { caSha256: hash(ca), adminSha256: hash(admin) }, recheck });
  } catch { fail(); }
}
