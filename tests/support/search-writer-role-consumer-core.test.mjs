/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { searchGenerationDispatchSpec, buildSearchGenerationManifest } from
  '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { makeCreateIntentProjection, sealCreateIntent, createPriorPublicFiles } from
  '../../scripts/search-create-intent-pure.mjs';
import { makeWriterRoleIntentProjection, sealWriterRoleIntent } from
  '../../scripts/search-writer-role-intent-pure.mjs';
import { makeWriterRoleConsumer } from '../../scripts/search-writer-role-consumer-core.mjs';
import { runFixedWriterRoleConsumer } from '../../scripts/search-writer-role-consumer-wrapper.mjs';
import { issuedWriterRoleRequest } from '../../packages/search/dist/opensearch-writer-role-contract.js';

const token = '11111111-1111-4111-8111-111111111111';
const transitionToken = '22222222-2222-4222-8222-222222222222';
const createDispatchId = '33333333-3333-4333-8333-333333333333';
const createOwnerId = '44444444-4444-4444-8444-444444444444';
const roleDispatchId = '55555555-5555-4555-8555-555555555555';
const roleOwnerId = '66666666-6666-4666-8666-666666666666';
const priorToken = '88888888-8888-4888-8888-888888888888';
const priorIndex = `station-mail-v2-g${priorToken.replaceAll('-', '')}`;
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
function snapshot(bound, v2Source = false) {
  const retained = { ...candidate(true), generationToken: priorToken, physicalIndex: priorIndex,
    indexUuid: 'retained_uuid', lifecycle: 'roles_attested',
    writerRole: `station_indexer_${priorToken.replaceAll('-', '')}`,
    queryRole: `station_query_${priorToken.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${priorToken.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${priorToken.replaceAll('-', '')}`,
    writerCertFingerprint: 'f'.repeat(64), queryCertFingerprint: 'e'.repeat(64) };
  const history = [legacy(), ...(v2Source ? [retained] : []), candidate(bound)];
  const priorDispatch = v2Source ? ['create_index', 'query_mapping', 'query_role',
    'writer_mapping', 'writer_role'].map((operation, i) => ({ generationToken: priorToken,
    operation, dispatchId: `99999999-9999-4999-8999-99999999999${i}`,
    ownerId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`,
    ...searchGenerationDispatchSpec(retained, operation),
    state: 'response_confirmed', createdAt: date() })) : [];
  const dispatch = [...(bound ? [{ generationToken: token, operation: 'create_index',
    dispatchId: createDispatchId, ownerId: createOwnerId,
    ...searchGenerationDispatchSpec(history.at(-1), 'create_index'),
    state: 'response_confirmed', createdAt: date() }] : []), ...priorDispatch];
  const control = { singleton: 1, revision: bound ? 7 : 2,
    stage: bound ? 'uuid_bound' : 'disabled_intent', transitionToken,
    sourceGenerationToken: v2Source ? priorToken : 'legacy-v1', generationToken: token,
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
function observed(bound, roleBody = null, v2Source = false) {
  const indexes = { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
      refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
      replication: { type: 'DOCUMENT' }, uuid: 'legacy_uuid', creation_date: '1760000000000',
      provided_name: 'station-mail-v1', version: { created: '13927900' } } } } };
  if (bound) indexes[index] = { aliases: {}, mappings: createV2IndexBody(index).mappings,
    settings: { index: { ...structuredClone(indexes['station-mail-v1'].settings.index),
      uuid: 'created_uuid', provided_name: index } } };
  if (v2Source) indexes[priorIndex] = { aliases: {},
    mappings: createV2IndexBody(priorIndex).mappings,
    settings: { index: { ...structuredClone(indexes['station-mail-v1'].settings.index),
      uuid: 'retained_uuid', provided_name: priorIndex } } };
  const prior = { version: 'station-generation-registry-v1', generations:
    buildSearchGenerationManifest(snapshot(false, v2Source).history)
      .filter(row => row.token !== token).map(row => ({ ...row, presence: 'exact' })) };
  const policy = buildExpectedSecurityPolicy(prior);
  return { indexes, roles: roleBody ? { ...policy.roles, [roleName]: roleBody } : policy.roles,
    mappings: policy.mappings };
}
function setup({ abandoned = false, v2Source = false } = {}) {
  const initial = snapshot(false, v2Source), initialView = observed(false, null, v2Source);
  const bound = snapshot(true, v2Source), pre = observed(true, null, v2Source);
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

function rig(options = {}) {
  const f = setup(options);
  let current = structuredClone(f.bound);
  let view = structuredClone(f.pre);
  const events = [];
  let sendCount = 0;
  let casCount = 0;
  const approval = Object.fromEntries(['approvedSha256', 'revision', 'transitionToken',
    'sourceToken', 'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex',
    'candidateUuid'].map(key => [key, key === 'approvedSha256' ? f.sealed.sha256 :
    f.sealed.intent[key]]));
  const databaseIdentity = structuredClone(f.bound.identity);
  const invocationId = '88888888-8888-4888-8888-888888888888';
  const context = { approval, invocationId,
    project: f.sealed.intent.project, databaseOid: f.sealed.intent.databaseOid,
    systemIdentifier: f.sealed.intent.systemIdentifier, databaseIdentity };
  const input = () => ({ approvedSha256: f.sealed.sha256,
    invocationId, intent: structuredClone(f.sealed.intent),
    binding: { version: 1, invocationId,
      approvedSha256: f.sealed.sha256, dispatchId: roleDispatchId, ownerId: roleOwnerId },
    createEvidence: { intent: structuredClone(f.createEvidence.intent),
      binding: structuredClone(f.createEvidence.binding) },
    transitionPassword: Buffer.from('a'.repeat(43)), publicDigests: structuredClone(f.publicDigests) });
  const deps = {
    readInput: async () => { events.push('input'); return input(); },
    recheckInput: async () => true,
    captureAdmin: async () => ({ public: { caSha256: 'a'.repeat(64),
      adminSha256: 'a'.repeat(64) }, recheck: async () => true }),
    readSnapshot: async () => structuredClone(current),
    recheckSnapshot: async expected => { assert.deepEqual(expected, current); return true; },
    readState: async () => structuredClone(state),
    capturePriorPublic: async () => structuredClone(f.publicDigests),
    observe: async () => { events.push('observe'); return structuredClone(view); },
    cas: async (kind, before, operation) => {
      events.push(`cas:${kind}`); casCount++;
      assert.deepEqual(before, current);
      assert.equal(operation?.dispatchId ?? roleDispatchId, roleDispatchId);
      const next = structuredClone(current);
      next.control.revision++;
      if (kind === 'request') next.control.stage = 'writer_role_requested';
      if (kind === 'arm') {
        next.dispatch.push({ generationToken: token, operation: 'writer_role',
          dispatchId: roleDispatchId, ownerId: roleOwnerId, target: roleName,
          bodyIdentity: f.sealed.intent.bodyIdentity, state: 'armed', createdAt: date() });
        next.exactTimestamps.dispatch.push({ generationToken: token,
          operation: 'writer_role', dispatchId: roleDispatchId, createdAt: micro });
        const key = row => `${row.generationToken}|${row.operation}|${row.dispatchId}`;
        next.dispatch.sort((a, b) => key(a).localeCompare(key(b)));
        next.exactTimestamps.dispatch.sort((a, b) => key(a).localeCompare(key(b)));
      }
      const roleRow = next.dispatch.find(row => row.generationToken === token &&
        row.operation === 'writer_role');
      if (kind === 'send') roleRow.state = 'sent_unknown';
      if (kind === 'confirm') roleRow.state = 'response_confirmed';
      if (kind === 'attest') next.control.stage = 'writer_role_attested';
      current = next;
      return structuredClone(next);
    },
    openSender: async contract => {
      events.push('sender-open');
      const request = issuedWriterRoleRequest(contract);
      assert.equal(request.target, roleName);
      return { sendOnce: async () => {
        events.push('send'); sendCount++;
        if (options.sendFailure) throw Error('original response lost');
        view = observed(true, request.body, options.v2Source);
        return { created: true };
      }, close: async () => { events.push('sender-close'); } };
    },
  };
  return { f, context, deps, events, get current() { return current; },
    get casCount() { return casCount; }, get sendCount() { return sendCount; },
    setView(value) { view = value; } };
}

test('one fixed writer-role core orders five CAS calls and one original response', async () => {
  const r = rig();
  const consumer = makeWriterRoleConsumer(r.context, r.deps);
  assert.deepEqual(await consumer.run(), { status: 'writer_role_attested', ready: false });
  assert.equal(r.casCount, 5);
  assert.equal(r.sendCount, 1);
  assert.deepEqual(r.events.filter(value => value.startsWith('cas:') || value === 'send'),
    ['cas:request', 'cas:arm', 'cas:send', 'send', 'cas:confirm', 'cas:attest']);
  assert.equal(r.current.control.publicationEnabled, false);
  assert.equal(r.current.control.servingReady, false);
  await assert.rejects(consumer.run());
  assert.equal(r.sendCount, 1);
});

test('retained-v2 source keeps legacy E0b and sorted prior dispatch unchanged', async () => {
  const r = rig({ v2Source: true });
  assert.equal(r.f.sealed.intent.sourceToken, priorToken);
  assert.equal(r.f.sealed.intent.state.indexUuid, 'legacy_uuid');
  let result;
  try { result = await makeWriterRoleConsumer(r.context, r.deps).run(); }
  catch { assert.fail(`v2 failed after ${r.events.filter(x => x.startsWith('cas:')).join(',')}`); }
  assert.deepEqual(result, { status: 'writer_role_attested', ready: false });
  assert.equal(r.casCount, 5); assert.equal(r.sendCount, 1);
  assert.deepEqual(r.current.dispatch.map(row => `${row.generationToken}|${row.operation}`),
    [...r.current.dispatch.map(row => `${row.generationToken}|${row.operation}`)].sort());
});

test('uncertain original result remains sent_unknown with one send and no confirmation', async () => {
  const r = rig({ sendFailure: true });
  await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run());
  assert.equal(r.casCount, 3);
  assert.equal(r.sendCount, 1);
  assert.equal(r.current.dispatch[1].state, 'sent_unknown');
  assert.equal(r.events.at(-1), 'sender-close');
});

test('independent approval and invocation reject before any CAS or sender', async () => {
  for (const change of [
    c => { c.approval.approvedSha256 = 'b'.repeat(64); },
    c => { c.approval.candidateUuid = 'changed'; },
    c => { c.invocationId = '99999999-9999-4999-8999-999999999999'; },
    c => { c.databaseIdentity.databaseOwner = 'changed'; },
  ]) {
    const r = rig();
    change(r.context);
    if (r.context.databaseIdentity.databaseOwner === 'changed')
      assert.throws(() => makeWriterRoleConsumer(r.context, r.deps));
    else await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run());
    assert.equal(r.casCount, 0); assert.equal(r.sendCount, 0);
  }
});

test('overlapping runs share one invocation latch before reader await', async () => {
  const r = rig();
  const consumer = makeWriterRoleConsumer(r.context, r.deps);
  const pair = await Promise.allSettled([consumer.run(), consumer.run()]);
  assert.deepEqual(pair.map(item => item.status), ['fulfilled', 'rejected']);
  assert.equal(r.sendCount, 1);
});

test('each CAS successor must match the one original predicted operation', async () => {
  for (const kind of ['request', 'arm', 'send', 'confirm', 'attest']) {
    const r = rig();
    const original = r.deps.cas;
    r.deps.cas = async (...args) => {
      const returned = await original(...args);
      if (args[0] === kind) returned.control.revision++;
      return returned;
    };
    await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run());
    assert.equal(r.casCount, ['request', 'arm', 'send', 'confirm', 'attest'].indexOf(kind) + 1);
    assert.equal(r.sendCount, ['confirm', 'attest'].includes(kind) ? 1 : 0);
  }
});

test('presend reached evidence drifts reject before PUT', async () => {
  for (const change of [
    value => { value.control.publicationEnabled = true; },
    value => { value.control.servingReady = true; },
    value => { value.history[0].indexUuid = 'changed'; },
    value => { value.history[1].indexUuid = 'changed'; },
    value => { value.dispatch[0].ownerId = roleOwnerId; },
    value => { value.dispatch[1].bodyIdentity = 'b'.repeat(64); },
    value => { value.exactTimestamps.control.updatedAt =
      '2026-10-22T18:00:00.123457Z'; },
    value => { value.exactTimestamps.dispatch[1].createdAt =
      '2026-10-22T18:00:00.123457Z'; },
  ]) {
    const r = rig();
    const original = r.deps.readSnapshot;
    r.deps.readSnapshot = async () => {
      const value = await original();
      if (r.casCount === 3) change(value);
      return value;
    };
    await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run());
    assert.equal(r.casCount, 3);
    assert.equal(r.sendCount, 0);
    assert.equal(r.current.dispatch[1].state, 'sent_unknown');
  }
});

test('actual database identity drift after observer is rejected before PUT', async () => {
  const r = rig();
  let drift = false;
  const originalObserve = r.deps.observe;
  r.deps.observe = async () => {
    const result = await originalObserve();
    if (r.casCount === 3) drift = true;
    return result;
  };
  const originalRead = r.deps.readSnapshot;
  r.deps.readSnapshot = async () => {
    const result = await originalRead();
    if (drift) result.identity.databaseOwner = 'changed';
    return result;
  };
  await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run(),
    { message: 'Private writer role apply failed.' });
  assert.equal(r.casCount, 3);
  assert.equal(r.sendCount, 0);
});

test('public, E0b and original input changes across observer await reject before PUT', async () => {
  for (const type of ['public', 'state', 'input']) {
    const r = rig();
    if (type === 'public') {
      const original = r.deps.capturePriorPublic;
      r.deps.capturePriorPublic = async (...args) => {
        const value = await original(...args);
        if (r.casCount === 3) value[0].sha256 = 'b'.repeat(64);
        return value;
      };
    }
    if (type === 'state') {
      let changed = false;
      const originalObserve = r.deps.observe;
      r.deps.observe = async () => {
        const value = await originalObserve();
        if (r.casCount === 3) changed = true;
        return value;
      };
      const originalState = r.deps.readState;
      r.deps.readState = async () => {
        const value = await originalState();
        if (changed) value.indexUuid = 'changed';
        return value;
      };
    }
    if (type === 'input') {
      const original = r.deps.readInput;
      r.deps.readInput = async () => {
        const value = await original();
        if (r.casCount === 3) value.intent.bodySha256 = 'b'.repeat(64);
        return value;
      };
    }
    await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run());
    assert.equal(r.casCount, 3); assert.equal(r.sendCount, 0);
  }
});

test('public bytes change during an awaited observer and cannot become the new baseline', async () => {
  const r = rig();
  let changed = false;
  const observeOriginal = r.deps.observe;
  r.deps.observe = async () => {
    const value = await observeOriginal();
    if (r.casCount === 3) changed = true;
    return value;
  };
  const publicOriginal = r.deps.capturePriorPublic;
  r.deps.capturePriorPublic = async (...args) => {
    const value = await publicOriginal(...args);
    if (changed) value[0].sha256 = 'b'.repeat(64);
    return value;
  };
  await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run());
  assert.equal(r.casCount, 3); assert.equal(r.sendCount, 0);
});

test('successful original response still requires exact sole-role readback', async () => {
  for (const change of [
    view => { view.roles[roleName].cluster_permissions = []; },
    view => { view.mappings[roleName] = {}; },
    view => { view.roles.extra = {}; },
    view => { view.indexes[index].settings.index.uuid = 'changed'; },
  ]) {
    const r = rig();
    const original = r.deps.openSender;
    r.deps.openSender = async contract => {
      const sender = await original(contract);
      return { sendOnce: async () => {
        const result = await sender.sendOnce();
        const value = observed(true, issuedWriterRoleRequest(contract).body);
        change(value); r.setView(value);
        return result;
      }, close: sender.close };
    };
    await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run());
    assert.equal(r.casCount, 3); assert.equal(r.sendCount, 1);
    assert.equal(r.current.dispatch[1].state, 'sent_unknown');
  }
});

test('original response shape failure cannot be adopted from an exact visible role', async () => {
  const r = rig();
  const original = r.deps.openSender;
  r.deps.openSender = async contract => {
    const sender = await original(contract);
    return { sendOnce: async () => { await sender.sendOnce(); return { created: false }; },
      close: sender.close };
  };
  await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run());
  assert.equal(r.casCount, 3); assert.equal(r.sendCount, 1);
  assert.equal(r.current.dispatch[1].state, 'sent_unknown');
});

test('descriptor-invalid authority rejects before reading or executing a getter', () => {
  const r = rig();
  let getter = 0;
  Object.defineProperty(r.context, 'approval', { get() { getter++; return {}; } });
  assert.throws(() => makeWriterRoleConsumer(r.context, r.deps));
  assert.equal(getter, 0); assert.equal(r.events.length, 0);
});

test('malformed sender cleanup accessor is never executed', async () => {
  const r = rig();
  let getter = 0;
  r.deps.openSender = async () => Object.defineProperty({ sendOnce: async () =>
    ({ created: true }) }, 'close', { enumerable: true,
    get() { getter++; throw Error('private close sentinel'); } });
  await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run(),
    { message: 'Private writer role apply failed.' });
  assert.equal(getter, 0); assert.equal(r.casCount, 3); assert.equal(r.sendCount, 0);
});

test('cleanup failure is sanitized and cannot confirm after a lost response', async () => {
  const r = rig({ sendFailure: true });
  const original = r.deps.openSender;
  r.deps.openSender = async contract => {
    const sender = await original(contract);
    return { sendOnce: sender.sendOnce, close: async () => { throw Error('private close sentinel'); } };
  };
  await assert.rejects(makeWriterRoleConsumer(r.context, r.deps).run(),
    { message: 'Private writer role apply failed.' });
  assert.equal(r.casCount, 3); assert.equal(r.sendCount, 1);
  assert.equal(r.current.dispatch[1].state, 'sent_unknown');
});

test('fixed wrapper connects copied-reader recheck and the original five CAS operations', async () => {
  const r = rig();
  let rechecks = 0;
  const adapters = { openInput: async () => ({ readInput: r.deps.readInput,
    recheck: async () => { rechecks++; return true; },
    capturePriorPublic: r.deps.capturePriorPublic }),
  readSnapshot: r.deps.readSnapshot, recheckSnapshot: r.deps.recheckSnapshot,
  cas: r.deps.cas, readState: r.deps.readState, captureAdmin: r.deps.captureAdmin,
  observe: r.deps.observe, openSender: r.deps.openSender };
  assert.deepEqual(await runFixedWriterRoleConsumer(r.context, adapters),
    { status: 'writer_role_attested', ready: false });
  assert.equal(r.casCount, 5); assert.equal(r.sendCount, 1);
  assert.ok(rechecks >= 7);
});
