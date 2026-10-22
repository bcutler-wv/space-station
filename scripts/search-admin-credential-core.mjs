import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isSearchAdminJobLock, withSearchAdminJobLock } from './search-admin-job-lock.mjs';

const roles = ['verifier', 'transition'];
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const metadataName = 'operation.json';
const finalName = 'initial-v1';
const maxMetadata = 4096;
const rotationPattern = /^\.rotation-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const containerPattern = /^[0-9a-f]{12,64}$/;

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
const readSecret = async (file, uid, stage = false) => {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid ||
        (stage ? (stat.mode & 0o777) !== 0o600 : ![0o400, 0o600].includes(stat.mode & 0o777)) ||
        stat.size !== 43) fail('secret');
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
const readFixedJson = async (file, uid, kind, maximum = maxMetadata) => {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 ||
        stat.size < 2 || stat.size > maximum) fail(kind);
    const bytes = Buffer.alloc(maximum + 1);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== stat.size) fail(kind);
    return JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'));
  } catch (error) { if (error instanceof CredentialOperationError) throw error; fail(kind); }
  finally { await handle?.close().catch(() => {}); }
};
const readFixedFlag = async (file, uid, kind) => {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size !== 3)
      fail(kind);
    const bytes = Buffer.alloc(4);
    const result = await handle.read(bytes, 0, 4, 0);
    if (result.bytesRead !== 3 || bytes.subarray(0, 3).toString('utf8') !== 'v1\n') fail(kind);
  } catch (error) { if (error instanceof CredentialOperationError) throw error; fail(kind); }
  finally { await handle?.close().catch(() => {}); }
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
  if (entries.length > 7 || entries.some(x => !['.operation.lock', '.job-operation.lock', finalName].includes(x) &&
      !/^\.pending-[0-9a-f-]{36}$/.test(x) && !rotationPattern.test(x)) ||
      entries.filter(x => rotationPattern.test(x)).length > 1) fail('unexpected material');
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

const rotationName = operationId => `.rotation-${operationId}`;
const readRotation = async (root, name, uid, installation, bundle) => {
  if (!rotationPattern.test(name)) fail('rotation ownership');
  const directory = path.join(root, name);
  await inspectedDirectory(directory, uid);
  const entries = (await readdir(directory)).sort();
  const permitted = ['rotation.json', 'old.password', 'new.password', 'new.publish', 'started', '.owner-operation-inflight'];
  if (entries.length < 3 || entries.length > permitted.length || entries.some(x => !permitted.includes(x)) ||
      !['rotation.json', 'old.password', 'new.password'].every(x => entries.includes(x))) fail('rotation inventory');
  const metadata = await readFixedJson(path.join(directory, 'rotation.json'), uid, 'rotation metadata');
  const keys = ['database', 'databaseOid', 'gid', 'initialOperationId', 'mode', 'operationId', 'owner',
    'project', 'role', 'service', 'systemIdentifier', 'uid', 'version'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      Object.keys(metadata).sort().join('|') !== keys.sort().join('|') ||
      metadata.version !== 1 || metadata.mode !== 'finish-new' || !roles.includes(metadata.role) ||
      !uuidPattern.test(metadata.operationId) || name !== rotationName(metadata.operationId) ||
      metadata.initialOperationId !== bundle.metadata.operationId ||
      !sameInstallation(metadata, installation)) fail('rotation metadata');
  const oldSecret = await readSecret(path.join(directory, 'old.password'), uid, true);
  const newSecret = await readSecret(path.join(directory, 'new.password'), uid, true);
  if (fixedEquals(oldSecret, newSecret) || fixedEquals(newSecret, bundle.secrets[roles.find(x => x !== metadata.role)]))
    fail('rotation secret');
  const published = bundle.secrets[metadata.role];
  const isOld = fixedEquals(published, oldSecret), isNew = fixedEquals(published, newSecret);
  if (!isOld && !isNew) fail('rotation publication');
  if (entries.includes('new.publish')) {
    const copy = await readSecret(path.join(directory, 'new.publish'), uid, true);
    if (!fixedEquals(copy, newSecret)) fail('rotation secret');
  } else if (!isNew) fail('rotation inventory');
  if (entries.includes('started')) await readFixedFlag(path.join(directory, 'started'), uid, 'rotation started');
  let marker;
  if (entries.includes('.owner-operation-inflight')) {
    marker = await readFixedJson(path.join(directory, '.owner-operation-inflight'), uid, 'rotation inflight', 512);
    const fields = ['action', 'attemptId', 'containerId', 'operationId', 'role', 'version'];
    if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
        Object.keys(marker).sort().join('|') !== fields.sort().join('|') || marker.version !== 1 ||
        marker.role !== metadata.role || marker.operationId !== metadata.operationId ||
        !uuidPattern.test(marker.attemptId) || !containerPattern.test(marker.containerId) ||
        !['nologin', 'terminate', 'password', 'login'].includes(marker.action) || !entries.includes('started'))
      fail('rotation inflight');
  }
  return { directory, metadata, oldSecret, newSecret, isOld, isNew,
    hasPublish: entries.includes('new.publish'), started: entries.includes('started'), marker };
};

