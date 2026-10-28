/* global structuredClone */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { classifySearchGenerationRegistry } from '../../packages/db/dist/search-generation-oracle.js';
import { assessCreateIndexCompletionEvidence, assessCreateIndexEvidence,
  buildAttestorPublicFiles, canonicalAttestorValue,
  makePreparedAttestorManifest } from '../../scripts/search-attestor-pure.mjs';
import { validateCapturedAttestorPublicAtTime } from '../../scripts/search-attestor-command-core.mjs';
import { createPriorPublicFiles, digestCreatePriorPublic, createPriorEvidenceDigest,
  makeCreateIntentProjection, sealCreateIntent } from '../../scripts/search-create-intent-pure.mjs';
import { runCreateIntentPrepare } from '../../scripts/search-create-intent-prepare-core.mjs';
import { captureCreateIntentAdminVolume } from '../../scripts/search-create-intent-admin-volume.mjs';
import { captureCreateIntentPublic } from '../../scripts/search-create-intent-public.mjs';

const token = '11111111-1111-4111-8111-111111111111';
const transitionToken = '22222222-2222-4222-8222-222222222222';
const dispatchId = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const index = `station-mail-v2-g${token.replaceAll('-', '')}`;
const micro = '2026-10-22T18:00:00.123456Z';
const instant = () => new Date('2026-10-22T18:00:00.123Z');
const legacy = () => ({ generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1',
  profileId: 'station-mail-v1', indexUuid: 'legacy_uuid', lifecycle: 'roles_attested',
  writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
  writerCertFingerprint: null, queryCertFingerprint: null, createdAt: instant() });
const candidate = () => ({ generationToken: token, physicalIndex: index,
  profileId: 'station-mail-v2', indexUuid: null, lifecycle: 'reserved',
  writerRole: `station_indexer_${token.replaceAll('-', '')}`,
  queryRole: `station_query_${token.replaceAll('-', '')}`,
  writerPrincipal: `station-search-indexer-${token.replaceAll('-', '')}`,
  queryPrincipal: `station-search-query-${token.replaceAll('-', '')}`,
  writerCertFingerprint: null, queryCertFingerprint: null, createdAt: instant() });
function fixture(stage = 'disabled_intent') {
  const history = [legacy(), candidate()];
  const dispatch = stage === 'disabled_intent' ? [] : [{ generationToken: token, operation: 'create_index',
    dispatchId, ownerId, ...searchGenerationDispatchSpec(history[1], 'create_index'),
    state: stage === 'sent_unknown' ? 'sent_unknown' : 'response_confirmed', createdAt: instant() }];
  if (stage === 'uuid_bound') { history[1].lifecycle = 'bound'; history[1].indexUuid = 'created_uuid'; }
  const control = { singleton: 1, revision: stage === 'disabled_intent' ? 2 : stage === 'uuid_bound' ? 6 : 5,
    stage: stage === 'disabled_intent' ? stage : stage === 'uuid_bound' ? stage : 'create_requested',
    transitionToken, sourceGenerationToken: 'legacy-v1', generationToken: token,
    physicalIndex: index, indexUuid: stage === 'uuid_bound' ? 'created_uuid' : null,
    profileId: 'station-mail-v2', publicationEnabled: false, servingReady: false, updatedAt: instant() };
  return { control, history, dispatch,
    identity: { sessionUser: 'station_search_transition', currentUser: 'station_search_transition',
      database: 'station', databaseOid: 16384, databaseOwner: 'station' },
    exactTimestamps: { control: { singleton: 1, updatedAt: micro },
      history: history.map(row => ({ generationToken: row.generationToken, createdAt: micro })),
      dispatch: dispatch.map(row => ({ generationToken: row.generationToken,
        operation: row.operation, dispatchId: row.dispatchId, createdAt: micro })) } };
}
function observed(created = false) {
  const indexes = { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
      refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
      replication: { type: 'DOCUMENT' }, uuid: 'legacy_uuid', creation_date: '1760000000000',
      provided_name: 'station-mail-v1', version: { created: '13927900' } } } } };
  if (created) indexes[index] = { aliases: {}, mappings: createV2IndexBody(index).mappings,
    settings: { index: { ...structuredClone(indexes['station-mail-v1'].settings.index), uuid: 'created_uuid',
      provided_name: index } } };
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
    generations: [{ token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
      presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
      writerPrincipal: null, queryPrincipal: null, writerCertFingerprint: null,
      queryCertFingerprint: null }] });
  return { indexes, roles: policy.roles, mappings: policy.mappings };
}
const state = { phase: 'ready', kind: 'complete', indexUuid: 'legacy_uuid' };
const expected = (stage, phase) => ({ phase, revision: stage === 'disabled_intent' ? 2 : stage === 'uuid_bound' ? 6 : 5,
  stage: stage === 'disabled_intent' ? stage : stage === 'uuid_bound' ? stage : 'create_requested',
  transitionToken, sourceToken: 'legacy-v1', sourceIndex: 'station-mail-v1',
  candidateToken: token, candidateIndex: index, dispatchId: stage === 'disabled_intent' ? null : dispatchId,
  ownerId: stage === 'disabled_intent' ? null : ownerId,
  createdUuid: phase === 'precreate' ? null : 'created_uuid' });

