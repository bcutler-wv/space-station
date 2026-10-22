import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { validateOfflineAttestorManifest } from './search-attestor-pure.mjs';

const MAX_PUBLIC_BYTES = 20 * 1024 * 1024;
const MAX_PUBLIC_FILES = 2_048;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const fail = () => { throw new Error('Private search attestor transfer failed.'); };
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const directoryIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
const ordered = values => [...values].sort().join('\0');

async function directory(path, uid, gid, mode) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (stat.mode & 0o777) !== mode || await realpath(path) !== resolve(path)) fail();
  return stat;
}

async function file(path, uid, gid, modes, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(), atPath = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || before.gid !== gid ||
        !modes.includes(before.mode & 0o777) || before.size < 1 || before.size > limit ||
        !identity(before, atPath)) fail();
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size || !identity(before, await handle.stat()) ||
        !identity(before, await lstat(path)) || await realpath(path) !== resolve(path)) fail();
    return { bytes: buffer.subarray(0, bytesRead), stat: before };
  } finally { await handle.close(); }
}

async function capture(path, uid, gid, modes, limit, exactParent = true,
  parentOwnership = { uid, gid, mode: 0o700 }) {
  const parent = await directory(dirname(path), parentOwnership.uid, parentOwnership.gid,
    parentOwnership.mode);
  if (exactParent && ordered(await readdir(dirname(path))) !== basename(path)) fail();
  const original = await file(path, uid, gid, modes, limit);
  return { ...original, recheck: async () => {
    if (!directoryIdentity(parent, await directory(dirname(path), parentOwnership.uid,
      parentOwnership.gid, parentOwnership.mode))) fail();
    if (exactParent && ordered(await readdir(dirname(path))) !== basename(path)) fail();
    const later = await file(path, uid, gid, modes, limit);
    if (!identity(original.stat, later.stat) || !original.bytes.equals(later.bytes)) fail();
  } };
}

function publicTree(names) {
  if (!Array.isArray(names) || names.length < 1 || names.length > MAX_PUBLIC_FILES) fail();
  const dirs = new Set(['']);
  for (const name of names) {
    if (typeof name !== 'string' || name.startsWith('/') || name.includes('..') ||
        name.split('/').some(part => !/^[a-z0-9.-]+$/.test(part))) fail();
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  if (new Set(names).size !== names.length || dirs.size > MAX_PUBLIC_FILES) fail();
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

async function capturePublic(root, names, uid, gid, deadline) {
  const dirs = publicTree(names), directoryStats = new Map(), files = new Map();
  let total = 0;
  for (const relative of dirs) {
    if (Date.now() >= deadline) fail();
    const path = relative ? join(root, relative) : root;
    directoryStats.set(path, await directory(path, uid, gid, 0o700));
    const children = names.filter(name => dirname(name) === (relative || '.')).map(name => name.split('/').at(-1));
    const subdirs = dirs.filter(name => name && dirname(name) === (relative || '.')).map(name => name.split('/').at(-1));
    if (ordered(await readdir(path)) !== ordered([...children, ...subdirs])) fail();
  }
  for (const name of names) {
    if (Date.now() >= deadline) fail();
    const item = await capture(join(root, name), uid, gid, [0o400], 16_384, false);
    if (item.bytes.length < 100) fail();
    total += item.bytes.length;
    if (total > MAX_PUBLIC_BYTES) fail();
    files.set(name, item);
  }
  return { dirs, files, recheck: async () => {
    for (const relative of dirs) {
      if (Date.now() >= deadline) fail();
      const path = relative ? join(root, relative) : root;
      if (!directoryIdentity(directoryStats.get(path), await directory(path, uid, gid, 0o700))) fail();
      const children = names.filter(name => dirname(name) === (relative || '.')).map(name => name.split('/').at(-1));
      const subdirs = dirs.filter(name => name && dirname(name) === (relative || '.')).map(name => name.split('/').at(-1));
      if (ordered(await readdir(path)) !== ordered([...children, ...subdirs])) fail();
    }
    for (const item of files.values()) await item.recheck();
  } };
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertDirectoryIdentity(path, expected) {
  const current = await lstat(path);
  if (!current.isDirectory() || current.isSymbolicLink() ||
      !directoryIdentity(expected, current) || await realpath(path) !== resolve(path)) fail();
}

async function changeDirectory(path, expected, mode, uid, gid) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!directoryIdentity(expected, await handle.stat()) ||
        !directoryIdentity(expected, await lstat(path))) fail();
    if (mode !== undefined) await handle.chmod(mode);
    if (uid !== undefined) await handle.chown(uid, gid);
    await handle.sync();
    const changed = await handle.stat();
    if (!directoryIdentity(changed, await lstat(path)) ||
        await realpath(path) !== resolve(path)) fail();
    return changed;
  } finally { await handle.close(); }
}

async function writeFileExclusive(path, bytes, mode, uid, gid, creatorUid, creatorGid) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const created = await handle.stat();
    if (!created.isFile() || created.nlink !== 1 || created.uid !== creatorUid ||
        created.gid !== creatorGid) fail();
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.chown(uid, gid);
    await handle.sync();
    const final = await handle.stat();
    if (!identity(final, await lstat(path))) fail();
    return final;
  } finally { await handle.close(); }
}

