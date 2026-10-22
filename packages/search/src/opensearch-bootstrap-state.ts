import { constants } from 'node:fs';
import { chmod, chown, lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const names = ['phase', 'v1-first-init', 'v1-profile-grant', 'v1-profile-claim', 'v1-profile-complete'] as const;
const uuid = /^[A-Za-z0-9_-]{1,128}$/;
const version = 'v1\n';
export type BootstrapState = { phase: 'fresh' | 'ready'; kind: 'legacy' | 'unintroduced' | 'incomplete' | 'complete';
  indexUuid?: string };
export type BootstrapOwners = { installer: number; service: number; group: number };
export const productionOwners: BootstrapOwners = { installer: 0, service: 1000, group: 1000 };
const roleNames = ['node', 'admin', 'query', 'indexer', 'outsider'] as const;
type RoleName = typeof roleNames[number];
export type IdentityPaths = { source: string; targets: Record<RoleName, string> };
const productionIdentities: IdentityPaths = { source: '/source', targets: {
  node: '/node', admin: '/admin', query: '/query', indexer: '/indexer', outsider: '/outsider',
} };
const invalid = (): never => { throw new Error('private search initialization state'); };
const invalidIdentity = (): never => { throw new Error('private search identity is incomplete'); };

async function identityBytes(directory: string, name: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 16384) invalidIdentity();
    const bytes = Buffer.alloc(stat.size + 1);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== stat.size) invalidIdentity();
    return bytes.subarray(0, result.bytesRead);
  } catch { return invalidIdentity(); }
  finally { await handle?.close(); }
}

/** Validate every source and retained role volume before publishing the first-init grant. */
export async function preflightPrivateIdentities(paths: IdentityPaths = productionIdentities): Promise<void> {
  try {
    const sourceStat = await lstat(paths.source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) invalidIdentity();
    for (const role of roleNames) {
      const target = paths.targets[role];
      const targetStat = await lstat(target);
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) invalidIdentity();
      const namesInTarget = await readdir(target);
      const files = ['ca.pem', `${role}.pem`, `${role}.key`];
      if (namesInTarget.length !== 0 &&
          (namesInTarget.length !== files.length || namesInTarget.some(name => !files.includes(name)))) invalidIdentity();
      for (const name of files) {
        const source = await identityBytes(paths.source, name);
        if (namesInTarget.length !== 0 && !source.equals(await identityBytes(target, name))) invalidIdentity();
      }
    }
  } catch { return invalidIdentity(); }
}

export async function installBootstrapWithIdentities(directory: string, dataDirectory: string,
  paths: IdentityPaths = productionIdentities, owners: BootstrapOwners = productionOwners): Promise<BootstrapState> {
  await preflightPrivateIdentities(paths);
  return installBootstrapState(directory, dataDirectory, owners);
}
const fileSpec = (name: typeof names[number], owners: BootstrapOwners) => name === 'phase' ?
  { uid: owners.installer, gid: owners.group, mode: 0o660, maximum: 10 } :
  name === 'v1-first-init' || name === 'v1-profile-grant' ?
    { uid: owners.installer, gid: owners.group, mode: 0o440, maximum: 3 } :
    { uid: owners.service, gid: owners.group, mode: 0o600, maximum: name === 'v1-profile-claim' ? 3 : 132 };

async function readFixed(directory: string, name: typeof names[number], owners: BootstrapOwners): Promise<string> {
  const spec = fileSpec(name, owners);
  let handle;
  try {
    handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== spec.uid || stat.gid !== spec.gid ||
        (stat.mode & 0o777) !== spec.mode || stat.size < 1 || stat.size > spec.maximum) invalid();
    const buffer = Buffer.alloc(spec.maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) invalid();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return invalid(); }
  finally { await handle?.close(); }
}

async function stateEntries(directory: string, owners: BootstrapOwners, allowEmpty: boolean): Promise<string[]> {
  const stat = await lstat(directory).catch(invalid);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owners.installer ||
      (!allowEmpty && (stat.gid !== owners.group || (stat.mode & 0o777) !== 0o770)) ||
      (allowEmpty && ((stat.mode & 0o002) !== 0 || (stat.mode & 0o700) !== 0o700))) invalid();
  const entries = await readdir(directory);
  if (entries.length > names.length || entries.some(name => !names.includes(name as typeof names[number]))) invalid();
  return entries;
}