const rotationMutation = async (stage, adapter, action, work) => {
  const markerFile = path.join(stage.directory, '.owner-operation-inflight');
  const containerId = await adapter.containerId();
  if (!containerPattern.test(containerId)) fail('container identity');
  const marker = { version: 1, operationId: stage.metadata.operationId, attemptId: randomUUID(),
    role: stage.metadata.role, action, containerId };
  await writeExclusive(markerFile, JSON.stringify(marker));
  await syncDirectory(stage.directory);
  // Any failure after the dispatch fence is uncertain. The marker is never
  // removed on a negative/timeout result; an owner must retire this exact ID.
  try { await work(); } catch { fail('remote uncertain'); }
  await rm(markerFile);
  await syncDirectory(stage.directory);
};

const checkOtherRole = async (adapter, role, bundle) => {
  const other = roles.find(x => x !== role);
  await adapter.authenticate(other, bundle.secrets[other]);
  const state = await adapter.roleEvidence(other);
  if (state.login !== true || typeof state.verifier !== 'string' || !state.verifier.startsWith('SCRAM-SHA-256$'))
    fail('other role state');
  return { role: other, file: bundle.secrets[other], ...state };
};
const assertOtherRoleUnchanged = async (adapter, before, root, uid) => {
  const after = await adapter.roleEvidence(before.role);
  const file = await readSecret(path.join(root, finalName, `${before.role}.password`), uid);
  if (after.login !== before.login || !fixedEquals(after.verifier, before.verifier) ||
      !fixedEquals(file, before.file)) fail('other role drift');
  await adapter.authenticate(before.role, before.file);
};
const assertTargetContainersAbsent = async (adapter, role) => {
  if (await adapter.targetContainersAbsent(role) !== true) fail('target containers');
};