/** Private fixture seam; production wrapper supplies only fixed paths and UID/GID 1000. */
export async function transferAttestorInputs(input, options = {}) {
  try {
    const deadline = Date.now() + 25_000;
    const tick = () => { if (Date.now() >= deadline) fail(); };
    const targetUid = options.targetUid ?? 1000, targetGid = options.targetGid ?? 1000;
    const creatorUid = options.initialUid ?? 0, creatorGid = options.initialGid ?? 0;
    const inputParent = { uid: options.inputParentUid ?? 0, gid: options.inputParentGid ?? 0,
      mode: options.inputParentMode ?? 0o755 };
    if (!Number.isSafeInteger(targetUid) || !Number.isSafeInteger(targetGid) ||
        targetUid < 1 || targetGid < 1) fail();
    const invocationStat = await lstat(input.invocationFile);
    const uid = invocationStat.uid, gid = invocationStat.gid;
    if (uid === 0 || gid === 0 || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) fail();
    const invocation = await capture(input.invocationFile, uid, gid, [0o400], 64, true, inputParent);
    const invocationText = invocation.bytes.toString('utf8');
    if (invocationText.length !== 37 || !UUID.test(invocationText.slice(0, -1)) ||
        invocationText.at(-1) !== '\n') fail();
    const invocationId = invocationText.slice(0, -1);
    const password = await capture(input.passwordFile, uid, gid, [0o400, 0o600], 43, true, inputParent);
    const secret = password.bytes.toString('utf8');
    if (password.bytes.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
        Buffer.from(secret, 'base64url').length !== 32) fail();
    const manifestInput = await capture(input.manifestFile, uid, gid, [0o600], 256 * 1024, true, inputParent);
    const manifestBytes = manifestInput.bytes;
    if (manifestBytes.at(-1) !== 10) fail();
    const supplied = JSON.parse(manifestBytes.subarray(0, -1).toString('utf8'));
    if (!manifestBytes.equals(Buffer.from(`${JSON.stringify(supplied)}\n`, 'utf8'))) fail();
    const manifest = validateOfflineAttestorManifest(invocationId, supplied);
    const names = manifest.publicFiles.map(row => row.path);
    const publicInput = await capturePublic(input.publicDirectory, names, uid, gid, deadline);
    tick();
    const destination = input.outputDirectory;
    const before = await lstat(destination);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== creatorUid ||
        before.gid !== creatorGid ||
        ![0o700, 0o755].includes(before.mode & 0o777) ||
        await realpath(destination) !== resolve(destination) || (await readdir(destination)).length !== 0) fail();
    // The destination volume is captured empty; no existing child is adopted.
    const privateRoot = await changeDirectory(destination, before, 0o700);
    const outputFiles = new Map([['password', { bytes: password.bytes, mode: 0o400 }],
      ['invocation', { bytes: invocation.bytes, mode: 0o400 }],
      ['manifest/manifest.json', { bytes: manifestBytes, mode: 0o600 }],
      ...names.map(name => [`public/${name}`, { bytes: publicInput.files.get(name).bytes, mode: 0o400 }])]);
    const outputDirs = ['manifest', 'public', ...publicInput.dirs.filter(Boolean).map(name => `public/${name}`)];
    const createdDirs = new Map();
    for (const relative of outputDirs) {
      tick();
      const path = join(destination, relative);
      const parent = dirname(path);
      await assertDirectoryIdentity(parent, parent === destination ? privateRoot : createdDirs.get(parent));
      await mkdir(path, { mode: 0o700 });
      createdDirs.set(path, await lstat(path));
    }
    const createdFiles = new Map();
    for (const [relative, item] of outputFiles) {
      tick();
      await options.beforeWrite?.(relative);
      const path = join(destination, relative);
      const parent = dirname(path);
      await assertDirectoryIdentity(parent, parent === destination ? privateRoot : createdDirs.get(parent));
      createdFiles.set(path, await writeFileExclusive(path, item.bytes, item.mode,
        targetUid, targetGid, creatorUid, creatorGid));
      await syncDirectory(dirname(path));
    }
    await publicInput.recheck();
    await invocation.recheck(); await password.recheck(); await manifestInput.recheck();
    for (const path of [...createdDirs.keys()].reverse()) {
      const prior = createdDirs.get(path), current = await lstat(path);
      if (!directoryIdentity(prior, current)) fail();
      createdDirs.set(path, await changeDirectory(path, prior, undefined, targetUid, targetGid));
    }
    const finalRoot = await changeDirectory(destination, privateRoot, undefined, targetUid, targetGid);
    for (const path of [...createdDirs.keys()].reverse()) await syncDirectory(path);
    await syncDirectory(destination);
    const wantedDirs = new Set(['', ...outputDirs]);
    for (const relative of wantedDirs) {
      tick();
      const path = relative ? join(destination, relative) : destination;
      const current = await directory(path, targetUid, targetGid, 0o700);
      if (!directoryIdentity(relative ? createdDirs.get(path) : finalRoot, current)) fail();
      const children = [...outputFiles.keys()].filter(name => dirname(name) === (relative || '.'))
        .map(name => name.split('/').at(-1));
      const subdirs = [...wantedDirs].filter(name => name && dirname(name) === (relative || '.'))
        .map(name => name.split('/').at(-1));
      if (ordered(await readdir(path)) !== ordered([...children, ...subdirs])) fail();
    }
    for (const [relative, item] of outputFiles) {
      const copied = await file(join(destination, relative), targetUid, targetGid, [item.mode], item.bytes.length);
      if (!identity(createdFiles.get(join(destination, relative)), copied.stat) ||
          !copied.bytes.equals(item.bytes)) fail();
    }
    await publicInput.recheck();
    await invocation.recheck(); await password.recheck(); await manifestInput.recheck();
    tick();
    return true;
  } catch { fail(); }
}

export const productionTransferPaths = Object.freeze({
  passwordFile: '/run/search-transfer-password/password',
  invocationFile: '/run/search-transfer-invocation/invocation',
  manifestFile: '/run/search-transfer-manifest/manifest.json',
  publicDirectory: '/run/search-transfer-public',
  outputDirectory: '/run/search-attestor',
});
