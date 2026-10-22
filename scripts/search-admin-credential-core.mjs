import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const roles = ['verifier', 'transition'];
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const metadataName = 'operation.json';
const finalName = 'initial-v1';
const maxMetadata = 4096;

export class CredentialOperationError extends Error {
  constructor(kind) { super(`Search admin credential ${kind}.`); this.kind = kind; }
}
const fail = kind => { throw new CredentialOperationError(kind); };
const fixedEquals = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const syncDirectory = async directory => {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
};
const inspectedDirectory = async (directory, uid) => {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || (entry.mode & 0o777) !== 0o700)
    fail('private directory');
};
const readSecret = async (file, uid) => {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid ||
        ![0o400, 0o600].includes(stat.mode & 0o777) || stat.size !== 43) fail('secret');
    const buffer = Buffer.alloc(44);
    const { bytesRead } = await handle.read(buffer, 0, 44, 0);
    const value = buffer.subarray(0, bytesRead).toString('utf8');
    if (bytesRead !== 43 || !secretPattern.test(value) || Buffer.from(value, 'base64url').length !== 32)
      fail('secret');
    return value;
  } catch (error) {
    if (error instanceof CredentialOperationError) throw error;
    fail('secret');
  } finally { await handle?.close().catch(() => {}); }
};
const readMetadata = async (directory, uid) => {
  const file = path.join(directory, metadataName);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 ||
        stat.size < 2 || stat.size > maxMetadata) fail('metadata');
    const buffer = Buffer.alloc(maxMetadata + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) fail('metadata');
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    const expectedKeys = ['database', 'databaseOid', 'gid', 'mode', 'operationId', 'owner',
      'project', 'roles', 'service', 'systemIdentifier', 'uid', 'version'];
    if (Object.keys(value).sort().join('|') !== expectedKeys.sort().join('|')) fail('metadata');
    if (value.version !== 1 || value.mode !== 'initial-create' ||
        JSON.stringify(value.roles) !== JSON.stringify(roles) ||
        !/^[0-9a-f-]{36}$/.test(value.operationId) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(value.project) ||
        value.service !== 'postgres' || value.database !== 'station' ||
        !/^[1-9][0-9]{0,9}$/.test(value.databaseOid) ||
        !/^[1-9][0-9]{0,19}$/.test(value.systemIdentifier) ||
        value.owner !== 'station' || !Number.isSafeInteger(value.uid) || !Number.isSafeInteger(value.gid) ||
        value.uid < 1 || value.gid < 1) fail('metadata');
    return value;
  } catch (error) {
    if (error instanceof CredentialOperationError) throw error;
    fail('metadata');
  } finally { await handle?.close().catch(() => {}); }
};
const writeExclusive = async (file, bytes) => {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
};
const sameInstallation = (left, right) => left.project === right.project &&
  left.service === right.service && left.database === right.database &&
  left.databaseOid === right.databaseOid && left.systemIdentifier === right.systemIdentifier &&
  left.owner === right.owner && left.uid === right.uid && left.gid === right.gid;
const boundedEntries = async root => {
  const entries = await readdir(root);
  if (entries.length > 5 || entries.some(x => !['.operation.lock', finalName].includes(x) &&
      !/^\.pending-[0-9a-f-]{36}$/.test(x))) fail('unexpected material');
  return entries;
};
const onePending = entries => {
  const found = entries.filter(x => x.startsWith('.pending-'));
  if (found.length !== 1) fail('pending state');
  return found[0];
};
const readBundle = async (directory, uid) => {
  await inspectedDirectory(directory, uid);
  const entries = (await readdir(directory)).sort();
  if (entries.join('|') !== 'operation.json|transition.password|verifier.password') fail('bundle inventory');
  return { metadata: await readMetadata(directory, uid),
    secrets: Object.fromEntries(await Promise.all(roles.map(async role =>
      [role, await readSecret(path.join(directory, `${role}.password`), uid)]))) };
};
const readPendingBundle = async (directory, uid) => {
  await inspectedDirectory(directory, uid);
  const entries = (await readdir(directory)).sort();
  if (!entries.includes(metadataName) || entries.some(x =>
      ![metadataName, 'verifier.password', 'transition.password'].includes(x))) fail('bundle inventory');
  const metadata = await readMetadata(directory, uid);
  for (const role of roles) if (entries.includes(`${role}.password`))
    await readSecret(path.join(directory, `${role}.password`), uid);
  return metadata;
};
const mutating = async (directory, operationId, work) => {
  const marker = path.join(directory, '.owner-operation-inflight');
  await writeExclusive(marker, operationId);
  await syncDirectory(directory);
  let result, failure;
  try { result = await work(); } catch (error) { failure = error; }
  if (failure instanceof CredentialOperationError && failure.kind === 'remote uncertain') throw failure;
  try { await rm(marker); await syncDirectory(directory); }
  catch { fail('remote uncertain'); }
  if (failure) throw failure;
  return result;
};

