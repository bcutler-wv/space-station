/* global structuredClone */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { makeCreateIntentProjection, sealCreateIntent, createPriorPublicFiles } from
  '../../scripts/search-create-intent-pure.mjs';
import { makeWriterRoleIntentProjection, sealWriterRoleIntent,
  assessWriterRoleEvidence } from '../../scripts/search-writer-role-intent-pure.mjs';

const token = '11111111-1111-4111-8111-111111111111';
const transitionToken = '22222222-2222-4222-8222-222222222222';
const createDispatchId = '33333333-3333-4333-8333-333333333333';
const createOwnerId = '44444444-4444-4444-8444-444444444444';
const roleDispatchId = '55555555-5555-4555-8555-555555555555';
const roleOwnerId = '66666666-6666-4666-8666-666666666666';
const roleCreatedAt = new Date('2026-10-22T18:00:00.123Z');
const micro = '2026-10-22T18:00:00.123456Z';
const index = `station-mail-v2-g${token.replaceAll('-', '')}`;
const roleName = `station_indexer_${token.replaceAll('-', '')}`;
const state = { phase: 'ready', kind: 'complete', indexUuid: 'legacy_uuid' };
const date = () => new Date('2026-10-22T18:00:00.123Z');
const legacy = () => ({ generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1',
  profileId: 'station-mail-v1', indexUuid: 'legacy_uuid', lifecycle: 'roles_attested',
  writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
  writerCertFingerprint: null, queryCertFingerprint: null, createdAt: date() });
const candidate = (bound) => ({ generationToken: token, physicalIndex: index,
  profileId: 'station-mail-v2', indexUuid: bound ? 'created_uuid' : null,
  lifecycle: bound ? 'bound' : 'reserved', writerRole: roleName,
  queryRole: `station_query_${token.replaceAll('-', '')}`,
  writerPrincipal: `station-search-indexer-${token.replaceAll('-', '')}`,
  queryPrincipal: `station-search-query-${token.replaceAll('-', '')}`,
  writerCertFingerprint: null, queryCertFingerprint: null, createdAt: date() });
function snapshot(bound) {
  const history = [legacy(), candidate(bound)];
  const dispatch = bound ? [{ generationToken: token, operation: 'create_index',
    dispatchId: createDispatchId, ownerId: createOwnerId,
    ...searchGenerationDispatchSpec(history[1], 'create_index'),
    state: 'response_confirmed', createdAt: date() }] : [];
  const control = { singleton: 1, revision: bound ? 7 : 2,
    stage: bound ? 'uuid_bound' : 'disabled_intent', transitionToken,
    sourceGenerationToken: 'legacy-v1', generationToken: token,
    physicalIndex: index, indexUuid: bound ? 'created_uuid' : null,
    profileId: 'station-mail-v2', publicationEnabled: false,
    servingReady: false, updatedAt: date() };
  const result = { control, history, dispatch,
    identity: { sessionUser: 'station_search_transition', currentUser: 'station_search_transition',
      database: 'station', databaseOid: 16384, databaseOwner: 'station' },
    exactTimestamps: { control: { singleton: 1, updatedAt: micro },
      history: history.map(row => ({ generationToken: row.generationToken, createdAt: micro })),
      dispatch: dispatch.map(row => ({ generationToken: row.generationToken,
        operation: row.operation, dispatchId: row.dispatchId, createdAt: micro })) } };
  return result;
}
function observed(bound, roleBody = null) {
  const indexes = { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
      refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
      replication: { type: 'DOCUMENT' }, uuid: 'legacy_uuid', creation_date: '1760000000000',
      provided_name: 'station-mail-v1', version: { created: '13927900' } } } } };
  if (bound) indexes[index] = { aliases: {}, mappings: createV2IndexBody(index).mappings,
    settings: { index: { ...structuredClone(indexes['station-mail-v1'].settings.index),
      uuid: 'created_uuid', provided_name: index } } };
  const prior = { version: 'station-generation-registry-v1', generations: [{
    token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
    presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
    writerPrincipal: null, queryPrincipal: null, writerCertFingerprint: null,
    queryCertFingerprint: null }] };
  const policy = buildExpectedSecurityPolicy(prior);
  return { indexes, roles: roleBody ? { ...policy.roles, [roleName]: roleBody } : policy.roles,
    mappings: policy.mappings };
}
function setup({ abandoned = false } = {}) {
  const initial = snapshot(false), initialView = observed(false);
  const bound = snapshot(true), pre = observed(true);
  if (abandoned) {
    const absent = { ...candidate(false),
      generationToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      physicalIndex: 'station-mail-v2-gaaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',
      writerRole: 'station_indexer_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',
      queryRole: 'station_query_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',
      writerPrincipal: 'station-search-indexer-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',
      queryPrincipal: 'station-search-query-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',
      lifecycle: 'abandoned' };
    for (const s of [initial, bound]) {
      s.history.push(structuredClone(absent));
      s.exactTimestamps.history.push({ generationToken: absent.generationToken,
        createdAt: micro });
    }
  }
  const publicFiles = createPriorPublicFiles(initial, token);
  const publicDigests = publicFiles.map(row => ({ path: row.path, sha256: 'a'.repeat(64) }));
  const create = sealCreateIntent(makeCreateIntentProjection(initial, initialView, state),
    publicDigests, { project: 'stationfixture', systemIdentifier: '123',
      dispatchId: createDispatchId, ownerId: createOwnerId });
  const createEvidence = { intent: create.intent, approvedSha256: create.sha256,
    binding: { version: 1, invocationId: '77777777-7777-4777-8777-777777777777',
      approvedSha256: create.sha256, dispatchId: createDispatchId,
      ownerId: createOwnerId } };
  const projection = makeWriterRoleIntentProjection(bound, pre, state,
    createEvidence, publicDigests);
  const sealed = sealWriterRoleIntent(projection,
    { dispatchId: roleDispatchId, ownerId: roleOwnerId }, createEvidence);
  return { bound, pre, createEvidence, publicDigests, projection, sealed };
}
const timestamps = roleTime => ({ controlUpdatedAt: micro,
  roleCreatedAt: roleTime === null ? null : micro });
