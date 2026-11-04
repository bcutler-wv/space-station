/* global structuredClone */
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { makeWriterRoleIntentProjection, sealWriterRoleIntent,
  assessWriterRoleEvidence } from './search-writer-role-intent-pure.mjs';

const fail = () => { throw Error('Private writer role preparation failed.'); };
const same = (left, right, max = 2 * 1024 * 1024) =>
  canonicalAttestorValue(left, max).bytes.equals(canonicalAttestorValue(right, max).bytes);
const keys = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  if (own.length !== names.length || own.some(key => typeof key !== 'string') ||
      own.slice().sort().join('|') !== names.slice().sort().join('|')) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return own.every(key => descriptors[key].enumerable &&
    Object.hasOwn(descriptors[key], 'value'));
};

/** Fixed read-only proof. The constructor and seal must run in this same process. */
export async function runWriterRolePrepare(deps) {
  try {
    const firstInput = await deps.readInput();
    if (!keys(firstInput, ['invocation', 'createEvidence', 'publicDigests', 'recheck'])) fail();
    const { invocation, createEvidence, publicDigests } = firstInput;
    canonicalAttestorValue(invocation);
    canonicalAttestorValue(createEvidence);
    canonicalAttestorValue(publicDigests);
    const pinnedInput = structuredClone({ invocation, createEvidence, publicDigests });
    if (
        !keys(invocation, ['version', 'invocationId', 'project', 'databaseOid',
          'systemIdentifier', 'createApprovedSha256', 'originalCreateBindingSha256',
          'dispatchId', 'ownerId']) || invocation.version !== 1 ||
        createEvidence.approvedSha256 !== invocation.createApprovedSha256) fail();
    const readPinned = async (read, max = 2 * 1024 * 1024) => {
      const value = await read();
      canonicalAttestorValue(value, max);
      return structuredClone(value);
    };
    const original = { state: await readPinned(deps.readState),
      snapshot: await readPinned(deps.readSnapshot),
      observed: await readPinned(deps.observe) };
    if (original.snapshot?.identity?.databaseOid !== pinnedInput.invocation.databaseOid ||
        original.snapshot?.identity?.sessionUser !== 'station_search_transition' ||
        original.snapshot?.identity?.currentUser !== 'station_search_transition') fail();
    const admin = await deps.captureAdminPublic();
    if (!keys(admin, ['public', 'recheck']) ||
        !keys(admin.public, ['caSha256', 'adminSha256']) ||
        !pinnedInput.publicDigests.some(row => row.path === 'ca.pem' &&
          row.sha256 === admin.public.caSha256) ||
        !pinnedInput.publicDigests.some(row => row.path === 'v1/admin.pem' &&
          row.sha256 === admin.public.adminSha256)) fail();
    canonicalAttestorValue(admin.public);
    const pinnedAdminPublic = structuredClone(admin.public);
    const fence = async () => {
      if (!(await deps.recheckSnapshot(structuredClone(original.snapshot))) ||
          !(await firstInput.recheck()) || !(await admin.recheck())) fail();
      const current = { state: await readPinned(deps.readState),
        snapshot: await readPinned(deps.readSnapshot),
        observed: await readPinned(deps.observe) };
      const currentInput = await deps.readInput();
      if (!keys(currentInput, ['invocation', 'createEvidence', 'publicDigests', 'recheck'])) fail();
      canonicalAttestorValue(currentInput.invocation);
      canonicalAttestorValue(currentInput.createEvidence);
      canonicalAttestorValue(currentInput.publicDigests);
      const currentPinnedInput = structuredClone({ invocation: currentInput.invocation,
        createEvidence: currentInput.createEvidence,
        publicDigests: currentInput.publicDigests });
      const currentAdmin = await deps.captureAdminPublic();
      if (!keys(currentAdmin, ['public', 'recheck']) ||
          !keys(currentAdmin.public, ['caSha256', 'adminSha256'])) fail();
      canonicalAttestorValue(currentAdmin.public);
      const currentPinnedAdmin = structuredClone(currentAdmin.public);
      if (
          !same(current, original) ||
          !same(currentPinnedInput.invocation, pinnedInput.invocation) ||
          !same(currentPinnedInput.createEvidence, pinnedInput.createEvidence) ||
          !same(currentPinnedInput.publicDigests, pinnedInput.publicDigests) ||
          !same(currentPinnedAdmin, pinnedAdminPublic) ||
          !(await currentInput.recheck()) || !(await currentAdmin.recheck()) ||
          !(await firstInput.recheck()) || !(await admin.recheck())) fail();
    };
    await fence();
    const projection = makeWriterRoleIntentProjection(original.snapshot, original.observed,
      original.state, pinnedInput.createEvidence, pinnedInput.publicDigests);
    await fence();
    const sealed = sealWriterRoleIntent(projection,
      { dispatchId: pinnedInput.invocation.dispatchId,
        ownerId: pinnedInput.invocation.ownerId }, pinnedInput.createEvidence);
    if (sealed.intent.project !== pinnedInput.invocation.project ||
        sealed.intent.systemIdentifier !== pinnedInput.invocation.systemIdentifier ||
        sealed.intent.originalCreateBindingSha256 !==
          pinnedInput.invocation.originalCreateBindingSha256 ||
        assessWriterRoleEvidence(original.snapshot, original.observed, original.state,
          pinnedInput.createEvidence, pinnedInput.publicDigests, sealed, 'bound',
          { controlUpdatedAt: original.snapshot.exactTimestamps.control.updatedAt,
            roleCreatedAt: null }, sealed.sha256).status !== 'writer-role-evidence') fail();
    await fence();
    const output = { intent: sealed.intent, sha256: sealed.sha256,
      adminPublic: pinnedAdminPublic };
    const bytes = canonicalAttestorValue(output, 256 * 1024).bytes;
    return `${bytes.toString('utf8')}\n`;
  } catch { fail(); }
}
