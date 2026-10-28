import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
const held = new WeakSet();
const fail = kind => { throw new Error(`Search admin ${kind}.`); };
const filename = '.job-operation.lock';

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export function isSearchAdminJobLock(lock, root, uid) {
  return held.has(lock) && lock.root === root && lock.uid === uid;
}

/** One owner-local lock for both stopped inspectors and credential commands. */
export async function withSearchAdminJobLock({ root, uid, fixtureFaultAt }, work) {
  if (fixtureFaultAt !== undefined && (process.env.STATION_JOB_LOCK_FIXTURE !== '1' ||
      !['after-append', 'after-file-sync', 'before-release-rm',
        'intent-pending-after-append', 'intent-pending-after-file-sync'].includes(fixtureFaultAt)))
    fail('job lock configuration');
  if (path.resolve(root) !== root || !root.endsWith('/.cache/search-db') ||
      !Number.isSafeInteger(uid) || uid < 1 || uid !== process.getuid?.() ||
      await realpath(path.dirname(root)) !== path.dirname(root) ||
      await realpath(root) !== root) fail('job lock configuration');
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      directory.uid !== uid || (directory.mode & 0o777) !== 0o700) fail('private directory');

  const lockPath = path.join(root, filename);
  let handle;
  try { handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { fail('job locked'); }
  let dispatched = false, confirmed = false, prepared = false;
  let active = false;
  let attestorSuccess = false;
  let mode = 'unselected', attestorStage = 'preflight', attestorAttempted = false;
  let attestorDurablePhase = null, attestorCleanup = false, attestorTerminalAttempted = false;
  let boundaryStage = 'preflight', boundaryAttempted = false, boundaryDurablePhase = null;
  let boundaryCleanup = false, boundaryTerminalAttempted = false, boundarySuccess = false;
  let intentStage = 'preflight', intentAttempted = false, intentDurablePhase = null;
  let intentCleanup = false, intentTerminalAttempted = false, intentSuccess = false;
  let intentPendingDurable = false;
  const operationId = randomUUID();
  const releaseError = error => {
    if (mode === 'attestor') fail('attestor lock release');
    if (mode === 'create-boundary') fail('create boundary lock release');
    if (mode === 'create-intent') fail('create intent lock release');
    throw error;
  };
  const assertOwned = async () => {
    const currentRoot = await lstat(root).catch(() => null);
    const currentLock = await lstat(lockPath).catch(() => null);
    const openedLock = await handle.stat().catch(() => null);
    if (!currentRoot?.isDirectory() || currentRoot.isSymbolicLink() ||
        currentRoot.dev !== directory.dev || currentRoot.ino !== directory.ino ||
        currentRoot.uid !== uid || (currentRoot.mode & 0o777) !== 0o700 ||
        await realpath(root).catch(() => null) !== root ||
        await realpath(path.dirname(root)).catch(() => null) !== path.dirname(root) ||
        !currentLock?.isFile() || currentLock.isSymbolicLink() || currentLock.nlink !== 1 ||
        currentLock.uid !== uid || (currentLock.mode & 0o777) !== 0o600 ||
        !openedLock || currentLock.dev !== openedLock.dev || currentLock.ino !== openedLock.ino)
      fail('job lock identity');
  };
  const appendRecord = async record => {
    await assertOwned();
    await handle.writeFile(`\n${JSON.stringify({ version: 1, operationId, pid: process.pid,
      role: 'attestor', ...record })}\n`);
    if (fixtureFaultAt === 'after-append' ||
        fixtureFaultAt === 'intent-pending-after-append' &&
          record.role === 'create-intent' && record.phase === 'pending') fail('job record fault');
    await handle.sync();
    if (fixtureFaultAt === 'after-file-sync' ||
        fixtureFaultAt === 'intent-pending-after-file-sync' &&
          record.role === 'create-intent' && record.phase === 'pending') fail('job record fault');
    await syncDirectory(root);
    await assertOwned();
  };
  const attestor = Object.freeze({
    invocationId: operationId,
    async markDispatched(phase) {
      if (!active) fail('attestor inactive');
      const from = { prepare: 'preflight', transfer: 'prepare-confirmed',
        attestor: 'transfer-confirmed' };
      if (typeof phase !== 'string' || !Object.hasOwn(from, phase) ||
          attestorStage !== from[phase] ||
          attestorCleanup || attestorTerminalAttempted) fail('attestor dispatch');
      // Attempted before any potentially partial append: a failed mark is terminal.
      attestorAttempted = true;
      attestorStage = `${phase}-dispatched`;
      attestorDurablePhase = null;
      await appendRecord({ phase, state: 'dispatched' });
      attestorDurablePhase = phase;
    },
    async confirmCompletion(phase) {
      if (!active) fail('attestor inactive');
      if (!['prepare', 'transfer', 'attestor'].includes(phase) ||
          attestorStage !== `${phase}-dispatched` || attestorDurablePhase !== phase ||
          attestorTerminalAttempted) fail('attestor completion');
      attestorTerminalAttempted = true;
      await appendRecord({ phase, state: 'confirmed' });
      attestorStage = `${phase}-confirmed`;
      attestorDurablePhase = null;
      attestorTerminalAttempted = false;
    },
    async confirmOwnedCleanup() {
      if (!active) fail('attestor inactive');
      if (!['prepare-confirmed', 'transfer-confirmed', 'attestor-confirmed']
        .includes(attestorStage) || attestorCleanup || attestorTerminalAttempted) fail('attestor cleanup');
      attestorTerminalAttempted = true;
      await appendRecord({ phase: attestorStage, state: 'cleanup-complete' });
      attestorCleanup = true;
    },
  });
  const boundary = Object.freeze({
    invocationId: operationId,
    async markDispatched(phase) {
      if (!active || mode !== 'create-boundary' ||
          phase !== 'transfer' && phase !== 'inspect' ||
          boundaryStage !== (phase === 'transfer' ? 'preflight' : 'transfer-confirmed') ||
          boundaryCleanup || boundaryTerminalAttempted) fail('create boundary dispatch');
      boundaryAttempted = true;
      boundaryStage = `${phase}-dispatched`;
      boundaryDurablePhase = null;
      await appendRecord({ role: 'create-boundary', phase, state: 'dispatched' });
      boundaryDurablePhase = phase;
    },
    async confirmCompletion(phase) {
      if (!active || mode !== 'create-boundary' ||
          phase !== 'transfer' && phase !== 'inspect' ||
          boundaryStage !== `${phase}-dispatched` || boundaryDurablePhase !== phase ||
          boundaryTerminalAttempted) fail('create boundary completion');
      boundaryTerminalAttempted = true;
      await appendRecord({ role: 'create-boundary', phase, state: 'confirmed' });
      boundaryStage = `${phase}-confirmed`;
      boundaryDurablePhase = null;
      boundaryTerminalAttempted = false;
    },
    async confirmOwnedCleanup() {
      if (!active || mode !== 'create-boundary' ||
          !['transfer-confirmed', 'inspect-confirmed'].includes(boundaryStage) ||
          boundaryCleanup || boundaryTerminalAttempted) fail('create boundary cleanup');
      boundaryTerminalAttempted = true;
      await appendRecord({ role: 'create-boundary', phase: boundaryStage, state: 'cleanup-complete' });
      boundaryCleanup = true;
    },
  });
  const intent = Object.freeze({
    invocationId: operationId,
    async markDispatched(phase) {
      if (!active || mode !== 'create-intent' ||
          phase !== 'transfer' && phase !== 'prepare' ||
          intentStage !== (phase === 'transfer' ? 'preflight' : 'transfer-confirmed') ||
          intentCleanup || intentTerminalAttempted) fail('create intent dispatch');
      intentAttempted = true;
      intentStage = `${phase}-dispatched`;
      intentDurablePhase = null;
      await appendRecord({ role: 'create-intent', phase, state: 'dispatched' });
      intentDurablePhase = phase;
    },
    async confirmCompletion(phase) {
      if (!active || mode !== 'create-intent' ||
          phase !== 'transfer' && phase !== 'prepare' ||
          intentStage !== `${phase}-dispatched` || intentDurablePhase !== phase ||
          intentTerminalAttempted) fail('create intent completion');
      intentTerminalAttempted = true;
      await appendRecord({ role: 'create-intent', phase, state: 'confirmed' });
      intentStage = `${phase}-confirmed`;
      intentDurablePhase = null;
      intentTerminalAttempted = false;
    },
    async markPendingAttempted() {
      if (!active || mode !== 'create-intent' || intentStage !== 'prepare-confirmed' ||
          intentCleanup || intentTerminalAttempted) fail('create intent pending');
      intentAttempted = true;
      intentStage = 'pending-attempted';
      intentPendingDurable = false;
      await appendRecord({ role: 'create-intent', phase: 'pending', state: 'attempted' });
      intentPendingDurable = true;
    },
    async confirmOwnedCleanup() {
      if (!active || mode !== 'create-intent' || intentStage !== 'pending-attempted' ||
          !intentPendingDurable || intentCleanup || intentTerminalAttempted) fail('create intent cleanup');
      intentTerminalAttempted = true;
      await appendRecord({ role: 'create-intent', phase: 'pending', state: 'cleanup-complete' });
      intentCleanup = true;
    },
  });
  const token = Object.freeze({
    root, uid,
    beginAttestor() {
      if (!active || mode !== 'unselected' || dispatched) fail('attestor mode');
      mode = 'attestor';
      return attestor;
    },
    beginCreateBoundary() {
      if (!active || mode !== 'unselected' || dispatched) fail('create boundary mode');
      mode = 'create-boundary';
      return boundary;
    },
    beginCreateIntentPrepare() {
      if (!active || mode !== 'unselected' || dispatched) fail('create intent mode');
      mode = 'create-intent';
      return intent;
    },
    async markDispatched(role) {
      if (mode !== 'unselected' || dispatched || !['verifier', 'transition'].includes(role)) fail('job dispatch');
      mode = 'single';
      const record = JSON.stringify({ version: 1, operationId, pid: process.pid, role, state: 'dispatched' });
      await handle.writeFile(`\n${record}\n`);
      await handle.sync();
      await syncDirectory(root);
      dispatched = true;
    },
    confirmCompletion() {
      if (mode !== 'single' || !dispatched || confirmed) fail('job completion');
      confirmed = true;
    },
  });
  held.add(token);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, operationId, pid: process.pid, state: 'preflight' }));
    await handle.sync();
    await syncDirectory(root);
    prepared = true;
    active = true;
    const result = await work(token);
    if (mode === 'attestor' && (attestorStage !== 'attestor-confirmed' || !attestorCleanup))
      fail('attestor incomplete');
    if (mode === 'attestor') attestorSuccess = true;
    if (mode === 'create-boundary' &&
        (boundaryStage !== 'inspect-confirmed' || !boundaryCleanup)) fail('create boundary incomplete');
    if (mode === 'create-boundary') boundarySuccess = true;
    if (mode === 'create-intent' &&
        (intentStage !== 'pending-attempted' || !intentPendingDurable || !intentCleanup))
      fail('create intent incomplete');
    if (mode === 'create-intent') intentSuccess = true;
    return result;
  } finally {
    active = false;
    held.delete(token);
    const original = await handle.stat().catch(() => null);
    await handle.close().catch(() => {});
    const canRelease = mode === 'attestor' ? !attestorAttempted || attestorCleanup :
      mode === 'create-boundary' ? !boundaryAttempted || boundaryCleanup :
        mode === 'create-intent' ? !intentAttempted || intentCleanup : !dispatched || confirmed;
    let released = false;
    if (prepared && canRelease && original) {
      const currentRoot = await lstat(root).catch(() => null);
      if (currentRoot?.isDirectory() && !currentRoot.isSymbolicLink() &&
          currentRoot.dev === directory.dev && currentRoot.ino === directory.ino &&
          currentRoot.uid === uid && (currentRoot.mode & 0o777) === 0o700 &&
          await realpath(root).catch(() => null) === root &&
          await realpath(path.dirname(root)).catch(() => null) === path.dirname(root)) {
        const current = await lstat(lockPath).catch(() => null);
        if (current?.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
            current.uid === uid && (current.mode & 0o777) === 0o600 &&
            current.dev === original.dev && current.ino === original.ino) {
          try {
            if ((mode === 'attestor' || mode === 'create-boundary' || mode === 'create-intent') &&
                fixtureFaultAt === 'before-release-rm')
              fail('fixture release fault');
            await rm(lockPath);
            await syncDirectory(root);
            released = true;
          } catch (error) {
            releaseError(error);
          }
        }
      }
    }
    if (attestorSuccess && !released) fail('attestor lock release');
    if (boundarySuccess && !released) fail('create boundary lock release');
    if (intentSuccess && !released) fail('create intent lock release');
  }
}