test('projection seals complete prior evidence and frozen body, excluding mutable N/dispatch fields', () => {
  const s = fixture(), o = observed(), files = createPriorPublicFiles(s, token);
  const publicDigests = files.map(row => ({ path: row.path, sha256: 'a'.repeat(64) }));
  const projection = makeCreateIntentProjection(s, o, state);
  assert.deepEqual(projection.publicFiles, files);
  const sealed = sealCreateIntent(projection, publicDigests,
    { project: 'stationfixture', systemIdentifier: '123', dispatchId, ownerId });
  assert.match(sealed.sha256, /^[0-9a-f]{64}$/);
  assert.match(sealed.intent.bodyDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(sealed.intent.bodyDigest, sealed.intent.bodyIdentity);
  const candidatePublicFiles = buildAttestorPublicFiles({ generations: [
    { token: 'legacy-v1', presence: 'exact' },
    { token, presence: 'exact', writerPrincipal: `station-search-indexer-${token.replaceAll('-', '')}`,
      queryPrincipal: `station-search-query-${token.replaceAll('-', '')}`,
      writerCertFingerprint: 'b'.repeat(64), queryCertFingerprint: 'c'.repeat(64) },
  ] });
  assert.throws(() => sealCreateIntent({ ...projection, publicFiles: candidatePublicFiles },
    candidatePublicFiles.map(row => ({ path: row.path, sha256: 'a'.repeat(64) })),
    { project: 'stationfixture', systemIdentifier: '123', dispatchId, ownerId }));
  const alternateIndex = 'station-mail-v2-gdifferentvalidname1234';
  const alternateCandidate = { ...candidate(), physicalIndex: alternateIndex };
  const alternateProjection = { ...projection, candidateIndex: alternateIndex,
    ...searchGenerationDispatchSpec(alternateCandidate, 'create_index') };
  assert.equal(sealCreateIntent(alternateProjection, publicDigests,
    { project: 'stationfixture', systemIdentifier: '123', dispatchId, ownerId }).intent.candidateIndex,
  alternateIndex);
  const alternateReservation = fixture();
  alternateReservation.history[1].physicalIndex = alternateIndex;
  alternateReservation.control.physicalIndex = alternateIndex;
  const derivedAlternate = makeCreateIntentProjection(alternateReservation, o, state);
  assert.equal(derivedAlternate.candidateIndex, alternateIndex);
  assert.equal(sealCreateIntent(derivedAlternate, publicDigests,
    { project: 'stationfixture', systemIdentifier: '123', dispatchId, ownerId }).intent.candidateIndex,
  alternateIndex);
  for (const malformed of [
    { ...projection, candidateToken: [token] },
    { ...projection, bodyIdentity: '0'.repeat(64) },
    { ...projection, sourceIndex: index },
    { ...projection, sourceToken: token },
    { ...projection, publicFiles: [...projection.publicFiles, {
      path: '/arbitrary', token: 'legacy-v1', role: 'ca', principal: 'wrong', fingerprint: null }] },
    { ...projection, sourceUuid: ['legacy_uuid'] },
  ]) assert.throws(() => sealCreateIntent(malformed, publicDigests,
    { project: 'stationfixture', systemIdentifier: '123', dispatchId, ownerId }));
  const getter = Object.defineProperty({ ...projection }, 'revision', { get() { return 2; }, enumerable: true });
  assert.throws(() => sealCreateIntent(getter, publicDigests,
    { project: 'stationfixture', systemIdentifier: '123', dispatchId, ownerId }));
  assert.throws(() => sealCreateIntent(projection, publicDigests,
    { project: ['stationfixture'], systemIdentifier: '123', dispatchId, ownerId }));
  const snapshotGetter = Object.defineProperty({ ...s }, 'control',
    { get() { throw new Error('getter executed'); }, enumerable: true });
  assert.throws(() => makeCreateIntentProjection(snapshotGetter, o, state),
    { message: 'Private search create intent evidence failed.' });
  const expectationGetter = Object.defineProperty({ ...expected('disabled_intent', 'precreate') },
    'phase', { get() { throw new Error('getter executed'); }, enumerable: true });
  assert.throws(() => createPriorEvidenceDigest(s, o, state, expectationGetter, publicDigests),
    { message: 'Private search create intent evidence failed.' });
  let stateReads = 0;
  const stateGetter = Object.defineProperty({ ...state }, 'phase',
    { get() { stateReads++; return 'ready'; }, enumerable: true });
  assert.throws(() => createPriorEvidenceDigest(s, o, stateGetter,
    expected('disabled_intent', 'precreate'), publicDigests),
  { message: 'Private search create intent evidence failed.' });
  assert.equal(stateReads, 0);
  assert.equal(sealed.intent.priorEvidenceDigest,
    createPriorEvidenceDigest(s, o, state, expected('disabled_intent', 'precreate'), publicDigests));
  for (const [stage, phase] of [['sent_unknown', 'postcreate'],
    ['response_confirmed', 'confirmed'], ['uuid_bound', 'bound']]) {
    const later = fixture(stage), view = observed(true), expectation = expected(stage, phase);
    if (stage === 'sent_unknown') assert.equal(assessCreateIndexEvidence(later, view, expectation).status, 'create-evidence');
    if (stage !== 'sent_unknown') assert.deepEqual(assessCreateIndexCompletionEvidence(later, view, expectation),
      { status: 'create-completion-evidence', phase, ready: false });
    if (stage !== 'sent_unknown') assert.deepEqual(assessCreateIndexEvidence(later, view, expectation),
      { status: 'create-evidence-rejected', ready: false });
    assert.equal(createPriorEvidenceDigest(later, view, state, expectation, publicDigests),
      sealed.intent.priorEvidenceDigest);
    assert.equal(classifySearchGenerationRegistry({ control: later.control,
      history: later.history, dispatch: later.dispatch }).status, 'incomplete');
  }
  for (const stage of ['disabled_intent', 'sent_unknown', 'response_confirmed', 'uuid_bound']) {
    const verifier = fixture(stage);
    verifier.identity.sessionUser = 'station_search_verifier';
    verifier.identity.currentUser = 'station_search_verifier';
    assert.throws(() => makePreparedAttestorManifest(verifier, dispatchId));
  }
  const abandonedToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const abandoned = { ...candidate(), generationToken: abandonedToken,
    physicalIndex: `station-mail-v2-g${abandonedToken.replaceAll('-', '')}`,
    writerRole: `station_indexer_${abandonedToken.replaceAll('-', '')}`,
    queryRole: `station_query_${abandonedToken.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${abandonedToken.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${abandonedToken.replaceAll('-', '')}`,
    lifecycle: 'abandoned' };
  const withAbandoned = structuredClone(s);
  withAbandoned.history.push(abandoned);
  withAbandoned.exactTimestamps.history.push({ generationToken: abandonedToken, createdAt: micro });
  assert.deepEqual(createPriorPublicFiles(withAbandoned, token), files);
  assert.notEqual(createPriorEvidenceDigest(withAbandoned, o, state,
    expected('disabled_intent', 'precreate'), publicDigests), sealed.intent.priorEvidenceDigest);
});

test('prior drift, public bytes and wrong completion ownership reject', () => {
  const s = fixture(), o = observed(), files = createPriorPublicFiles(s, token);
  const publicDigests = files.map(row => ({ path: row.path, sha256: 'a'.repeat(64) }));
  const baseline = createPriorEvidenceDigest(s, o, state, expected('disabled_intent', 'precreate'), publicDigests);
  const changed = structuredClone(s);
  changed.history[0].indexUuid = 'changed';
  assert.throws(() => createPriorEvidenceDigest(changed, o, state,
    expected('disabled_intent', 'precreate'), publicDigests));
  const laterTimestamp = structuredClone(s);
  laterTimestamp.history[0].createdAt = new Date('2026-10-22T18:00:01.123Z');
  laterTimestamp.exactTimestamps.history[0].createdAt = '2026-10-22T18:00:01.123456Z';
  assert.notEqual(createPriorEvidenceDigest(laterTimestamp, o, state,
    expected('disabled_intent', 'precreate'), publicDigests), baseline);
  const changedPublic = structuredClone(publicDigests); changedPublic[0].sha256 = 'b'.repeat(64);
  assert.notEqual(createPriorEvidenceDigest(s, o, state,
    expected('disabled_intent', 'precreate'), changedPublic), baseline);
  const changedEngine = structuredClone(o); changedEngine.roles.station_query.cluster_permissions = [];
  assert.throws(() => createPriorEvidenceDigest(s, changedEngine, state,
    expected('disabled_intent', 'precreate'), publicDigests));
  const later = fixture('response_confirmed'), view = observed(true), e = expected('response_confirmed', 'confirmed');
  for (const mutate of [
    value => { value.dispatch[0].ownerId = '55555555-5555-4555-8555-555555555555'; },
    value => { value.dispatch[0].state = 'quiesced'; },
    value => { value.control.servingReady = true; },
  ]) { const changed = structuredClone(later); mutate(changed);
    assert.deepEqual(assessCreateIndexCompletionEvidence(changed, view, e),
      { status: 'create-completion-evidence-rejected', ready: false }); }
});

test('retained and registered prior v2 history and public inventory stay in the seal', () => {
  const s = fixture(), o = observed();
  const olderToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const olderIndex = `station-mail-v2-g${olderToken.replaceAll('-', '')}`;
  const older = { ...candidate(), generationToken: olderToken, physicalIndex: olderIndex,
    indexUuid: 'older_uuid', lifecycle: 'roles_attested',
    writerRole: `station_indexer_${olderToken.replaceAll('-', '')}`,
    queryRole: `station_query_${olderToken.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${olderToken.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${olderToken.replaceAll('-', '')}`,
    writerCertFingerprint: 'a'.repeat(64), queryCertFingerprint: 'b'.repeat(64) };
  s.history[0].lifecycle = 'retired_retained';
  s.history.splice(1, 0, older);
  s.exactTimestamps.history.splice(1, 0, { generationToken: olderToken, createdAt: micro });
  s.control.sourceGenerationToken = olderToken;
  for (let i = 0; i < 5; i++) {
    const operation = ['create_index', 'writer_role', 'writer_mapping', 'query_role', 'query_mapping'][i];
    const row = { generationToken: olderToken, operation,
      dispatchId: `55555555-5555-4555-8555-${String(i + 1).padStart(12, '0')}`,
      ownerId, ...searchGenerationDispatchSpec(older, operation),
      state: 'response_confirmed', createdAt: instant() };
    s.dispatch.push(row);
    s.exactTimestamps.dispatch.push({ generationToken: olderToken, operation,
      dispatchId: row.dispatchId, createdAt: micro });
  }
  o.indexes[olderIndex] = { aliases: {}, mappings: createV2IndexBody(olderIndex).mappings,
    settings: { index: { ...structuredClone(o.indexes['station-mail-v1'].settings.index),
      uuid: 'older_uuid', provided_name: olderIndex } } };
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
    generations: [
      { token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
        presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
        writerPrincipal: null, queryPrincipal: null, writerCertFingerprint: null,
        queryCertFingerprint: null },
      { token: olderToken, index: olderIndex, profile: 'station-mail-v2',
        presence: 'exact', uuid: 'older_uuid', writerRole: older.writerRole,
        queryRole: older.queryRole, writerPrincipal: older.writerPrincipal,
        queryPrincipal: older.queryPrincipal, writerCertFingerprint: older.writerCertFingerprint,
        queryCertFingerprint: older.queryCertFingerprint },
    ] });
  o.roles = policy.roles; o.mappings = policy.mappings;
  const e = { ...expected('disabled_intent', 'precreate'), sourceToken: olderToken,
    sourceIndex: olderIndex };
  const files = createPriorPublicFiles(s, token);
  assert.deepEqual(files.map(row => row.path), ['ca.pem',
    `generations/${olderToken.replaceAll('-', '')}/query.pem`,
    `generations/${olderToken.replaceAll('-', '')}/writer.pem`,
    'v1/admin.pem', 'v1/indexer.pem', 'v1/query.pem']);
  const publicDigests = files.map(row => ({ path: row.path, sha256: 'c'.repeat(64) }));
  const baseline = createPriorEvidenceDigest(s, o, state, e, publicDigests);
  const projection = makeCreateIntentProjection(s, o, state);
  assert.equal(projection.sourceToken, olderToken);
  assert.equal(sealCreateIntent(projection, publicDigests,
    { project: 'stationfixture', systemIdentifier: '123', dispatchId, ownerId }).intent.sourceIndex,
  olderIndex);
  assert.throws(() => sealCreateIntent({ ...projection, sourceToken: transitionToken }, publicDigests,
    { project: 'stationfixture', systemIdentifier: '123', dispatchId, ownerId }));
  const changed = structuredClone(s);
  changed.history[1].writerCertFingerprint = 'd'.repeat(64);
  assert.notEqual(createPriorEvidenceDigest(changed, o, state, e, publicDigests), baseline);
  const changedDispatch = structuredClone(s);
  changedDispatch.dispatch[0].ownerId = '66666666-6666-4666-8666-666666666666';
  assert.notEqual(createPriorEvidenceDigest(changedDispatch, o, state, e, publicDigests), baseline);
});

