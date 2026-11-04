import { Buffer } from 'node:buffer';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { validateSerializedWriterRoleIntent } from './search-writer-role-pending.mjs';
import { sealCreateIntent } from './search-create-intent-pure.mjs';
import { createHash } from 'node:crypto';

const fail = () => { throw Error('Private writer role preparation output failed.'); };
const same = (a, b) => canonicalAttestorValue(a).bytes.equals(canonicalAttestorValue(b).bytes);
const exact = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  if (own.length !== names.length || own.some(key => typeof key !== 'string') ||
      own.slice().sort().join('|') !== names.slice().sort().join('|')) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return own.every(key => descriptors[key].enumerable &&
    Object.hasOwn(descriptors[key], 'value'));
};
const hash = value => createHash('sha256').update(canonicalAttestorValue(value).bytes)
  .digest('hex');
const createProjectionKeys = ['version', 'revision', 'stage', 'transitionToken',
  'sourceToken', 'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex',
  'databaseOid', 'priorObservationDigest', 'publicFiles', 'target', 'bodyIdentity'];

/** Strict host-side serialized result check; no projection or reseal authority. */
export function parseWriterRolePrepareOutput(bytes, expected) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 3 || bytes.length > 256 * 1024 ||
        bytes.at(-1) !== 10) fail();
    const value = JSON.parse(bytes.subarray(0, -1).toString('utf8'));
    if (!canonicalAttestorValue(value, 256 * 1024).bytes.equals(bytes.subarray(0, -1)) ||
        Object.keys(value).sort().join('|') !== 'adminPublic|intent|sha256' ||
        !value.adminPublic || Object.keys(value.adminPublic).sort().join('|') !==
          'adminSha256|caSha256' ||
        !/^[0-9a-f]{64}$/.test(value.adminPublic.adminSha256) ||
        !/^[0-9a-f]{64}$/.test(value.adminPublic.caSha256) ||
        !exact(expected, ['adminPublic', 'createEvidence', 'invocation',
          'publicDigests'])) fail();
    canonicalAttestorValue(expected.invocation);
    canonicalAttestorValue(expected.createEvidence);
    canonicalAttestorValue(expected.publicDigests);
    canonicalAttestorValue(expected.adminPublic);
    const old = expected.createEvidence.intent;
    const binding = expected.createEvidence.binding;
    const original = sealCreateIntent(Object.fromEntries(createProjectionKeys.map(key =>
      [key, old[key]])), old.publicDigests,
    { project: old.project, systemIdentifier: old.systemIdentifier,
      dispatchId: old.dispatchId, ownerId: old.ownerId });
    if (original.sha256 !== expected.createEvidence.approvedSha256 ||
        !same(original.intent, old) ||
        binding.approvedSha256 !== original.sha256 ||
        binding.dispatchId !== old.dispatchId || binding.ownerId !== old.ownerId ||
        expected.invocation.createApprovedSha256 !== original.sha256 ||
        expected.invocation.originalCreateBindingSha256 !== hash(binding)) fail();
    const intent = validateSerializedWriterRoleIntent(value.intent, value.sha256,
      expected.invocation.project);
    if (intent.dispatchId !== expected.invocation.dispatchId ||
        intent.ownerId !== expected.invocation.ownerId ||
        intent.databaseOid !== expected.invocation.databaseOid ||
        intent.systemIdentifier !== expected.invocation.systemIdentifier ||
        intent.createApprovedSha256 !== expected.invocation.createApprovedSha256 ||
        intent.originalCreateBindingSha256 !==
          expected.invocation.originalCreateBindingSha256 ||
        intent.createApprovedSha256 !== expected.createEvidence.approvedSha256 ||
        intent.revision !== old.revision + 5 ||
        ['transitionToken', 'sourceToken', 'sourceIndex', 'sourceUuid',
          'candidateToken', 'candidateIndex', 'databaseOid',
          'priorEvidenceDigest'].some(key => intent[key] !== old[key]) ||
        !same(intent.publicFiles, old.publicFiles) ||
        !same(intent.publicDigests, old.publicDigests) ||
        [intent.dispatchId, intent.ownerId].some(id =>
          id === old.dispatchId || id === old.ownerId || id === binding.invocationId) ||
        !same(intent.publicDigests, expected.publicDigests) ||
        !same(value.adminPublic, expected.adminPublic) ||
        !expected.publicDigests.some(row => row.path === 'ca.pem' &&
          row.sha256 === value.adminPublic.caSha256) ||
        !expected.publicDigests.some(row => row.path === 'v1/admin.pem' &&
          row.sha256 === value.adminPublic.adminSha256)) fail();
    return Object.freeze({ intent, sha256: value.sha256 });
  } catch { fail(); }
}
