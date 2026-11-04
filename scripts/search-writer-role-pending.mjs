import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { sealCreateIntent } from './search-create-intent-pure.mjs';
import { deriveWriterRoleRequest } from '../packages/search/dist/opensearch-writer-role-contract.js';

const fail = () => { throw Error('Private writer role approval failed.'); };
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equalStat = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
const equalFile = (a, b) => equalStat(a, b) && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const roleKeys = ['version', 'revision', 'transitionToken', 'sourceToken',
  'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex', 'candidateUuid',
  'target', 'bodyIdentity', 'bodySha256', 'databaseOid', 'project',
  'systemIdentifier', 'priorEvidenceDigest', 'publicFiles', 'publicDigests',
  'state', 'createApprovedSha256', 'originalCreateBindingSha256',
  'boundControlUpdatedAt', 'baselineDigest', 'dispatchId', 'ownerId'];
function exactMicrotime(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value)) return false;
  const milliseconds = `${value.slice(0, 23)}Z`;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) && date.toISOString() === milliseconds;
}
const createProjectionKeys = ['version', 'revision', 'stage', 'transitionToken',
  'sourceToken', 'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex',
  'databaseOid', 'priorObservationDigest', 'publicFiles', 'target', 'bodyIdentity'];

/** Shared strict serialized intent check; never grants constructor provenance. */
export function validateSerializedWriterRoleIntent(intent, expectedSha256, project) {
  try {
    const value = canonicalAttestorValue(intent, 256 * 1024).value;
    const request = deriveWriterRoleRequest({ token: value.candidateToken,
      index: value.candidateIndex, profile: 'station-mail-v2',
      uuid: value.candidateUuid, writerRole: value.target });
    if (Object.keys(value).sort().join('|') !== roleKeys.slice().sort().join('|') ||
        digest(canonicalAttestorValue(value, 256 * 1024).bytes) !== expectedSha256 ||
        value.project !== project || value.version !== 1 ||
        !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        value.target !== request.target ||
        value.bodyIdentity !== request.dispatchBodyIdentity ||
        value.bodySha256 !== request.bodySha256 ||
        !sha(value.priorEvidenceDigest) || !sha(value.baselineDigest) ||
        !sha(value.createApprovedSha256) || !sha(value.originalCreateBindingSha256) ||
        !uuid(value.dispatchId) || !uuid(value.ownerId) ||
        value.dispatchId === value.ownerId ||
        !Number.isSafeInteger(value.databaseOid) || value.databaseOid < 1 ||
        typeof value.systemIdentifier !== 'string' ||
        !exactMicrotime(value.boundControlUpdatedAt) ||
        !value.state || Object.keys(value.state).sort().join('|') !==
          'indexUuid|kind|phase' || value.state.phase !== 'ready' ||
        value.state.kind !== 'complete' || typeof value.state.indexUuid !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(value.state.indexUuid) ||
        value.sourceToken === 'legacy-v1' && value.state.indexUuid !== value.sourceUuid) fail();
    return value;
  } catch { fail(); }
}

/** Exactly nine positional approved fields, without a path or operation selector. */
export function parseWriterRoleApprovalArgs(input) {
  try {
    const args = canonicalAttestorValue(input).value;
    if (!Array.isArray(args) || args.length !== 9 ||
        args.some(value => typeof value !== 'string')) fail();
    const [approvedSha256, revision, transitionToken, sourceToken, sourceIndex,
      sourceUuid, candidateToken, candidateIndex, candidateUuid] = args;
    if (!sha(approvedSha256) || !/^[1-9][0-9]{0,14}$/.test(revision) ||
        !Number.isSafeInteger(Number(revision)) || !uuid(transitionToken) ||
        !(sourceToken === 'legacy-v1' || uuid(sourceToken)) ||
        !(sourceToken === 'legacy-v1' ? sourceIndex === 'station-mail-v1' :
          /^station-mail-v2-g[a-f0-9]{32}$/.test(sourceIndex)) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(sourceUuid) || !uuid(candidateToken) ||
        candidateIndex !== `station-mail-v2-g${candidateToken.replaceAll('-', '')}` ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(candidateUuid) ||
        sourceToken === candidateToken || sourceIndex === candidateIndex) fail();
    return Object.freeze({ approvedSha256, revision: Number(revision),
      transitionToken, sourceToken, sourceIndex, sourceUuid, candidateToken,
      candidateIndex, candidateUuid });
  } catch { fail(); }
}

async function directory(name, uid, gid, mode, previous) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      stat.gid !== gid || (mode === null ? (stat.mode & 0o022) !== 0 :
        (stat.mode & 0o777) !== mode) || await realpath(name) !== name ||
      previous && !equalStat(stat, previous)) fail();
  return stat;
}

