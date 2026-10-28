import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { buildSearchGenerationManifest, searchGenerationDispatchSpec } from
  '../packages/db/dist/search-generation-manifest.js';
import { createV2IndexBody } from '../packages/search/dist/opensearch-v2-profile.js';
import { assessCreateIndexEvidence, assessCreateIndexCompletionEvidence, buildAttestorPublicFiles,
  canonicalAttestorValue } from './search-attestor-pure.mjs';
import { validateCapturedAttestorPublic,
  validateCapturedAttestorPublicAtTime } from './search-attestor-command-core.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const fail = () => { throw new Error('Private search create intent evidence failed.'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const uuid = value => typeof value === 'string' && UUID.test(value);
const sha = value => typeof value === 'string' && SHA.test(value);

function exactPublicFiles(input) {
  const files = canonicalAttestorValue(input).value;
  if (!Array.isArray(files) || files.length < 4 || files.length > 1_028) fail();
  const base = [
    { path: 'ca.pem', token: 'legacy-v1', role: 'ca', principal: 'station-search-ca', fingerprint: null },
    { path: 'v1/admin.pem', token: 'legacy-v1', role: 'admin', principal: 'station-search-admin', fingerprint: null },
    { path: 'v1/indexer.pem', token: 'legacy-v1', role: 'indexer', principal: 'station-search-indexer', fingerprint: null },
    { path: 'v1/query.pem', token: 'legacy-v1', role: 'query', principal: 'station-search-query', fingerprint: null },
  ];
  if (!canonicalAttestorValue(files.slice(0, 1)).bytes.equals(
    canonicalAttestorValue(base.slice(0, 1)).bytes)) fail();
  const generations = new Map();
  for (const row of files) {
    if (!exact(row, ['path', 'token', 'role', 'principal', 'fingerprint'])) fail();
    if (row.token === 'legacy-v1') continue;
    if (!uuid(row.token) || !['writer', 'query'].includes(row.role) || !sha(row.fingerprint)) fail();
    const suffix = row.token.replaceAll('-', '');
    if (row.path !== `generations/${suffix}/${row.role}.pem` ||
        row.principal !== `station-search-${row.role === 'writer' ? 'indexer' : 'query'}-${suffix}`) fail();
    const generation = generations.get(row.token) ?? { token: row.token, presence: 'exact' };
    if (generation[`${row.role}CertFingerprint`]) fail();
    generation[`${row.role}CertFingerprint`] = row.fingerprint;
    generation[`${row.role}Principal`] = row.principal;
    generations.set(row.token, generation);
  }
  if ([...generations.values()].some(row => !row.writerCertFingerprint || !row.queryCertFingerprint)) fail();
  const wanted = buildAttestorPublicFiles({ generations: [
    { token: 'legacy-v1', presence: 'exact' }, ...generations.values(),
  ] });
  if (!canonicalAttestorValue(files).bytes.equals(canonicalAttestorValue(wanted).bytes)) fail();
  return files;
}

/** Prior-only inventory. Candidate N has no public certificates at this stage. */
export function createPriorPublicFiles(snapshot, candidateToken) {
  try {
    canonicalAttestorValue(snapshot);
    if (!uuid(candidateToken) || !Array.isArray(snapshot?.history)) fail();
    const candidate = snapshot.history.filter(row => row.generationToken === candidateToken);
    if (candidate.length !== 1 || !(candidate[0].lifecycle === 'reserved' &&
        candidate[0].indexUuid === null || candidate[0].lifecycle === 'bound' &&
        typeof candidate[0].indexUuid === 'string')) fail();
    const manifest = buildSearchGenerationManifest(snapshot.history);
    const prior = manifest.filter(row => row.token !== candidateToken);
    if (!prior.some(row => row.token === 'legacy-v1')) fail();
    const files = buildAttestorPublicFiles({ generations: prior.map(row => ({ ...row,
      presence: row.presence === 'absent' ? 'absent' : 'exact' })) });
    return exactPublicFiles(files);
  } catch { fail(); }
}

