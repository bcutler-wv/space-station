import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { sealCreateIntent, digestCreatePriorPublic } from './search-create-intent-pure.mjs';

const fail = () => { throw Error('Private writer role preparation input failed.'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const canonical = (value, max = 256 * 1024) => canonicalAttestorValue(value, max).bytes;
const createProjectionKeys = ['version', 'revision', 'stage', 'transitionToken',
  'sourceToken', 'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex',
  'databaseOid', 'priorObservationDigest', 'publicFiles', 'target', 'bodyIdentity'];

/** Parse one fixed invocation, never an operation or path selector. */
export function parseWriterRolePrepareInvocation(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 2048) fail();
    const value = JSON.parse(bytes.toString('utf8'));
    if (!canonical(value, 2048).equals(bytes) || Object.keys(value).sort().join('|') !==
        'createApprovedSha256|databaseOid|dispatchId|invocationId|originalCreateBindingSha256|ownerId|project|systemIdentifier|version' ||
        value.version !== 1 || !uuid(value.invocationId) || !uuid(value.dispatchId) ||
        !uuid(value.ownerId) || new Set([value.invocationId, value.dispatchId,
          value.ownerId]).size !== 3 || !digest(value.createApprovedSha256) ||
        !digest(value.originalCreateBindingSha256) ||
        !Number.isSafeInteger(value.databaseOid) || value.databaseOid < 1 ||
        typeof value.project !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.project) ||
        typeof value.systemIdentifier !== 'string' ||
        !/^[0-9]{1,20}$/.test(value.systemIdentifier)) fail();
    return value;
  } catch { fail(); }
}

export async function fixedDir(name, uid, gid, prior) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (stat.mode & 0o777) !== 0o700 || await realpath(name) !== name ||
      prior && (stat.dev !== prior.dev || stat.ino !== prior.ino ||
        stat.uid !== prior.uid || stat.gid !== prior.gid || stat.mode !== prior.mode)) fail();
  return stat;
}
export async function fixedFile(name, uid, gid, max, prior) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
        (stat.mode & 0o777) !== 0o400 || stat.size < 1 || stat.size > max ||
        !same(stat, await lstat(name)) || await realpath(name) !== name ||
        prior && !same(stat, prior.stat)) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead !== stat.size || !same(stat, await handle.stat()) ||
        !same(stat, await lstat(name))) fail();
    const bytes = buffer.subarray(0, read.bytesRead);
    if (prior && !bytes.equals(prior.bytes)) fail();
    return { stat, bytes };
  } finally { await handle.close(); }
}