const assessWith = (f, s, o, phase, roleTime = null, overrides = {}) =>
  assessWriterRoleEvidence(s, o, overrides.state ?? state,
    overrides.createEvidence ?? f.createEvidence,
    overrides.publicDigests ?? f.publicDigests,
    overrides.sealed ?? f.sealed, phase, timestamps(roleTime),
    overrides.approvedSha256 ?? f.sealed.sha256);
const assess = assessWith;

test('original confirmed create seals a separate role body and stays never ready through exact stages', () => {
  const f = setup();
  assert.notEqual(f.projection.bodySha256, f.projection.bodyIdentity);
  const expected = phase => ({ status: 'writer-role-evidence', phase, ready: false });
  assert.deepEqual(assess(f, f.bound, f.pre, 'bound'), expected('bound'));
  const requested = structuredClone(f.bound);
  requested.control.stage = 'writer_role_requested'; requested.control.revision = 8;
  assert.deepEqual(assess(f, requested, f.pre, 'requested'), expected('requested'));
  const roleRow = { generationToken: token, operation: 'writer_role',
    dispatchId: roleDispatchId, ownerId: roleOwnerId, target: f.projection.target,
    bodyIdentity: f.projection.bodyIdentity, state: 'armed', createdAt: date() };
  requested.dispatch.push(roleRow);
  requested.exactTimestamps.dispatch.push({ generationToken: token, operation: 'writer_role',
    dispatchId: roleDispatchId, createdAt: micro });
  requested.control.revision = 9;
  assert.deepEqual(assess(f, requested, f.pre, 'armed', roleCreatedAt), expected('armed'));
  requested.dispatch[1].state = 'sent_unknown'; requested.control.revision = 10;
  assert.deepEqual(assess(f, requested, f.pre, 'presend', roleCreatedAt), expected('presend'));
  const roleBody = { cluster_permissions: ['indices:data/write/bulk'],
    index_permissions: [{ index_patterns: [index], allowed_actions: [
      'indices:data/write/index', 'indices:data/read/get', 'indices:data/write/bulk[s]'] }],
    tenant_permissions: [] };
  const post = observed(true, roleBody);
  assert.deepEqual(assess(f, requested, post, 'postsend', roleCreatedAt), expected('postsend'));
  requested.dispatch[1].state = 'response_confirmed'; requested.control.revision = 11;
  assert.deepEqual(assess(f, requested, post, 'confirmed', roleCreatedAt), expected('confirmed'));
  requested.control.stage = 'writer_role_attested'; requested.control.revision = 12;
  assert.deepEqual(assess(f, requested, post, 'attested', roleCreatedAt), expected('attested'));
  assert.deepEqual(assess(f, requested, f.pre, 'attested', roleCreatedAt),
    { status: 'writer-role-evidence-rejected', ready: false });
});

