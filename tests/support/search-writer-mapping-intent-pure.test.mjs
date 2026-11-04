/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { deriveWriterRoleRequest, buildWriterMappingContract } from
  '../../packages/search/dist/opensearch-writer-role-contract.js';
import { makeCreateIntentProjection, sealCreateIntent, createPriorPublicFiles } from
  '../../scripts/search-create-intent-pure.mjs';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { makeWriterRoleIntentProjection, sealWriterRoleIntent,
  writerRolePriorInput } from '../../scripts/search-writer-role-intent-pure.mjs';
import { makeWriterMappingIntentProjection, sealWriterMappingIntent,
  assessWriterMappingEvidence } from '../../scripts/search-writer-mapping-intent-pure.mjs';

const token = '11111111-1111-4111-8111-111111111111';
const transition = '22222222-2222-4222-8222-222222222222';
const ids = ['33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '77777777-7777-4777-8777-777777777777',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '88888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
const micro = '2026-10-22T18:00:00.123456Z';
const date = () => new Date('2026-10-22T18:00:00.123Z');
const index = `station-mail-v2-g${token.replaceAll('-', '')}`;
const roleName = `station_indexer_${token.replaceAll('-', '')}`;
const principal = `station-search-indexer-${token.replaceAll('-', '')}`;
const state = { phase: 'ready', kind: 'complete', indexUuid: 'legacy_uuid' };
const sha = value => createHash('sha256').update(value).digest('hex');
const publicCa = Buffer.from('-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(140) +
  '\n-----END CERTIFICATE-----\n');
const publicWriter = readFileSync(new URL('../fixtures/writer-mapping-pure-public.pem', import.meta.url));
const expected = phase => ({ status: 'writer-mapping-evidence', phase, ready: false });
const rejected = { status: 'writer-mapping-evidence-rejected', ready: false };
const successor = (snapshotValue, second) => {
  snapshotValue.control.updatedAt = new Date(`2026-10-22T18:00:${String(second).padStart(2, '0')}.123Z`);
  snapshotValue.exactTimestamps.control.updatedAt =
    `2026-10-22T18:00:${String(second).padStart(2, '0')}.123456Z`;
  return snapshotValue.exactTimestamps.control.updatedAt;
};
const legacy = () => ({ generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1',
  profileId: 'station-mail-v1', indexUuid: 'legacy_uuid', lifecycle: 'roles_attested',
  writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
  writerCertFingerprint: null, queryCertFingerprint: null, createdAt: date() });
const candidate = bound => ({ generationToken: token, physicalIndex: index,
  profileId: 'station-mail-v2', indexUuid: bound ? 'created_uuid' : null,
  lifecycle: bound ? 'bound' : 'reserved', writerRole: roleName,
  queryRole: `station_query_${token.replaceAll('-', '')}`,
  writerPrincipal: principal,
  queryPrincipal: `station-search-query-${token.replaceAll('-', '')}`,
  writerCertFingerprint: null, queryCertFingerprint: null, createdAt: date() });
function snapshot(bound) {
  const history = [legacy(), candidate(bound)];
  const dispatch = bound ? [{ generationToken: token, operation: 'create_index',
    dispatchId: ids[0], ownerId: ids[1],
    ...searchGenerationDispatchSpec(history[1], 'create_index'),
    state: 'response_confirmed', createdAt: date() }] : [];
  return { control: { singleton: 1, revision: bound ? 7 : 2,
    stage: bound ? 'uuid_bound' : 'disabled_intent', transitionToken: transition,
    sourceGenerationToken: 'legacy-v1', generationToken: token,
    physicalIndex: index, indexUuid: bound ? 'created_uuid' : null,
    profileId: 'station-mail-v2', publicationEnabled: false,
    servingReady: false, updatedAt: date() }, history, dispatch,
  identity: { sessionUser: 'station_search_transition', currentUser: 'station_search_transition',
    database: 'station', databaseOid: 16384, databaseOwner: 'station' },
  exactTimestamps: { control: { singleton: 1, updatedAt: micro },
    history: history.map(row => ({ generationToken: row.generationToken, createdAt: micro })),
    dispatch: dispatch.map(row => ({ generationToken: row.generationToken,
      operation: row.operation, dispatchId: row.dispatchId, createdAt: micro })) } };
}
function observed(bound, roleBody, mappingBody, retained = null) {
  const indexes = { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
      refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
      replication: { type: 'DOCUMENT' }, uuid: 'legacy_uuid', creation_date: '1760000000000',
      provided_name: 'station-mail-v1', version: { created: '13927900' } } } } };
  if (bound) indexes[index] = { aliases: {}, mappings: createV2IndexBody(index).mappings,
    settings: { index: { ...structuredClone(indexes['station-mail-v1'].settings.index),
      uuid: 'created_uuid', provided_name: index } } };
  if (retained) indexes[retained.physicalIndex] = { aliases: {},
    mappings: createV2IndexBody(retained.physicalIndex).mappings,
    settings: { index: { ...structuredClone(indexes['station-mail-v1'].settings.index),
      uuid: retained.indexUuid, provided_name: retained.physicalIndex } } };
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
    generations: [{ token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
      presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
      writerPrincipal: null, queryPrincipal: null, writerCertFingerprint: null,
      queryCertFingerprint: null }, ...(retained ? [{ token: retained.generationToken,
        index: retained.physicalIndex, profile: 'station-mail-v2', presence: 'exact',
        uuid: retained.indexUuid, writerRole: retained.writerRole,
        queryRole: retained.queryRole, writerPrincipal: retained.writerPrincipal,
        queryPrincipal: retained.queryPrincipal,
        writerCertFingerprint: retained.writerCertFingerprint,
        queryCertFingerprint: retained.queryCertFingerprint }] : [])] });
  return { indexes, roles: roleBody ? { ...policy.roles, [roleName]: roleBody } : policy.roles,
    mappings: mappingBody ? { ...policy.mappings, [roleName]: mappingBody } : policy.mappings };
}
export function fixture({ absent = false, retainedSource = false,
  caPem = publicCa, writerPem = publicWriter } = {}) {
  const initial = snapshot(false), bound = snapshot(true);
  let retained = null;
  if (retainedSource) {
    const suffix = 'cccccccccccc4ccc8ccccccccccccccc';
    retained = { generationToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      physicalIndex: `station-mail-v2-g${suffix}`, profileId: 'station-mail-v2',
      indexUuid: 'retained_uuid', lifecycle: 'roles_attested',
      writerRole: `station_indexer_${suffix}`, queryRole: `station_query_${suffix}`,
      writerPrincipal: `station-search-indexer-${suffix}`,
      queryPrincipal: `station-search-query-${suffix}`,
      writerCertFingerprint: 'c'.repeat(64), queryCertFingerprint: 'd'.repeat(64),
      createdAt: date() };
    for (const s of [initial, bound]) {
      s.history.push(structuredClone(retained));
      s.exactTimestamps.history.push({ generationToken: retained.generationToken,
        createdAt: micro });
      s.control.sourceGenerationToken = retained.generationToken;
      for (const [i, operation] of ['create_index', 'writer_role', 'writer_mapping',
        'query_role', 'query_mapping'].entries()) {
        const dispatchId = `b0000000-0000-4000-8000-00000000000${i + 1}`;
        s.dispatch.push({ generationToken: retained.generationToken, operation,
          dispatchId, ownerId: `c0000000-0000-4000-8000-00000000000${i + 1}`,
          ...searchGenerationDispatchSpec(retained, operation),
          state: 'response_confirmed', createdAt: date() });
        s.exactTimestamps.dispatch.push({ generationToken: retained.generationToken,
          operation, dispatchId, createdAt: micro });
      }
    }
  }
  if (absent) {
    const suffix = 'bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb';
    const row = { generationToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      physicalIndex: `station-mail-v2-g${suffix}`, profileId: 'station-mail-v2',
      indexUuid: null, lifecycle: 'abandoned', writerRole: `station_indexer_${suffix}`,
      queryRole: `station_query_${suffix}`,
      writerPrincipal: `station-search-indexer-${suffix}`,
      queryPrincipal: `station-search-query-${suffix}`,
      writerCertFingerprint: null, queryCertFingerprint: null, createdAt: date() };
    for (const s of [initial, bound]) {
      s.history.push(structuredClone(row));
      s.exactTimestamps.history.push({ generationToken: row.generationToken, createdAt: micro });
    }
  }
  const initialView = observed(false, null, null, retained);
  const preRole = observed(true, null, null, retained);
  const priorDigests = createPriorPublicFiles(initial, token).map(row =>
    ({ path: row.path, sha256: row.path === 'ca.pem' ? sha(caPem) : 'a'.repeat(64) }));
  const create = sealCreateIntent(makeCreateIntentProjection(initial, initialView, state),
    priorDigests, { project: 'stationfixture', systemIdentifier: '123',
      dispatchId: ids[0], ownerId: ids[1] });
  const createEvidence = { intent: create.intent, approvedSha256: create.sha256,
    binding: { version: 1, invocationId: ids[2], approvedSha256: create.sha256,
      dispatchId: ids[0], ownerId: ids[1] } };
  const roleProjection = makeWriterRoleIntentProjection(bound, preRole, state,
    createEvidence, priorDigests);
  const roleSeal = sealWriterRoleIntent(roleProjection,
    { dispatchId: ids[3], ownerId: ids[4] }, createEvidence);
  const roleEvidence = { intent: roleSeal.intent, approvedSha256: roleSeal.sha256,
    binding: { version: 1, invocationId: ids[5], approvedSha256: roleSeal.sha256,
      dispatchId: ids[3], ownerId: ids[4] } };
  const roleBody = deriveWriterRoleRequest({ token, index, profile: 'station-mail-v2',
    uuid: 'created_uuid', writerRole: roleName }).body;
  const attested = structuredClone(bound);
  attested.control.stage = 'writer_role_attested'; attested.control.revision = 12;
  attested.dispatch.push({ generationToken: token, operation: 'writer_role',
    dispatchId: ids[3], ownerId: ids[4],
    ...searchGenerationDispatchSpec(attested.history[1], 'writer_role'),
    state: 'response_confirmed', createdAt: date() });
  attested.exactTimestamps.dispatch.push({ generationToken: token, operation: 'writer_role',
    dispatchId: ids[3], createdAt: micro });
  const pre = observed(true, roleBody, null, retained);
  const publicEvidence = { originalCaPemHex: caPem.toString('hex'),
    candidateCaPemHex: caPem.toString('hex'), writerPemHex: writerPem.toString('hex'),
    candidateDigests: [{ path: 'ca.pem', sha256: sha(caPem) },
      { path: `generations/${token.replaceAll('-', '')}/writer.pem`,
        sha256: sha(writerPem) }],
    writerPrincipal: principal, writerCertFingerprint: new X509Certificate(writerPem)
      .fingerprint256.replaceAll(':', '').toLowerCase() };
  const projection = makeWriterMappingIntentProjection(attested, pre, state,
    createEvidence, roleEvidence, priorDigests, publicEvidence);
  const sealed = sealWriterMappingIntent(projection,
    { dispatchId: ids[6], ownerId: ids[7] });
  const contract = buildWriterMappingContract(writerRolePriorInput(attested, token),
    { token, index, profile: 'station-mail-v2', uuid: 'created_uuid',
      writerRole: roleName, writerPrincipal: principal },
    searchGenerationDispatchSpec(attested.history[1], 'writer_role'),
    searchGenerationDispatchSpec(attested.history[1], 'writer_mapping'));
  const post = observed(true, roleBody, contract.body, retained);
  return { attested, pre, post, state, createEvidence, roleEvidence,
    priorDigests, publicEvidence, projection, sealed, contract };
}
const check = (f, snapshot, observedValue, phase, createdAt = null, overrides = {}) =>
  assessWriterMappingEvidence(snapshot, observedValue, overrides.state ?? f.state,
    overrides.createEvidence ?? f.createEvidence,
    overrides.roleEvidence ?? f.roleEvidence,
    overrides.priorDigests ?? f.priorDigests,
    overrides.publicEvidence ?? f.publicEvidence,
    overrides.sealed ?? f.sealed, phase,
    overrides.times ?? { controlUpdatedAt: micro, mappingCreatedAt: createdAt },
    overrides.approvedSha256 ?? f.sealed.sha256);

