/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { createPriorPublicFiles, makeCreateIntentProjection, sealCreateIntent } from
  '../../scripts/search-create-intent-pure.mjs';
import { runCreateApplyConsumer } from '../../scripts/search-create-apply-consumer-core.mjs';

const token = '11111111-1111-4111-8111-111111111111';
const transitionToken = '22222222-2222-4222-8222-222222222222';
const dispatchId = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const invocationId = '55555555-5555-4555-8555-555555555555';
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
function initial() {
  const history = [legacy(), candidate()];
  return { control: { singleton: 1, revision: 2, stage: 'disabled_intent',
    transitionToken, sourceGenerationToken: 'legacy-v1', generationToken: token,
    physicalIndex: index, indexUuid: null, profileId: 'station-mail-v2',
    publicationEnabled: false, servingReady: false, updatedAt: instant() },
  history, dispatch: [], identity: { sessionUser: 'station_search_transition',
    currentUser: 'station_search_transition', database: 'station', databaseOid: 16384,
    databaseOwner: 'station' }, exactTimestamps: { control: { singleton: 1, updatedAt: micro },
    history: history.map(row => ({ generationToken: row.generationToken, createdAt: micro })),
    dispatch: [] } };
}
function observed(created) {
  const settings = { number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
    refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
    replication: { type: 'DOCUMENT' }, uuid: 'legacy_uuid',
    creation_date: '1760000000000', provided_name: 'station-mail-v1',
    version: { created: '13927900' } };
  const indexes = { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
    settings: { index: settings } } };
  if (created) indexes[index] = { aliases: {}, mappings: createV2IndexBody(index).mappings,
    settings: { index: { ...structuredClone(settings), uuid: 'created_uuid',
      provided_name: index } } };
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
    generations: [{ token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
      presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
      writerPrincipal: null, queryPrincipal: null, writerCertFingerprint: null,
      queryCertFingerprint: null }] });
  return { indexes, roles: policy.roles, mappings: policy.mappings };
}
const state = { phase: 'ready', kind: 'complete', indexUuid: 'legacy_uuid' };

function rig(options = {}) {
  const original = initial();
  const publicFiles = createPriorPublicFiles(original, token);
  const publicDigests = publicFiles.map(row => ({ path: row.path, sha256: 'a'.repeat(64) }));
  const projection = makeCreateIntentProjection(original, observed(false), state);
  if (options.sourceUuid) projection.sourceUuid = options.sourceUuid;
  const sealed = sealCreateIntent(projection, publicDigests,
    { project: 'fixture', systemIdentifier: '123', dispatchId, ownerId });
  const binding = { version: 1, invocationId, approvedSha256: sealed.sha256,
    dispatchId, ownerId };
  let current = original, created = false, sends = 0, adminReads = 0;
  const events = [];
  const drift = () => options.driftAt && events.includes(options.driftAt);
  const wrongSuccessor = (name, row) => options.badSuccessorAt === name ?
    { ...row, revision: row.revision + 1 } : row;
  const bump = changes => {
    current.control = { ...current.control, ...changes, revision: current.control.revision + 1 };
    return structuredClone(current.control);
  };
  const deps = {
    readInput: async () => ({ approvedSha256: sealed.sha256,
      intent: drift() && options.driftKind === 'sealed_intent' ?
        { ...sealed.intent, sourceUuid: 'changed_uuid' } : sealed.intent,
      binding: drift() && options.driftKind === 'sealed_input' ?
        { ...binding, approvedSha256: '0'.repeat(64) } : binding }),
    readSnapshot: async () => {
      const result = structuredClone(current);
      if (drift() && options.driftKind === 'prior_history')
        result.history[0].indexUuid = 'changed_uuid';
      if (drift() && options.driftKind === 'control_identity')
        result.control.transitionToken = '99999999-9999-4999-8999-999999999999';
      if (drift() && options.driftKind === 'gates')
        result.control.servingReady = true;
      return result;
    },
    recheck: async snapshot => canonicalAttestorValue(snapshot).bytes.equals(
      canonicalAttestorValue(current).bytes),
    readState: async () => drift() && options.driftKind === 'e0b' ?
      { ...state, indexUuid: 'changed_uuid' } : state,
    captureAdmin: async () => { adminReads++; return { public: {
      caSha256: 'a'.repeat(64), adminSha256: 'a'.repeat(64) },
    recheck: async () => !options.adminDrift || !events.includes(options.adminDrift) }; },
    capturePriorPublic: async () => drift() && options.driftKind === 'public_digest' ?
      publicDigests.map((row, i) => i === 0 ? { ...row, sha256: '0'.repeat(64) } : row) : publicDigests,
    observe: async () => observed(created),
    advance: async (before, stage, uuid) => {
      events.push(stage);
      assert.equal(before.revision, current.control.revision);
      if (options.failAt === stage) throw Error('CAS failed');
      if (stage === 'uuid_bound') {
        current.history[1].lifecycle = 'bound'; current.history[1].indexUuid = uuid;
      }
      return wrongSuccessor(stage, bump({ stage, ...(uuid ? { indexUuid: uuid } : {}) }));
    },
    arm: async (before, dispatch) => {
      events.push('armed');
      assert.equal(before.revision, current.control.revision);
      if (options.failAt === 'armed') throw Error('CAS failed');
      current.dispatch = [{ generationToken: token, ...dispatch,
        state: 'armed', createdAt: instant() }];
      current.exactTimestamps.dispatch = [{ generationToken: token,
        operation: 'create_index', dispatchId, createdAt: micro }];
      return wrongSuccessor('armed', bump({}));
    },
    dispatch: async (before, dispatch) => {
      events.push(dispatch.state);
      assert.equal(before.revision, current.control.revision);
      if (options.failAt === dispatch.state) throw Error('CAS failed');
      current.dispatch[0].state = dispatch.state;
      return wrongSuccessor(dispatch.state, bump({}));
    },
    createOnce: async (name, recheckAdmin) => {
      events.push('send'); sends++;
      assert.equal(name, index);
      assert.equal(current.dispatch[0].state, 'sent_unknown');
      assert.equal(await recheckAdmin(), true);
      if (options.failAt === 'send') throw Error('response lost');
      created = true;
      return { uuid: options.resultUuid ?? 'created_uuid' };
    },
  };
  return { deps, events, counts: () => ({ sends, adminReads }), snapshot: () => current };
}