async function capture(name, root, uid, gid, max) {
  const rootStat = await directory(root, uid, gid, 0o700);
  if ((await readdir(root)).join('|') !== path.basename(name)) fail();
  const read = async previous => {
    await directory(root, uid, gid, 0o700, rootStat);
    if ((await readdir(root)).join('|') !== path.basename(name)) fail();
    const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
          (stat.mode & 0o777) !== 0o400 || stat.size < 2 || stat.size > max ||
          !equalFile(stat, await lstat(name)) || await realpath(name) !== name ||
          previous && !equalFile(stat, previous.stat)) fail();
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size || !equalFile(stat, await handle.stat()) ||
          !equalFile(stat, await lstat(name))) fail();
      const bytes = buffer.subarray(0, bytesRead);
      if (previous && !bytes.equals(previous.bytes)) fail();
      return { stat, bytes };
    } finally { await handle.close(); }
  };
  const original = await read();
  return { bytes: original.bytes, recheck: () => read(original) };
}

/** Capture all three original files once; every later check compares their inodes and bytes. */
export async function readWriterRolePending(repository, uid, gid, approved) {
  try {
    approved = canonicalAttestorValue(approved).value;
    if (path.resolve(repository) !== repository || uid !== process.getuid?.() ||
        gid !== process.getgid?.() || !approved ||
        Object.keys(approved).sort().join('|') !==
          'approvedSha256|candidateIndex|candidateToken|candidateUuid|revision|sourceIndex|sourceToken|sourceUuid|transitionToken') fail();
    const cache = path.join(repository, '.cache');
    const cacheStat = await directory(cache, uid, gid, null);
    const paths = [
      ['role', path.join(cache, 'search-writer-role-intent/pending.json'), 256 * 1024],
      ['create', path.join(cache, 'search-create-intent/pending.json'), 256 * 1024],
      ['binding', path.join(cache, 'search-create-apply/binding.json'), 1024],
    ];
    const captures = new Map();
    for (const [key, name, max] of paths) {
      await directory(cache, uid, gid, null, cacheStat);
      captures.set(key, await capture(name, path.dirname(name), uid, gid, max));
    }
    const roleBytes = captures.get('role').bytes;
    const intent = JSON.parse(roleBytes.toString('utf8'));
    if (!canonicalAttestorValue(intent, 256 * 1024).bytes.equals(roleBytes) ||
        intent.revision !== approved.revision ||
        ['transitionToken', 'sourceToken', 'sourceIndex', 'sourceUuid',
          'candidateToken', 'candidateIndex', 'candidateUuid'].some(key =>
          intent[key] !== approved[key])) fail();
    validateSerializedWriterRoleIntent(intent, approved.approvedSha256,
      path.basename(repository));
    const createBytes = captures.get('create').bytes;
    const create = JSON.parse(createBytes.toString('utf8'));
    if (!canonicalAttestorValue(create, 256 * 1024).bytes.equals(createBytes)) fail();
    const projection = Object.fromEntries(createProjectionKeys.map(key => [key, create[key]]));
    const old = sealCreateIntent(projection, create.publicDigests,
      { project: create.project, systemIdentifier: create.systemIdentifier,
        dispatchId: create.dispatchId, ownerId: create.ownerId });
    if (old.sha256 !== intent.createApprovedSha256 ||
        !canonicalAttestorValue(old.intent, 256 * 1024).bytes.equals(createBytes) ||
        digest(createBytes) !== old.sha256 ||
        ['transitionToken', 'sourceToken', 'sourceIndex', 'sourceUuid',
          'candidateToken', 'candidateIndex'].some(key => create[key] !== intent[key]) ||
        intent.databaseOid !== create.databaseOid ||
        intent.priorEvidenceDigest !== create.priorEvidenceDigest ||
        canonicalAttestorValue(intent.publicFiles).bytes.toString('hex') !==
          canonicalAttestorValue(create.publicFiles).bytes.toString('hex') ||
        canonicalAttestorValue(intent.publicDigests).bytes.toString('hex') !==
          canonicalAttestorValue(create.publicDigests).bytes.toString('hex') ||
        create.project !== intent.project || create.systemIdentifier !== intent.systemIdentifier ||
        create.revision + 5 !== intent.revision) fail();
    const bindingBytes = captures.get('binding').bytes;
    const binding = JSON.parse(bindingBytes.toString('utf8'));
    if (!canonicalAttestorValue(binding).bytes.equals(bindingBytes) ||
        Object.keys(binding).sort().join('|') !==
          'approvedSha256|dispatchId|invocationId|ownerId|version' ||
        binding.version !== 1 || !uuid(binding.invocationId) ||
        binding.invocationId === create.dispatchId ||
        binding.invocationId === create.ownerId ||
        binding.approvedSha256 !== old.sha256 || binding.dispatchId !== create.dispatchId ||
        binding.ownerId !== create.ownerId ||
        ![intent.dispatchId, intent.ownerId].every(id =>
          id !== create.dispatchId && id !== create.ownerId && id !== binding.invocationId) ||
        digest(bindingBytes) !== intent.originalCreateBindingSha256) fail();
    const recheck = async () => {
      try {
        await directory(cache, uid, gid, null, cacheStat);
        for (const item of captures.values()) await item.recheck();
        return true;
      } catch { fail(); }
    };
    await recheck();
    return Object.freeze({ approvedSha256: approved.approvedSha256,
      dispatchId: intent.dispatchId, ownerId: intent.ownerId,
      intent: () => JSON.parse(roleBytes.toString('utf8')), recheck });
  } catch { fail(); }
}
