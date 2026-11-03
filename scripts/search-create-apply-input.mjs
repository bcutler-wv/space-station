import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { digestCreatePriorPublic, sealCreateIntent } from './search-create-intent-pure.mjs';

const fail = () => { throw Error('Private create apply input failed.'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixedFile(name, prior, max, ownerUid, ownerGid) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== ownerUid || stat.gid !== ownerGid ||
        (stat.mode & 0o777) !== 0o400 || stat.size < 1 || stat.size > max ||
        !same(stat, await lstat(name)) || await realpath(name) !== name ||
        prior && !same(stat, prior.stat)) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytesRead !== stat.size || !same(stat, await handle.stat()) ||
        !same(stat, await lstat(name)) || prior && !bytes.equals(prior.bytes)) fail();
    return { stat, bytes };
  } finally { await handle.close(); }
}
async function directory(name, prior, ownerUid, ownerGid) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUid ||
      stat.gid !== ownerGid || (stat.mode & 0o777) !== 0o700 ||
      await realpath(name) !== name || prior &&
      (stat.dev !== prior.dev || stat.ino !== prior.ino || stat.mode !== prior.mode)) fail();
  return stat;
}
function relativeNames(files) {
  const dirs = new Set(['']);
  for (const row of files) {
    if (typeof row.path !== 'string' || row.path.startsWith('/') || row.path.includes('..') ||
        row.path.split('/').some(part => !/^[a-z0-9.-]+$/.test(part))) fail();
    const parts = row.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** Fixed UID-1000 volume; no proposal is generated from observed state. */
export async function openCreateApplyInput(root = '/run/search-create-apply',
  scratchRoot = '/tmp/.cache/search-create-apply', fixture = undefined) {
  try {
    if (!path.isAbsolute(root) || !path.isAbsolute(scratchRoot) ||
        !scratchRoot.includes('/.cache/')) fail();
    const ownerUid = fixture?.ownerUid ?? 1000;
    const ownerGid = fixture?.ownerGid ?? 1000;
    if (fixture !== undefined && (process.env.STATION_CREATE_APPLY_FIXTURE !== '1' ||
        Object.keys(fixture).sort().join('|') !== 'ownerGid|ownerUid' ||
        ownerUid !== process.getuid?.() || ownerGid !== process.getgid?.() ||
        !root.includes('/.cache/results/'))) fail();
    const rootStat = await directory(root, undefined, ownerUid, ownerGid);
    const entries = (await readdir(root)).sort();
    if (entries.join('|') !== 'binding.json|intent.json|public|transition.password') fail();
    const originals = new Map();
    for (const [name, max] of [['binding.json', 1024], ['intent.json', 256 * 1024],
      ['transition.password', 43]]) originals.set(name,
      await fixedFile(path.join(root, name), null, max, ownerUid, ownerGid));
    const intentBytes = originals.get('intent.json').bytes;
    const bindingBytes = originals.get('binding.json').bytes;
    const intent = JSON.parse(intentBytes.toString('utf8'));
    const binding = JSON.parse(bindingBytes.toString('utf8'));
    if (!canonicalAttestorValue(intent, 256 * 1024).bytes.equals(intentBytes) ||
        !canonicalAttestorValue(binding).bytes.equals(bindingBytes) ||
        binding.version !== 1 || binding.approvedSha256 !== digest(intentBytes) ||
        binding.dispatchId !== intent.dispatchId || binding.ownerId !== intent.ownerId ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(binding.invocationId)) fail();
    const projection = Object.fromEntries(['version', 'revision', 'stage', 'transitionToken',
      'sourceToken', 'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex',
      'databaseOid', 'priorObservationDigest', 'publicFiles', 'target', 'bodyIdentity']
      .map(key => [key, intent[key]]));
    if (sealCreateIntent(projection, intent.publicDigests,
      { project: intent.project, systemIdentifier: intent.systemIdentifier,
        dispatchId: intent.dispatchId, ownerId: intent.ownerId }).sha256 !== binding.approvedSha256) fail();
    const secret = originals.get('transition.password').bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, 'base64url').length !== 32) fail();
    const publicRoot = path.join(root, 'public');
    const dirs = relativeNames(intent.publicFiles), directoryStats = new Map(), publicOriginals = new Map();
    for (const relative of dirs) {
      const name = relative ? path.join(publicRoot, relative) : publicRoot;
      directoryStats.set(name, await directory(name, undefined, ownerUid, ownerGid));
      const children = intent.publicFiles.filter(row => path.dirname(row.path) === (relative || '.'))
        .map(row => path.basename(row.path));
      const subdirs = dirs.filter(row => row && path.dirname(row) === (relative || '.'))
        .map(row => path.basename(row));
      if ((await readdir(name)).sort().join('|') !== [...children, ...subdirs].sort().join('|')) fail();
    }
    for (const row of intent.publicFiles) publicOriginals.set(row.path,
      await fixedFile(path.join(publicRoot, row.path), null, 16_384, ownerUid, ownerGid));
    const recheck = async () => {
      await directory(root, rootStat, ownerUid, ownerGid);
      if ((await readdir(root)).sort().join('|') !== entries.join('|')) fail();
      for (const [name, prior] of originals) await fixedFile(path.join(root, name), prior,
        name === 'intent.json' ? 256 * 1024 : name === 'binding.json' ? 1024 : 43,
        ownerUid, ownerGid);
      for (const [name, stat] of directoryStats) {
        await directory(name, stat, ownerUid, ownerGid);
        const relative = path.relative(publicRoot, name);
        const children = intent.publicFiles.filter(row =>
          path.dirname(row.path) === (relative || '.')).map(row => path.basename(row.path));
        const subdirs = dirs.filter(row => row &&
          path.dirname(row) === (relative || '.')).map(row => path.basename(row));
        if ((await readdir(name)).sort().join('|') !== [...children, ...subdirs].sort().join('|')) fail();
      }
      for (const [name, prior] of publicOriginals) await fixedFile(path.join(publicRoot, name),
        prior, 16_384, ownerUid, ownerGid);
      return true;
    };
    const capturePriorPublic = async files => {
      if (!canonicalAttestorValue(files).bytes.equals(canonicalAttestorValue(intent.publicFiles).bytes)) fail();
      await recheck();
      const bytes = new Map([...publicOriginals].map(([name, item]) => [name, item.bytes]));
      const result = await digestCreatePriorPublic(files, bytes, new Date(), scratchRoot);
      await recheck();
      return result;
    };
    await capturePriorPublic(intent.publicFiles);
    return Object.freeze({ readInput: async () => { await recheck(); return {
      approvedSha256: binding.approvedSha256, intent, binding }; },
    capturePriorPublic, recheck });
  } catch { fail(); }
}
