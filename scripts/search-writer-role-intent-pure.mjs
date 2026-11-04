import { createHash } from 'node:crypto';
import { buildSearchGenerationManifest, searchGenerationDispatchSpec } from
  '../packages/db/dist/search-generation-manifest.js';
import { buildWriterRoleContract, compareWriterRoleStage } from
  '../packages/search/dist/opensearch-writer-role-contract.js';
import { assessCreateIndexCompletionEvidence, canonicalAttestorValue,
  validatePartialTransitionSnapshot } from './search-attestor-pure.mjs';
import { createPriorEvidenceDigest, createPriorPublicFiles, sealCreateIntent } from
  './search-create-intent-pure.mjs';

const fail = () => { throw Error('Private writer role intent evidence failed.'); };
const issuedProjections = new WeakSet();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = value => createHash('sha256').update(canonicalAttestorValue(value, 2 * 1024 * 1024).bytes).digest('hex');
const same = (a, b) => canonicalAttestorValue(a, 2 * 1024 * 1024).bytes.equals(
  canonicalAttestorValue(b, 2 * 1024 * 1024).bytes);
const exact = (value, keys) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
const microtime = value => typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value);

const createProjectionKeys = ['version', 'revision', 'stage', 'transitionToken',
  'sourceToken', 'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex',
  'databaseOid', 'priorObservationDigest', 'publicFiles', 'target', 'bodyIdentity'];

function originalCreate(evidence) {
  if (!exact(evidence, ['intent', 'binding', 'approvedSha256'])) fail();
  const { intent, binding, approvedSha256 } = evidence;
  const projection = Object.fromEntries(createProjectionKeys.map(key => [key, intent?.[key]]));
  const sealed = sealCreateIntent(projection, intent?.publicDigests,
    { project: intent?.project, systemIdentifier: intent?.systemIdentifier,
      dispatchId: intent?.dispatchId, ownerId: intent?.ownerId });
  if (sealed.sha256 !== approvedSha256 || !same(sealed.intent, intent) ||
      !exact(binding, ['version', 'invocationId', 'approvedSha256', 'dispatchId', 'ownerId']) ||
      binding.version !== 1 || !uuid.test(binding.invocationId) ||
      binding.invocationId === intent.dispatchId || binding.invocationId === intent.ownerId ||
      binding.approvedSha256 !== approvedSha256 || binding.dispatchId !== intent.dispatchId ||
      binding.ownerId !== intent.ownerId) fail();
  return intent;
}

function priorInput(snapshot, candidateToken) {
  const manifest = buildSearchGenerationManifest(snapshot.history);
  return { version: 'station-generation-registry-v1', generations: manifest
    .filter(row => row.token !== candidateToken).map(row => ({ ...row,
      presence: row.presence === 'absent' ? 'absent' : 'exact' })) };
}

function baseline(snapshot, observed, state, publicDigests, evidence, candidateToken) {
  const writerRole = `station_indexer_${candidateToken.replaceAll('-', '')}`;
  const priorRoles = Object.fromEntries(Object.entries(observed.roles)
    .filter(([name]) => name !== writerRole));
  const priorDispatch = snapshot.dispatch.filter(row =>
    !(row.generationToken === candidateToken && row.operation === 'writer_role'));
  const priorSide = snapshot.exactTimestamps.dispatch.filter(row =>
    !(row.generationToken === candidateToken && row.operation === 'writer_role'));
  return hash({ history: hash(snapshot.history),
    historyTimestamps: hash(snapshot.exactTimestamps.history),
    priorDispatch: hash(priorDispatch), priorDispatchTimestamps: hash(priorSide),
    indexes: hash(observed.indexes), roles: hash(priorRoles),
    mappings: hash(observed.mappings), state: hash(state),
    publicDigests: hash(publicDigests), createEvidence: hash(evidence) });
}

function contractFor(snapshot, intent) {
  const candidate = snapshot.history.find(row => row.generationToken === intent.candidateToken);
  if (!candidate || candidate.lifecycle !== 'bound' || candidate.indexUuid !== intent.candidateUuid ||
      candidate.physicalIndex !== intent.candidateIndex ||
      candidate.writerCertFingerprint !== null || candidate.queryCertFingerprint !== null) fail();
  const spec = searchGenerationDispatchSpec(candidate, 'writer_role');
  if (spec.target !== intent.target || spec.bodyIdentity !== intent.bodyIdentity) fail();
  const contract = buildWriterRoleContract(priorInput(snapshot, intent.candidateToken),
    { token: intent.candidateToken, index: intent.candidateIndex, profile: 'station-mail-v2',
      uuid: intent.candidateUuid, writerRole: intent.target }, spec);
  if (contract.bodySha256 !== intent.bodySha256 ||
      contract.dispatchBodyIdentity !== intent.bodyIdentity) fail();
  return contract;
}

