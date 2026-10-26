import { X509Certificate } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { makePreparedAttestorManifest, validatePreparedAttestorManifest,
  compareReadyAttestorObservation } from './search-attestor-pure.mjs';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';
const execFileAsync = promisify(execFile);
const fail = () => { throw new Error('Private search attestor command failed.'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode;

async function fixedDirectory(path, uid, gid, mode) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (stat.mode & 0o777) !== mode || await realpath(path) !== resolve(path)) fail();
  return stat;
}

async function boundedFile(path, uid, gid, modes, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    const atPath = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || before.gid !== gid ||
        !modes.includes(before.mode & 0o777) || before.size < 1 || before.size > maximum ||
        !same(before, atPath)) fail();
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size || !same(before, await handle.stat()) ||
        !same(before, await lstat(path))) fail();
    return { bytes: buffer.subarray(0, bytesRead), stat: before };
  } finally { await handle.close(); }
}

async function readFixedInput(path, uid, gid, mode, maximum) {
  const parent = await fixedDirectory(dirname(path), uid, gid, 0o700);
  const initial = await boundedFile(path, uid, gid, [mode], maximum);
  return { bytes: initial.bytes, recheck: async () => {
    if (!sameIdentity(parent, await fixedDirectory(dirname(path), uid, gid, 0o700))) fail();
    const later = await boundedFile(path, uid, gid, [mode], maximum);
    if (!same(initial.stat, later.stat) || !initial.bytes.equals(later.bytes)) fail();
  } };
}

function invocationText(bytes) {
  const text = bytes.toString('utf8');
  if (text.length !== 37 || !UUID.test(text.slice(0, -1)) || text.at(-1) !== '\n') fail();
  return text.slice(0, -1);
}

async function writeManifest(path, uid, gid, manifest) {
  const directory = dirname(path);
  const parent = await fixedDirectory(directory, uid, gid, 0o700);
  if ((await readdir(directory)).length !== 0) fail();
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  if (bytes.length > 256 * 1024) fail();
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let created;
  try {
    created = await handle.stat();
    if (!created.isFile() || created.nlink !== 1 || created.uid !== uid || created.gid !== gid ||
        (created.mode & 0o777) !== 0o600) fail();
    await handle.writeFile(bytes);
    await handle.sync();
    created = await handle.stat();
  } finally { await handle.close(); }
  const readback = await boundedFile(path, uid, gid, [0o600], 256 * 1024);
  if (!same(created, readback.stat) || !readback.bytes.equals(bytes) ||
      !sameIdentity(parent, await fixedDirectory(directory, uid, gid, 0o700))) fail();
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
  if (!same(created, (await boundedFile(path, uid, gid, [0o600], 256 * 1024)).stat) ||
      !sameIdentity(parent, await fixedDirectory(directory, uid, gid, 0o700))) fail();
}

function certificate(bytes) {
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(
    bytes.toString('ascii'))) fail();
  return new X509Certificate(bytes);
}

function validAt(cert, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !(cert.validFromDate.getTime() <= now.getTime() && now.getTime() < cert.validToDate.getTime())) fail();
}

function validateCa(bytes, now) {
  const ca = certificate(bytes);
  validAt(ca, now);
  if (ca.subject !== 'CN=station-search-ca' || ca.issuer !== ca.subject ||
      ca.ca !== true || !ca.verify(ca.publicKey)) fail();
  return ca;
}

function validateLeaf(bytes, ca, principal, fingerprint, now) {
  const leaf = certificate(bytes);
  validAt(leaf, now);
  if (leaf.subject !== `CN=${principal}` || leaf.issuer !== ca.subject || leaf.ca !== false ||
      !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey) ||
      !Array.isArray(leaf.keyUsage) || leaf.keyUsage.length !== 1 ||
      leaf.keyUsage[0] !== CLIENT_AUTH ||
      fingerprint !== null && leaf.fingerprint256.replaceAll(':', '').toLowerCase() !== fingerprint) fail();
}

