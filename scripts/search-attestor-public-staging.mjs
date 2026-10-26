import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { validateOfflineAttestorManifest } from './search-attestor-pure.mjs';
import { validateCapturedAttestorPublic,
  validateCapturedAttestorPublicAtTime } from './search-attestor-command-core.mjs';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LIMIT = 16_384, TOTAL = 20 * 1024 * 1024, DEADLINE = 25_000;
const fail = () => { throw new Error('Private search attestor public staging failed.'); };
const sameDir = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode;
const sameFile = (a, b) => sameDir(a, b) && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const ordered = names => [...names].sort().join('\0');

async function ownedDirectory(path, uid, gid, prior) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (stat.mode & 0o777) !== 0o700 || await realpath(path) !== resolve(path) ||
      prior && !sameDir(prior, stat)) fail();
  return stat;
}

async function ownedAncestor(path, uid, gid, prior) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (stat.mode & 0o022) !== 0 || await realpath(path) !== resolve(path) ||
      prior && !sameDir(prior, stat)) fail();
  return stat;
}

async function capturedFile(path, uid, gid, mode, prior) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid ||
        (stat.mode & 0o777) !== mode || stat.size < 100 || stat.size > LIMIT ||
        !sameFile(stat, await lstat(path)) || prior && !sameFile(prior.stat, stat) ||
        await realpath(path) !== resolve(path)) fail();
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size || !sameFile(stat, await handle.stat()) ||
        !sameFile(stat, await lstat(path))) fail();
    const result = bytes.subarray(0, bytesRead);
    if (prior && !prior.bytes.equals(result)) fail();
    return { stat, bytes: result };
  } finally { await handle.close(); }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function sourceFor(row, v1Root, generationsRoot) {
  if (row.token === 'legacy-v1') {
    const names = { 'ca.pem': 'ca.pem', 'v1/admin.pem': 'admin.pem',
      'v1/query.pem': 'query.pem', 'v1/indexer.pem': 'indexer.pem' };
    if (!Object.hasOwn(names, row.path)) fail();
    return join(v1Root, names[row.path]);
  }
  if (!UUID.test(row.token) || !['writer', 'query'].includes(row.role)) fail();
  const suffix = row.token.replaceAll('-', '').toLowerCase();
  if (row.path !== `generations/${suffix}/${row.role}.pem`) fail();
  return join(generationsRoot, suffix, `${row.role}.pem`);
}