const runRotation = async ({ stage, adapter, root, uid, bundle }) => {
  const role = stage.metadata.role;
  await adapter.attestAuthentication();
  await adapter.auditRecovery(role);
  await assertTargetContainersAbsent(adapter, role);
  const otherBefore = await checkOtherRole(adapter, role, bundle);
  if (!stage.started) {
    await writeExclusive(path.join(stage.directory, 'started'), 'v1\n');
    await syncDirectory(stage.directory);
  }
  await rotationMutation(stage, adapter, 'nologin', () => adapter.setLogin(role, false));
  await rotationMutation(stage, adapter, 'terminate', () => adapter.terminateTargetSessions(role));
  await assertTargetContainersAbsent(adapter, role);
  await rotationMutation(stage, adapter, 'password', () => adapter.setPassword(role, stage.newSecret));
  await assertTargetContainersAbsent(adapter, role);
  await rotationMutation(stage, adapter, 'login', () => adapter.setLogin(role, true));
  await adapter.authenticate(role, stage.newSecret);
  await adapter.authenticateRejected(role, stage.oldSecret);
  await assertOtherRoleUnchanged(adapter, otherBefore, root, uid);
  await assertTargetContainersAbsent(adapter, role);
  if (stage.isOld) {
    if (!stage.hasPublish) fail('rotation inventory');
    await rename(path.join(stage.directory, 'new.publish'), path.join(root, finalName, `${role}.password`));
    await syncDirectory(path.join(root, finalName));
    await syncDirectory(stage.directory);
    await syncDirectory(root);
    await adapter.afterRotationPublication?.();
  }
  await assertTargetContainersAbsent(adapter, role);
  const current = await readBundle(path.join(root, finalName), uid);
  if (!fixedEquals(current.secrets[role], stage.newSecret)) fail('rotation publication');
  await adapter.attestAuthentication();
  await adapter.audit();
  await adapter.authenticate(role, stage.newSecret);
  await adapter.authenticateRejected(role, stage.oldSecret);
  await assertOtherRoleUnchanged(adapter, otherBefore, root, uid);
  await assertTargetContainersAbsent(adapter, role);
  if (await adapter.targetSessionsZero(role) !== true) fail('target sessions');
  await rm(stage.directory, { recursive: true });
  await syncDirectory(root);
  return { state: 'rotated', operationId: stage.metadata.operationId };
};

