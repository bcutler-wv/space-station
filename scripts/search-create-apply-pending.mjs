import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { sealCreateIntent } from './search-create-intent-pure.mjs';

const fail = () => { throw Error('Private create apply approval failed.'); };
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode;
const sameFile = (a, b) => same(a, b) && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const tupleKeys = ['revision', 'transitionToken', 'sourceToken', 'sourceIndex',
  'sourceUuid', 'candidateToken', 'candidateIndex'];
const projectionKeys = ['version', ...tupleKeys, 'stage', 'databaseOid',
  'priorObservationDigest', 'publicFiles', 'target', 'bodyIdentity'];

/** Fixed positional CLI fields. No path, body, role or recovery selector is accepted. */
export function parseCreateApplyApprovalArgs(input) {
  try {
    const args = canonicalAttestorValue(input).value;
    if (!Array.isArray(args) || args.length !== 8 || args.some(x => typeof x !== 'string')) fail();
    const [approvedSha256, revision, transitionToken, sourceToken, sourceIndex,
      sourceUuid, candidateToken, candidateIndex] = args;
    if (!sha(approvedSha256) || !/^[1-9][0-9]{0,14}$/.test(revision) ||
        !Number.isSafeInteger(Number(revision)) || !uuid(transitionToken) ||
        !(sourceToken === 'legacy-v1' || uuid(sourceToken)) ||
        typeof sourceIndex !== 'string' ||
        !(sourceToken === 'legacy-v1' ? sourceIndex === 'station-mail-v1' :
          /^station-mail-v2-g[a-z0-9]{16,64}$/.test(sourceIndex)) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(sourceUuid) || !uuid(candidateToken) ||
        !/^station-mail-v2-g[a-z0-9]{16,64}$/.test(candidateIndex) ||
        sourceToken === candidateToken || sourceIndex === candidateIndex) fail();
    return Object.freeze({ approvedSha256, revision: Number(revision), transitionToken,
      sourceToken, sourceIndex, sourceUuid, candidateToken, candidateIndex });
  } catch { fail(); }
}

async function directory(name, uid, gid, mode, prior) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (mode === null ? (stat.mode & 0o022) !== 0 : (stat.mode & 0o777) !== mode) ||
      await realpath(name) !== name || prior && !same(stat, prior)) fail();
  return stat;
}

/** Read the only approved file, reconstruct its 3a seal and capture this apply's inode. */
export async function readCreateApplyPending(repository, uid, gid, approved) {
  try {
    approved = canonicalAttestorValue(approved).value;
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || !approved ||
        Object.keys(approved).sort().join('|') !== ['approvedSha256', ...tupleKeys].sort().join('|')) fail();
    const cache = path.join(repository, '.cache');
    const root = path.join(cache, 'search-create-intent');
    const name = path.join(root, 'pending.json');
    const cacheStat = await directory(cache, uid, gid, null);
    const rootStat = await directory(root, uid, gid, 0o700);
    const read = async prior => {
      await directory(cache, uid, gid, null, cacheStat);
      await directory(root, uid, gid, 0o700, rootStat);
      if ((await readdir(root)).join('|') !== 'pending.json') fail();
      const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
            (stat.mode & 0o777) !== 0o400 || stat.size < 2 || stat.size > 256 * 1024 ||
            !sameFile(stat, await lstat(name)) || await realpath(name) !== name ||
            prior && !sameFile(stat, prior.stat)) fail();
        const buffer = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== stat.size || !sameFile(stat, await handle.stat()) ||
            !sameFile(stat, await lstat(name))) fail();
        const bytes = buffer.subarray(0, bytesRead);
        if (prior && !bytes.equals(prior.bytes)) fail();
        return { stat, bytes };
      } finally { await handle.close(); }
    };
    const original = await read();
    const intent = JSON.parse(original.bytes.toString('utf8'));
    if (!canonicalAttestorValue(intent, 256 * 1024).bytes.equals(original.bytes) ||
        intent.project !== path.basename(repository)) fail();
    const projection = Object.fromEntries(projectionKeys.map(key => [key, intent[key]]));
    const seal = sealCreateIntent(projection, intent.publicDigests,
      { project: intent.project, systemIdentifier: intent.systemIdentifier,
        dispatchId: intent.dispatchId, ownerId: intent.ownerId });
    if (seal.sha256 !== approved.approvedSha256 ||
        !canonicalAttestorValue(seal.intent, 256 * 1024).bytes.equals(original.bytes) ||
        createHash('sha256').update(original.bytes).digest('hex') !== approved.approvedSha256 ||
        tupleKeys.some(key => intent[key] !== approved[key])) fail();
    const recheck = async () => {
      try { await read(original); return true; } catch { fail(); }
    };
    await recheck();
    return Object.freeze({ approvedSha256: seal.sha256,
      dispatchId: intent.dispatchId, ownerId: intent.ownerId,
      intent: () => JSON.parse(original.bytes.toString('utf8')),
      bytes: () => Buffer.from(original.bytes), recheck });
  } catch { fail(); }
}