function createExpected(intent, revision) {
  return { phase: 'bound', revision, stage: 'uuid_bound',
    transitionToken: intent.transitionToken, sourceToken: intent.sourceToken,
    sourceIndex: intent.sourceIndex, candidateToken: intent.candidateToken,
    candidateIndex: intent.candidateIndex, dispatchId: intent.dispatchId,
    ownerId: intent.ownerId, createdUuid: intent.candidateUuid };
}

const phases = Object.freeze({
  bound: { stage: 'uuid_bound', revision: 0, dispatch: null, role: 'pre', reason: 'transition_in_progress' },
  requested: { stage: 'writer_role_requested', revision: 1, dispatch: null, role: 'pre', reason: 'transition_in_progress' },
  armed: { stage: 'writer_role_requested', revision: 2, dispatch: 'armed', role: 'pre', reason: 'armed' },
  presend: { stage: 'writer_role_requested', revision: 3, dispatch: 'sent_unknown', role: 'pre', reason: 'sent_unknown' },
  postsend: { stage: 'writer_role_requested', revision: 3, dispatch: 'sent_unknown', role: 'post', reason: 'sent_unknown' },
  confirmed: { stage: 'writer_role_requested', revision: 4, dispatch: 'response_confirmed', role: 'post', reason: 'confirmed_awaiting_advance' },
  attested: { stage: 'writer_role_attested', revision: 5, dispatch: 'response_confirmed', role: 'post', reason: 'transition_in_progress' },
});

function roleEvidence(snapshot, observed, state, createEvidence, publicDigests, intent, phase,
  expectedTimestamps) {
  const selected = phases[phase];
  if (!selected) fail();
  const classified = validatePartialTransitionSnapshot(snapshot);
  if (classified.status !== 'incomplete' || classified.reason !== selected.reason) fail();
  const old = originalCreate(createEvidence);
  const control = snapshot.control;
  if (!exact(expectedTimestamps, ['controlUpdatedAt', 'roleCreatedAt']) ||
      !microtime(expectedTimestamps.controlUpdatedAt) ||
      (selected.dispatch === null ? expectedTimestamps.roleCreatedAt !== null :
        !microtime(expectedTimestamps.roleCreatedAt)) ||
      snapshot.exactTimestamps.control.updatedAt !== expectedTimestamps.controlUpdatedAt ||
      (phase === 'bound' && expectedTimestamps.controlUpdatedAt !== intent.boundControlUpdatedAt)) fail();
  if (control.revision !== intent.revision + selected.revision ||
      control.stage !== selected.stage || control.transitionToken !== intent.transitionToken ||
      control.sourceGenerationToken !== intent.sourceToken ||
      control.generationToken !== intent.candidateToken ||
      control.physicalIndex !== intent.candidateIndex ||
      control.indexUuid !== intent.candidateUuid || control.profileId !== 'station-mail-v2' ||
      control.publicationEnabled !== false || control.servingReady !== false ||
      snapshot.identity.databaseOid !== intent.databaseOid ||
      old.revision + 5 !== intent.revision || old.transitionToken !== intent.transitionToken ||
      old.sourceToken !== intent.sourceToken || old.sourceIndex !== intent.sourceIndex ||
      old.sourceUuid !== intent.sourceUuid || old.candidateToken !== intent.candidateToken ||
      old.candidateIndex !== intent.candidateIndex || old.databaseOid !== intent.databaseOid ||
      old.project !== intent.project || old.systemIdentifier !== intent.systemIdentifier ||
      old.priorEvidenceDigest !== intent.priorEvidenceDigest ||
      !same(old.publicFiles, intent.publicFiles) ||
      !same(old.publicDigests, intent.publicDigests) ||
      hash(createEvidence.binding) !== intent.originalCreateBindingSha256 ||
      !same(publicDigests, intent.publicDigests) || !same(state, intent.state)) fail();
  const source = snapshot.history.find(row => row.generationToken === intent.sourceToken);
  if (!source || source.physicalIndex !== intent.sourceIndex ||
      source.indexUuid !== intent.sourceUuid) fail();
  const originalDispatch = snapshot.dispatch.filter(row =>
    row.generationToken === intent.candidateToken && row.operation === 'create_index');
  const candidate = snapshot.history.find(row => row.generationToken === intent.candidateToken);
  const createSpec = searchGenerationDispatchSpec(candidate, 'create_index');
  if (originalDispatch.length !== 1 || originalDispatch[0].dispatchId !== old.dispatchId ||
      originalDispatch[0].ownerId !== old.ownerId ||
      originalDispatch[0].target !== old.target ||
      originalDispatch[0].bodyIdentity !== old.bodyIdentity ||
      originalDispatch[0].target !== createSpec.target ||
      originalDispatch[0].bodyIdentity !== createSpec.bodyIdentity ||
      originalDispatch[0].state !== 'response_confirmed') fail();
  if (!same(createPriorPublicFiles(snapshot, intent.candidateToken), intent.publicFiles)) fail();
  if (baseline(snapshot, observed, state, publicDigests, createEvidence,
    intent.candidateToken) !== intent.baselineDigest) {
    // Only the new role changes after send; index/registry/public baselines do not.
    fail();
  }
  const roleRows = snapshot.dispatch.filter(row => row.generationToken === intent.candidateToken &&
    row.operation === 'writer_role');
  if (selected.dispatch === null ? roleRows.length !== 0 : roleRows.length !== 1) fail();
  if (selected.dispatch !== null) {
    const role = roleRows[0];
    if (role.dispatchId !== intent.dispatchId || role.ownerId !== intent.ownerId ||
        role.target !== intent.target || role.bodyIdentity !== intent.bodyIdentity ||
        role.state !== selected.dispatch ||
        snapshot.exactTimestamps.dispatch.find(row => row.generationToken === intent.candidateToken &&
          row.operation === 'writer_role')?.createdAt !== expectedTimestamps.roleCreatedAt) fail();
  }
  if (compareWriterRoleStage(contractFor(snapshot, intent), observed, selected.role) !== 'exact') fail();
  return Object.freeze({ status: 'writer-role-evidence', phase, ready: false });
}

