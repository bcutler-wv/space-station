import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
const held = new WeakSet();
const applyOperations = new WeakMap();
const writerRoleOperations = new WeakMap();
const writerMappingOperations = new WeakMap();
const writerDeliveryRecords = ['transfer-dispatched', 'transfer-confirmed',
  'apply-dispatched', 'apply-confirmed', 'cleanup-complete'];
const writerDeliveryFaults = writerDeliveryRecords.flatMap(name =>
  [`writer-${name}-after-append`, `writer-${name}-after-file-sync`]);
const mappingDeliveryRecords = ['transfer-dispatched', 'transfer-confirmed',
  'apply-dispatched', 'apply-confirmed', 'cleanup-complete'];
const mappingDeliveryFaults = mappingDeliveryRecords.flatMap(name =>
  [`mapping-apply-${name}-after-append`,
    `mapping-apply-${name}-after-file-sync`]);
const mappingPrepareRecords = ['preflight-failed', 'transfer-confirmed',
  'prepare-dispatched', 'prepare-confirmed', 'cleanup-confirmed', 'pending-attempted'];
const mappingPrepareFaults = mappingPrepareRecords.flatMap(name =>
  [`mapping-prepare-${name}-after-append`, `mapping-prepare-${name}-after-file-sync`]);
const fail = kind => { throw new Error(`Search admin ${kind}.`); };
const filename = '.job-operation.lock';
const applyUuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function readApplyKnown(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).sort().join('|') !== 'approvedSha256|dispatchId|ownerId' ||
        Object.values(descriptors).some(row => !Object.hasOwn(row, 'value') ||
          !row.enumerable || !row.configurable || !row.writable)) return null;
    const known = Object.fromEntries(Object.entries(descriptors).map(([key, row]) => [key, row.value]));
    if (typeof known.approvedSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(known.approvedSha256) ||
        !applyUuid(known.dispatchId) || !applyUuid(known.ownerId) ||
        known.dispatchId === known.ownerId) return null;
    return known;
  } catch { return null; }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export function isSearchAdminJobLock(lock, root, uid) {
  return held.has(lock) && lock.root === root && lock.uid === uid;
}
export function isCreateApplyBindingOperation(operation, root, uid) {
  const owned = applyOperations.get(operation);
  return owned?.root === root && owned.uid === uid;
}
export function isWriterRoleBindingOperation(operation, root, uid) {
  const owned = writerRoleOperations.get(operation);
  return owned?.root === root && owned.uid === uid;
}
export function isWriterMappingBindingOperation(operation, root, uid) {
  const owned = writerMappingOperations.get(operation);
  return owned?.root === root && owned.uid === uid;
}