function walkAllPhases(f) {
  assert.notEqual(f.projection.bodySha256, f.projection.bodyIdentity);
  assert.deepEqual(check(f, f.attested, f.pre, 'attested'), expected('attested'));
  const next = structuredClone(f.attested);
  next.control.stage = 'writer_mapping_requested'; next.control.revision = 13;
  let controlTime = successor(next, 1);
  assert.deepEqual(check(f, next, f.pre, 'requested', null,
    { times: { controlUpdatedAt: controlTime, mappingCreatedAt: null } }), expected('requested'));
  next.dispatch.push({ generationToken: token, operation: 'writer_mapping',
    dispatchId: ids[6], ownerId: ids[7], target: f.projection.target,
    bodyIdentity: f.projection.bodyIdentity, state: 'armed', createdAt: date() });
  next.exactTimestamps.dispatch.push({ generationToken: token, operation: 'writer_mapping',
    dispatchId: ids[6], createdAt: micro });
  next.control.revision = 14;
  controlTime = successor(next, 2);
  assert.deepEqual(check(f, next, f.pre, 'armed', micro,
    { times: { controlUpdatedAt: controlTime, mappingCreatedAt: micro } }), expected('armed'));
  assert.deepEqual(check(f, next, f.pre, 'armed', micro,
    { times: { controlUpdatedAt: '2026-10-22T18:00:02.123457Z',
      mappingCreatedAt: micro } }), rejected);
  const mappingRow = next.dispatch.find(row =>
    row.generationToken === token && row.operation === 'writer_mapping');
  mappingRow.state = 'sent_unknown'; next.control.revision = 15;
  controlTime = successor(next, 3);
  const sentTimes = { controlUpdatedAt: controlTime, mappingCreatedAt: micro };
  assert.deepEqual(check(f, next, f.pre, 'presend', micro,
    { times: sentTimes }), expected('presend'));
  assert.deepEqual(check(f, next, f.post, 'postsend', micro,
    { times: sentTimes }), expected('postsend'));
  mappingRow.state = 'response_confirmed'; next.control.revision = 16;
  controlTime = successor(next, 4);
  assert.deepEqual(check(f, next, f.post, 'confirmed', micro,
    { times: { controlUpdatedAt: controlTime, mappingCreatedAt: micro } }), expected('confirmed'));
  next.control.stage = 'writer_attested'; next.control.revision = 17;
  controlTime = successor(next, 5);
  const finalTimes = { controlUpdatedAt: controlTime, mappingCreatedAt: micro };
  assert.deepEqual(check(f, next, f.post, 'writerAttested', micro,
    { times: finalTimes }), expected('writerAttested'));
  assert.deepEqual(check(f, next, f.pre, 'writerAttested', micro,
    { times: finalTimes }), rejected);
  return { next, finalTimes };
}