/** Read-only approval projection at the one original confirmed create boundary. */
export function makeWriterRoleIntentProjection(snapshot, observed, state,
  createEvidence, publicDigests) {
  try {
    canonicalAttestorValue(snapshot);
    canonicalAttestorValue(observed, 2 * 1024 * 1024);
    canonicalAttestorValue(state);
    canonicalAttestorValue(createEvidence);
    canonicalAttestorValue(publicDigests);
    const old = originalCreate(createEvidence);
    const control = snapshot.control;
    const candidate = snapshot.history.find(row => row.generationToken === old.candidateToken);
    if (!candidate || control.revision !== old.revision + 5 ||
        control.stage !== 'uuid_bound' || control.indexUuid !== candidate.indexUuid ||
        !same(publicDigests, old.publicDigests) ||
        createPriorEvidenceDigest(snapshot, observed, state,
          createExpected({ ...old, candidateUuid: candidate.indexUuid }, control.revision),
          publicDigests) !== old.priorEvidenceDigest ||
        assessCreateIndexCompletionEvidence(snapshot, observed,
          createExpected({ ...old, candidateUuid: candidate.indexUuid }, control.revision))
            .status !== 'create-completion-evidence') fail();
    const spec = searchGenerationDispatchSpec(candidate, 'writer_role');
    const contract = buildWriterRoleContract(priorInput(snapshot, old.candidateToken),
      { token: old.candidateToken, index: old.candidateIndex, profile: 'station-mail-v2',
        uuid: candidate.indexUuid, writerRole: candidate.writerRole }, spec);
    if (compareWriterRoleStage(contract, observed, 'pre') !== 'exact') fail();
    const projection = { version: 1, revision: control.revision,
      transitionToken: old.transitionToken, sourceToken: old.sourceToken,
      sourceIndex: old.sourceIndex, sourceUuid: old.sourceUuid,
      candidateToken: old.candidateToken, candidateIndex: old.candidateIndex,
      candidateUuid: candidate.indexUuid, target: spec.target,
      bodyIdentity: spec.bodyIdentity, bodySha256: contract.bodySha256,
      databaseOid: old.databaseOid, project: old.project,
      systemIdentifier: old.systemIdentifier,
      priorEvidenceDigest: old.priorEvidenceDigest,
      publicFiles: old.publicFiles, publicDigests,
      state, createApprovedSha256: createEvidence.approvedSha256,
      originalCreateBindingSha256: hash(createEvidence.binding),
      boundControlUpdatedAt: snapshot.exactTimestamps.control.updatedAt,
      baselineDigest: baseline(snapshot, observed, state, publicDigests,
        createEvidence, old.candidateToken) };
    const issued = freezeTree(canonicalAttestorValue(projection, 256 * 1024).value);
    issuedProjections.add(issued);
    return issued;
  } catch { fail(); }
}

