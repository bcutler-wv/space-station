/* global structuredClone */
import { createHash } from 'node:crypto';
import { searchGenerationDispatchSpec, buildSearchGenerationManifest } from '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { makeCreateIntentProjection, sealCreateIntent, createPriorPublicFiles } from '../../scripts/search-create-intent-pure.mjs';
const token = '11111111-1111-4111-8111-111111111111';
const transitionToken = '22222222-2222-4222-8222-222222222222';
const createDispatchId = '33333333-3333-4333-8333-333333333333';
const createOwnerId = '44444444-4444-4444-8444-444444444444';
const dispatchId = '55555555-5555-4555-8555-555555555555';
const ownerId = '66666666-6666-4666-8666-666666666666';
const originalInvocationId = '77777777-7777-4777-8777-777777777777';
const index = `station-mail-v2-g${token.replaceAll('-', '')}`;
const priorToken = '88888888-8888-4888-8888-888888888888';
const priorIndex = `station-mail-v2-g${priorToken.replaceAll('-', '')}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => canonicalAttestorValue(value, 256 * 1024).bytes;
const state = { phase: 'ready', kind: 'complete', indexUuid: 'legacy_uuid' };
const date = () => new Date('2026-10-22T18:00:00.123Z');
const micro = '2026-10-22T18:00:00.123456Z';
function snapshot(bound, v2Source = false) {
  const history = [{ generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1',
    profileId: 'station-mail-v1', indexUuid: 'legacy_uuid', lifecycle: 'roles_attested',
    writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
    writerCertFingerprint: null, queryCertFingerprint: null, createdAt: date() },
  ...(v2Source ? [{ generationToken: priorToken, physicalIndex: priorIndex,
    profileId: 'station-mail-v2', indexUuid: 'retained_uuid', lifecycle: 'roles_attested',
    writerRole: `station_indexer_${priorToken.replaceAll('-', '')}`,
    queryRole: `station_query_${priorToken.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${priorToken.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${priorToken.replaceAll('-', '')}`,
    writerCertFingerprint: 'f'.repeat(64), queryCertFingerprint: 'e'.repeat(64),
    createdAt: date() }] : []),
  { generationToken: token, physicalIndex: index, profileId: 'station-mail-v2',
    indexUuid: bound ? 'created_uuid' : null, lifecycle: bound ? 'bound' : 'reserved',
    writerRole: `station_indexer_${token.replaceAll('-', '')}`,
    queryRole: `station_query_${token.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${token.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${token.replaceAll('-', '')}`,
    writerCertFingerprint: null, queryCertFingerprint: null, createdAt: date() }];
  const priorDispatch = v2Source ? ['create_index', 'writer_role', 'writer_mapping',
    'query_role', 'query_mapping'].map((operation, i) => ({
    generationToken: priorToken, operation,
    dispatchId: `99999999-9999-4999-8999-99999999999${i}`,
    ownerId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`,
    ...searchGenerationDispatchSpec(history[1], operation),
    state: 'response_confirmed', createdAt: date() })) : [];
  const dispatch = [...priorDispatch, ...(bound ? [{ generationToken: token, operation: 'create_index',
    dispatchId: createDispatchId, ownerId: createOwnerId,
    ...searchGenerationDispatchSpec(history.at(-1), 'create_index'),
    state: 'response_confirmed', createdAt: date() }] : [])];
  return { control: { singleton: 1, revision: bound ? 7 : 2,
    stage: bound ? 'uuid_bound' : 'disabled_intent', transitionToken,
    sourceGenerationToken: v2Source ? priorToken : 'legacy-v1', generationToken: token,
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
function observed(bound, v2Source = false) {
  const indexes = { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0',
      max_result_window: '200', refresh_interval: '1s',
      mapping: { total_fields: { limit: '64' } }, replication: { type: 'DOCUMENT' },
      uuid: 'legacy_uuid', creation_date: '1760000000000',
      provided_name: 'station-mail-v1', version: { created: '13927900' } } } } };
  if (bound) indexes[index] = { aliases: {}, mappings: createV2IndexBody(index).mappings,
    settings: { index: { ...structuredClone(indexes['station-mail-v1'].settings.index),
      uuid: 'created_uuid', provided_name: index } } };
  if (v2Source) indexes[priorIndex] = { aliases: {},
    mappings: createV2IndexBody(priorIndex).mappings,
    settings: { index: { ...structuredClone(indexes['station-mail-v1'].settings.index),
      uuid: 'retained_uuid', provided_name: priorIndex } } };
  const prior = buildSearchGenerationManifest(snapshot(false, v2Source).history)
    .filter(row => row.token !== token).map(row => ({ ...row, presence: 'exact' }));
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
    generations: prior });
  return { indexes, roles: policy.roles, mappings: policy.mappings };
}

export function pureFixture(v2Source = false) {
  const initial = snapshot(false, v2Source);
  const current = { snapshot: snapshot(true, v2Source), state: structuredClone(state),
    observed: observed(true, v2Source) };
  const publicFiles = createPriorPublicFiles(initial, token);
  const publicDigests = publicFiles.map(row => ({ path: row.path, sha256: 'a'.repeat(64) }));
  const create = sealCreateIntent(makeCreateIntentProjection(initial,
    observed(false, v2Source), state), publicDigests,
  { project: 'stationfixture', systemIdentifier: '123',
    dispatchId: createDispatchId, ownerId: createOwnerId });
  const binding = { version: 1, invocationId: originalInvocationId,
    approvedSha256: create.sha256, dispatchId: createDispatchId, ownerId: createOwnerId };
  const createEvidence = { intent: create.intent, approvedSha256: create.sha256, binding };
  let invocation = { version: 1,
    invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    project: 'stationfixture', databaseOid: 16384, systemIdentifier: '123',
    createApprovedSha256: create.sha256,
    originalCreateBindingSha256: sha(canonical(binding)), dispatchId, ownerId };
  const adminPublic = { caSha256: 'a'.repeat(64), adminSha256: 'a'.repeat(64) };
  const counters = { input: 0, snapshot: 0, state: 0, observed: 0, admin: 0,
    inputRecheck: 0, adminRecheck: 0 };
  const deps = { readInput: async () => {
    counters.input++;
    return { invocation, createEvidence, publicDigests,
      recheck: async () => { counters.inputRecheck++; return true; } };
  }, readSnapshot: async () => { counters.snapshot++; return current.snapshot; },
  readState: async () => { counters.state++; return current.state; },
  observe: async () => { counters.observed++; return current.observed; },
  captureAdminPublic: async () => {
    counters.admin++;
    return { public: adminPublic,
      recheck: async () => { counters.adminRecheck++; return true; } };
  }, recheckSnapshot: async () => true };
  return { deps, counters, current, invocation, createEvidence, publicDigests, adminPublic,
    setInvocation: value => { invocation = value; } };
}