test('C4e certificate validator accepts captured public set and rejects altered leaf', async t => {
  await import('node:fs/promises').then(fs => fs.mkdir(path.resolve('.cache/results'), { recursive: true }));
  const root = await mkdtemp(path.resolve('.cache/results/search-create-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.resolve('scripts/init-search-security.mjs')],
    { cwd: root, stdio: 'ignore', timeout: 30_000 });
  const files = createPriorPublicFiles(fixture(), token);
  const source = name => path.join(root, '.cache/search-security',
    name === 'ca.pem' ? name : path.basename(name));
  const captured = new Map(await Promise.all(files.map(async row => [row.path, await readFile(source(row.path))])));
  const scratch = path.join(root, '.cache/search-create-intent');
  await mkdir(scratch, { mode: 0o700 });
  const hostCapture = await captureCreateIntentPublic({ repository: root,
    uid: process.getuid(), gid: process.getgid(), files, scratchRoot: scratch });
  assert.equal(await hostCapture.recheck(), true);
  const adminVolume = path.join(root, 'admin-volume');
  await mkdir(adminVolume, { mode: 0o700 });
  for (const name of ['ca.pem', 'admin.pem', 'admin.key'])
    await copyFile(path.join(root, '.cache/search-security', name), path.join(adminVolume, name));
  const adminCapture = await captureCreateIntentAdminVolume(adminVolume,
    { uid: process.getuid(), gid: process.getgid(), dirMode: 0o700, fileMode: 0o600 }, root);
  const adminProof = adminCapture.public;
  assert.match(adminProof.caSha256, /^[0-9a-f]{64}$/);
  assert.match(adminProof.adminSha256, /^[0-9a-f]{64}$/);
  assert.equal(hostCapture.publicDigests.find(row => row.path === 'ca.pem').sha256, adminProof.caSha256);
  assert.equal(hostCapture.publicDigests.find(row => row.path === 'v1/admin.pem').sha256,
    adminProof.adminSha256);
  process.env.STATION_INTENT_CERT_FIXTURE = '1';
  try {
    await assert.rejects(() => digestCreatePriorPublic(files, captured, new Date(), scratch,
      { fixtureFinalNow: () => new Date('2200-01-01') }),
    { message: 'Private search create intent evidence failed.' });
    await assert.rejects(() => captureCreateIntentAdminVolume(adminVolume,
      { uid: process.getuid(), gid: process.getgid(), dirMode: 0o700, fileMode: 0o600 }, root,
      { fixtureFinalNow: () => new Date('2200-01-01') }),
    { message: 'Private create intent admin identity failed.' });
  } finally { delete process.env.STATION_INTENT_CERT_FIXTURE; }
  await copyFile(path.join(root, '.cache/search-security/query.key'), path.join(adminVolume, 'admin.key'));
  await assert.rejects(() => adminCapture.recheck(),
  { message: 'Private create intent admin identity failed.' });
  const hashes = await digestCreatePriorPublic(files, captured, new Date(), root);
  assert.equal(hashes.length, 4);
  await assert.rejects(() => digestCreatePriorPublic(files, captured, new Date()),
    { message: 'Private search create intent evidence failed.' });
  const altered = new Map(captured);
  altered.set('v1/admin.pem', captured.get('v1/query.pem'));
  await assert.rejects(() => digestCreatePriorPublic(files, altered, new Date(), root),
    { message: 'Private search create intent evidence failed.' });
  const missing = new Map(captured);
  missing.delete('v1/admin.pem');
  await assert.rejects(() => digestCreatePriorPublic(files, missing, new Date(), root),
    { message: 'Private search create intent evidence failed.' });
  await assert.rejects(() => digestCreatePriorPublic(files, captured, new Date('2200-01-01'), root),
    { message: 'Private search create intent evidence failed.' });
  const fingerprintMismatch = files.map(row => row.path === 'v1/admin.pem' ?
    { ...row, fingerprint: '0'.repeat(64) } : row);
  assert.throws(() => validateCapturedAttestorPublicAtTime(
    { publicFiles: fingerprintMismatch }, captured, new Date()));
});

test('fixed prepare consumer returns only bounded canonical projection after read-only rechecks', async () => {
  const snapshot = fixture(), view = observed(), invocation = { version: 1,
    invocationId: ownerId, project: 'fixture', databaseOid: '16384', owner: 'station',
    systemIdentifier: '123' };
  let snapshotReads = 0, observerReads = 0, stateReads = 0, markerReads = 0;
  const deps = { readInvocation: async () => { markerReads++; return structuredClone(invocation); },
    readState: async () => { stateReads++; return structuredClone(state); },
    captureAdminPublic: async () => ({ public: { caSha256: 'a'.repeat(64),
      adminSha256: 'b'.repeat(64) }, recheck: async () => true }),
    readSnapshot: async () => { snapshotReads++; return structuredClone(snapshot); },
    recheck: async () => true,
    observe: async () => { observerReads++; return structuredClone(view); } };
  const output = await runCreateIntentPrepare(deps);
  assert.equal(output, `${canonicalAttestorValue(JSON.parse(output)).bytes.toString('utf8')}\n`);
  assert.deepEqual(JSON.parse(output).projection, makeCreateIntentProjection(snapshot, view, state));
  assert.deepEqual(JSON.parse(output).adminPublic,
    { caSha256: 'a'.repeat(64), adminSha256: 'b'.repeat(64) });
  assert.equal(output.includes('password'), false);
  assert.equal(output.includes('pem'), true); // Public file path specifications only.
  assert.deepEqual([snapshotReads, observerReads, stateReads, markerReads], [1, 2, 3, 3]);
  await assert.rejects(() => runCreateIntentPrepare({ ...deps,
    observe: async () => { observerReads++; return observerReads % 2 ? structuredClone(view) :
      { ...structuredClone(view), roles: {} }; } }),
  { message: 'Private create intent preparation failed.' });
  await assert.rejects(() => runCreateIntentPrepare({ ...deps,
    recheck: async () => false }), { message: 'Private create intent preparation failed.' });
});
