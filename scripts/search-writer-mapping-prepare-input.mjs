import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { validateWriterRoleCopiedEvidence } from './search-writer-role-apply-evidence.mjs';

const fail = () => { throw Error('Private writer mapping preparation input failed.'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exact = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.length === names.length && keys.every(key => typeof key === 'string' &&
    names.includes(key) && descriptors[key].enumerable &&
    Object.hasOwn(descriptors[key], 'value'));
};
const canon = (value, cap = 256 * 1024) => canonicalAttestorValue(value, cap);

/** Structural copied-input check only; expected approval values come from outside the bytes. */
export function parseWriterMappingPrepareInput(bytes, expected) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 512 * 1024 ||
        !exact(expected, ['createApprovedSha256', 'roleApprovedSha256', 'project',
          'databaseOid', 'systemIdentifier', 'invocationId', 'dispatchId', 'ownerId']) ||
        ![expected.createApprovedSha256, expected.roleApprovedSha256].every(x =>
          typeof x === 'string' && sha.test(x))) fail();
    const value = JSON.parse(bytes.toString('utf8'));
    if (!canon(value, 512 * 1024).bytes.equals(bytes) ||
        !exact(value, ['invocation', 'files', 'priorPublicDigests', 'publicEvidence']) ||
        !exact(value.invocation, ['version', 'project', 'databaseOid',
          'systemIdentifier', 'invocationId', 'dispatchId', 'ownerId']) ||
        value.invocation.version !== 1 ||
        ['project', 'databaseOid', 'systemIdentifier', 'invocationId',
          'dispatchId', 'ownerId'].some(key =>
          value.invocation[key] !== expected[key]) ||
        ![expected.invocationId, expected.dispatchId, expected.ownerId].every(x =>
          typeof x === 'string' && uuid.test(x)) ||
        new Set([expected.invocationId, expected.dispatchId, expected.ownerId]).size !== 3 ||
        !exact(value.files, ['intent', 'binding', 'createIntent', 'createBinding'])) fail();
    const files = {};
    for (const [key, cap] of [['intent', 256 * 1024], ['binding', 1024],
      ['createIntent', 256 * 1024], ['createBinding', 1024]]) {
      const hex = value.files[key];
      if (typeof hex !== 'string' || hex.length < 4 || hex.length > cap * 2 ||
          hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) fail();
      files[key] = Buffer.from(hex, 'hex');
    }
    const old = validateWriterRoleCopiedEvidence(files, expected.project);
    if (old.approvedSha256 !== expected.roleApprovedSha256 ||
        hash(files.createIntent) !== expected.createApprovedSha256 ||
        new Set([expected.invocationId, expected.dispatchId, expected.ownerId,
          old.intent.dispatchId, old.intent.ownerId, old.binding.invocationId,
          old.create.dispatchId, old.create.ownerId,
          old.createBinding.invocationId]).size !== 9 ||
        old.intent.databaseOid !== expected.databaseOid ||
        old.intent.systemIdentifier !== expected.systemIdentifier ||
        !canon(value.priorPublicDigests).bytes.equals(
          canon(old.intent.publicDigests).bytes)) fail();
    canon(value.publicEvidence, 128 * 1024);
    const pinned = canon({ invocation: value.invocation,
      createEvidence: { intent: old.create, binding: old.createBinding,
        approvedSha256: expected.createApprovedSha256 },
      roleEvidence: { intent: old.intent, binding: old.binding,
        approvedSha256: expected.roleApprovedSha256 },
      priorPublicDigests: value.priorPublicDigests,
      publicEvidence: value.publicEvidence }, 512 * 1024).value;
    return Object.freeze(pinned);
  } catch { fail(); }
}