test('original confirmed role issues a distinct mapping body and seven never-ready phases', () => {
  walkAllPhases(fixture());
});

test('prior operations, public evidence, role and mapping cannot drift', () => {
  const f = fixture();
  for (const change of [
    s => { s.history[0].indexUuid = 'changed'; },
    s => { s.history[1].writerCertFingerprint = 'b'.repeat(64); },
    s => { s.exactTimestamps.history[0].createdAt = '2026-10-22T18:00:00.123457Z'; },
    s => { s.dispatch[0].ownerId = ids[7]; },
    s => { s.dispatch[1].state = 'sent_unknown'; },
    s => { s.exactTimestamps.dispatch[1].createdAt = '2026-10-22T18:00:00.123457Z'; },
    s => { s.control.revision++; },
    s => { s.control.publicationEnabled = true; },
  ]) { const s = structuredClone(f.attested); change(s);
    assert.deepEqual(check(f, s, f.pre, 'attested'), rejected); }
  for (const change of [
    p => { p.candidateCaPemHex = Buffer.from('different').toString('hex'); },
    p => { p.writerPemHex = Buffer.from('different').toString('hex'); },
    p => { p.writerPrincipal = 'wrong'; },
    p => { p.writerCertFingerprint = 'a'.repeat(64); },
  ]) { const p = structuredClone(f.publicEvidence); change(p);
    assert.deepEqual(check(f, f.attested, f.pre, 'attested', null,
      { publicEvidence: p }), rejected); }
  for (const change of [
    e => { e.binding.invocationId = ids[7]; },
    e => { e.intent.bodySha256 = '0'.repeat(64); },
  ]) { const e = structuredClone(f.roleEvidence); change(e);
    assert.deepEqual(check(f, f.attested, f.pre, 'attested', null,
      { roleEvidence: e }), rejected); }
  for (const change of [
    o => { o.indexes[index].settings.index.uuid = 'wrong'; },
    o => { o.indexes[index].settings.index.creation_date = '1760000000001'; },
    o => { o.roles[roleName].cluster_permissions.push('cluster:admin/*'); },
    o => { o.mappings[roleName] = f.contract.body; },
    o => { o.roles.hidden_extra = {}; },
  ]) { const o = structuredClone(f.pre); change(o);
    assert.deepEqual(check(f, f.attested, o, 'attested'), rejected); }
  assert.deepEqual(check(f, f.attested, f.pre, 'attested', null,
    { times: { controlUpdatedAt: '2026-10-22T18:00:00.123457Z',
      mappingCreatedAt: null } }), rejected);
  assert.deepEqual(check(f, f.attested, f.pre, 'attested', null,
    { approvedSha256: '0'.repeat(64) }), rejected);
});

