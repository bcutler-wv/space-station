/* global structuredClone */
import { Buffer } from 'node:buffer';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { parseWriterMappingPrepareInput } from './search-writer-mapping-prepare-input.mjs';
import { makeWriterMappingIntentProjection, sealWriterMappingIntent,
  assessWriterMappingEvidence } from './search-writer-mapping-intent-pure.mjs';

const fail = () => { throw Error('Private writer mapping preparation failed.'); };
const canon = (value, max = 2 * 1024 * 1024) => canonicalAttestorValue(value, max);
const same = (a, b) => canon(a).bytes.equals(canon(b).bytes);
const exact = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.length === names.length && keys.every(key => typeof key === 'string' &&
    names.includes(key) && descriptors[key].enumerable &&
    Object.hasOwn(descriptors[key], 'value'));
};

/** Read-only injected core. Acquisition and byte identity belong to a later fixed reader. */
export async function runWriterMappingPrepare(inputBytes, expected, deps) {
  try {
    const pinnedExpected = canon(expected, 4096).value;
    const input = parseWriterMappingPrepareInput(inputBytes, pinnedExpected);
    const originalInputBytes = Buffer.from(inputBytes);
    const names = ['readInputBytes', 'recheckInput', 'readState', 'readSnapshot',
      'recheckSnapshot', 'observe', 'captureAdminPublic'];
    if (!exact(deps, names) || names.some(name => typeof deps[name] !== 'function')) fail();
    const methods = Object.fromEntries(names.map(name => [name, deps[name]]));
    const read = async (method, max) => {
      const value = await method();
      canon(value, max);
      return structuredClone(value);
    };
    const original = { state: await read(methods.readState, 16 * 1024),
      snapshot: await read(methods.readSnapshot, 2 * 1024 * 1024),
      observed: await read(methods.observe, 2 * 1024 * 1024) };
    const admin = await methods.captureAdminPublic();
    if (!exact(admin, ['public', 'recheck']) ||
        !exact(admin.public, ['caSha256', 'adminSha256']) ||
        typeof admin.recheck !== 'function') fail();
    const adminRecheck = admin.recheck;
    const originalAdmin = structuredClone(canon(admin.public, 4096).value);
    if (original.snapshot.identity?.databaseOid !== input.invocation.databaseOid ||
        original.snapshot.identity?.sessionUser !== 'station_search_transition' ||
        original.snapshot.identity?.currentUser !== 'station_search_transition' ||
        originalAdmin.caSha256 !== input.priorPublicDigests.find(row =>
          row.path === 'ca.pem')?.sha256 ||
        originalAdmin.adminSha256 !== input.priorPublicDigests.find(row =>
          row.path === 'v1/admin.pem')?.sha256) fail();
    const fence = async () => {
      if (!(await methods.recheckInput()) ||
          !(await methods.recheckSnapshot(structuredClone(original.snapshot))) ||
          !(await adminRecheck())) fail();
      const currentBytes = await methods.readInputBytes();
      if (!Buffer.isBuffer(currentBytes) ||
          !originalInputBytes.equals(currentBytes) ||
          !same(parseWriterMappingPrepareInput(currentBytes, pinnedExpected), input)) fail();
      const current = { state: await read(methods.readState, 16 * 1024),
        snapshot: await read(methods.readSnapshot, 2 * 1024 * 1024),
        observed: await read(methods.observe, 2 * 1024 * 1024) };
      const currentAdmin = await methods.captureAdminPublic();
      if (!exact(currentAdmin, ['public', 'recheck']) ||
          !exact(currentAdmin.public, ['caSha256', 'adminSha256']) ||
          typeof currentAdmin.recheck !== 'function') fail();
      const currentRecheck = currentAdmin.recheck;
      const currentPublic = structuredClone(canon(currentAdmin.public, 4096).value);
      if (!same(current, original) || !same(currentPublic, originalAdmin) ||
          !(await currentRecheck()) || !(await adminRecheck()) ||
          !(await methods.recheckInput()) ||
          !(await methods.recheckSnapshot(structuredClone(original.snapshot)))) fail();
      const trailing = await methods.readInputBytes();
      if (!Buffer.isBuffer(trailing) || !originalInputBytes.equals(trailing)) fail();
    };
    await fence();
    const projection = makeWriterMappingIntentProjection(original.snapshot,
      original.observed, original.state, input.createEvidence, input.roleEvidence,
      input.priorPublicDigests, input.publicEvidence);
    await fence();
    const sealed = sealWriterMappingIntent(projection,
      { dispatchId: input.invocation.dispatchId, ownerId: input.invocation.ownerId });
    const attested = assessWriterMappingEvidence(original.snapshot, original.observed,
      original.state, input.createEvidence, input.roleEvidence,
      input.priorPublicDigests, input.publicEvidence, sealed, 'attested',
      { controlUpdatedAt: original.snapshot.exactTimestamps.control.updatedAt,
        mappingCreatedAt: null }, sealed.sha256);
    if (attested.status !== 'writer-mapping-evidence' || attested.phase !== 'attested' ||
        attested.ready !== false || sealed.intent.project !== input.invocation.project ||
        sealed.intent.systemIdentifier !== input.invocation.systemIdentifier ||
        sealed.intent.databaseOid !== input.invocation.databaseOid) fail();
    await fence();
    const output = canon({ intent: sealed.intent, sha256: sealed.sha256,
      adminPublic: originalAdmin }, 256 * 1024).bytes;
    await fence();
    return Buffer.concat([output, Buffer.from('\n')]);
  } catch { fail(); }
}
