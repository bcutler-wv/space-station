import { createHash, X509Certificate } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { searchGenerationDispatchSpec } from '../packages/db/dist/search-generation-manifest.js';
import { buildWriterMappingContract, compareWriterMappingStage } from
  '../packages/search/dist/opensearch-writer-role-contract.js';
import { canonicalAttestorValue, validatePartialTransitionSnapshot } from './search-attestor-pure.mjs';
import { assessWriterRoleEvidence, constructApprovedWriterRoleContract,
  validateOriginalCreateForWriterRole, writerRolePriorInput } from
  './search-writer-role-intent-pure.mjs';

const fail = () => { throw Error('Private writer mapping intent evidence failed.'); };
const issued = new WeakSet();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const micro = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const canonical = (value, cap = 256 * 1024) => canonicalAttestorValue(value, cap).value;
const hash = value => createHash('sha256').update(canonicalAttestorValue(value, 2 * 1024 * 1024).bytes)
  .digest('hex');
const bytesHash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => hash(a) === hash(b);
const exact = (value, keys) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function exactMicro(value) {
  if (typeof value !== 'string' || !micro.test(value)) return false;
  const millis = `${value.slice(0, 23)}Z`;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) && date.toISOString() === millis;
}
function pem(hex) {
  if (typeof hex !== 'string' || hex.length < 200 || hex.length > 32_768 ||
      hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) fail();
  return Buffer.from(hex, 'hex');
}
function publicBinding(publicEvidence, priorDigests, roleIntent, candidateToken) {
  const input = canonical(publicEvidence, 128 * 1024);
  if (!exact(input, ['originalCaPemHex', 'candidateCaPemHex', 'writerPemHex',
    'candidateDigests', 'writerPrincipal', 'writerCertFingerprint']) ||
      !Array.isArray(input.candidateDigests) || input.candidateDigests.length !== 2 ||
      typeof input.writerCertFingerprint !== 'string' ||
      !sha.test(input.writerCertFingerprint)) fail();
  const suffix = candidateToken.replaceAll('-', '');
  const writerPath = `generations/${suffix}/writer.pem`;
  if (input.writerPrincipal !== `station-search-indexer-${suffix}` ||
      !exact(input.candidateDigests[0], ['path', 'sha256']) ||
      !exact(input.candidateDigests[1], ['path', 'sha256']) ||
      input.candidateDigests[0].path !== 'ca.pem' ||
      input.candidateDigests[1].path !== writerPath) fail();
  const oldCa = pem(input.originalCaPemHex);
  const newCa = pem(input.candidateCaPemHex);
  const writer = pem(input.writerPemHex);
  const certificate = new X509Certificate(writer);
  const caHash = bytesHash(oldCa);
  const writerHash = bytesHash(writer);
  if (certificate.subject !== `CN=${input.writerPrincipal}` ||
      certificate.fingerprint256.replaceAll(':', '').toLowerCase() !==
        input.writerCertFingerprint ||
      !oldCa.equals(newCa) || input.candidateDigests[0].sha256 !== caHash ||
      input.candidateDigests[1].sha256 !== writerHash ||
      !Array.isArray(priorDigests) ||
      priorDigests.find(row => row.path === 'ca.pem')?.sha256 !== caHash ||
      roleIntent.publicDigests.find(row => row.path === 'ca.pem')?.sha256 !== caHash) fail();
  return freeze({ caSha256: caHash, writerSha256: writerHash,
    writerFingerprint: input.writerCertFingerprint,
    writerPrincipal: input.writerPrincipal, publicDigests: input.candidateDigests });
}
function mappingContract(snapshot, intent) {
  const candidate = snapshot.history.find(row => row.generationToken === intent.candidateToken);
  if (!candidate || candidate.lifecycle !== 'bound' ||
      candidate.indexUuid !== intent.candidateUuid ||
      candidate.physicalIndex !== intent.candidateIndex ||
      candidate.writerCertFingerprint !== null || candidate.queryCertFingerprint !== null ||
      candidate.writerPrincipal !== intent.candidatePublic.writerPrincipal) fail();
  const role = searchGenerationDispatchSpec(candidate, 'writer_role');
  const mapping = searchGenerationDispatchSpec(candidate, 'writer_mapping');
  if (mapping.target !== intent.target || mapping.bodyIdentity !== intent.bodyIdentity) fail();
  const contract = buildWriterMappingContract(writerRolePriorInput(snapshot, intent.candidateToken),
    { token: intent.candidateToken, index: intent.candidateIndex, profile: 'station-mail-v2',
      uuid: intent.candidateUuid, writerRole: intent.target,
      writerPrincipal: intent.candidatePublic.writerPrincipal }, role, mapping);
  if (contract.bodySha256 !== intent.bodySha256 ||
      contract.dispatchBodyIdentity !== intent.bodyIdentity) fail();
  return contract;
}
function originalRole(roleEvidence, createEvidence, snapshot, observed, state, priorDigests) {
  if (!exact(roleEvidence, ['intent', 'binding', 'approvedSha256']) ||
      typeof roleEvidence.approvedSha256 !== 'string' ||
      !sha.test(roleEvidence.approvedSha256) ||
      hash(roleEvidence.intent) !== roleEvidence.approvedSha256 ||
      !exact(roleEvidence.binding,
        ['version', 'invocationId', 'approvedSha256', 'dispatchId', 'ownerId']) ||
      roleEvidence.binding.version !== 1 ||
      roleEvidence.binding.approvedSha256 !== roleEvidence.approvedSha256 ||
      roleEvidence.binding.dispatchId !== roleEvidence.intent.dispatchId ||
      roleEvidence.binding.ownerId !== roleEvidence.intent.ownerId ||
      typeof roleEvidence.binding.invocationId !== 'string' ||
      !uuid.test(roleEvidence.binding.invocationId)) fail();
  const originalIds = [createEvidence.intent.dispatchId, createEvidence.intent.ownerId,
    createEvidence.binding.invocationId, roleEvidence.intent.dispatchId,
    roleEvidence.intent.ownerId, roleEvidence.binding.invocationId];
  if (new Set(originalIds).size !== 6) fail();
  const side = snapshot.exactTimestamps.dispatch.find(row =>
    row.generationToken === roleEvidence.intent.candidateToken && row.operation === 'writer_role');
  const expectedTimestamps = { controlUpdatedAt: snapshot.exactTimestamps.control.updatedAt,
    roleCreatedAt: side?.createdAt };
  const result = assessWriterRoleEvidence(snapshot, observed, state, createEvidence,
    priorDigests, { intent: roleEvidence.intent, sha256: roleEvidence.approvedSha256 },
    'attested', expectedTimestamps, roleEvidence.approvedSha256);
  if (result.status !== 'writer-role-evidence' || result.phase !== 'attested' ||
      result.ready !== false) fail();
  return originalIds;
}
function originalDispatchLinks(snapshot, createEvidence, roleEvidence, intent) {
  validateOriginalCreateForWriterRole(createEvidence);
  constructApprovedWriterRoleContract(snapshot,
    { intent: roleEvidence.intent, sha256: roleEvidence.approvedSha256 },
    roleEvidence.approvedSha256);
  const create = createEvidence.intent;
  const role = roleEvidence.intent;
  for (const field of ['transitionToken', 'sourceToken', 'sourceIndex', 'sourceUuid',
    'candidateToken', 'candidateIndex', 'databaseOid', 'project',
    'systemIdentifier']) {
    if (create[field] !== role[field] || role[field] !== intent[field]) fail();
  }
  if (create.revision + 5 !== role.revision || role.revision + 5 !== intent.revision ||
      role.candidateUuid !== intent.candidateUuid ||
      role.createApprovedSha256 !== createEvidence.approvedSha256 ||
      role.originalCreateBindingSha256 !== hash(createEvidence.binding) ||
      role.priorEvidenceDigest !== create.priorEvidenceDigest ||
      !same(role.publicFiles, create.publicFiles) ||
      !same(role.publicDigests, create.publicDigests)) fail();
  const source = snapshot.history.find(row => row.generationToken === intent.sourceToken);
  if (!source || source.physicalIndex !== intent.sourceIndex ||
      source.indexUuid !== intent.sourceUuid) fail();
  const candidate = snapshot.history.find(row => row.generationToken === intent.candidateToken);
  if (!candidate || createEvidence.intent.candidateToken !== intent.candidateToken ||
      roleEvidence.intent.candidateToken !== intent.candidateToken ||
      createEvidence.intent.sourceUuid !== intent.sourceUuid ||
      roleEvidence.intent.sourceUuid !== intent.sourceUuid ||
      createEvidence.intent.candidateIndex !== intent.candidateIndex ||
      roleEvidence.intent.candidateIndex !== intent.candidateIndex ||
      roleEvidence.intent.candidateUuid !== intent.candidateUuid ||
      createEvidence.binding.approvedSha256 !== createEvidence.approvedSha256 ||
      createEvidence.binding.dispatchId !== createEvidence.intent.dispatchId ||
      createEvidence.binding.ownerId !== createEvidence.intent.ownerId ||
      roleEvidence.binding.approvedSha256 !== roleEvidence.approvedSha256 ||
      roleEvidence.binding.dispatchId !== roleEvidence.intent.dispatchId ||
      roleEvidence.binding.ownerId !== roleEvidence.intent.ownerId) fail();
  for (const [operation, approved] of [
    ['create_index', createEvidence.intent], ['writer_role', roleEvidence.intent]]) {
    const rows = snapshot.dispatch.filter(row =>
      row.generationToken === intent.candidateToken && row.operation === operation);
    const spec = searchGenerationDispatchSpec(candidate, operation);
    if (rows.length !== 1 || rows[0].dispatchId !== approved.dispatchId ||
        rows[0].ownerId !== approved.ownerId || rows[0].target !== approved.target ||
        rows[0].bodyIdentity !== approved.bodyIdentity ||
        rows[0].target !== spec.target || rows[0].bodyIdentity !== spec.bodyIdentity ||
        rows[0].state !== 'response_confirmed') fail();
  }
}
const phases = Object.freeze({
  attested: { stage: 'writer_role_attested', offset: 0, dispatch: null, mapping: 'pre', reason: 'transition_in_progress' },
  requested: { stage: 'writer_mapping_requested', offset: 1, dispatch: null, mapping: 'pre', reason: 'transition_in_progress' },
  armed: { stage: 'writer_mapping_requested', offset: 2, dispatch: 'armed', mapping: 'pre', reason: 'armed' },
  presend: { stage: 'writer_mapping_requested', offset: 3, dispatch: 'sent_unknown', mapping: 'pre', reason: 'sent_unknown' },
  postsend: { stage: 'writer_mapping_requested', offset: 3, dispatch: 'sent_unknown', mapping: 'post', reason: 'sent_unknown' },
  confirmed: { stage: 'writer_mapping_requested', offset: 4, dispatch: 'response_confirmed', mapping: 'post', reason: 'confirmed_awaiting_advance' },
  writerAttested: { stage: 'writer_attested', offset: 5, dispatch: 'response_confirmed', mapping: 'post', reason: 'transition_in_progress' },
});

