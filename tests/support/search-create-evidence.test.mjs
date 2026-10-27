/* global structuredClone */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { classifySearchGenerationRegistry } from '../../packages/db/dist/search-generation-oracle.js';
import { assessCreateIndexEvidence, makePreparedAttestorManifest } from '../../scripts/search-attestor-pure.mjs';

const token = '11111111-1111-4111-8111-111111111111';
const transitionToken = '22222222-2222-4222-8222-222222222222';
const dispatchId = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const index = `station-mail-v2-g${token.replaceAll('-', '')}`;
const olderToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const olderIndex = `station-mail-v2-g${olderToken.replaceAll('-', '')}`;
const abandonedToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const instant = () => new Date('2026-10-22T18:00:00.123Z');
const micro = '2026-10-22T18:00:00.123456Z';
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
function fixture(phase = 'precreate') {
  const history = [legacy(), candidate()];
  const dispatch = [{ generationToken: token, operation: 'create_index', dispatchId, ownerId,
    ...searchGenerationDispatchSpec(history[1], 'create_index'),
    state: phase === 'precreate' ? 'armed' : 'sent_unknown', createdAt: instant() }];
  const control = { singleton: 1, revision: 2, stage: 'create_requested',
    transitionToken, sourceGenerationToken: 'legacy-v1', generationToken: token,
    physicalIndex: index, indexUuid: null, profileId: 'station-mail-v2',
    publicationEnabled: false, servingReady: false, updatedAt: instant() };
  return { control, history, dispatch,
    identity: { sessionUser: 'station_search_transition', currentUser: 'station_search_transition',
      database: 'station', databaseOid: 16384, databaseOwner: 'station' },
    exactTimestamps: { control: { singleton: 1, updatedAt: micro },
      history: history.map(row => ({ generationToken: row.generationToken, createdAt: micro })),
      dispatch: dispatch.map(row => ({ generationToken: row.generationToken,
        operation: row.operation, dispatchId: row.dispatchId, createdAt: micro })) } };
}
function observed(post = false) {
  const indexes = { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
      refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
      replication: { type: 'DOCUMENT' }, uuid: 'legacy_uuid', creation_date: '1760000000000',
      provided_name: 'station-mail-v1', version: { created: '13927900' } } } } };
  if (post) indexes[index] = { aliases: {}, mappings: createV2IndexBody(index).mappings,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
      refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
      replication: { type: 'DOCUMENT' }, uuid: 'created_uuid', creation_date: '1760000000000',
      provided_name: index, version: { created: '13927900' } } } };
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
    generations: [{ token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
      presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
      writerPrincipal: null, queryPrincipal: null,
      writerCertFingerprint: null, queryCertFingerprint: null }] });
  return { indexes, roles: policy.roles, mappings: policy.mappings };
}
const expected = phase => ({ phase, revision: 2, stage: 'create_requested', transitionToken,
  sourceToken: 'legacy-v1', sourceIndex: 'station-mail-v1', candidateToken: token,
  candidateIndex: index,
  dispatchId, ownerId, createdUuid: phase === 'precreate' ? null : 'created_uuid' });
const assess = (s, o, e) => assessCreateIndexEvidence(s, o, e);
function withHistory(phase = 'postcreate') {
  const s = fixture(phase), o = observed(phase === 'postcreate'), e = expected(phase);
  const older = { ...candidate(), generationToken: olderToken, physicalIndex: olderIndex,
    indexUuid: 'historical_uuid', lifecycle: 'roles_attested',
    writerRole: `station_indexer_${olderToken.replaceAll('-', '')}`,
    queryRole: `station_query_${olderToken.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${olderToken.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${olderToken.replaceAll('-', '')}`,
    writerCertFingerprint: 'a'.repeat(64), queryCertFingerprint: 'b'.repeat(64) };
  s.history.splice(1, 0, older);
  s.history[0].lifecycle = 'retired_retained';
  s.control.sourceGenerationToken = olderToken;
  e.sourceToken = olderToken; e.sourceIndex = olderIndex;
  const operations = ['create_index', 'writer_role', 'writer_mapping', 'query_role', 'query_mapping'];
  const completed = operations.map((operation, slot) => ({ generationToken: olderToken, operation,
    dispatchId: `55555555-5555-4555-8555-${String(slot + 1).padStart(12, '0')}`,
    ownerId: '66666666-6666-4666-8666-666666666666',
    ...searchGenerationDispatchSpec(older, operation), state: 'response_confirmed', createdAt: instant() }));
  s.dispatch.unshift(...completed);
  s.exactTimestamps.history = s.history.map(row => ({ generationToken: row.generationToken, createdAt: micro }));
  s.exactTimestamps.dispatch = s.dispatch.map(row => ({ generationToken: row.generationToken,
    operation: row.operation, dispatchId: row.dispatchId, createdAt: micro }));
  o.indexes[olderIndex] = { aliases: {}, mappings: createV2IndexBody(olderIndex).mappings,
    settings: { index: { ...o.indexes[index].settings.index, uuid: 'historical_uuid',
      provided_name: olderIndex } } };
  const prior = [
    { token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1', presence: 'exact',
      uuid: 'legacy_uuid', writerRole: null, queryRole: null, writerPrincipal: null,
      queryPrincipal: null, writerCertFingerprint: null, queryCertFingerprint: null },
    { token: olderToken, index: olderIndex, profile: 'station-mail-v2', presence: 'exact',
      uuid: 'historical_uuid', writerRole: older.writerRole, queryRole: older.queryRole,
      writerPrincipal: older.writerPrincipal, queryPrincipal: older.queryPrincipal,
      writerCertFingerprint: older.writerCertFingerprint,
      queryCertFingerprint: older.queryCertFingerprint },
  ];
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
    generations: prior });
  o.roles = policy.roles; o.mappings = policy.mappings;
  return { s, o: JSON.parse(JSON.stringify(o)), e };
}