/** Fixed copied evidence, not an approval or a role sender. */
export async function openWriterRolePrepareInput(root = '/run/search-writer-role-prepare',
  scratchRoot = '/tmp/.cache/search-writer-role-prepare', fixture = undefined) {
  try {
    const uid = fixture?.uid ?? 1000, gid = fixture?.gid ?? 1000;
    if (!path.isAbsolute(root) || !path.isAbsolute(scratchRoot) ||
        !scratchRoot.includes('/.cache/') || fixture !== undefined &&
        (process.env.STATION_WRITER_ROLE_PREPARE_FIXTURE !== '1' ||
          Object.keys(fixture).sort().join('|') !== 'gid|uid' ||
          uid !== process.getuid?.() || gid !== process.getgid?.() ||
          !root.includes('/.cache/results/'))) fail();
    const rootStat = await fixedDir(root, uid, gid);
    const names = ['create-binding.json', 'create-intent.json', 'invocation.json',
      'public', 'transition.password'];
    if ((await readdir(root)).sort().join('|') !== names.join('|')) fail();
    const files = new Map();
    for (const [name, max] of [['create-binding.json', 1024],
      ['create-intent.json', 256 * 1024], ['invocation.json', 2048],
      ['transition.password', 43]]) files.set(name,
      await fixedFile(path.join(root, name), uid, gid, max));
    const invocation = parseWriterRolePrepareInvocation(files.get('invocation.json').bytes);
    const createBytes = files.get('create-intent.json').bytes;
    const intent = JSON.parse(createBytes.toString('utf8'));
    if (!canonical(intent).equals(createBytes)) fail();
    const projection = Object.fromEntries(createProjectionKeys.map(key => [key, intent[key]]));
    const sealed = sealCreateIntent(projection, intent.publicDigests,
      { project: intent.project, systemIdentifier: intent.systemIdentifier,
        dispatchId: intent.dispatchId, ownerId: intent.ownerId });
    if (!canonical(sealed.intent).equals(createBytes) ||
        sealed.sha256 !== invocation.createApprovedSha256 ||
        intent.project !== invocation.project ||
        intent.databaseOid !== invocation.databaseOid ||
        intent.systemIdentifier !== invocation.systemIdentifier) fail();
    const bindingBytes = files.get('create-binding.json').bytes;
    const binding = JSON.parse(bindingBytes.toString('utf8'));
    if (!canonical(binding).equals(bindingBytes) ||
        Object.keys(binding).sort().join('|') !==
          'approvedSha256|dispatchId|invocationId|ownerId|version' ||
        binding.version !== 1 || !uuid(binding.invocationId) ||
        binding.approvedSha256 !== sealed.sha256 ||
        binding.dispatchId !== intent.dispatchId || binding.ownerId !== intent.ownerId ||
        sha(bindingBytes) !== invocation.originalCreateBindingSha256 ||
        [invocation.invocationId, invocation.dispatchId, invocation.ownerId].some(id =>
          id === binding.invocationId || id === binding.dispatchId || id === binding.ownerId)) fail();
    const password = files.get('transition.password').bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(password) ||
        Buffer.from(password, 'base64url').length !== 32) fail();
    const publicRoot = path.join(root, 'public');
    const dirs = new Map(), publicFiles = new Map();
    const expected = new Map([['', new Set()]]);
    for (const row of intent.publicFiles) {
      if (typeof row.path !== 'string' || row.path.startsWith('/') ||
          row.path.split('/').some(part => part === '.' || part === '..' ||
            !/^[a-z0-9.-]+$/.test(part))) fail();
      const parts = row.path.split('/');
      let parent = '';
      for (let i = 0; i < parts.length - 1; i++) {
        expected.get(parent).add(parts[i]);
        parent = parent ? `${parent}/${parts[i]}` : parts[i];
        if (!expected.has(parent)) expected.set(parent, new Set());
      }
      expected.get(parent).add(parts.at(-1));
    }
    for (const [relative, children] of expected) {
      const name = path.join(publicRoot, relative);
      dirs.set(name, await fixedDir(name, uid, gid));
      if ((await readdir(name)).sort().join('|') !== [...children].sort().join('|')) fail();
    }
    for (const row of intent.publicFiles) publicFiles.set(row.path,
      await fixedFile(path.join(publicRoot, row.path), uid, gid, 16_384));
    const recheck = async () => {
      await fixedDir(root, uid, gid, rootStat);
      if ((await readdir(root)).sort().join('|') !== names.join('|')) fail();
      for (const [name, item] of files) await fixedFile(path.join(root, name), uid, gid,
        name === 'create-intent.json' ? 256 * 1024 : name === 'invocation.json' ? 2048 :
          name === 'transition.password' ? 43 : 1024, item);
      for (const [name, stat] of dirs) {
        await fixedDir(name, uid, gid, stat);
        const relative = path.relative(publicRoot, name);
        if ((await readdir(name)).sort().join('|') !==
            [...expected.get(relative)].sort().join('|')) fail();
      }
      for (const [name, item] of publicFiles) await fixedFile(path.join(publicRoot, name),
        uid, gid, 16_384, item);
      const currentDigests = await digestCreatePriorPublic(intent.publicFiles,
        new Map([...publicFiles].map(([name, item]) => [name, item.bytes])),
        new Date(), scratchRoot);
      if (!canonical(currentDigests).equals(canonical(intent.publicDigests))) fail();
      return true;
    };
    await recheck();
    const publicDigests = await digestCreatePriorPublic(intent.publicFiles,
      new Map([...publicFiles].map(([name, item]) => [name, item.bytes])),
      new Date(), scratchRoot);
    if (!canonical(publicDigests).equals(canonical(intent.publicDigests))) fail();
    await recheck();
    return Object.freeze({ readInput: async () => {
      await recheck();
      return { invocation, createEvidence: { intent, approvedSha256: sealed.sha256, binding },
        publicDigests, recheck };
    }, recheck });
  } catch { fail(); }
}