/** Consistency-only pure projection from the original completed writer role. */
export function makeWriterMappingIntentProjection(snapshot, observed, state, createEvidence,
  roleEvidence, priorDigests, publicEvidence) {
  try {
    canonicalAttestorValue(snapshot, 2 * 1024 * 1024);
    canonicalAttestorValue(observed, 2 * 1024 * 1024);
    canonicalAttestorValue(state);
    createEvidence = canonical(createEvidence);
    roleEvidence = canonical(roleEvidence);
    priorDigests = canonical(priorDigests);
    const control = snapshot.control;
    const originalIds = originalRole(roleEvidence, createEvidence, snapshot,
      observed, state, priorDigests);
    const role = roleEvidence.intent;
    const candidate = snapshot.history.find(row => row.generationToken === role.candidateToken);
    const publicLink = publicBinding(publicEvidence, priorDigests, role, role.candidateToken);
    if (control.stage !== 'writer_role_attested' || control.revision !== role.revision + 5 ||
        control.indexUuid !== role.candidateUuid ||
        candidate?.writerCertFingerprint !== null || candidate?.queryCertFingerprint !== null ||
        publicLink.writerPrincipal !== candidate.writerPrincipal) fail();
    const mapping = searchGenerationDispatchSpec(candidate, 'writer_mapping');
    const contract = buildWriterMappingContract(writerRolePriorInput(snapshot, role.candidateToken),
      { token: role.candidateToken, index: role.candidateIndex, profile: 'station-mail-v2',
        uuid: role.candidateUuid, writerRole: candidate.writerRole,
        writerPrincipal: candidate.writerPrincipal },
      searchGenerationDispatchSpec(candidate, 'writer_role'), mapping);
    if (compareWriterMappingStage(contract, observed, 'pre') !== 'exact') fail();
    const projection = { version: 1, revision: control.revision,
      transitionToken: role.transitionToken, sourceToken: role.sourceToken,
      sourceIndex: role.sourceIndex, sourceUuid: role.sourceUuid,
      candidateToken: role.candidateToken, candidateIndex: role.candidateIndex,
      candidateUuid: role.candidateUuid, databaseOid: role.databaseOid,
      project: role.project, systemIdentifier: role.systemIdentifier,
      target: mapping.target, bodyIdentity: mapping.bodyIdentity,
      bodySha256: contract.bodySha256, state: canonical(state),
      priorPublicDigests: priorDigests, candidatePublic: publicLink,
      createApprovedSha256: createEvidence.approvedSha256,
      originalCreateBindingSha256: hash(createEvidence.binding),
      roleApprovedSha256: roleEvidence.approvedSha256,
      originalRoleBindingSha256: hash(roleEvidence.binding),
      originalIds, boundControlUpdatedAt: snapshot.exactTimestamps.control.updatedAt,
      originalHistoryDigest: hash(snapshot.history),
      originalHistoryTimesDigest: hash(snapshot.exactTimestamps.history),
      originalDispatchDigest: hash(snapshot.dispatch),
      originalDispatchTimesDigest: hash(snapshot.exactTimestamps.dispatch),
      originalIndexesDigest: hash(observed.indexes),
      originalRolesDigest: hash(observed.roles),
      originalMappingsDigest: hash(observed.mappings) };
    const result = freeze(canonical(projection, 256 * 1024));
    issued.add(result);
    return result;
  } catch { fail(); }
}