test('create-phase evidence is explicit and never upgrades the registry to ready', () => {
  const intent = fixture();
  intent.control.stage = 'disabled_intent';
  intent.dispatch = [];
  intent.exactTimestamps.dispatch = [];
  assert.deepEqual(assess(intent, observed(), { ...expected('precreate'), stage: 'disabled_intent',
    dispatchId: null, ownerId: null }),
  { status: 'create-evidence', phase: 'precreate', ready: false });
  for (const phase of ['precreate', 'postcreate']) {
    const s = fixture(phase), o = observed(phase === 'postcreate');
    assert.deepEqual(assess(s, o, expected(phase)), { status: 'create-evidence', phase, ready: false });
    assert.deepEqual(classifySearchGenerationRegistry({ control: s.control, history: s.history,
      dispatch: s.dispatch }), { status: 'incomplete',
      reason: phase === 'precreate' ? 'armed' : 'sent_unknown' });
    const verifier = structuredClone(s);
    verifier.identity.sessionUser = 'station_search_verifier';
    verifier.identity.currentUser = 'station_search_verifier';
    assert.throws(() => makePreparedAttestorManifest(verifier,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  }
});

test('partial, drifted and wrong-phase evidence stays rejected', () => {
  const base = fixture('postcreate'), view = observed(true), e = expected('postcreate');
  for (const change of [
    s => { s.control.servingReady = true; },
    s => { s.identity.sessionUser = 'station_search_verifier'; s.identity.currentUser = 'station_search_verifier'; },
    s => { s.identity.currentUser = 'station'; },
    s => { s.identity.sessionUser = 'station'; s.identity.currentUser = 'station'; },
    s => { s.identity.database = 'other'; },
    s => { s.control.sourceGenerationToken = 'wrong'; },
    s => { s.history[0].indexUuid = 'wrong'; },
    s => { s.dispatch[0].state = 'quiesced'; },
    s => { s.dispatch[0].bodyIdentity = '0'.repeat(64); },
    s => { s.exactTimestamps.dispatch[0].createdAt = '2026-10-22T18:00:00.124000Z'; },
  ]) { const s = structuredClone(base); change(s);
    assert.deepEqual(assess(s, view, e), { status: 'create-evidence-rejected', ready: false }, change.toString()); }
  for (const change of [
    o => { o.indexes[index].aliases = { wrong: {} }; },
    o => { o.indexes[index].settings.index.uuid = 'wrong'; },
    o => { o.indexes[index].settings.index.mapping.total_fields.limit = '99'; },
    o => { o.roles.unlisted = {}; },
    o => { o.indexes.unlisted = {}; },
  ]) { const o = structuredClone(view); change(o);
    assert.deepEqual(assess(base, o, e), { status: 'create-evidence-rejected', ready: false }); }
  assert.deepEqual(assess(base, view, { ...e, createdUuid: 'wrong' }),
    { status: 'create-evidence-rejected', ready: false });
  assert.deepEqual(assess(base, view, { ...e, revision: 3 }),
    { status: 'create-evidence-rejected', ready: false });
  assert.deepEqual(assess(fixture(), observed(true), expected('precreate')),
    { status: 'create-evidence-rejected', ready: false });
});

test('complete older v2 and retired history remain exact; clean abandoned stays absent', () => {
  const { s, o, e } = withHistory();
  assert.equal(classifySearchGenerationRegistry({ control: s.control, history: s.history,
    dispatch: s.dispatch }).status, 'incomplete');
  assert.deepEqual(assess(s, o, e), { status: 'create-evidence', phase: 'postcreate', ready: false });
  const abandoned = { ...candidate(), generationToken: abandonedToken,
    physicalIndex: `station-mail-v2-g${abandonedToken.replaceAll('-', '')}`,
    lifecycle: 'abandoned', writerRole: `station_indexer_${abandonedToken.replaceAll('-', '')}`,
    queryRole: `station_query_${abandonedToken.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${abandonedToken.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${abandonedToken.replaceAll('-', '')}` };
  s.history.push(abandoned);
  s.exactTimestamps.history.push({ generationToken: abandonedToken, createdAt: micro });
  assert.deepEqual(assess(s, o, e), { status: 'create-evidence', phase: 'postcreate', ready: false });
  const changed = structuredClone(o);
  changed.indexes[olderIndex].settings.index.number_of_shards = '2';
  assert.deepEqual(assess(s, changed, e), { status: 'create-evidence-rejected', ready: false });
  const missing = structuredClone(o);
  delete missing.indexes[olderIndex];
  assert.deepEqual(assess(s, missing, e), { status: 'create-evidence-rejected', ready: false });
  const mapping = structuredClone(o);
  mapping.mappings[`station_indexer_${olderToken.replaceAll('-', '')}`].users = ['rogue'];
  assert.deepEqual(assess(s, mapping, e), { status: 'create-evidence-rejected', ready: false });
  const hidden = structuredClone(o);
  hidden.roles.hidden_extra = { hidden: true };
  assert.deepEqual(assess(s, hidden, e), { status: 'create-evidence-rejected', ready: false });
  const unresolved = structuredClone(s);
  unresolved.history.at(-1).indexUuid = 'unresolved_uuid';
  assert.deepEqual(assess(unresolved, o, e), { status: 'create-evidence-rejected', ready: false });
  const earlierUnknown = structuredClone(s);
  earlierUnknown.dispatch[0].state = 'sent_unknown';
  assert.deepEqual(assess(earlierUnknown, o, e), { status: 'create-evidence-rejected', ready: false });
});