/** The adapter performs fixed owner-local PostgreSQL operations; no network I/O occurs under a DB transaction. */
export async function operateSearchAdminCredentials({ action, root, uid, gid, adapter }) {
  if (!['create', 'verify', 'abort-pending-create'].includes(action) || !Number.isSafeInteger(uid) ||
      !Number.isSafeInteger(gid) || uid < 1 || gid < 1 ||
      uid !== process.getuid?.() || gid !== process.getgid?.()) fail('configuration');
  if (path.resolve(root) !== root || !root.endsWith('/.cache/search-db')) fail('configuration');
  const parent = path.dirname(root);
  if (await realpath(parent) !== parent) fail('canonical parent');
  if (action === 'create') {
    try { await mkdir(root, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') fail('private directory'); }
  }
  await inspectedDirectory(root, uid);
  if (await realpath(root) !== root) fail('canonical root');
  const lock = path.join(root, '.operation.lock');
  let lockHandle;
  try { lockHandle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { fail('operation locked'); }
  try {
    await lockHandle.writeFile(`${process.pid}\n`); await lockHandle.sync();
    const entries = await boundedEntries(root);
    const installation = await adapter.identity();
    if (installation.uid !== uid || installation.gid !== gid) fail('installation identity');
    if (action === 'create') {
      if (entries.includes(finalName) || entries.some(x => x.startsWith('.pending-'))) fail('existing material');
      await adapter.preflightCreate();
      const operationId = randomUUID();
      const pendingName = `.pending-${operationId}`;
      const pending = path.join(root, pendingName);
      const metadata = { version: 1, mode: 'initial-create', operationId, roles, ...installation };
      await mkdir(pending, { mode: 0o700 });
      await writeExclusive(path.join(pending, metadataName), JSON.stringify(metadata));
      await syncDirectory(pending); await syncDirectory(root);
      const secrets = Object.fromEntries(roles.map(role => [role, randomBytes(32).toString('base64url')]));
      if (fixedEquals(secrets.verifier, secrets.transition)) fail('randomness');
      for (const role of roles) {
        await writeExclusive(path.join(pending, `${role}.password`), secrets[role]);
        if (role === 'verifier') await adapter.afterFirstSecret?.();
      }
      await syncDirectory(pending); await syncDirectory(root);
      let published = false;
      try {
        await mutating(pending, operationId, () => adapter.applyPolicy());
        for (const role of roles) {
          await mutating(pending, operationId, () => adapter.setPassword(role, secrets[role]));
          await mutating(pending, operationId, () => adapter.setLogin(role, true));
        }
        for (const role of roles) await adapter.authenticate(role, secrets[role]);
        await adapter.audit();
        if ((await readdir(root)).includes(finalName)) fail('existing material');
        await rename(pending, path.join(root, finalName)); published = true;
        await syncDirectory(root);
        await adapter.afterPublication?.();
      } catch (error) {
        if (!published) {
          if (error instanceof CredentialOperationError && error.kind === 'remote uncertain') throw error;
          try { await mutating(pending, operationId, () => adapter.disableRoles()); }
          catch { fail('shutdown uncertain'); }
        }
        throw error;
      }
      return { state: 'created', operationId };
    }
    if (action === 'verify') {
      if (!entries.includes(finalName) || entries.some(x => x.startsWith('.pending-'))) fail('incomplete setup');
      const bundle = await readBundle(path.join(root, finalName), uid);
      if (!sameInstallation(bundle.metadata, installation)) fail('installation mismatch');
      await adapter.audit();
      for (const role of roles) await adapter.authenticate(role, bundle.secrets[role]);
      return { state: 'verified', operationId: bundle.metadata.operationId };
    }
    if (entries.includes(finalName)) fail('published bundle');
    const pending = path.join(root, onePending(entries));
    const pendingMetadata = await readPendingBundle(pending, uid);
    if (path.basename(pending) !== `.pending-${pendingMetadata.operationId}`) fail('pending ownership');
    if (!sameInstallation(pendingMetadata, installation)) fail('installation mismatch');
    await mutating(pending, pendingMetadata.operationId, () => adapter.disableAndClearRoles());
    await mutating(pending, pendingMetadata.operationId, () => adapter.applyPolicy());
    await adapter.audit();
    await rm(pending, { recursive: true });
    await syncDirectory(root);
    return { state: 'aborted', operationId: pendingMetadata.operationId };
  } finally {
    await lockHandle.close().catch(() => {});
    await rm(lock, { force: true }).catch(() => {});
  }
}