export async function readBootstrapState(directory: string, owners: BootstrapOwners = productionOwners): Promise<BootstrapState> {
  const entries = await stateEntries(directory, owners, false);
  const has = (name: string) => entries.includes(name);
  if (!has('phase')) invalid();
  const phaseText = await readFixed(directory, 'phase', owners);
  if (phaseText !== 'fresh\n' && phaseText !== 'ready\n') invalid();
  const phase = phaseText.trim() as 'fresh' | 'ready';
  const first = has('v1-first-init'), grant = has('v1-profile-grant');
  const claim = has('v1-profile-claim'), complete = has('v1-profile-complete');
  if ((!first && (grant || claim || complete)) || (first && !grant) ||
      (claim && !grant) || (complete && !claim) || (phase === 'fresh' && (claim || complete))) invalid();
  if (first && ((await readFixed(directory, 'v1-first-init', owners)) !== version ||
      (await readFixed(directory, 'v1-profile-grant', owners)) !== version)) invalid();
  if (claim && await readFixed(directory, 'v1-profile-claim', owners) !== version) invalid();
  if (complete) {
    const contents = await readFixed(directory, 'v1-profile-complete', owners);
    if (!contents.startsWith(version) || !contents.endsWith('\n') || !uuid.test(contents.slice(3, -1))) invalid();
    return { phase, kind: 'complete', indexUuid: contents.slice(3, -1) };
  }
  return { phase, kind: first ? claim ? 'incomplete' : 'unintroduced' : 'legacy' };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function createFixed(directory: string, name: typeof names[number], contents: string,
  owners: BootstrapOwners): Promise<void> {
  const spec = fileSpec(name, owners);
  const handle = await open(path.join(directory, name), constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, spec.mode);
  try {
    await handle.chown(spec.uid, spec.gid);
    await handle.chmod(spec.mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(directory);
}

export async function installBootstrapState(directory: string, dataDirectory: string,
  owners: BootstrapOwners = productionOwners): Promise<BootstrapState> {
  const entries = await stateEntries(directory, owners, true);
  const data = await lstat(dataDirectory).catch(invalid);
  if (!data.isDirectory() || data.isSymbolicLink()) invalid();
  const dataEntries = await readdir(dataDirectory);
  if (entries.length !== 0) {
    const state = await readBootstrapState(directory, owners);
    if (state.phase === 'fresh' && dataEntries.length !== 0) invalid();
    return state;
  }
  if (dataEntries.length !== 0) invalid();
  await chown(directory, owners.installer, owners.group);
  await chmod(directory, 0o770);
  await syncDirectory(directory);
  await createFixed(directory, 'v1-first-init', version, owners);
  await createFixed(directory, 'v1-profile-grant', version, owners);
  await createFixed(directory, 'phase', 'fresh\n', owners);
  return { phase: 'fresh', kind: 'unintroduced' };
}

export async function claimBootstrapIntroduction(directory: string,
  owners: BootstrapOwners = productionOwners): Promise<void> {
  const state = await readBootstrapState(directory, owners);
  if (state.phase !== 'ready' || state.kind !== 'unintroduced') invalid();
  await createFixed(directory, 'v1-profile-claim', version, owners);
}

export async function completeBootstrapIntroduction(directory: string, observedUuid: string,
  owners: BootstrapOwners = productionOwners): Promise<void> {
  if (!uuid.test(observedUuid)) invalid();
  const state = await readBootstrapState(directory, owners);
  if (state.phase !== 'ready' || state.kind !== 'incomplete') invalid();
  await createFixed(directory, 'v1-profile-complete', `${version}${observedUuid}\n`, owners);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== 'install') process.exitCode = 1;
  else installBootstrapWithIdentities('/state', '/search-data').catch(() => {
    process.stderr.write('Private search initialization state is incomplete.\n');
    process.exitCode = 1;
  });
}