/** One owner-local lock for both stopped inspectors and credential commands. */
export async function withSearchAdminJobLock({ root, uid, fixtureFaultAt }, work) {
  if (fixtureFaultAt !== undefined && (process.env.STATION_JOB_LOCK_FIXTURE !== '1' ||
      !['after-append', 'after-file-sync', 'before-release-rm',
        'intent-pending-after-append', 'intent-pending-after-file-sync',
        'apply-binding-after-append', 'apply-binding-after-file-sync',
        'writer-binding-after-append', 'writer-binding-after-file-sync',
        'writer-prepare-final-after-append',
        'writer-prepare-final-after-file-sync', 'writer-release-after-rm',
        'writer-release-after-sync', 'mapping-prepare-final-after-append',
        'mapping-prepare-final-after-file-sync', 'mapping-prepare-release-after-rm',
        'mapping-prepare-release-after-sync', ...writerDeliveryFaults,
        ...mappingPrepareFaults, ...mappingDeliveryFaults,
        'mapping-apply-release-after-rm', 'mapping-apply-release-after-sync',
        'mapping-binding-after-append',
        'mapping-binding-after-file-sync', 'mapping-preflight-failed-after-append',
        'mapping-preflight-failed-after-file-sync'].includes(fixtureFaultAt)))
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
  let applyAttempted = false, applyBindingDurable = false;
  let applyStage = 'preflight', applyDurablePhase = null;
  let applyTerminalAttempted = false, applyCleanup = false, applySuccess = false;
  let applyKnown;
  let writerAttempted = false, writerBindingDurable = false, writerKnown;
  let writerMappingAttempted = false, writerMappingBindingDurable = false;
  let writerMappingPreflightFailed = false, writerMappingKnown;
  let writerMappingStage = 'preflight', writerMappingDurablePhase = null;
  let writerMappingTerminalAttempted = false, writerMappingCleanup = false;
  let writerMappingSuccess = false;
  let writerStage = 'preflight', writerDurablePhase = null;
  let writerTerminalAttempted = false, writerCleanup = false, writerSuccess = false;
  let rolePrepareStage = 'preflight', rolePrepareAttempted = false;
  let rolePrepareDurablePhase = null, rolePrepareTerminalAttempted = false;
  let rolePrepareSuccess = false, rolePrepareFinalAttempted = false;
  let mappingPrepareStage = 'preflight', mappingPrepareAttempted = false;
  let mappingPrepareDurablePhase = null, mappingPrepareTerminalAttempted = false;
  let mappingPrepareSuccess = false, mappingPrepareFinalAttempted = false;
  let mappingPrepareReturned = false;
  const operationId = randomUUID();
  const releaseError = error => {
    if (mode === 'attestor') fail('attestor lock release');
    if (mode === 'create-boundary') fail('create boundary lock release');
    if (mode === 'create-intent') fail('create intent lock release');
    if (mode === 'create-apply') fail('create apply lock release');
    if (mode === 'writer-role-apply') fail('writer role lock release');
    if (mode === 'writer-mapping-apply') fail('writer mapping lock release');
    if (mode === 'writer-role-prepare') fail('writer role prepare lock release');
    if (mode === 'writer-mapping-prepare') fail('writer mapping prepare lock release');
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
    const writerFault = record.role === 'writer-role-apply' ?
      `writer-${record.phase}-${record.state}` : null;
    const mappingFault = record.role === 'writer-mapping-prepare' ?
      `mapping-prepare-${record.phase}-${record.state}` : null;
    const mappingApplyFault = record.role === 'writer-mapping-apply' ?
      `mapping-apply-${record.phase}-${record.state}` : null;
    if (fixtureFaultAt === 'after-append' ||
        fixtureFaultAt === 'intent-pending-after-append' &&
          record.role === 'create-intent' && record.phase === 'pending' ||
        fixtureFaultAt === 'apply-binding-after-append' &&
          record.role === 'create-apply' && record.phase === 'binding' ||
        fixtureFaultAt === 'writer-binding-after-append' &&
          record.role === 'writer-role-apply' && record.phase === 'binding' ||
        fixtureFaultAt === 'mapping-binding-after-append' &&
          record.role === 'writer-mapping-apply' && record.phase === 'binding' ||
        fixtureFaultAt === 'mapping-preflight-failed-after-append' &&
          record.role === 'writer-mapping-apply' && record.phase === 'preflight' ||
        fixtureFaultAt === 'writer-prepare-final-after-append' &&
          record.role === 'writer-role-prepare' && record.phase === 'pending' &&
          record.state === 'prepared' || fixtureFaultAt === `${writerFault}-after-append` &&
          writerDeliveryRecords.includes(`${record.phase}-${record.state}`) ||
        fixtureFaultAt === 'mapping-prepare-final-after-append' &&
          record.role === 'writer-mapping-prepare' && record.phase === 'pending' &&
          record.state === 'prepared' || fixtureFaultAt === `${mappingFault}-after-append` &&
          mappingPrepareRecords.includes(`${record.phase}-${record.state}`) ||
        fixtureFaultAt === `${mappingApplyFault}-after-append` &&
          mappingDeliveryRecords.includes(`${record.phase}-${record.state}`)) fail('job record fault');
    await handle.sync();
    if (fixtureFaultAt === 'after-file-sync' ||
        fixtureFaultAt === 'intent-pending-after-file-sync' &&
          record.role === 'create-intent' && record.phase === 'pending' ||
        fixtureFaultAt === 'apply-binding-after-file-sync' &&
          record.role === 'create-apply' && record.phase === 'binding' ||
        fixtureFaultAt === 'writer-binding-after-file-sync' &&
          record.role === 'writer-role-apply' && record.phase === 'binding' ||
        fixtureFaultAt === 'mapping-binding-after-file-sync' &&
          record.role === 'writer-mapping-apply' && record.phase === 'binding' ||
        fixtureFaultAt === 'mapping-preflight-failed-after-file-sync' &&
          record.role === 'writer-mapping-apply' && record.phase === 'preflight' ||
        fixtureFaultAt === 'writer-prepare-final-after-file-sync' &&
          record.role === 'writer-role-prepare' && record.phase === 'pending' &&
          record.state === 'prepared' || fixtureFaultAt === `${writerFault}-after-file-sync` &&
          writerDeliveryRecords.includes(`${record.phase}-${record.state}`) ||
        fixtureFaultAt === 'mapping-prepare-final-after-file-sync' &&
          record.role === 'writer-mapping-prepare' && record.phase === 'pending' &&
          record.state === 'prepared' || fixtureFaultAt === `${mappingFault}-after-file-sync` &&
          mappingPrepareRecords.includes(`${record.phase}-${record.state}`) ||
        fixtureFaultAt === `${mappingApplyFault}-after-file-sync` &&
          mappingDeliveryRecords.includes(`${record.phase}-${record.state}`)) fail('job record fault');
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
  const apply = Object.freeze({
    invocationId: operationId,
    async assertOwned() {
      if (!active || mode !== 'create-apply' || !applyBindingDurable)
        fail('create apply binding');
      await assertOwned();
    },
    async markBindingAttempted() {
      if (!active || mode !== 'create-apply' || applyAttempted || applyBindingDurable)
        fail('create apply binding');
      applyAttempted = true;
      await appendRecord({ role: 'create-apply', phase: 'binding', state: 'attempted',
        ...applyKnown });
      applyBindingDurable = true;
      applyStage = 'binding-confirmed';
    },
    assertBindingAttempted(input) {
      if (!active || mode !== 'create-apply' || !applyAttempted || !applyBindingDurable)
        fail('create apply binding');
      const known = readApplyKnown(input);
      if (!known || known.approvedSha256 !== applyKnown.approvedSha256 ||
          known.dispatchId !== applyKnown.dispatchId || known.ownerId !== applyKnown.ownerId)
        fail('create apply binding');
      return true;
    },
    async markDispatched(phase) {
      if (!active || mode !== 'create-apply' || !applyBindingDurable ||
          !['transfer', 'create'].includes(phase) ||
          applyStage !== (phase === 'transfer' ? 'binding-confirmed' : 'transfer-confirmed') ||
          applyCleanup || applyTerminalAttempted) fail('create apply dispatch');
      applyStage = `${phase}-dispatched`;
      applyDurablePhase = null;
      await appendRecord({ role: 'create-apply', phase, state: 'dispatched', ...applyKnown });
      applyDurablePhase = phase;
    },
    async confirmCompletion(phase) {
      if (!active || mode !== 'create-apply' || !['transfer', 'create'].includes(phase) ||
          applyStage !== `${phase}-dispatched` || applyDurablePhase !== phase ||
          applyTerminalAttempted) fail('create apply completion');
      applyTerminalAttempted = true;
      await appendRecord({ role: 'create-apply', phase, state: 'confirmed', ...applyKnown });
      applyStage = `${phase}-confirmed`;
      applyDurablePhase = null;
      applyTerminalAttempted = false;
    },
    async confirmOwnedCleanup() {
      if (!active || mode !== 'create-apply' || applyStage !== 'create-confirmed' ||
          applyCleanup || applyTerminalAttempted) fail('create apply cleanup');
      applyTerminalAttempted = true;
      await appendRecord({ role: 'create-apply', phase: 'create', state: 'cleanup-complete',
        ...applyKnown });
      applyCleanup = true;
    },
  });
  const writerRole = Object.freeze({
    invocationId: operationId,
    async assertOwned() {
      if (!active || mode !== 'writer-role-apply' || !writerBindingDurable)
        fail('writer role binding');
      await assertOwned();
    },
    async markBindingAttempted() {
      if (!active || mode !== 'writer-role-apply' || writerAttempted || writerBindingDurable)
        fail('writer role binding');
      writerAttempted = true;
      await appendRecord({ role: 'writer-role-apply', phase: 'binding', state: 'attempted',
        ...writerKnown });
      writerBindingDurable = true;
      writerStage = 'binding-confirmed';
    },
    assertBindingAttempted(input) {
      if (!active || mode !== 'writer-role-apply' || !writerAttempted ||
          !writerBindingDurable) fail('writer role binding');
      const known = readApplyKnown(input);
      if (!known || known.approvedSha256 !== writerKnown.approvedSha256 ||
          known.dispatchId !== writerKnown.dispatchId ||
          known.ownerId !== writerKnown.ownerId) fail('writer role binding');
      return true;
    },
    async markDispatched(phase) {
      if (!active || mode !== 'writer-role-apply' || !writerBindingDurable ||
          !['transfer', 'apply'].includes(phase) ||
          writerStage !== (phase === 'transfer' ? 'binding-confirmed' : 'transfer-confirmed') ||
          writerCleanup || writerTerminalAttempted) fail('writer role dispatch');
      writerAttempted = true;
      writerStage = `${phase}-dispatched`;
      writerDurablePhase = null;
      await appendRecord({ role: 'writer-role-apply', phase, state: 'dispatched',
        ...writerKnown });
      writerDurablePhase = phase;
    },
    async confirmCompletion(phase) {
      if (!active || mode !== 'writer-role-apply' || !['transfer', 'apply'].includes(phase) ||
          writerStage !== `${phase}-dispatched` || writerDurablePhase !== phase ||
          writerTerminalAttempted) fail('writer role completion');
      writerTerminalAttempted = true;
      await appendRecord({ role: 'writer-role-apply', phase, state: 'confirmed', ...writerKnown });
      writerStage = `${phase}-confirmed`;
      writerDurablePhase = null;
      writerTerminalAttempted = false;
    },
    async confirmOwnedCleanup() {
      if (!active || mode !== 'writer-role-apply' || writerStage !== 'apply-confirmed' ||
          writerCleanup || writerTerminalAttempted) fail('writer role cleanup');
      writerTerminalAttempted = true;
      await appendRecord({ role: 'writer-role-apply', phase: 'cleanup',
        state: 'complete', ...writerKnown });
      writerStage = 'cleanup-confirmed';
      writerCleanup = true;
    },
  });
  const writerMapping = Object.freeze({
    invocationId: operationId,
    async assertPreflightOwned() {
      if (!active || mode !== 'writer-mapping-apply' ||
          writerMappingAttempted || writerMappingPreflightFailed)
        fail('writer mapping preflight');
      await assertOwned();
    },
    async assertOwned() {
      if (!active || mode !== 'writer-mapping-apply' ||
          !writerMappingBindingDurable) fail('writer mapping binding');
      await assertOwned();
    },
    async retainPreflightFailure() {
      if (!active || mode !== 'writer-mapping-apply' || writerMappingAttempted ||
          writerMappingPreflightFailed) fail('writer mapping preflight');
      writerMappingPreflightFailed = true;
      await appendRecord({ role: 'writer-mapping-apply', phase: 'preflight',
        state: 'failed', ...writerMappingKnown });
    },
    async markBindingAttempted() {
      if (!active || mode !== 'writer-mapping-apply' || writerMappingAttempted ||
          writerMappingPreflightFailed) fail('writer mapping binding');
      writerMappingAttempted = true;
      await appendRecord({ role: 'writer-mapping-apply', phase: 'binding',
        state: 'attempted', ...writerMappingKnown });
      writerMappingBindingDurable = true;
      writerMappingStage = 'binding-confirmed';
    },
    assertBindingAttempted(input) {
      const known = readApplyKnown(input);
      if (!active || mode !== 'writer-mapping-apply' || !writerMappingAttempted ||
          !writerMappingBindingDurable || !known ||
          known.approvedSha256 !== writerMappingKnown.approvedSha256 ||
          known.dispatchId !== writerMappingKnown.dispatchId ||
          known.ownerId !== writerMappingKnown.ownerId) fail('writer mapping binding');
      return true;
    },
    async markDispatched(phase) {
      if (!active || mode !== 'writer-mapping-apply' ||
          !writerMappingBindingDurable ||
          !['transfer', 'apply'].includes(phase) ||
          writerMappingStage !== (phase === 'transfer' ?
            'binding-confirmed' : 'transfer-confirmed') ||
          writerMappingCleanup || writerMappingTerminalAttempted) fail('writer mapping dispatch');
      writerMappingAttempted = true;
      writerMappingStage = `${phase}-dispatched`;
      writerMappingDurablePhase = null;
      await appendRecord({ role: 'writer-mapping-apply', phase,
        state: 'dispatched', ...writerMappingKnown });
      writerMappingDurablePhase = phase;
    },
    async confirmCompletion(phase) {
      if (!active || mode !== 'writer-mapping-apply' ||
          !['transfer', 'apply'].includes(phase) ||
          writerMappingStage !== `${phase}-dispatched` ||
          writerMappingDurablePhase !== phase ||
          writerMappingTerminalAttempted) fail('writer mapping completion');
      writerMappingTerminalAttempted = true;
      await appendRecord({ role: 'writer-mapping-apply', phase,
        state: 'confirmed', ...writerMappingKnown });
      writerMappingStage = `${phase}-confirmed`;
      writerMappingDurablePhase = null;
      writerMappingTerminalAttempted = false;
    },
    async confirmOwnedCleanup() {
      if (!active || mode !== 'writer-mapping-apply' ||
          writerMappingStage !== 'apply-confirmed' ||
          writerMappingCleanup || writerMappingTerminalAttempted)
        fail('writer mapping cleanup');
      writerMappingTerminalAttempted = true;
      await appendRecord({ role: 'writer-mapping-apply', phase: 'cleanup',
        state: 'complete', ...writerMappingKnown });
      writerMappingStage = 'cleanup-confirmed';
      writerMappingCleanup = true;
    },
  });
  const writerPrepare = Object.freeze({
    invocationId: operationId,
    async assertOwned() {
      if (!active || mode !== 'writer-role-prepare') fail('writer role prepare identity');
      await assertOwned();
    },
    async markDispatched(phase) {
      if (!active || mode !== 'writer-role-prepare' ||
          !['transfer', 'prepare'].includes(phase) ||
          rolePrepareStage !== (phase === 'transfer' ? 'preflight' : 'transfer-confirmed') ||
          rolePrepareTerminalAttempted) fail('writer role prepare dispatch');
      rolePrepareAttempted = true;
      rolePrepareStage = `${phase}-dispatched`;
      rolePrepareDurablePhase = null;
      await appendRecord({ role: 'writer-role-prepare', phase, state: 'dispatched' });
      rolePrepareDurablePhase = phase;
    },
    async confirmCompletion(phase) {
      if (!active || mode !== 'writer-role-prepare' ||
          !['transfer', 'prepare'].includes(phase) ||
          rolePrepareStage !== `${phase}-dispatched` ||
          rolePrepareDurablePhase !== phase || rolePrepareTerminalAttempted)
        fail('writer role prepare completion');
      rolePrepareTerminalAttempted = true;
      await appendRecord({ role: 'writer-role-prepare', phase, state: 'confirmed' });
      rolePrepareStage = `${phase}-confirmed`;
      rolePrepareDurablePhase = null;
      rolePrepareTerminalAttempted = false;
    },
    async confirmOwnedCleanup() {
      if (!active || mode !== 'writer-role-prepare' ||
          rolePrepareStage !== 'prepare-confirmed' || rolePrepareTerminalAttempted)
        fail('writer role prepare cleanup');
      rolePrepareTerminalAttempted = true;
      await appendRecord({ role: 'writer-role-prepare', phase: 'cleanup', state: 'confirmed' });
      rolePrepareStage = 'cleanup-confirmed';
      rolePrepareTerminalAttempted = false;
    },
    async markPendingAttempted() {
      if (!active || mode !== 'writer-role-prepare' ||
          rolePrepareStage !== 'cleanup-confirmed' || rolePrepareTerminalAttempted)
        fail('writer role prepare pending');
      rolePrepareAttempted = true;
      rolePrepareTerminalAttempted = true;
      await appendRecord({ role: 'writer-role-prepare', phase: 'pending', state: 'attempted' });
      rolePrepareStage = 'pending-attempted';
    },
    async confirmPrepared() {
      if (!active || mode !== 'writer-role-prepare' ||
          rolePrepareStage !== 'pending-attempted' || !rolePrepareTerminalAttempted ||
          rolePrepareFinalAttempted)
        fail('writer role prepare success');
      rolePrepareFinalAttempted = true;
      await appendRecord({ role: 'writer-role-prepare', phase: 'pending', state: 'prepared' });
      rolePrepareStage = 'prepared';
      rolePrepareSuccess = true;
    },
  });
  const mappingPrepare = Object.freeze({
    invocationId: operationId,
    async retainPreflightFailure() {
      if (!active || mode !== 'writer-mapping-prepare' ||
          mappingPrepareStage !== 'preflight' || mappingPrepareAttempted ||
          mappingPrepareTerminalAttempted) fail('writer mapping prepare preflight');
      mappingPrepareAttempted = true;
      mappingPrepareTerminalAttempted = true;
      mappingPrepareStage = 'preflight-failed';
      await appendRecord({ role: 'writer-mapping-prepare', phase: 'preflight', state: 'failed' });
    },
    async assertOwned() {
      if (!active || mode !== 'writer-mapping-prepare') fail('writer mapping prepare identity');
      await assertOwned();
    },
    async markDispatched(phase) {
      if (!active || mode !== 'writer-mapping-prepare' ||
          !['transfer', 'prepare'].includes(phase) ||
          mappingPrepareStage !== (phase === 'transfer' ? 'preflight' : 'transfer-confirmed') ||
          mappingPrepareTerminalAttempted) fail('writer mapping prepare dispatch');
      mappingPrepareAttempted = true;
      mappingPrepareStage = `${phase}-dispatched`;
      mappingPrepareDurablePhase = null;
      await appendRecord({ role: 'writer-mapping-prepare', phase, state: 'dispatched' });
      mappingPrepareDurablePhase = phase;
    },
    async confirmCompletion(phase) {
      if (!active || mode !== 'writer-mapping-prepare' ||
          !['transfer', 'prepare'].includes(phase) ||
          mappingPrepareStage !== `${phase}-dispatched` ||
          mappingPrepareDurablePhase !== phase || mappingPrepareTerminalAttempted)
        fail('writer mapping prepare completion');
      mappingPrepareTerminalAttempted = true;
      await appendRecord({ role: 'writer-mapping-prepare', phase, state: 'confirmed' });
      mappingPrepareStage = `${phase}-confirmed`;
      mappingPrepareDurablePhase = null;
      mappingPrepareTerminalAttempted = false;
    },
    async confirmOwnedCleanup() {
      if (!active || mode !== 'writer-mapping-prepare' ||
          mappingPrepareStage !== 'prepare-confirmed' || mappingPrepareTerminalAttempted)
        fail('writer mapping prepare cleanup');
      mappingPrepareTerminalAttempted = true;
      await appendRecord({ role: 'writer-mapping-prepare', phase: 'cleanup', state: 'confirmed' });
      mappingPrepareStage = 'cleanup-confirmed';
      mappingPrepareTerminalAttempted = false;
    },
    async markPendingAttempted() {
      if (!active || mode !== 'writer-mapping-prepare' ||
          mappingPrepareStage !== 'cleanup-confirmed' || mappingPrepareTerminalAttempted)
        fail('writer mapping prepare pending');
      mappingPrepareAttempted = true;
      mappingPrepareTerminalAttempted = true;
      await appendRecord({ role: 'writer-mapping-prepare', phase: 'pending', state: 'attempted' });
      mappingPrepareStage = 'pending-attempted';
    },
    async confirmPrepared() {
      if (!active || mode !== 'writer-mapping-prepare' ||
          mappingPrepareStage !== 'pending-attempted' || !mappingPrepareTerminalAttempted ||
          mappingPrepareFinalAttempted)
        fail('writer mapping prepare success');
      mappingPrepareFinalAttempted = true;
      await appendRecord({ role: 'writer-mapping-prepare', phase: 'pending', state: 'prepared' });
      mappingPrepareStage = 'prepared';
      mappingPrepareSuccess = true;
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
    beginCreateApply(input) {
      if (!active || mode !== 'unselected' || dispatched) fail('create apply mode');
      const known = readApplyKnown(input);
      if (!known || operationId === known.dispatchId ||
          operationId === known.ownerId) fail('create apply mode');
      applyKnown = known;
      mode = 'create-apply';
      applyOperations.set(apply, { root, uid });
      return apply;
    },
    beginWriterRoleApply(input) {
      if (!active || mode !== 'unselected' || dispatched) fail('writer role mode');
      const known = readApplyKnown(input);
      if (!known || operationId === known.dispatchId ||
          operationId === known.ownerId) fail('writer role mode');
      writerKnown = known;
      mode = 'writer-role-apply';
      writerRoleOperations.set(writerRole, { root, uid });
      return writerRole;
    },
    beginWriterMappingApply(input) {
      if (!active || mode !== 'unselected' || dispatched) fail('writer mapping mode');
      const known = readApplyKnown(input);
      if (!known || operationId === known.dispatchId ||
          operationId === known.ownerId) fail('writer mapping mode');
      writerMappingKnown = known;
      mode = 'writer-mapping-apply';
      writerMappingOperations.set(writerMapping, { root, uid });
      return writerMapping;
    },
    beginWriterRolePrepare() {
      if (!active || mode !== 'unselected' || dispatched) fail('writer role prepare mode');
      mode = 'writer-role-prepare';
      return writerPrepare;
    },
    beginWriterMappingPrepare() {
      if (!active || mode !== 'unselected' || dispatched) fail('writer mapping prepare mode');
      mode = 'writer-mapping-prepare';
      return mappingPrepare;
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
    if (mode === 'create-apply') {
      if (!applyBindingDurable) fail('create apply incomplete');
      await assertOwned();
      if (applyCleanup) applySuccess = true;
    }
    if (mode === 'writer-role-apply') {
      if (!writerBindingDurable) fail('writer role incomplete');
      await assertOwned();
      if (writerStage !== 'binding-confirmed' && !writerCleanup)
        fail('writer role incomplete');
      if (writerCleanup) writerSuccess = true;
    }
    if (mode === 'writer-mapping-apply') {
      if (!writerMappingBindingDurable) fail('writer mapping incomplete');
      await assertOwned();
      if (writerMappingStage !== 'binding-confirmed' && !writerMappingCleanup)
        fail('writer mapping incomplete');
      if (writerMappingCleanup) writerMappingSuccess = true;
    }
    if (mode === 'writer-role-prepare' && !rolePrepareSuccess)
      fail('writer role prepare incomplete');
    if (mode === 'writer-mapping-prepare' && !mappingPrepareSuccess)
      fail('writer mapping prepare incomplete');
    if (mode === 'writer-mapping-prepare') mappingPrepareReturned = true;
    return result;
  } finally {
    active = false;
    held.delete(token);
    applyOperations.delete(apply);
    writerRoleOperations.delete(writerRole);
    writerMappingOperations.delete(writerMapping);
    const original = await handle.stat().catch(() => null);
    await handle.close().catch(() => {});
    let canRelease = mode === 'attestor' ? !attestorAttempted || attestorCleanup :
      mode === 'create-boundary' ? !boundaryAttempted || boundaryCleanup :
        mode === 'create-intent' ? !intentAttempted || intentCleanup : !dispatched || confirmed;
    if (mode === 'create-apply') canRelease = !applyAttempted || applyCleanup;
    if (mode === 'writer-role-apply') canRelease = !writerAttempted || writerSuccess;
    if (mode === 'writer-mapping-apply') canRelease =
      !writerMappingAttempted && !writerMappingPreflightFailed ||
      writerMappingSuccess;
    if (mode === 'writer-role-prepare') canRelease =
      !rolePrepareAttempted || rolePrepareSuccess;
    if (mode === 'writer-mapping-prepare') canRelease =
      !mappingPrepareAttempted || mappingPrepareSuccess && mappingPrepareReturned;
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
            if ((mode === 'attestor' || mode === 'create-boundary' ||
                mode === 'create-intent' || mode === 'create-apply' ||
                mode === 'writer-role-prepare' || mode === 'writer-role-apply' ||
                mode === 'writer-mapping-prepare' ||
                mode === 'writer-mapping-apply') &&
                fixtureFaultAt === 'before-release-rm')
              fail('fixture release fault');
            await rm(lockPath);
            if (mode === 'writer-role-apply' && fixtureFaultAt === 'writer-release-after-rm')
              fail('fixture release fault');
            if (mode === 'writer-mapping-apply' &&
                fixtureFaultAt === 'mapping-apply-release-after-rm') fail('fixture release fault');
            if (mode === 'writer-mapping-prepare' &&
                fixtureFaultAt === 'mapping-prepare-release-after-rm') fail('fixture release fault');
            await syncDirectory(root);
            if (mode === 'writer-role-apply' && fixtureFaultAt === 'writer-release-after-sync')
              fail('fixture release fault');
            if (mode === 'writer-mapping-apply' &&
                fixtureFaultAt === 'mapping-apply-release-after-sync') fail('fixture release fault');
            if (mode === 'writer-mapping-prepare' &&
                fixtureFaultAt === 'mapping-prepare-release-after-sync') fail('fixture release fault');
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
    if (applySuccess && !released) fail('create apply lock release');
    if (writerSuccess && !released) fail('writer role lock release');
    if (writerMappingSuccess && !released) fail('writer mapping lock release');
    if (rolePrepareSuccess && !released) fail('writer role prepare lock release');
    if (mappingPrepareSuccess && !released) fail('writer mapping prepare lock release');
  }
}