test('an abandoned historical generation remains absent in physical and security collections', () => {
  const f = setup({ abandoned: true });
  assert.deepEqual(assess(f, f.bound, f.pre, 'bound'),
    { status: 'writer-role-evidence', phase: 'bound', ready: false });
  const absent = f.bound.history.at(-1);
  for (const change of [
    o => { o.indexes[absent.physicalIndex] = structuredClone(o.indexes[index]); },
    o => { o.roles[absent.writerRole] = {}; },
    o => { o.mappings[absent.writerRole] = {}; },
  ]) { const observedDrift = structuredClone(f.pre); change(observedDrift);
    assert.deepEqual(assess(f, f.bound, observedDrift, 'bound'),
      { status: 'writer-role-evidence-rejected', ready: false }); }
});

test('changed original create and original public/source baselines cannot be resealed into role authority', () => {
  const f = setup();
  const bad = { status: 'writer-role-evidence-rejected', ready: false };
  for (const change of [
    s => { s.history[0].indexUuid = 'wrong'; },
    s => { s.history[1].indexUuid = 'wrong'; s.control.indexUuid = 'wrong'; },
    s => { s.dispatch[0].ownerId = roleOwnerId; },
    s => { s.dispatch[0].bodyIdentity = '0'.repeat(64); },
    s => { s.history[0].createdAt = new Date('2026-10-23T18:00:00.123Z');
      s.exactTimestamps.history[0].createdAt = '2026-10-23T18:00:00.123456Z'; },
    s => { s.control.revision++; },
    s => { s.control.publicationEnabled = true; },
  ]) { const s = structuredClone(f.bound); change(s);
    assert.deepEqual(assess(f, s, f.pre, 'bound'), bad); }
  for (const change of [
    e => { e.binding.invocationId = roleDispatchId; },
    e => { e.binding.approvedSha256 = '0'.repeat(64); },
    e => { e.binding.invocationId = '88888888-8888-4888-8888-888888888888'; },
    e => { e.intent.sourceUuid = 'wrong'; },
  ]) { const e = structuredClone(f.createEvidence); change(e);
    assert.deepEqual(assessWith(f, f.bound, f.pre, 'bound', null,
      { createEvidence: e }), bad); }
  const publicDigests = structuredClone(f.publicDigests);
  publicDigests[0].sha256 = 'b'.repeat(64);
  assert.deepEqual(assessWith(f, f.bound, f.pre, 'bound', null,
    { publicDigests }), bad);
  assert.deepEqual(assessWith(f, f.bound, f.pre, 'bound', null,
    { state: { ...state, indexUuid: 'wrong' } }), bad);
  for (const change of [
    o => { o.indexes[index].settings.index.uuid = 'wrong'; },
    o => { o.indexes['station-mail-v1'].settings.index.uuid = 'wrong'; },
    o => { o.roles.hidden_extra = { hidden: true }; },
    o => { o.roles.station_query.description = null; },
    o => { o.mappings.hidden_extra = {}; },
  ]) { const o = structuredClone(f.pre); change(o);
    assert.deepEqual(assess(f, f.bound, o, 'bound'), bad); }
  const target = structuredClone(f.sealed);
  target.intent.target = 'station_indexer_other';
  assert.deepEqual(assessWith(f, f.bound, f.pre, 'bound', null,
    { sealed: target }), bad);
  const digest = structuredClone(f.sealed);
  digest.intent.bodySha256 = '0'.repeat(64);
  assert.deepEqual(assessWith(f, f.bound, f.pre, 'bound', null,
    { sealed: digest }), bad);
  for (const change of [
    p => { p.sourceUuid = 'wrong'; },
    p => { p.candidateUuid = 'wrong'; },
    p => { p.target = 'station_indexer_other'; },
    p => { p.bodyIdentity = '0'.repeat(64); },
    p => { p.bodySha256 = '0'.repeat(64); },
    p => { p.originalCreateBindingSha256 = '0'.repeat(64); },
    p => { p.baselineDigest = '0'.repeat(64); },
    p => { p.revision++; },
    p => { p.state.indexUuid = 'wrong'; },
    p => { p.publicDigests[0].sha256 = 'b'.repeat(64); },
  ]) {
    const projection = structuredClone(f.projection); change(projection);
    assert.throws(() => sealWriterRoleIntent(projection,
      { dispatchId: roleDispatchId, ownerId: roleOwnerId }, f.createEvidence));
  }
  assert.throws(() => sealWriterRoleIntent(f.projection,
    { dispatchId: createDispatchId, ownerId: roleOwnerId }, f.createEvidence));
});