// OpenSSL supplies the full sslclient purpose, KeyUsage and critical-extension
// checks that Node's signature/EKU properties do not. The only trust anchor
// and leaves are copied from the already captured public PEM bytes into one
// private temporary directory; no mounted path is passed to the subprocess.
async function verifyClientPurpose(caBytes, leafBytes, scratchRoot = '/tmp', purposeExec = execFileAsync) {
  if (!Array.isArray(leafBytes) || leafBytes.length > 1_025) fail();
  const directory = await mkdtemp(join(scratchRoot, 'station-attestor-purpose-'));
  const owned = [];
  const uid = process.getuid(), gid = process.getgid();
  const directoryStat = await fixedDirectory(directory, uid, gid, 0o700);
  try {
    for (const [name, bytes] of [['ca.pem', caBytes],
      ...leafBytes.map((value, i) => [`leaf-${i}.pem`, value])]) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16_384) fail();
      const path = join(directory, name);
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const item = { path, stat: await handle.stat(), bytes };
      owned.push(item);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const captured = await boundedFile(path, uid, gid, [0o600], 16_384);
      if (!captured.bytes.equals(bytes)) fail();
      item.stat = captured.stat;
    }
    const arguments_ = ['verify', '-purpose', 'sslclient', '-no_check_time',
      '-no-CAfile', '-no-CApath', '-no-CAstore', '-CAfile', join(directory, 'ca.pem'),
      ...leafBytes.map((_, i) => join(directory, `leaf-${i}.pem`))];
    await purposeExec('/usr/bin/openssl', arguments_, { shell: false,
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', OPENSSL_CONF: '/dev/null' },
      timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, encoding: 'utf8' });
    for (const item of owned) {
      const later = await boundedFile(item.path, uid, gid, [0o600], 16_384);
      if (!same(item.stat, later.stat) || !item.bytes.equals(later.bytes)) fail();
    }
  } finally {
    // An unexpected replacement is an incident; never unlink its pathname.
    const originalDirectory = async () => {
      if (!sameIdentity(directoryStat, await fixedDirectory(directory, uid, gid, 0o700))) fail();
    };
    await originalDirectory();
    for (const item of owned.reverse()) {
      await originalDirectory();
      const current = await lstat(item.path).catch(() => null);
      if (!current || !current.isFile() || current.nlink !== 1 ||
          current.uid !== uid || current.gid !== gid ||
          (current.mode & 0o777) !== 0o600 || !sameIdentity(item.stat, current)) fail();
      await unlink(item.path);
    }
    await originalDirectory();
    if ((await readdir(directory)).length !== 0) fail();
    await rmdir(directory);
  }
}

/** Validate an already captured, manifest-derived public PEM set. No source paths enter OpenSSL. */
export async function validateCapturedAttestorPublic(manifest, bytes, now,
  scratchRoot = '/tmp', purposeExec = execFileAsync) {
  try {
    validateCapturedAttestorPublicAtTime(manifest, bytes, now);
    await verifyClientPurpose(bytes.get('ca.pem'), manifest.publicFiles.filter(row => row.role !== 'ca')
      .map(row => bytes.get(row.path)), scratchRoot, purposeExec);
  } catch { fail(); }
}

/** Fresh synchronous certificate check after any external purpose process completes. */
export function validateCapturedAttestorPublicAtTime(manifest, bytes, now) {
  try {
    if (!(bytes instanceof Map) || bytes.size !== manifest.publicFiles.length ||
        manifest.publicFiles.some(row => !bytes.has(row.path))) fail();
    const ca = validateCa(bytes.get('ca.pem'), now);
    for (const row of manifest.publicFiles) {
      if (row.role === 'ca') continue;
      validateLeaf(bytes.get(row.path), ca, row.principal, row.fingerprint, now);
    }
  } catch { fail(); }
}

async function publicInventory(root, expected, adminRoot, uid, gid, now, adminOwnership,
  scratchRoot, purposeExec) {
  const rootStat = await fixedDirectory(root, uid, gid, 0o700);
  const expectedFiles = expected.publicFiles.map(row => row.path);
  const expectedDirs = new Set(['']);
  for (const name of expectedFiles) {
    if (typeof name !== 'string' || name.startsWith('/') || name.includes('..') ||
        name.split('/').some(part => !/^[a-z0-9.-]+$/.test(part))) fail();
    const pieces = name.split('/');
    for (let i = 1; i < pieces.length; i++) expectedDirs.add(pieces.slice(0, i).join('/'));
  }
  const seen = new Map();
  for (const relative of [...expectedDirs].sort()) {
    const directory = relative ? join(root, relative) : root;
    const stat = relative ? await fixedDirectory(directory, uid, gid, 0o700) : rootStat;
    const childFiles = expectedFiles.filter(name => dirname(name) === (relative || '.') ).map(name => name.split('/').at(-1));
    const childDirs = [...expectedDirs].filter(name => name && dirname(name) === (relative || '.') ).map(name => name.split('/').at(-1));
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...childFiles, ...childDirs].sort())) fail();
    seen.set(directory, stat);
  }
  const bytes = new Map();
  for (const name of expectedFiles) {
    const file = join(root, name);
    const item = await boundedFile(file, uid, gid, [0o400], 16_384);
    bytes.set(name, item.bytes);
    seen.set(file, item.stat);
  }
  // Frozen v1 admin volume: installer owns it root:1000, readable by UID 1000's group.
  const admin = adminOwnership ?? { uid: 0, gid: 1000, directoryMode: 0o750, fileMode: 0o440 };
  const adminDirectory = await fixedDirectory(adminRoot, admin.uid, admin.gid, admin.directoryMode);
  seen.set(adminRoot, adminDirectory);
  for (const name of ['ca.pem', 'admin.pem']) {
    const path = join(adminRoot, name);
    const item = await boundedFile(path, admin.uid, admin.gid, [admin.fileMode], 16_384);
    seen.set(path, item.stat);
    if (!item.bytes.equals(bytes.get(name === 'ca.pem' ? 'ca.pem' : 'v1/admin.pem'))) fail();
  }
  await validateCapturedAttestorPublic(expected, bytes, now, scratchRoot, purposeExec);
  return async finalNow => {
    for (const [path, stat] of seen) if (!same(stat, await lstat(path)) ||
        await realpath(path) !== resolve(path)) fail();
    for (const relative of expectedDirs) {
      const directory = relative ? join(root, relative) : root;
      const childFiles = expectedFiles.filter(name => dirname(name) === (relative || '.') ).map(name => name.split('/').at(-1));
      const childDirs = [...expectedDirs].filter(name => name && dirname(name) === (relative || '.') ).map(name => name.split('/').at(-1));
      if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...childFiles, ...childDirs].sort())) fail();
    }
    for (const [name, original] of bytes) {
      if (!(await boundedFile(join(root, name), uid, gid, [0o400], 16_384)).bytes.equals(original)) fail();
    }
    for (const name of ['ca.pem', 'admin.pem']) {
      if (!(await boundedFile(join(adminRoot, name), admin.uid, admin.gid, [admin.fileMode], 16_384)).bytes.equals(
        bytes.get(name === 'ca.pem' ? 'ca.pem' : 'v1/admin.pem'))) fail();
    }
    const finalCa = validateCa(bytes.get('ca.pem'), finalNow);
    for (const row of expected.publicFiles) {
      if (row.role === 'ca') continue;
      validateLeaf(bytes.get(row.path), finalCa, row.principal, row.fingerprint, finalNow);
    }
  };
}

