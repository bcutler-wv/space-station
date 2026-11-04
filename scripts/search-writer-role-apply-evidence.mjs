import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { sealCreateIntent } from './search-create-intent-pure.mjs';
import { validateSerializedWriterRoleIntent } from './search-writer-role-pending.mjs';

const fail = () => { throw Error('Private writer role copied evidence failed.'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const projectionKeys = ['version', 'revision', 'stage', 'transitionToken', 'sourceToken',
  'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex', 'databaseOid',
  'priorObservationDigest', 'publicFiles', 'target', 'bodyIdentity'];
const sameCanonical = (value, bytes, max) => canonicalAttestorValue(value, max).bytes.equals(bytes);

/** Structural copied evidence only: no current caller, approved tuple, or live U authority. */
export function validateWriterRoleCopiedEvidence(files, project) {
  try {
    if (Object.keys(files).sort().join('|') !==
        'binding|createBinding|createIntent|intent' ||
        Object.values(files).some(value => !Buffer.isBuffer(value))) fail();
    const intent = JSON.parse(files.intent.toString('utf8'));
    const binding = JSON.parse(files.binding.toString('utf8'));
    const create = JSON.parse(files.createIntent.toString('utf8'));
    const createBinding = JSON.parse(files.createBinding.toString('utf8'));
    if (!sameCanonical(intent, files.intent, 256 * 1024) ||
        !sameCanonical(binding, files.binding, 1024) ||
        !sameCanonical(create, files.createIntent, 256 * 1024) ||
        !sameCanonical(createBinding, files.createBinding, 1024)) fail();
    validateSerializedWriterRoleIntent(intent, hash(files.intent), project);
    const old = sealCreateIntent(Object.fromEntries(projectionKeys.map(key => [key, create[key]])),
      create.publicDigests, { project: create.project,
        systemIdentifier: create.systemIdentifier, dispatchId: create.dispatchId,
        ownerId: create.ownerId });
    if (!sameCanonical(old.intent, files.createIntent, 256 * 1024) ||
        old.sha256 !== hash(files.createIntent) ||
        Object.keys(binding).sort().join('|') !==
          'approvedSha256|dispatchId|invocationId|ownerId|version' ||
        Object.keys(createBinding).sort().join('|') !==
          'approvedSha256|dispatchId|invocationId|ownerId|version' ||
        binding.version !== 1 || createBinding.version !== 1 ||
        binding.approvedSha256 !== hash(files.intent) ||
        createBinding.approvedSha256 !== old.sha256 ||
        intent.createApprovedSha256 !== old.sha256 ||
        intent.originalCreateBindingSha256 !== hash(files.createBinding) ||
        binding.dispatchId !== intent.dispatchId || binding.ownerId !== intent.ownerId ||
        createBinding.dispatchId !== create.dispatchId ||
        createBinding.ownerId !== create.ownerId ||
        !uuid(binding.invocationId) || !uuid(createBinding.invocationId) ||
        new Set([intent.dispatchId, intent.ownerId, binding.invocationId,
          create.dispatchId, create.ownerId, createBinding.invocationId]).size !== 6 ||
        create.project !== project || create.project !== intent.project ||
        create.systemIdentifier !== intent.systemIdentifier ||
        create.databaseOid !== intent.databaseOid ||
        create.revision + 5 !== intent.revision ||
        create.priorEvidenceDigest !== intent.priorEvidenceDigest ||
        ['transitionToken', 'sourceToken', 'sourceIndex', 'sourceUuid',
          'candidateToken', 'candidateIndex'].some(key => create[key] !== intent[key]) ||
        !canonicalAttestorValue(create.publicFiles).bytes.equals(
          canonicalAttestorValue(intent.publicFiles).bytes) ||
        !canonicalAttestorValue(create.publicDigests).bytes.equals(
          canonicalAttestorValue(intent.publicDigests).bytes)) fail();
    return Object.freeze({ approvedSha256: hash(files.intent),
      invocationId: binding.invocationId, intent, binding, create, createBinding });
  } catch { fail(); }
}