test('abandoned prior generation remains absent throughout the mapping proposal', () => {
  const f = fixture({ absent: true });
  assert.deepEqual(check(f, f.attested, f.pre, 'attested'), expected('attested'));
  const absent = f.attested.history.at(-1);
  for (const mutate of [
    o => { o.indexes[absent.physicalIndex] = structuredClone(o.indexes[index]); },
    o => { o.roles[absent.writerRole] = {}; },
    o => { o.mappings[absent.writerRole] = {}; },
  ]) { const value = structuredClone(f.pre); mutate(value);
    assert.deepEqual(check(f, f.attested, value, 'attested'), rejected); }
});

test('retained-v2 source stays exact while its candidate mapping is proposed', () => {
  const f = fixture({ retainedSource: true });
  assert.equal(f.projection.sourceToken, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(f.projection.sourceUuid, 'retained_uuid');
  assert.deepEqual(check(f, f.attested, f.pre, 'attested'), expected('attested'));
  const changed = structuredClone(f.pre);
  changed.indexes[f.projection.sourceIndex].settings.index.uuid = 'changed';
  assert.deepEqual(check(f, f.attested, changed, 'attested'), rejected);
});

test('retained source and absent history remain exact through all seven mapping phases', () => {
  const f = fixture({ retainedSource: true, absent: true });
  const { next, finalTimes } = walkAllPhases(f);
  const absent = f.attested.history.find(row => row.lifecycle === 'abandoned');
  for (const mutate of [
    o => { o.indexes[absent.physicalIndex] = structuredClone(o.indexes[index]); },
    o => { o.roles[absent.writerRole] = {}; },
    o => { o.mappings[absent.writerRole] = {}; },
  ]) { const drift = structuredClone(f.post); mutate(drift);
    assert.deepEqual(check(f, next, drift, 'writerAttested', micro,
      { times: finalTimes }), rejected); }
  const retained = f.attested.history.find(row => row.generationToken === f.projection.sourceToken);
  const changed = structuredClone(f.post);
  changed.indexes[retained.physicalIndex].settings.index.creation_date = '1760000000001';
  assert.deepEqual(check(f, next, changed, 'writerAttested', micro,
    { times: finalTimes }), rejected);
});

test('projection provenance and descriptor validation reject forged authority', () => {
  const f = fixture();
  assert.equal(Object.isFrozen(f.projection), true);
  assert.equal(Object.isFrozen(f.projection.candidatePublic.publicDigests[0]), true);
  assert.throws(() => sealWriterMappingIntent(structuredClone(f.projection),
    { dispatchId: ids[6], ownerId: ids[7] }));
  assert.throws(() => sealWriterMappingIntent(f.projection,
    { dispatchId: ids[3], ownerId: ids[7] }));
  let calls = 0;
  const hostile = { ...f.publicEvidence };
  Object.defineProperty(hostile, 'writerPrincipal', { enumerable: true,
    get() { calls++; throw Error('secret'); } });
  assert.throws(() => makeWriterMappingIntentProjection(f.attested, f.pre, f.state,
    f.createEvidence, f.roleEvidence, f.priorDigests, hostile),
  { message: 'Private writer mapping intent evidence failed.' });
  assert.equal(calls, 0);
  assert.throws(() => makeWriterMappingIntentProjection(f.attested, f.pre, f.state,
    f.createEvidence, f.roleEvidence, f.priorDigests,
    { ...f.publicEvidence, writerCertFingerprint: '0'.repeat(64) }),
  { message: 'Private writer mapping intent evidence failed.' });
  const forged = structuredClone(f.sealed);
  const changed = structuredClone(f.attested);
  changed.dispatch[0].ownerId = ids[7];
  forged.intent.originalDispatchDigest = sha(canonicalAttestorValue(changed.dispatch).bytes);
  forged.sha256 = sha(canonicalAttestorValue(forged.intent).bytes);
  assert.deepEqual(check(f, changed, f.pre, 'attested', null,
    { sealed: forged, approvedSha256: forged.sha256 }), rejected);
  for (const mutate of [
    intent => { intent.project = 'otherproject'; },
    intent => { intent.systemIdentifier = 'different'; },
    intent => { intent.sourceIndex = 'different'; },
    intent => { intent.sourceUuid = 'different'; },
    intent => { intent.databaseOid++; },
    intent => { intent.revision++; },
  ]) {
    const changedSeal = structuredClone(f.sealed);
    mutate(changedSeal.intent);
    changedSeal.sha256 = sha(canonicalAttestorValue(changedSeal.intent).bytes);
    assert.deepEqual(check(f, f.attested, f.pre, 'attested', null,
      { sealed: changedSeal, approvedSha256: changedSeal.sha256 }), rejected);
  }
});

test('non-string phase cannot coerce into attested or skip its exact microtime fence', () => {
  const f = fixture();
  const changed = structuredClone(f.attested);
  changed.exactTimestamps.control.updatedAt = '2026-10-22T18:00:00.123457Z';
  let calls = 0;
  const forgedPhase = { [Symbol.toPrimitive]() { calls++; return 'attested'; },
    toString() { calls++; return 'attested'; } };
  assert.deepEqual(check(f, changed, f.pre, forgedPhase, null,
    { times: { controlUpdatedAt: changed.exactTimestamps.control.updatedAt,
      mappingCreatedAt: null } }), rejected);
  const accessorPhase = {};
  Object.defineProperty(accessorPhase, 'toString', {
    get() { calls++; throw Error('private'); },
  });
  assert.deepEqual(check(f, f.attested, f.pre, accessorPhase), rejected);
  assert.equal(calls, 0);
  assert.deepEqual(check(f, changed, f.pre, 'attested', null,
    { times: { controlUpdatedAt: changed.exactTimestamps.control.updatedAt,
      mappingCreatedAt: null } }), rejected);
});