test('one original send follows sent_unknown and binds exact UUID with both gates false', async () => {
  const f = rig();
  assert.deepEqual(await runCreateApplyConsumer(f.deps), { status: 'uuid_bound', ready: false });
  assert.deepEqual(f.events, ['create_requested', 'armed', 'sent_unknown', 'send',
    'response_confirmed', 'uuid_bound']);
  assert.equal(f.counts().sends, 1);
  assert.equal(f.counts().adminReads, 1);
  assert.equal(f.snapshot().control.indexUuid, 'created_uuid');
  assert.equal(f.snapshot().control.publicationEnabled, false);
  assert.equal(f.snapshot().control.servingReady, false);
});

test('pre-send CAS faults send zero; ambiguous send and post-send CAS faults send once', async () => {
  for (const stage of ['create_requested', 'armed', 'sent_unknown', 'send',
    'response_confirmed', 'uuid_bound']) {
    const f = rig({ failAt: stage });
    await assert.rejects(runCreateApplyConsumer(f.deps));
    assert.equal(f.counts().sends, ['send', 'response_confirmed', 'uuid_bound'].includes(stage) ? 1 : 0);
    assert.equal(f.snapshot().control.servingReady, false);
    if (stage === 'send') {
      assert.equal(f.snapshot().dispatch[0].state, 'sent_unknown');
      assert.equal(f.snapshot().control.stage, 'create_requested');
    }
  }
});

test('incorrect CAS successors stop the invocation without rebasing or resending', async () => {
  for (const stage of ['create_requested', 'armed', 'sent_unknown',
    'response_confirmed', 'uuid_bound']) {
    const f = rig({ badSuccessorAt: stage });
    await assert.rejects(runCreateApplyConsumer(f.deps));
    assert.equal(f.counts().sends,
      ['response_confirmed', 'uuid_bound'].includes(stage) ? 1 : 0, stage);
    assert.equal(f.events.filter(event => event === 'send').length, f.counts().sends);
    assert.equal(f.snapshot().control.servingReady, false);
  }
});

test('sealed input, public, E0b and prior-history drift before or after send fail closed', async () => {
  for (const driftKind of ['sealed_input', 'sealed_intent', 'public_digest', 'e0b', 'prior_history',
    'control_identity', 'gates']) {
    for (const driftAt of ['sent_unknown', 'send']) {
      const f = rig({ driftKind, driftAt });
      await assert.rejects(runCreateApplyConsumer(f.deps));
      assert.equal(f.counts().sends, driftAt === 'send' ? 1 : 0,
        `${driftKind}/${driftAt}`);
      assert.equal(f.snapshot().dispatch[0].state, 'sent_unknown',
        `${driftKind}/${driftAt}`);
      assert.equal(f.snapshot().control.stage, 'create_requested');
      assert.equal(f.snapshot().control.publicationEnabled, false);
      assert.equal(f.snapshot().control.servingReady, false);
    }
  }
});

test('wrong original readback UUID leaves the original dispatch sent_unknown', async () => {
  const f = rig({ resultUuid: 'wrong_uuid' });
  await assert.rejects(runCreateApplyConsumer(f.deps));
  assert.equal(f.counts().sends, 1);
  assert.deepEqual(f.events, ['create_requested', 'armed', 'sent_unknown', 'send']);
  assert.equal(f.snapshot().dispatch[0].state, 'sent_unknown');
  assert.equal(f.snapshot().control.servingReady, false);
});

test('changed original source UUID and changed original admin identity prevent CAS and send', async () => {
  const wrongSource = rig({ sourceUuid: 'wrong_uuid' });
  await assert.rejects(runCreateApplyConsumer(wrongSource.deps));
  assert.deepEqual(wrongSource.events, []);
  const changedAdmin = rig({ adminDrift: 'create_requested' });
  await assert.rejects(runCreateApplyConsumer(changedAdmin.deps));
  assert.deepEqual(changedAdmin.events, ['create_requested', 'armed']);
  assert.equal(changedAdmin.counts().sends, 0);
});