test('projection provenance and approved digest reject resealed changed original dispatch', () => {
  const f = setup();
  const changed = structuredClone(f.bound);
  changed.dispatch[0].ownerId = '88888888-8888-4888-8888-888888888888';
  const forged = structuredClone(f.projection);
  forged.baselineDigest = 'b'.repeat(64);
  assert.throws(() => sealWriterRoleIntent(forged,
    { dispatchId: roleDispatchId, ownerId: roleOwnerId }, f.createEvidence));
  assert.deepEqual(assess(f, changed, f.pre, 'bound'),
    { status: 'writer-role-evidence-rejected', ready: false });
  const serialized = structuredClone(f.sealed);
  assert.deepEqual(assessWith(f, f.bound, f.pre, 'bound', null, { sealed: serialized }),
    { status: 'writer-role-evidence', phase: 'bound', ready: false });
  assert.deepEqual(assessWith(f, f.bound, f.pre, 'bound', null,
    { sealed: serialized, approvedSha256: '0'.repeat(64) }),
  { status: 'writer-role-evidence-rejected', ready: false });
});

test('latched microsecond timestamps reject control and armed dispatch drift', () => {
  const f = setup();
  const bad = { status: 'writer-role-evidence-rejected', ready: false };
  const changedBound = structuredClone(f.bound);
  changedBound.exactTimestamps.control.updatedAt = '2026-10-22T18:00:00.123457Z';
  assert.deepEqual(assess(f, changedBound, f.pre, 'bound'), bad);
  const armed = structuredClone(f.bound);
  armed.control.stage = 'writer_role_requested'; armed.control.revision = 9;
  armed.dispatch.push({ generationToken: token, operation: 'writer_role',
    dispatchId: roleDispatchId, ownerId: roleOwnerId, target: f.projection.target,
    bodyIdentity: f.projection.bodyIdentity, state: 'armed', createdAt: date() });
  armed.exactTimestamps.dispatch.push({ generationToken: token, operation: 'writer_role',
    dispatchId: roleDispatchId, createdAt: micro });
  assert.deepEqual(assess(f, armed, f.pre, 'armed', roleCreatedAt),
    { status: 'writer-role-evidence', phase: 'armed', ready: false });
  armed.exactTimestamps.dispatch[1].createdAt = '2026-10-22T18:00:00.123457Z';
  assert.deepEqual(assess(f, armed, f.pre, 'armed', roleCreatedAt), bad);
  armed.exactTimestamps.dispatch[1].createdAt = micro;
  armed.exactTimestamps.control.updatedAt = '2026-10-22T18:00:00.123457Z';
  assert.deepEqual(assess(f, armed, f.pre, 'armed', roleCreatedAt), bad);
  assert.deepEqual(assessWriterRoleEvidence(armed, f.pre, state, f.createEvidence,
    f.publicDigests, f.sealed, 'armed', { controlUpdatedAt: micro,
      roleCreatedAt: '2026-10-22T18:00:00.123457Z' }, f.sealed.sha256), bad);
});

test('descriptor-invalid inputs fail without executing accessors', () => {
  const f = setup();
  let called = 0;
  const getter = { ...f.createEvidence };
  Object.defineProperty(getter, 'intent', { enumerable: true,
    get() { called++; return f.createEvidence.intent; } });
  assert.throws(() => sealWriterRoleIntent(f.projection,
    { dispatchId: roleDispatchId, ownerId: roleOwnerId }, getter));
  assert.deepEqual(assessWith(f, f.bound, f.pre, 'bound', null,
    { createEvidence: getter }), { status: 'writer-role-evidence-rejected', ready: false });
  const hidden = { ...f.createEvidence };
  Object.defineProperty(hidden, 'extra', { value: 'x', enumerable: false });
  assert.throws(() => sealWriterRoleIntent(f.projection,
    { dispatchId: roleDispatchId, ownerId: roleOwnerId }, hidden));
  const symbol = { ...f.createEvidence, [Symbol('extra')]: 'x' };
  assert.deepEqual(assessWith(f, f.bound, f.pre, 'bound', null,
    { createEvidence: symbol }), { status: 'writer-role-evidence-rejected', ready: false });
  assert.equal(called, 0);
});