/** Validate C4e's complete CA/leaf and OpenSSL client-purpose rules before hashing public bytes. */
export async function digestCreatePriorPublic(files, captured, now, scratchRoot, test = {}) {
  try {
    if (test.fixtureFinalNow !== undefined &&
        (process.env.STATION_INTENT_CERT_FIXTURE !== '1' ||
          typeof test.fixtureFinalNow !== 'function')) fail();
    files = exactPublicFiles(files);
    if (Object.getPrototypeOf(captured) !== Map.prototype || captured.size !== files.length ||
        typeof scratchRoot !== 'string' || !path.isAbsolute(scratchRoot) ||
        !scratchRoot.includes('/.cache/')) fail();
    for (const row of files) {
      if (typeof row.path !== 'string' || !captured.has(row.path) ||
          !Buffer.isBuffer(captured.get(row.path)) ||
          captured.get(row.path).length < 100 || captured.get(row.path).length > 16_384) fail();
    }
    await validateCapturedAttestorPublic({ publicFiles: files }, captured, now, scratchRoot);
    validateCapturedAttestorPublicAtTime({ publicFiles: files }, captured,
      test.fixtureFinalNow?.() ?? new Date());
    return files.map(row => ({ path: row.path, sha256: digest(captured.get(row.path)) }));
  } catch { fail(); }
}

/** Exact immutable baseline. Candidate row/dispatch/control are intentionally excluded. */
function priorObservation(snapshot, observed, state, expectation) {
  try {
    canonicalAttestorValue(state);
    canonicalAttestorValue(expectation);
    const phase = expectation?.phase;
    const accepted = ['confirmed', 'bound'].includes(phase) ?
      assessCreateIndexCompletionEvidence(snapshot, observed, expectation).status === 'create-completion-evidence' :
      assessCreateIndexEvidence(snapshot, observed, expectation).status === 'create-evidence';
    if (!accepted ||
        !exact(state, ['phase', 'kind', 'indexUuid']) || state.phase !== 'ready' ||
        state.kind !== 'complete' ||
        state.indexUuid !== snapshot.history.find(row => row.generationToken === 'legacy-v1')?.indexUuid) fail();
    const files = createPriorPublicFiles(snapshot, expectation.candidateToken);
    const priorHistory = snapshot.history.filter(row => row.generationToken !== expectation.candidateToken);
    const priorDispatch = snapshot.dispatch.filter(row => row.generationToken !== expectation.candidateToken);
    const priorTimestamps = {
      history: snapshot.exactTimestamps.history.filter(row => row.generationToken !== expectation.candidateToken),
      dispatch: snapshot.exactTimestamps.dispatch.filter(row => row.generationToken !== expectation.candidateToken),
    };
    const priorIndexes = Object.fromEntries(Object.entries(observed.indexes)
      .filter(([name]) => name !== expectation.candidateIndex));
    const bytes = canonicalAttestorValue({ version: 1, priorHistory, priorDispatch,
      priorTimestamps, priorIndexes, roles: observed.roles, mappings: observed.mappings,
      state }, 2 * 1024 * 1024).bytes;
    return { observationDigest: digest(bytes), files };
  } catch { fail(); }
}

function combinePrior(observationDigest, files, publicDigests) {
  files = exactPublicFiles(files);
  canonicalAttestorValue(publicDigests);
  if (!sha(observationDigest) || !Array.isArray(publicDigests) ||
      publicDigests.length !== files.length ||
      publicDigests.some((row, i) => !exact(row, ['path', 'sha256']) ||
          row.path !== files[i].path || !sha(row.sha256))) fail();
  return digest(canonicalAttestorValue({ version: 1, observationDigest,
    publicFiles: files, publicDigests }).bytes);
}

export function createPriorEvidenceDigest(snapshot, observed, state, expectation, publicDigests) {
  try {
    const { observationDigest, files } = priorObservation(snapshot, observed, state, expectation);
    return combinePrior(observationDigest, files, publicDigests);
  } catch { fail(); }
}

/** Public proposal only. Its own snapshot cannot approve a later send. */
export function makeCreateIntentProjection(snapshot, observed, state) {
  try {
    canonicalAttestorValue(snapshot);
    canonicalAttestorValue(observed, 2 * 1024 * 1024);
    canonicalAttestorValue(state);
    const c = snapshot?.control;
    const source = snapshot.history.find(row => row.generationToken === c?.sourceGenerationToken);
    const candidate = snapshot.history.find(row => row.generationToken === c?.generationToken);
    const expectation = { phase: 'precreate', revision: c.revision, stage: 'disabled_intent',
      transitionToken: c.transitionToken, sourceToken: source.generationToken,
      sourceIndex: source.physicalIndex, candidateToken: candidate.generationToken,
      candidateIndex: candidate.physicalIndex, dispatchId: null, ownerId: null, createdUuid: null };
    const { observationDigest, files } = priorObservation(snapshot, observed, state, expectation);
    const spec = searchGenerationDispatchSpec(candidate, 'create_index');
    return { version: 1, revision: c.revision, stage: 'disabled_intent',
      transitionToken: c.transitionToken, sourceToken: source.generationToken,
      sourceIndex: source.physicalIndex, sourceUuid: source.indexUuid,
      candidateToken: candidate.generationToken, candidateIndex: candidate.physicalIndex,
      databaseOid: snapshot.identity.databaseOid, priorObservationDigest: observationDigest,
      publicFiles: files,
      target: spec.target, bodyIdentity: spec.bodyIdentity };
  } catch { fail(); }
}

