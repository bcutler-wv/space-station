import assert from 'node:assert/strict';
import test from 'node:test';
import { runReadOnlyCreateBoundary } from '../../scripts/search-create-boundary-core.mjs';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';

const marker = { version: 1, invocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  project: 'fixture', owner: 'station', databaseOid: '16384', systemIdentifier: '12345678901234567890' };
const state = { phase: 'ready', kind: 'complete', indexUuid: 'legacy_uuid' };
const snapshot = { control: { stage: 'disabled_intent', revision: 2,
  transitionToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  sourceGenerationToken: 'legacy-v1', generationToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  publicationEnabled: false, servingReady: false },
history: [{ generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1', indexUuid: 'legacy_uuid' },
  { generationToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    physicalIndex: 'station-mail-v2-gcccccccccccc4ccc8ccc', indexUuid: null }],
identity: { database: 'station', databaseOid: 16384, databaseOwner: 'station' } };
function fixture() {
  let reads = 0, states = 0, observed = 0, rechecks = 0, assessed = 0;
  const deps = { readInvocation: async () => { reads++; return marker; },
    readState: async () => { states++; return state; },
    readSnapshot: async () => snapshot,
    observe: async () => { observed++; return { fixed: true }; },
    recheck: async value => { rechecks++; assert.equal(value, snapshot); return true; },
    assess: (value, view, expected) => {
      assessed++;
      assert.equal(value, snapshot); assert.deepEqual(view, { fixed: true });
      assert.deepEqual(expected, { phase: 'precreate', revision: 2, stage: 'disabled_intent',
        transitionToken: snapshot.control.transitionToken, sourceToken: 'legacy-v1',
        sourceIndex: 'station-mail-v1', candidateToken: snapshot.control.generationToken,
        candidateIndex: snapshot.history[1].physicalIndex,
        dispatchId: null, ownerId: null, createdUuid: null });
      return { status: 'create-evidence', phase: 'precreate', ready: false };
    } };
  return { deps, counts: () => ({ reads, states, observed, rechecks, assessed }) };
}

test('read-only job derives only precreate expectation and rechecks state, snapshot and marker', async () => {
  const f = fixture();
  assert.deepEqual(await runReadOnlyCreateBoundary(f.deps),
    { status: 'precreate-observed', ready: false });
  assert.deepEqual(f.counts(), { reads: 2, states: 2, observed: 1, rechecks: 1, assessed: 1 });
});

test('wrong OID, changed state and failed snapshot recheck fail closed', async () => {
  const wrongOid = fixture();
  wrongOid.deps.readInvocation = async () => ({ ...marker, databaseOid: '16385' });
  await assert.rejects(runReadOnlyCreateBoundary(wrongOid.deps));
  assert.equal(wrongOid.counts().observed, 0);
  const wrongDatabase = fixture();
  wrongDatabase.deps.readSnapshot = async () => ({ ...snapshot,
    identity: { ...snapshot.identity, database: 'other' } });
  await assert.rejects(runReadOnlyCreateBoundary(wrongDatabase.deps));
  assert.equal(wrongDatabase.counts().observed, 0);
  const changed = fixture();
  let stateReads = 0;
  changed.deps.readState = async () => ++stateReads === 1 ? state : { ...state, indexUuid: 'other' };
  await assert.rejects(runReadOnlyCreateBoundary(changed.deps));
  const stale = fixture(); stale.deps.recheck = async () => false;
  await assert.rejects(runReadOnlyCreateBoundary(stale.deps));
});

test('real create predicate accepts only complete transition-role, secure disabled intent evidence', async () => {
  const candidateToken = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const candidateIndex = `station-mail-v2-g${candidateToken.replaceAll('-', '')}`;
  const instant = () => new Date('2026-10-22T18:00:00.123Z');
  const micro = '2026-10-22T18:00:00.123456Z';
  const legacy = { generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1',
    profileId: 'station-mail-v1', indexUuid: 'legacy_uuid', lifecycle: 'roles_attested',
    writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
    writerCertFingerprint: null, queryCertFingerprint: null, createdAt: instant() };
  const candidate = { generationToken: candidateToken, physicalIndex: candidateIndex,
    profileId: 'station-mail-v2', indexUuid: null, lifecycle: 'reserved',
    writerRole: `station_indexer_${candidateToken.replaceAll('-', '')}`,
    queryRole: `station_query_${candidateToken.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${candidateToken.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${candidateToken.replaceAll('-', '')}`,
    writerCertFingerprint: null, queryCertFingerprint: null, createdAt: instant() };
  const control = { singleton: 1, revision: 2, stage: 'disabled_intent',
    transitionToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sourceGenerationToken: 'legacy-v1', generationToken: candidateToken,
    physicalIndex: candidateIndex, indexUuid: null, profileId: 'station-mail-v2',
    publicationEnabled: false, servingReady: false, updatedAt: instant() };
  const complete = { control, history: [legacy, candidate], dispatch: [],
    identity: { sessionUser: 'station_search_transition', currentUser: 'station_search_transition',
      database: 'station', databaseOid: 16384, databaseOwner: 'station' },
    exactTimestamps: { control: { singleton: 1, updatedAt: micro },
      history: [{ generationToken: 'legacy-v1', createdAt: micro },
        { generationToken: candidateToken, createdAt: micro }], dispatch: [] } };
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
    generations: [{ token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
      presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
      writerPrincipal: null, queryPrincipal: null,
      writerCertFingerprint: null, queryCertFingerprint: null }] });
  const view = { indexes: { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
      refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
      replication: { type: 'DOCUMENT' }, uuid: 'legacy_uuid', creation_date: '1760000000000',
      provided_name: 'station-mail-v1', version: { created: '13927900' } } } } },
    roles: policy.roles, mappings: policy.mappings };
  const make = (s = complete, o = view) => ({ readInvocation: async () => marker,
    readState: async () => state, readSnapshot: async () => s,
    recheck: async value => value === s, observe: async () => o });
  assert.deepEqual(await runReadOnlyCreateBoundary(make()),
    { status: 'precreate-observed', ready: false });
  await assert.rejects(runReadOnlyCreateBoundary(make({ ...complete,
    identity: { ...complete.identity, sessionUser: 'station_search_verifier' } })));
  await assert.rejects(runReadOnlyCreateBoundary(make({ ...complete,
    control: { ...control, stage: 'create_requested' } })));
  await assert.rejects(runReadOnlyCreateBoundary(make(complete,
    { ...view, roles: { ...view.roles, rogue: {} } })));
});