/** Planned mapping IDs are fresh; the SHA is not an operator approval. */
export function sealWriterMappingIntent(projection, planned) {
  try {
    const branded = issued.has(projection);
    const input = canonical(projection);
    const ids = canonical(planned);
    if (!branded || !exact(ids, ['dispatchId', 'ownerId']) ||
        typeof ids.dispatchId !== 'string' || typeof ids.ownerId !== 'string' ||
        !uuid.test(ids.dispatchId) || !uuid.test(ids.ownerId) ||
        ids.dispatchId === ids.ownerId || input.originalIds.includes(ids.dispatchId) ||
        input.originalIds.includes(ids.ownerId)) fail();
    const intent = freeze({ ...input, ...ids });
    return Object.freeze({ intent, sha256: hash(intent) });
  } catch { fail(); }
}

/** Pure phase comparison only; acquisition and the approved SHA are external. */
export function assessWriterMappingEvidence(snapshot, observed, state, createEvidence,
  roleEvidence, priorDigests, publicEvidence, sealed, phase, expectedTimestamps,
  approvedSha256) {
  try {
    canonicalAttestorValue(snapshot, 2 * 1024 * 1024);
    canonicalAttestorValue(observed, 2 * 1024 * 1024);
    state = canonical(state);
    createEvidence = canonical(createEvidence);
    roleEvidence = canonical(roleEvidence);
    priorDigests = canonical(priorDigests);
    publicEvidence = canonical(publicEvidence, 128 * 1024);
    sealed = canonical(sealed);
    expectedTimestamps = canonical(expectedTimestamps);
    if (typeof phase !== 'string' || !Object.hasOwn(phases, phase)) fail();
    const selected = phases[phase];
    if (!selected || typeof approvedSha256 !== 'string' || !sha.test(approvedSha256) ||
        !exact(sealed, ['intent', 'sha256']) || sealed.sha256 !== approvedSha256 ||
        hash(sealed.intent) !== approvedSha256 ||
        !exact(expectedTimestamps, ['controlUpdatedAt', 'mappingCreatedAt']) ||
        !exactMicro(expectedTimestamps.controlUpdatedAt) ||
        (selected.dispatch === null ? expectedTimestamps.mappingCreatedAt !== null :
          !exactMicro(expectedTimestamps.mappingCreatedAt))) fail();
    const intent = sealed.intent;
    if (!exact(intent, ['version', 'revision', 'transitionToken', 'sourceToken',
      'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex', 'candidateUuid',
      'databaseOid', 'project', 'systemIdentifier', 'target', 'bodyIdentity',
      'bodySha256', 'state', 'priorPublicDigests', 'candidatePublic',
      'createApprovedSha256', 'originalCreateBindingSha256', 'roleApprovedSha256',
      'originalRoleBindingSha256', 'originalIds', 'boundControlUpdatedAt',
      'originalHistoryDigest', 'originalHistoryTimesDigest', 'originalDispatchDigest',
      'originalDispatchTimesDigest', 'originalIndexesDigest', 'originalRolesDigest',
      'originalMappingsDigest', 'dispatchId', 'ownerId']) ||
        !Number.isSafeInteger(intent.revision) || intent.version !== 1 ||
        !Array.isArray(intent.originalIds) || intent.originalIds.length !== 6 ||
        ![intent.bodySha256, intent.bodyIdentity, intent.originalHistoryDigest,
          intent.originalHistoryTimesDigest, intent.originalDispatchDigest,
          intent.originalDispatchTimesDigest, intent.originalIndexesDigest,
          intent.originalRolesDigest, intent.originalMappingsDigest]
          .every(value => typeof value === 'string' && sha.test(value)) ||
        !same(state, intent.state) || !same(priorDigests, intent.priorPublicDigests) ||
        !same(publicBinding(publicEvidence, priorDigests, roleEvidence.intent,
          intent.candidateToken), intent.candidatePublic) ||
        createEvidence.approvedSha256 !== intent.createApprovedSha256 ||
        hash(createEvidence.intent) !== createEvidence.approvedSha256 ||
        hash(createEvidence.binding) !== intent.originalCreateBindingSha256 ||
        roleEvidence.approvedSha256 !== intent.roleApprovedSha256 ||
        hash(roleEvidence.intent) !== roleEvidence.approvedSha256 ||
        hash(roleEvidence.binding) !== intent.originalRoleBindingSha256 ||
        !same([createEvidence.intent.dispatchId, createEvidence.intent.ownerId,
          createEvidence.binding.invocationId, roleEvidence.intent.dispatchId,
          roleEvidence.intent.ownerId, roleEvidence.binding.invocationId], intent.originalIds) ||
        new Set([...intent.originalIds, intent.dispatchId, intent.ownerId]).size !== 8) fail();
    const classified = validatePartialTransitionSnapshot(snapshot);
    if (classified.status !== 'incomplete' || classified.reason !== selected.reason) fail();
    const control = snapshot.control;
    if (control.revision !== intent.revision + selected.offset ||
        control.stage !== selected.stage || control.transitionToken !== intent.transitionToken ||
        control.sourceGenerationToken !== intent.sourceToken ||
        control.generationToken !== intent.candidateToken ||
        control.physicalIndex !== intent.candidateIndex ||
        control.indexUuid !== intent.candidateUuid || control.profileId !== 'station-mail-v2' ||
        control.publicationEnabled !== false || control.servingReady !== false ||
        snapshot.identity.databaseOid !== intent.databaseOid ||
        snapshot.exactTimestamps.control.updatedAt !== expectedTimestamps.controlUpdatedAt ||
        (phase === 'attested' && expectedTimestamps.controlUpdatedAt !== intent.boundControlUpdatedAt) ||
        hash(snapshot.history) !== intent.originalHistoryDigest ||
        hash(snapshot.exactTimestamps.history) !== intent.originalHistoryTimesDigest) fail();
    const originalDispatch = snapshot.dispatch.filter(row =>
      !(row.generationToken === intent.candidateToken && row.operation === 'writer_mapping'));
    const originalTimes = snapshot.exactTimestamps.dispatch.filter(row =>
      !(row.generationToken === intent.candidateToken && row.operation === 'writer_mapping'));
    if (hash(originalDispatch) !== intent.originalDispatchDigest ||
        hash(originalTimes) !== intent.originalDispatchTimesDigest) fail();
    originalDispatchLinks(snapshot, createEvidence, roleEvidence, intent);
    const originalMappings = Object.fromEntries(Object.entries(observed.mappings)
      .filter(([name]) => name !== intent.target));
    if (hash(observed.indexes) !== intent.originalIndexesDigest ||
        hash(observed.roles) !== intent.originalRolesDigest ||
        hash(originalMappings) !== intent.originalMappingsDigest) fail();
    const mappingRows = snapshot.dispatch.filter(row =>
      row.generationToken === intent.candidateToken && row.operation === 'writer_mapping');
    if (selected.dispatch === null ? mappingRows.length !== 0 : mappingRows.length !== 1) fail();
    if (selected.dispatch !== null) {
      const row = mappingRows[0];
      const time = snapshot.exactTimestamps.dispatch.find(item =>
        item.generationToken === intent.candidateToken && item.operation === 'writer_mapping');
      if (row.dispatchId !== intent.dispatchId || row.ownerId !== intent.ownerId ||
          row.target !== intent.target || row.bodyIdentity !== intent.bodyIdentity ||
          row.state !== selected.dispatch || time?.createdAt !== expectedTimestamps.mappingCreatedAt) fail();
    }
    if (compareWriterMappingStage(mappingContract(snapshot, intent), observed,
      selected.mapping) !== 'exact') fail();
    return Object.freeze({ status: 'writer-mapping-evidence', phase, ready: false });
  } catch { return Object.freeze({ status: 'writer-mapping-evidence-rejected', ready: false }); }
}