/** Owner-local copy only. The caller supplies a positively confirmed preparation manifest. */
export async function stageAttestorPublic({ v1Root, generationsRoot, destinationParent,
  invocationId, manifest }, options = {}) {
  try {
    if (options.fixtureNow !== undefined &&
        (process.env.STATION_ATTESTOR_STAGING_FIXTURE !== '1' ||
        typeof options.fixtureNow !== 'function')) fail();
    const clock = options.fixtureNow ?? (() => performance.now());
    const stageDeadline = clock() + DEADLINE;
    const tick = deadline => { if (clock() >= deadline) fail(); };
    const uid = process.getuid?.(), gid = process.getgid?.();
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1 ||
        typeof invocationId !== 'string' || !UUID.test(invocationId)) fail();
    const roots = [v1Root, generationsRoot, destinationParent];
    if (roots.some(root => typeof root !== 'string' || resolve(root) !== root) ||
        basename(v1Root) !== 'search-security' ||
        basename(generationsRoot) !== 'search-generations' ||
        basename(destinationParent) !== 'search-attestor-public' ||
        new Set(roots.map(dirname)).size !== 1) fail();
    const cache = dirname(v1Root);
    if (basename(cache) !== '.cache' || await realpath(dirname(cache)) !== dirname(cache)) fail();
    const cacheStat = await ownedAncestor(cache, uid, gid);
    const v1Stat = await ownedDirectory(v1Root, uid, gid);
    const destinationParentStat = await ownedDirectory(destinationParent, uid, gid);
    const normalized = validateOfflineAttestorManifest(invocationId, manifest);
    const names = normalized.publicFiles.map(row => row.path);
    if (names.length < 4 || names.length > 1_028 || ordered(names) !== ordered([...new Set(names)])) fail();
    const sourceDirs = new Map([[v1Root, v1Stat]]);
    const sources = new Map(), bytes = new Map();
    let total = 0;
    for (const row of normalized.publicFiles) {
      tick(stageDeadline);
      const source = sourceFor(row, v1Root, generationsRoot);
      const parent = dirname(source);
      if (!sourceDirs.has(parent)) {
        if (parent !== generationsRoot) {
          if (!parent.startsWith(`${generationsRoot}${sep}`) ||
              basename(parent) !== row.token.replaceAll('-', '').toLowerCase()) fail();
          if (!sourceDirs.has(generationsRoot))
            sourceDirs.set(generationsRoot, await ownedDirectory(generationsRoot, uid, gid));
        }
        sourceDirs.set(parent, await ownedDirectory(parent, uid, gid));
      }
      const item = await capturedFile(source, uid, gid, 0o600);
      total += item.bytes.length;
      if (total > TOTAL) fail();
      sources.set(row.path, { path: source, ...item });
      bytes.set(row.path, item.bytes);
      tick(stageDeadline);
    }
    await validateCapturedAttestorPublic(normalized, bytes, new Date(),
      options.scratchRoot ?? destinationParent, options.purposeExec);
    tick(stageDeadline);
    const root = join(destinationParent, invocationId);
    await ownedDirectory(destinationParent, uid, gid, destinationParentStat);
    await mkdir(root, { mode: 0o700 });
    const dirs = new Map([[root, await ownedDirectory(root, uid, gid)]]);
    const files = new Map();
    const relativeDirs = new Set();
    for (const name of names) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) relativeDirs.add(parts.slice(0, i).join('/'));
    }
    for (const relative of [...relativeDirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
      tick(stageDeadline);
      const path = join(root, relative), parent = dirname(path);
      await ownedDirectory(parent, uid, gid, dirs.get(parent));
      await mkdir(path, { mode: 0o700 });
      dirs.set(path, await ownedDirectory(path, uid, gid));
      await syncDirectory(parent);
      tick(stageDeadline);
    }
    for (const name of names) {
      tick(stageDeadline);
      const path = join(root, name), parent = dirname(path);
      await ownedDirectory(parent, uid, gid, dirs.get(parent));
      await options.beforeWrite?.(name);
      tick(stageDeadline);
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const initial = await handle.stat();
        if (!initial.isFile() || initial.nlink !== 1 || initial.uid !== uid || initial.gid !== gid ||
            (initial.mode & 0o777) !== 0o600) fail();
        await handle.writeFile(bytes.get(name));
        await handle.chmod(0o400);
        await handle.sync();
        const final = await handle.stat();
        if (!sameFile(final, await lstat(path))) fail();
        files.set(name, { stat: final, bytes: bytes.get(name) });
      } finally { await handle.close(); }
      await syncDirectory(parent);
      tick(stageDeadline);
    }
    await syncDirectory(root);
    await syncDirectory(destinationParent);
    tick(stageDeadline);
    let active = true, cleanupAttempted = false;
    const checkAncestor = async path => {
      await ownedAncestor(cache, uid, gid, cacheStat);
      await ownedDirectory(destinationParent, uid, gid, destinationParentStat);
      const chain = [];
      for (let current = path; current !== destinationParent; current = dirname(current)) {
        if (!dirs.has(current) || !current.startsWith(`${root}${sep}`) && current !== root) fail();
        chain.push(current);
      }
      for (const current of chain.reverse())
        await ownedDirectory(current, uid, gid, dirs.get(current));
    };
    const checkOutput = async deadline => {
        tick(deadline);
        await checkAncestor(root);
        for (const [path, stat] of dirs) {
          tick(deadline);
          await ownedDirectory(path, uid, gid, stat);
        }
        for (const [path] of dirs) {
          tick(deadline);
          const wantedFiles = names.filter(name => dirname(join(root, name)) === path)
            .map(name => basename(name));
          const wantedDirs = [...dirs.keys()].filter(name => name !== path && dirname(name) === path)
            .map(name => basename(name));
          if (ordered(await readdir(path)) !== ordered([...wantedFiles, ...wantedDirs])) fail();
        }
        for (const [name, item] of sources) {
          tick(deadline);
          const output = await capturedFile(join(root, name), uid, gid, 0o400, files.get(name));
          if (!output.bytes.equals(item.bytes)) fail();
        }
        tick(deadline);
    };
    const verify = async deadline => {
      try {
        if (!active || cleanupAttempted) fail();
        const checkSources = async () => {
          tick(deadline);
          await ownedAncestor(cache, uid, gid, cacheStat);
          for (const [path, stat] of sourceDirs) {
            tick(deadline);
            await ownedDirectory(path, uid, gid, stat);
          }
          for (const item of sources.values()) {
            tick(deadline);
            await ownedDirectory(dirname(item.path), uid, gid, sourceDirs.get(dirname(item.path)));
            await capturedFile(item.path, uid, gid, 0o600, item);
          }
          tick(deadline);
        };
        await checkOutput(deadline);
        await checkSources();
        await validateCapturedAttestorPublic(normalized, bytes, new Date(),
          options.scratchRoot ?? destinationParent, options.purposeExec);
        tick(deadline);
        await checkOutput(deadline);
        await checkSources();
        validateCapturedAttestorPublicAtTime(normalized, bytes, new Date());
        tick(deadline);
        return true;
      } catch { fail(); }
    };
    await verify(stageDeadline);
    tick(stageDeadline);
    const recheck = () => verify(clock() + DEADLINE);
    return Object.freeze({ root, recheck, cleanup: async () => {
      try {
        if (!active || cleanupAttempted) fail();
        cleanupAttempted = true;
        const cleanupDeadline = clock() + DEADLINE;
        await checkOutput(cleanupDeadline);
        for (const name of [...names].reverse()) {
          tick(cleanupDeadline);
          await checkAncestor(dirname(join(root, name)));
          const item = files.get(name), current = await lstat(join(root, name));
          if (!sameFile(item.stat, current) || !current.isFile() || current.nlink !== 1) fail();
          await unlink(join(root, name));
          tick(cleanupDeadline);
        }
        for (const path of [...dirs.keys()].reverse()) {
          tick(cleanupDeadline);
          await checkAncestor(path);
          if ((await readdir(path)).length) fail();
          await rmdir(path);
          tick(cleanupDeadline);
        }
        await ownedDirectory(destinationParent, uid, gid, destinationParentStat);
        await syncDirectory(destinationParent);
        tick(cleanupDeadline);
        active = false;
        return true;
      } catch { fail(); }
    } });
  } catch { fail(); }
}