function bootstrapDecision(state, expected) {
  if (state.phase !== 'ready' || !['legacy', 'complete'].includes(state.kind)) fail();
  const legacy = expected.generations.find(row => row.token === 'legacy-v1');
  if (!legacy || legacy.presence !== 'exact' ||
      state.kind === 'complete' && state.indexUuid !== legacy.uuid) fail();
  return legacy.uuid;
}

/** Private test seam: production supplies fixed paths, verifier reads and observer. */
export async function prepareAttestor(input, deps) {
  try {
    const invocation = await readFixedInput(input.invocationFile, input.uid, input.gid, 0o400, 64);
    const invocationId = invocationText(invocation.bytes);
    const snapshot = await deps.readSnapshot();
    const manifest = makePreparedAttestorManifest(snapshot, invocationId);
    await writeManifest(input.manifestFile, input.uid, input.gid, manifest);
    await invocation.recheck();
    return true;
  } catch { fail(); }
}

/** Re-reads DB after engine I/O; success is only a fixed assertion. */
export async function runCombinedAttestor(input, deps) {
  try {
    const invocation = await readFixedInput(input.invocationFile, input.uid, input.gid, 0o400, 64);
    const invocationId = invocationText(invocation.bytes);
    const manifestInput = await readFixedInput(input.manifestFile, input.uid, input.gid, 0o600, 256 * 1024);
    const manifestBytes = manifestInput.bytes;
    if (manifestBytes.at(-1) !== 10) fail();
    const supplied = JSON.parse(manifestBytes.subarray(0, -1).toString('utf8'));
    if (!manifestBytes.equals(Buffer.from(`${JSON.stringify(supplied)}\n`, 'utf8'))) fail();
    const first = await deps.readSnapshot();
    const manifest = validatePreparedAttestorManifest(first, invocationId, supplied);
    const state = await deps.readState(input.stateDirectory, input.owners);
    const legacyUuid = bootstrapDecision(state, manifest.expected);
    const recheckPublic = await publicInventory(input.publicDirectory, manifest,
      input.adminDirectory, input.uid, input.gid, deps.now(), deps.adminOwnership,
      deps.scratchRoot, deps.purposeExec);
    const observed = await deps.observe();
    if (compareReadyAttestorObservation(manifest.expected, observed) !== 'exact' ||
        observed.indexes['station-mail-v1'].settings.index.uuid !== legacyUuid) fail();
    const final = await deps.readSnapshot();
    validatePreparedAttestorManifest(final, invocationId, manifest);
    const finalState = await deps.readState(input.stateDirectory, input.owners);
    if (JSON.stringify(finalState) !== JSON.stringify(state)) fail();
    await invocation.recheck();
    await manifestInput.recheck();
    await recheckPublic(deps.now());
    return true;
  } catch { fail(); }
}

export const productionAttestorPaths = Object.freeze({
  invocationFile: '/run/search-attestor/invocation',
  manifestFile: '/run/search-attestor/manifest/manifest.json',
  publicDirectory: '/run/search-attestor/public', adminDirectory: '/run/station-admin',
  stateDirectory: '/run/station-state',
});