/** Seal exact public fields and the complete frozen SDK body, never a supplied body. */
export function sealCreateIntent(projection, publicDigests,
  input) {
  try {
    projection = canonicalAttestorValue(projection).value;
    input = canonicalAttestorValue(input).value;
    if (!exact(input, ['project', 'systemIdentifier', 'dispatchId', 'ownerId'])) fail();
    const { project, systemIdentifier, dispatchId, ownerId } = input;
    if (!exact(projection, ['version', 'revision', 'stage', 'transitionToken', 'sourceToken',
      'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex', 'databaseOid',
      'priorObservationDigest', 'publicFiles', 'target', 'bodyIdentity']) ||
        projection.version !== 1 || projection.stage !== 'disabled_intent' ||
        !Number.isSafeInteger(projection.revision) || projection.revision < 1 ||
        !uuid(projection.transitionToken) || !uuid(projection.candidateToken) ||
        !(projection.sourceToken === 'legacy-v1' || uuid(projection.sourceToken)) ||
        projection.sourceToken === projection.candidateToken ||
        typeof projection.sourceIndex !== 'string' ||
        (projection.sourceToken === 'legacy-v1' ? projection.sourceIndex !== 'station-mail-v1' :
          !/^station-mail-v2-g[a-z0-9]{16,64}$/.test(projection.sourceIndex) ||
          projection.sourceIndex === projection.candidateIndex) ||
        typeof projection.sourceUuid !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(projection.sourceUuid) ||
        typeof projection.candidateIndex !== 'string' ||
        !/^station-mail-v2-g[a-z0-9]{16,64}$/.test(projection.candidateIndex) ||
        projection.candidateIndex === projection.sourceIndex ||
        !Number.isSafeInteger(projection.databaseOid) || projection.databaseOid < 1 ||
        projection.databaseOid > 4_294_967_295 ||
        !sha(projection.priorObservationDigest) || !sha(projection.bodyIdentity) ||
        projection.target !== projection.candidateIndex ||
        typeof project !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(project) ||
        typeof systemIdentifier !== 'string' || !/^[1-9][0-9]{0,19}$/.test(systemIdentifier) ||
        BigInt(systemIdentifier) > 18_446_744_073_709_551_615n ||
        !uuid(dispatchId) || !uuid(ownerId) || dispatchId === ownerId) fail();
    const fixedCandidate = { generationToken: projection.candidateToken,
      physicalIndex: projection.candidateIndex, profileId: 'station-mail-v2',
      indexUuid: null, lifecycle: 'reserved',
      writerRole: `station_indexer_${projection.candidateToken.replaceAll('-', '')}`,
      queryRole: `station_query_${projection.candidateToken.replaceAll('-', '')}`,
      writerPrincipal: `station-search-indexer-${projection.candidateToken.replaceAll('-', '')}`,
      queryPrincipal: `station-search-query-${projection.candidateToken.replaceAll('-', '')}`,
      writerCertFingerprint: null, queryCertFingerprint: null };
    const spec = searchGenerationDispatchSpec(fixedCandidate, 'create_index');
    if (projection.target !== spec.target || projection.bodyIdentity !== spec.bodyIdentity) fail();
    const publicFiles = exactPublicFiles(projection.publicFiles);
    if (publicFiles.some(row => row.token === projection.candidateToken)) fail();
    if (projection.sourceToken !== 'legacy-v1' &&
        !['writer', 'query'].every(role => publicFiles.some(row =>
          row.token === projection.sourceToken && row.role === role))) fail();
    const bodyDigest = digest(canonicalAttestorValue(createV2IndexBody(projection.candidateIndex)).bytes);
    const priorEvidenceDigest = combinePrior(projection.priorObservationDigest,
      projection.publicFiles, publicDigests);
    const intent = { version: 1, ...projection, project, systemIdentifier, dispatchId, ownerId,
      priorEvidenceDigest, publicDigests, bodyDigest };
    const bytes = canonicalAttestorValue(intent).bytes;
    return { intent, sha256: digest(bytes) };
  } catch { fail(); }
}
