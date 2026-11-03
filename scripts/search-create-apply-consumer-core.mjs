import { createHash } from 'node:crypto';
import { canonicalAttestorValue, assessCreateIndexEvidence,
  assessCreateIndexCompletionEvidence } from './search-attestor-pure.mjs';
import { createPriorEvidenceDigest, sealCreateIntent } from './search-create-intent-pure.mjs';

const fail = () => { throw new Error('Private create apply failed.'); };
const same = (a, b) => canonicalAttestorValue(a, 2 * 1024 * 1024).bytes.equals(
  canonicalAttestorValue(b, 2 * 1024 * 1024).bytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function expectation(intent, control, phase, uuid = null) {
  return { phase, revision: control.revision, stage: control.stage,
    transitionToken: intent.transitionToken, sourceToken: intent.sourceToken,
    sourceIndex: intent.sourceIndex, candidateToken: intent.candidateToken,
    candidateIndex: intent.candidateIndex, dispatchId: phase === 'precreate' &&
      control.stage === 'disabled_intent' ? null : intent.dispatchId,
    ownerId: phase === 'precreate' && control.stage === 'disabled_intent' ? null : intent.ownerId,
    createdUuid: uuid };
}

function successor(before, after, changes) {
  const expected = { ...before, ...changes, revision: before.revision + 1 };
  delete expected.updatedAt;
  const actual = { ...after };
  delete actual.updatedAt;
  if (!same(expected, actual) || after.publicationEnabled !== false ||
      after.servingReady !== false) fail();
  return after;
}

function exactInput(input) {
  const item = canonicalAttestorValue(input, 256 * 1024).value;
  if (!item || Object.keys(item).sort().join('|') !== 'approvedSha256|binding|intent') fail();
  const intent = item.intent, binding = item.binding;
  if (!binding || Object.keys(binding).sort().join('|') !==
      'approvedSha256|dispatchId|invocationId|ownerId|version' || binding.version !== 1 ||
      binding.approvedSha256 !== item.approvedSha256 ||
      binding.dispatchId !== intent.dispatchId || binding.ownerId !== intent.ownerId ||
      binding.invocationId === intent.dispatchId || binding.invocationId === intent.ownerId) fail();
  const projection = Object.fromEntries(['version', 'revision', 'stage', 'transitionToken',
    'sourceToken', 'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex',
    'databaseOid', 'priorObservationDigest', 'publicFiles', 'target', 'bodyIdentity']
    .map(key => [key, intent[key]]));
  const sealed = sealCreateIntent(projection, intent.publicDigests,
    { project: intent.project, systemIdentifier: intent.systemIdentifier,
      dispatchId: intent.dispatchId, ownerId: intent.ownerId });
  if (sealed.sha256 !== item.approvedSha256 || !same(sealed.intent, intent) ||
      sha(canonicalAttestorValue(intent).bytes) !== item.approvedSha256) fail();
  return { intent, binding };
}

/** One live invocation only. The caller supplies fixed readers and fixed CAS operations. */
export async function runCreateApplyConsumer(deps) {
  try {
    const { intent, binding } = exactInput(await deps.readInput());
    // Capture the original mounted admin key and certificates once. A later
    // internally valid replacement must not become this invocation's identity.
    const originalAdmin = await deps.captureAdmin();
    const verify = async (control, phase, uuid = null) => {
      const input = await deps.readInput();
      const next = exactInput(input);
      if (!same(next.intent, intent) || !same(next.binding, binding)) fail();
      const snapshot = await deps.readSnapshot();
      if (!same(snapshot.control, control) || snapshot.identity?.sessionUser !== 'station_search_transition' ||
          snapshot.identity?.currentUser !== 'station_search_transition' ||
          snapshot.identity?.database !== 'station' || snapshot.identity?.databaseOwner !== 'station' ||
          snapshot.identity?.databaseOid !== intent.databaseOid) fail();
      const source = snapshot.history?.find(row => row.generationToken === intent.sourceToken);
      if (!source || source.physicalIndex !== intent.sourceIndex ||
          source.indexUuid !== intent.sourceUuid) fail();
      const state = await deps.readState();
      if (originalAdmin?.public?.caSha256 !== intent.publicDigests.find(x => x.path === 'ca.pem')?.sha256 ||
          originalAdmin?.public?.adminSha256 !== intent.publicDigests.find(x => x.path === 'v1/admin.pem')?.sha256 ||
          !(await originalAdmin.recheck())) fail();
      const publicDigests = await deps.capturePriorPublic(intent.publicFiles);
      if (!same(publicDigests, intent.publicDigests)) fail();
      const observed = await deps.observe();
      const expected = expectation(intent, control, phase, uuid);
      const assessed = ['confirmed', 'bound'].includes(phase) ?
        assessCreateIndexCompletionEvidence(snapshot, observed, expected) :
        assessCreateIndexEvidence(snapshot, observed, expected);
      if (assessed.status !== (['confirmed', 'bound'].includes(phase) ?
        'create-completion-evidence' : 'create-evidence') || assessed.ready !== false ||
        createPriorEvidenceDigest(snapshot, observed, state, expected, publicDigests) !==
          intent.priorEvidenceDigest) fail();
      if (!(await originalAdmin.recheck()) || !(await deps.recheck(snapshot)) ||
          !same(state, await deps.readState()) ||
          !same(input, await deps.readInput())) fail();
      return snapshot;
    };

    let snapshot = await deps.readSnapshot();
    let control = snapshot.control;
    if (control.revision !== intent.revision || control.stage !== 'disabled_intent' ||
        control.transitionToken !== intent.transitionToken ||
        control.sourceGenerationToken !== intent.sourceToken ||
        control.generationToken !== intent.candidateToken ||
        control.physicalIndex !== intent.candidateIndex) fail();
    await verify(control, 'precreate');
    control = successor(control, await deps.advance(control, 'create_requested'),
      { stage: 'create_requested' });
    control = successor(control, await deps.arm(control, { operation: 'create_index',
      dispatchId: intent.dispatchId, ownerId: intent.ownerId,
      target: intent.target, bodyIdentity: intent.bodyIdentity }), {});
    await verify(control, 'precreate');
    control = successor(control, await deps.dispatch(control, { operation: 'create_index',
      dispatchId: intent.dispatchId, ownerId: intent.ownerId, state: 'sent_unknown' }), {});
    await verify(control, 'presend');
    // No retry or adoption path exists after this call. A failure stays sent_unknown.
    if (!(await originalAdmin.recheck())) fail();
    const result = await deps.createOnce(intent.candidateIndex, originalAdmin.recheck);
    if (!result || typeof result.uuid !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(result.uuid)) fail();
    await verify(control, 'postcreate', result.uuid);
    control = successor(control, await deps.dispatch(control, { operation: 'create_index',
      dispatchId: intent.dispatchId, ownerId: intent.ownerId, state: 'response_confirmed' }), {});
    await verify(control, 'confirmed', result.uuid);
    control = successor(control, await deps.advance(control, 'uuid_bound', result.uuid),
      { stage: 'uuid_bound', indexUuid: result.uuid });
    await verify(control, 'bound', result.uuid);
    return Object.freeze({ status: 'uuid_bound', ready: false });
  } catch { fail(); }
}