async function prepareRoot({ action, root, uid, gid }) {
  if (!['create', 'verify', 'abort-pending-create', 'rotate', 'finish-pending-rotation',
      'abort-pending-rotation'].includes(action) || !Number.isSafeInteger(uid) ||
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
}

/** Called only while the fixed job lock is held; verification acquires the credential lock. */
export async function operateSearchAdminCredentialsAlreadyJobLocked({ action, role, operationId, root, uid, gid,
  adapter, adapterFactory, jobLock }) {
  if (!isSearchAdminJobLock(jobLock, root, uid)) fail('job locked');
  await prepareRoot({ action, root, uid, gid });
  const lock = path.join(root, '.operation.lock');
  let lockHandle;
  try { lockHandle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { fail('operation locked'); }
  try {
    await lockHandle.writeFile(`${process.pid}\n`); await lockHandle.sync();
    const entries = await boundedEntries(root);
    adapter ??= await adapterFactory?.();
    if (!adapter) fail('configuration');
    const installation = await adapter.identity();
    if (installation.uid !== uid || installation.gid !== gid) fail('installation identity');
    if (action === 'create') {
      if (entries.includes(finalName) || entries.some(x => x.startsWith('.pending-') || rotationPattern.test(x)))
        fail('existing material');
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
      if (!entries.includes(finalName) || entries.some(x => x.startsWith('.pending-') || rotationPattern.test(x)))
        fail('incomplete setup');
      const bundle = await readBundle(path.join(root, finalName), uid);
      if (!sameInstallation(bundle.metadata, installation)) fail('installation mismatch');
      await adapter.audit();
      for (const role of roles) await adapter.authenticate(role, bundle.secrets[role]);
      return { state: 'verified', operationId: bundle.metadata.operationId };
    }
    if (['rotate', 'finish-pending-rotation', 'abort-pending-rotation'].includes(action)) {
      if (!roles.includes(role) || (action === 'rotate' ? operationId !== undefined : !uuidPattern.test(operationId ?? '')))
        fail('rotation arguments');
      if (!entries.includes(finalName) || entries.some(x => x.startsWith('.pending-'))) fail('incomplete setup');
      const bundle = await readBundle(path.join(root, finalName), uid);
      if (!sameInstallation(bundle.metadata, installation)) fail('installation mismatch');
      const rotations = entries.filter(x => rotationPattern.test(x));
      if (action === 'rotate') {
        if (rotations.length) fail('pending rotation');
        await adapter.attestAuthentication();
        await adapter.audit();
        for (const currentRole of roles) await adapter.authenticate(currentRole, bundle.secrets[currentRole]);
        await assertTargetContainersAbsent(adapter, role);
        const other = await checkOtherRole(adapter, role, bundle);
        const original = await adapter.roleEvidence(role);
        if (original.login !== true || typeof original.verifier !== 'string' ||
            !original.verifier.startsWith('SCRAM-SHA-256$')) fail('target role state');
        const id = randomUUID();
        const directory = path.join(root, rotationName(id));
        await mkdir(directory, { mode: 0o700 });
        const metadata = { version: 1, mode: 'finish-new', operationId: id,
          initialOperationId: bundle.metadata.operationId, role, ...installation };
        await writeExclusive(path.join(directory, 'rotation.json'), JSON.stringify(metadata));
        await syncDirectory(directory); await syncDirectory(root);
        const secret = randomBytes(32).toString('base64url');
        if (fixedEquals(secret, bundle.secrets[role]) || fixedEquals(secret, other.file)) fail('randomness');
        await writeExclusive(path.join(directory, 'old.password'), bundle.secrets[role]);
        await writeExclusive(path.join(directory, 'new.password'), secret);
        await writeExclusive(path.join(directory, 'new.publish'), secret);
        await syncDirectory(directory); await syncDirectory(root);
        const stage = await readRotation(root, rotationName(id), uid, installation, bundle);
        await adapter.afterRotationStaged?.();
        return await runRotation({ stage, adapter, root, uid, bundle });
      }
      if (rotations.length !== 1 || rotations[0] !== rotationName(operationId)) fail('rotation ownership');
      const stage = await readRotation(root, rotations[0], uid, installation, bundle);
      if (stage.metadata.role !== role) fail('rotation ownership');
      await adapter.attestAuthentication();
      await adapter.auditRecovery(role);
      await assertTargetContainersAbsent(adapter, role);
      if (action === 'abort-pending-rotation') {
        if (stage.started || stage.marker || !stage.isOld) fail('rotation started');
        await adapter.audit();
        await adapter.authenticate(role, stage.oldSecret);
        await adapter.authenticateRejected(role, stage.newSecret);
        await checkOtherRole(adapter, role, bundle);
        await assertTargetContainersAbsent(adapter, role);
        await rm(stage.directory, { recursive: true });
        await syncDirectory(root);
        return { state: 'rotation-aborted', operationId };
      }
      if (stage.marker) {
        // Docker absence of the exact captured ID is the only supported local
        // proof that this prior owner exec cannot execute again. Never accept
        // a merely stopped/restartable container or a transport error.
        await adapter.assertRetiredContainer(stage.marker.containerId);
        await adapter.attestAuthentication();
        await adapter.auditRecovery(role);
        await rm(path.join(stage.directory, '.owner-operation-inflight'));
        await syncDirectory(stage.directory);
      }
      return await runRotation({ stage, adapter, root, uid, bundle });
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
    const claimed = await lockHandle.stat().catch(() => null);
    await lockHandle.close().catch(() => {});
    const current = await lstat(lock).catch(() => null);
    if (claimed && current?.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
        current.uid === uid && (current.mode & 0o777) === 0o600 &&
        current.dev === claimed.dev && current.ino === claimed.ino) {
      await rm(lock);
      await syncDirectory(root);
    }
  }
}

/** The adapter performs fixed owner-local PostgreSQL operations; no network I/O occurs under a DB transaction. */
export async function operateSearchAdminCredentials(options) {
  await prepareRoot(options);
  return withSearchAdminJobLock({ root: options.root, uid: options.uid }, jobLock =>
    operateSearchAdminCredentialsAlreadyJobLocked({ ...options, jobLock }));
}
