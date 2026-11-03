import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { sealCreateIntent } from './search-create-intent-pure.mjs';

const fail = () => { throw Error('Private create apply transfer failed.'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const projectionKeys = ['version', 'revision', 'stage', 'transitionToken', 'sourceToken',
  'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex', 'databaseOid',
  'priorObservationDigest', 'publicFiles', 'target', 'bodyIdentity'];

async function capture(name, uid, mode, max) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== uid ||
        !(Array.isArray(mode) ? mode : [mode]).includes(stat.mode & 0o777) ||
        stat.size < 1 || stat.size > max ||
        !same(stat, await lstat(name)) || await realpath(name) !== name) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || !same(stat, await handle.stat()) ||
        !same(stat, await lstat(name))) fail();
    return { stat, bytes: buffer.subarray(0, bytesRead), name };
  } finally { await handle.close(); }
}
async function directory(name, uid, mode) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      stat.gid !== uid || (stat.mode & 0o777) !== mode || await realpath(name) !== name) fail();
  return stat;
}
async function syncDir(name) {
  const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Fixed network-free copy of the sealed approval and exact prior public inventory. */
export async function transferCreateApplyInputs(input, fixture = {}) {
  try {
    if (Object.keys(input).sort().join('|') !==
        'bindingFile|intentFile|passwordFile|publicRoot|volumeRoot' ||
        Object.values(input).some(name => typeof name !== 'string' || !path.isAbsolute(name)) ||
        fixture.targetUid !== undefined && fixture.fixture !== true) fail();
    const uid = (await lstat(input.intentFile)).uid;
    if (!fixture.fixture && ![1000, 1001].includes(uid)) fail();
    const target = fixture.targetUid ?? 1000;
    const inputParents = new Map();
    for (const name of [input.intentFile, input.bindingFile, input.passwordFile]) {
      const parent = path.dirname(name);
      inputParents.set(parent, await directory(parent, fixture.creatorUid ?? 0, 0o755));
      if ((await readdir(parent)).join('|') !== path.basename(name)) fail();
    }
    const intentFile = await capture(input.intentFile, uid, 0o400, 256 * 1024);
    const bindingFile = await capture(input.bindingFile, uid, 0o400, 1024);
    const passwordFile = await capture(input.passwordFile, uid, [0o400, 0o600], 43);
    const secret = passwordFile.bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, 'base64url').length !== 32) fail();
    const intent = JSON.parse(intentFile.bytes.toString('utf8'));
    const binding = JSON.parse(bindingFile.bytes.toString('utf8'));
    if (!canonicalAttestorValue(intent, 256 * 1024).bytes.equals(intentFile.bytes) ||
        !canonicalAttestorValue(binding).bytes.equals(bindingFile.bytes) ||
        Object.keys(binding).sort().join('|') !== 'approvedSha256|dispatchId|invocationId|ownerId|version' ||
        binding.version !== 1 || binding.approvedSha256 !== sha(intentFile.bytes) ||
        binding.dispatchId !== intent.dispatchId || binding.ownerId !== intent.ownerId ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(binding.invocationId)) fail();
    const projection = Object.fromEntries(projectionKeys.map(key => [key, intent[key]]));
    const sealed = sealCreateIntent(projection, intent.publicDigests,
      { project: intent.project, systemIdentifier: intent.systemIdentifier,
        dispatchId: intent.dispatchId, ownerId: intent.ownerId });
    if (sealed.sha256 !== binding.approvedSha256 ||
        !canonicalAttestorValue(sealed.intent).bytes.equals(intentFile.bytes)) fail();
    const files = intent.publicFiles;
    const dirs = new Set(['']);
    for (const row of files) {
      if (typeof row.path !== 'string' || row.path.startsWith('/') || row.path.includes('..') ||
          row.path.split('/').some(part => !/^[a-z0-9.-]+$/.test(part))) fail();
      const parts = row.path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    const ordered = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    const sourceDirs = new Map(), publicFiles = new Map();
    for (const relative of ordered) {
      const name = path.join(input.publicRoot, relative);
      sourceDirs.set(name, await directory(name, uid, 0o700));
      const children = files.filter(row => path.dirname(row.path) === (relative || '.'))
        .map(row => path.basename(row.path));
      const subdirs = ordered.filter(row => row && path.dirname(row) === (relative || '.'))
        .map(row => path.basename(row));
      if ((await readdir(name)).sort().join('|') !== [...children, ...subdirs].sort().join('|')) fail();
    }
    for (const [i, row] of files.entries()) {
      const item = await capture(path.join(input.publicRoot, row.path), uid, 0o400, 16_384);
      if (item.bytes.length < 100 || sha(item.bytes) !== intent.publicDigests[i]?.sha256) fail();
      publicFiles.set(row.path, item);
    }
    const root = await directory(input.volumeRoot, fixture.creatorUid ?? 0, 0o755);
    if ((await readdir(input.volumeRoot)).length) fail();
    const targetDirs = [input.volumeRoot];
    await mkdir(path.join(input.volumeRoot, 'public'), { mode: 0o700 });
    targetDirs.push(path.join(input.volumeRoot, 'public'));
    for (const relative of ordered.filter(Boolean)) {
      const name = path.join(input.volumeRoot, 'public', relative);
      await mkdir(name, { mode: 0o700 });
      targetDirs.push(name);
    }
    const output = new Map([['intent.json', intentFile], ['binding.json', bindingFile],
      ['transition.password', passwordFile],
      ...[...publicFiles].map(([name, item]) => [`public/${name}`, item])]);
    for (const [relative, item] of output) {
      await fixture.beforeWrite?.(relative);
      const name = path.join(input.volumeRoot, relative);
      const handle = await open(name, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(item.bytes);
        await handle.chmod(0o400);
        await handle.chown(target, target);
        await handle.sync();
      } finally { await handle.close(); }
      await syncDir(path.dirname(name));
    }
    for (const item of [intentFile, bindingFile, passwordFile, ...publicFiles.values()]) {
      const later = await capture(item.name, uid,
        item.name === input.passwordFile ? [0o400, 0o600] : 0o400,
        item.name === input.passwordFile ? 43 : item.name === input.bindingFile ? 1024 :
          item.name === input.intentFile ? 256 * 1024 : 16_384);
      if (!same(item.stat, later.stat) || !item.bytes.equals(later.bytes)) fail();
    }
    for (const [name, stat] of sourceDirs) {
      if (!same(stat, await directory(name, uid, 0o700))) fail();
      const relative = path.relative(input.publicRoot, name);
      const children = files.filter(row => path.dirname(row.path) === (relative || '.'))
        .map(row => path.basename(row.path));
      const subdirs = ordered.filter(row => row && path.dirname(row) === (relative || '.'))
        .map(row => path.basename(row));
      if ((await readdir(name)).sort().join('|') !== [...children, ...subdirs].sort().join('|')) fail();
    }
    for (const [name, stat] of inputParents) {
      if (!same(stat, await directory(name, fixture.creatorUid ?? 0, 0o755))) fail();
      const source = [input.intentFile, input.bindingFile, input.passwordFile]
        .find(file => path.dirname(file) === name);
      if ((await readdir(name)).join('|') !== path.basename(source)) fail();
    }
    for (const name of targetDirs.reverse()) {
      const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.chmod(0o700); await handle.chown(target, target);
        await handle.sync(); } finally { await handle.close(); }
    }
    if (root.dev !== (await lstat(input.volumeRoot)).dev ||
        root.ino !== (await lstat(input.volumeRoot)).ino) fail();
    for (const relative of ordered) {
      const name = path.join(input.volumeRoot, 'public', relative);
      await directory(name, target, 0o700);
      const children = files.filter(row => path.dirname(row.path) === (relative || '.'))
        .map(row => path.basename(row.path));
      const subdirs = ordered.filter(row => row && path.dirname(row) === (relative || '.'))
        .map(row => path.basename(row));
      if ((await readdir(name)).sort().join('|') !== [...children, ...subdirs].sort().join('|')) fail();
    }
    await directory(input.volumeRoot, target, 0o700);
    if ((await readdir(input.volumeRoot)).sort().join('|') !==
        'binding.json|intent.json|public|transition.password') fail();
    for (const [relative, item] of output) {
      const copied = await capture(path.join(input.volumeRoot, relative), target, 0o400,
        relative === 'transition.password' ? 43 : relative === 'binding.json' ? 1024 :
          relative === 'intent.json' ? 256 * 1024 : 16_384);
      if (!copied.bytes.equals(item.bytes)) fail();
    }
    await syncDir(input.volumeRoot);
    return { approvedSha256: binding.approvedSha256, invocationId: binding.invocationId };
  } catch { fail(); }
}

export const productionCreateApplyTransferPaths = Object.freeze({
  passwordFile: '/run/create-apply-password/password',
  intentFile: '/run/create-apply-intent/intent.json',
  bindingFile: '/run/create-apply-binding/binding.json',
  publicRoot: '/run/create-apply-public',
  volumeRoot: '/run/search-create-apply',
});