/** Fixed seal; planned IDs are new and distinct from the original create owner. */
export function sealWriterRoleIntent(projection, planned, createEvidence) {
  try {
    const issued = issuedProjections.has(projection);
    const input = canonicalAttestorValue(projection, 256 * 1024).value;
    const ids = canonicalAttestorValue(planned).value;
    createEvidence = canonicalAttestorValue(createEvidence).value;
    if (!issued) fail();
    if (!exact(ids, ['dispatchId', 'ownerId']) || !uuid.test(ids.dispatchId) ||
        !uuid.test(ids.ownerId) || ids.dispatchId === ids.ownerId ||
        !exact(input, ['version', 'revision', 'transitionToken', 'sourceToken',
          'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex',
          'candidateUuid', 'target', 'bodyIdentity', 'bodySha256', 'databaseOid',
          'project', 'systemIdentifier', 'priorEvidenceDigest', 'publicFiles',
          'publicDigests', 'state', 'createApprovedSha256',
          'originalCreateBindingSha256', 'boundControlUpdatedAt',
          'baselineDigest']) ||
        input.version !== 1 || !Number.isSafeInteger(input.revision) ||
        !uuid.test(input.transitionToken) || !uuid.test(input.candidateToken) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.candidateUuid) ||
        !/^[0-9a-f]{64}$/.test(input.bodyIdentity) ||
        !/^[0-9a-f]{64}$/.test(input.bodySha256) ||
        !/^[0-9a-f]{64}$/.test(input.baselineDigest) ||
        !/^[0-9a-f]{64}$/.test(input.createApprovedSha256) ||
        !/^[0-9a-f]{64}$/.test(input.originalCreateBindingSha256)) fail();
    if (!microtime(input.boundControlUpdatedAt)) fail();
    const old = originalCreate(createEvidence);
    if (createEvidence.approvedSha256 !== input.createApprovedSha256 ||
        hash(createEvidence.binding) !== input.originalCreateBindingSha256 ||
        ids.dispatchId === old.dispatchId || ids.dispatchId === old.ownerId ||
        ids.ownerId === old.dispatchId || ids.ownerId === old.ownerId ||
        ids.dispatchId === createEvidence.binding.invocationId ||
        ids.ownerId === createEvidence.binding.invocationId) fail();
    const intent = { ...input, ...ids };
    return { intent, sha256: hash(intent) };
  } catch { fail(); }
}

/** Bounded pure evidence only; acquisition of trusted admin context is external. */
export function assessWriterRoleEvidence(snapshot, observed, state, createEvidence,
  publicDigests, sealed, phase, expectedTimestamps, approvedSha256) {
  try {
    canonicalAttestorValue(snapshot);
    canonicalAttestorValue(observed, 2 * 1024 * 1024);
    canonicalAttestorValue(state);
    canonicalAttestorValue(createEvidence);
    canonicalAttestorValue(publicDigests);
    sealed = canonicalAttestorValue(sealed, 256 * 1024).value;
    expectedTimestamps = canonicalAttestorValue(expectedTimestamps).value;
    if (typeof phase !== 'string' || typeof approvedSha256 !== 'string' ||
        !exact(sealed, ['intent', 'sha256']) ||
        !/^[0-9a-f]{64}$/.test(approvedSha256) ||
        sealed.sha256 !== approvedSha256 || hash(sealed.intent) !== sealed.sha256 ||
        !exact(sealed.intent, ['version', 'revision', 'transitionToken', 'sourceToken',
          'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex', 'candidateUuid',
          'target', 'bodyIdentity', 'bodySha256', 'databaseOid', 'project',
          'systemIdentifier', 'priorEvidenceDigest', 'publicFiles', 'publicDigests',
          'state', 'createApprovedSha256', 'originalCreateBindingSha256',
          'boundControlUpdatedAt', 'baselineDigest',
          'dispatchId', 'ownerId'])) fail();
    return roleEvidence(snapshot, observed, state, createEvidence, publicDigests,
      sealed.intent, phase, expectedTimestamps);
  } catch { return Object.freeze({ status: 'writer-role-evidence-rejected', ready: false }); }
}
