/* global structuredClone */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { makePreparedAttestorManifest, validatePreparedAttestorManifest,
  compareReadyAttestorObservation, matchOwnerDatabaseOid } from '../../scripts/search-attestor-pure.mjs';

const invocation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token = 'AB12CD34-0000-4000-8000-000000000001';
const abandoned = 'ab12cd34-0000-4000-8000-000000000002';
const suffix = value => value.replaceAll('-', '').toLowerCase();
const instant = () => new Date('2026-10-22T18:00:00.123Z');
const micro = '2026-10-22T18:00:00.123456Z';
const legacy = () => ({ generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1',
  profileId: 'station-mail-v1', indexUuid: 'legacy_uuid', lifecycle: 'roles_attested',
  writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
  writerCertFingerprint: null, queryCertFingerprint: null, createdAt: instant() });
const generation = (value, lifecycle) => ({ generationToken: value,
  physicalIndex: `station-mail-v2-g${suffix(value)}`, profileId: 'station-mail-v2',
  indexUuid: lifecycle === 'abandoned' ? null : `uuid_${suffix(value)}`, lifecycle,
  writerRole: `station_indexer_${suffix(value)}`, queryRole: `station_query_${suffix(value)}`,
  writerPrincipal: `station-search-indexer-${suffix(value)}`,
  queryPrincipal: `station-search-query-${suffix(value)}`,
  writerCertFingerprint: lifecycle === 'abandoned' ? null : 'a'.repeat(64),
  queryCertFingerprint: lifecycle === 'abandoned' ? null : 'b'.repeat(64), createdAt: instant() });
const ops = ['create_index', 'writer_role', 'writer_mapping', 'query_role', 'query_mapping'];
function fixture(terminal = false) {
  const rows = [legacy(), ...(terminal ? [generation(token, 'roles_attested')] : []),
    generation(abandoned, 'abandoned')];
  const current = rows.find(row => row.generationToken === token);
  const dispatch = current ? ops.map((operation, i) => ({ generationToken: token, operation,
    dispatchId: `11111111-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    ownerId: '22222222-0000-4000-8000-000000000001',
    ...searchGenerationDispatchSpec(current, operation), state: 'response_confirmed', createdAt: instant() })) : [];
  const control = { singleton: 1, revision: 1, stage: terminal ? 'roles_attested' : 'disabled',
    transitionToken: terminal ? '33333333-0000-4000-8000-000000000001' : null,
    sourceGenerationToken: 'legacy-v1', generationToken: terminal ? token : null,
    physicalIndex: terminal ? current.physicalIndex : null,
    indexUuid: terminal ? current.indexUuid : null,
    profileId: terminal ? 'station-mail-v2' : null,
    publicationEnabled: false, servingReady: false, updatedAt: instant() };
  return { control, history: rows, dispatch,
    identity: { sessionUser: 'station_search_verifier', currentUser: 'station_search_verifier',
      database: 'station', databaseOid: 16384, databaseOwner: 'station' },
    exactTimestamps: { control: { singleton: 1, updatedAt: micro },
      history: rows.map(row => ({ generationToken: row.generationToken, createdAt: micro })),
      dispatch: dispatch.map(row => ({ generationToken: row.generationToken,
        operation: row.operation, dispatchId: row.dispatchId, createdAt: micro })) } };
}
function observed(manifest) {
  const indexes = { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING, settings: { index: {
    number_of_shards: '1', number_of_replicas: '0', max_result_window: '200', refresh_interval: '1s',
    mapping: { total_fields: { limit: '64' } }, replication: { type: 'DOCUMENT' },
    uuid: 'legacy_uuid', creation_date: '1760000000000', provided_name: 'station-mail-v1',
    version: { created: '13927900' },
  } } } };
  for (const row of manifest.expected.generations.filter(row => row.profile === 'station-mail-v2' &&
    row.presence === 'exact')) {
    const body = createV2IndexBody(row.index);
    indexes[row.index] = { aliases: {}, mappings: body.mappings, settings: { index: {
      number_of_shards: '1', number_of_replicas: '0', max_result_window: '200', refresh_interval: '1s',
      mapping: { total_fields: { limit: '64' } }, replication: { type: 'DOCUMENT' },
      uuid: row.uuid, creation_date: '1760000000000', provided_name: row.index,
      version: { created: '13927900' },
    } } };
  }
  const policy = buildExpectedSecurityPolicy(manifest.expected);
  return { indexes, roles: policy.roles, mappings: policy.mappings };
}
const reject = run => assert.throws(run, { message: 'Private search attestor evidence is invalid.' });

test('ready legacy and terminal generations derive exact public lists and compare complete observations', () => {
  for (const terminal of [false, true]) {
    const snapshot = fixture(terminal);
    const manifest = makePreparedAttestorManifest(snapshot, invocation);
    assert.equal(manifest.invocationId, invocation);
    assert.equal(manifest.publicFiles.some(file => file.token === abandoned), false);
    assert.equal(manifest.publicFiles.length, terminal ? 6 : 4);
    if (terminal) assert.ok(manifest.publicFiles.some(file => file.path ===
      `generations/${suffix(token)}/writer.pem` && file.token === token));
    assert.deepEqual(validatePreparedAttestorManifest(snapshot, invocation, manifest), manifest);
    assert.equal(compareReadyAttestorObservation(manifest.expected, observed(manifest)), 'exact');
    assert.equal(matchOwnerDatabaseOid(snapshot.identity, '16384'), true);
  }
});

test('invocation, identity, every exact timestamp set and raw fields are bound', () => {
  const source = fixture(true), manifest = makePreparedAttestorManifest(source, invocation);
  reject(() => validatePreparedAttestorManifest(source, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', manifest));
  for (const mutate of [
    row => { row.identity.databaseOid = 16385; },
    row => { row.identity.currentUser = 'station'; },
    row => { row.exactTimestamps.control.updatedAt = '2026-10-22T18:00:00.123457Z'; },
    row => { row.exactTimestamps.history[0].createdAt = '2026-10-22T18:00:00.123457Z'; },
    row => { row.exactTimestamps.dispatch[0].createdAt = '2026-10-22T18:00:00.123457Z'; },
    row => { row.history[1].writerCertFingerprint = 'c'.repeat(64); },
    row => { row.control.revision++; },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    reject(() => validatePreparedAttestorManifest(changed, invocation, manifest));
  }
  reject(() => matchOwnerDatabaseOid(source.identity, '016384'));
  reject(() => matchOwnerDatabaseOid(source.identity, '16385'));
});

test('sidecar cardinality, key spelling, duplicate evidence and Date precision fail closed', () => {
  for (const mutate of [
    row => { row.exactTimestamps.history.pop(); },
    row => { row.exactTimestamps.history[1].generationToken = 'wrong'; },
    row => { row.exactTimestamps.history[1].generationToken = row.exactTimestamps.history[0].generationToken; },
    row => { row.exactTimestamps.dispatch[0].dispatchId = 'wrong'; },
    row => { row.exactTimestamps.control.updatedAt = '2026-10-22T18:00:00.124456Z'; },
    row => { row.exactTimestamps.history[0].createdAt = '2026-99-99T18:00:00.123456Z'; },
  ]) { const row = fixture(true); mutate(row); reject(() => makePreparedAttestorManifest(row, invocation)); }
});

test('matching raw digest cannot excuse a changed derived inventory or public list', () => {
  const source = fixture(true), manifest = makePreparedAttestorManifest(source, invocation);
  const altered = structuredClone(manifest);
  altered.expected.generations[1].writerRole = 'other';
  reject(() => validatePreparedAttestorManifest(source, invocation, altered));
  const changedFiles = structuredClone(manifest);
  changedFiles.publicFiles.pop();
  reject(() => validatePreparedAttestorManifest(source, invocation, changedFiles));
  const nestedExtra = structuredClone(manifest);
  Object.defineProperty(nestedExtra.expected.generations[1], '__proto__',
    { value: { attacker: true }, enumerable: true, configurable: true });
  reject(() => validatePreparedAttestorManifest(source, invocation, nestedExtra));
  assert.deepEqual(validatePreparedAttestorManifest(source, invocation, manifest), manifest);
  assert.notStrictEqual(validatePreparedAttestorManifest(source, invocation, manifest), manifest);
  manifest.expected.generations[1].writerRole = 'caller-change';
  assert.notEqual(makePreparedAttestorManifest(source, invocation).expected.generations[1].writerRole,
    'caller-change');
});

test('canonical object ordering is stable while row order remains evidence', () => {
  const source = fixture(true);
  const wanted = makePreparedAttestorManifest(source, invocation);
  const reorderedKeys = { exactTimestamps: source.exactTimestamps, identity: source.identity,
    dispatch: source.dispatch, history: source.history, control: source.control };
  assert.equal(makePreparedAttestorManifest(reorderedKeys, invocation).rawDigest, wanted.rawDigest);
  const reorderedRows = structuredClone(source);
  reorderedRows.history.reverse();
  reorderedRows.exactTimestamps.history.reverse();
  assert.notEqual(makePreparedAttestorManifest(reorderedRows, invocation).rawDigest, wanted.rawDigest);
});

test('all-history nonready states and unsupported/oversized values reject before serialization', () => {
  const source = fixture(true);
  source.dispatch[0].state = 'sent_unknown';
  reject(() => makePreparedAttestorManifest(source, invocation));
  const invalid = fixture(); invalid.control.publicationEnabled = true;
  reject(() => makePreparedAttestorManifest(invalid, invocation));
  const callback = fixture(); let calls = 0;
  Object.defineProperty(callback, 'extra', { enumerable: true, get() { calls++; return 'x'; } });
  reject(() => makePreparedAttestorManifest(callback, invocation));
  assert.equal(calls, 0);
  const unsafe = fixture(); unsafe.control.revision = Number.MAX_SAFE_INTEGER + 1;
  reject(() => makePreparedAttestorManifest(unsafe, invocation));
  const huge = fixture(); huge.control.stage = 'x'.repeat(256 * 1024);
  reject(() => makePreparedAttestorManifest(huge, invocation));
  const aggregate = fixture(); aggregate.history = Array.from({ length: 512 }, (_, i) => ({
    ...legacy(), generationToken: `extra-${i}`, writerRole: 'x'.repeat(900) }));
  reject(() => makePreparedAttestorManifest(aggregate, invocation));
  const replay = fixture();
  reject(() => makePreparedAttestorManifest(replay, { toString() { calls++; return invocation; } }));
  assert.equal(calls, 0);
  const manifest = makePreparedAttestorManifest(fixture(), invocation);
  const oversizedManifest = { ...manifest, padding: 'x'.repeat(256 * 1024) };
  reject(() => validatePreparedAttestorManifest(fixture(), invocation, oversizedManifest));
  const oversizedExpected = { ...manifest.expected, padding: 'x'.repeat(256 * 1024) };
  reject(() => compareReadyAttestorObservation(oversizedExpected, observed(manifest)));
  const badIdentity = fixture().identity;
  badIdentity.currentUser = 'station';
  reject(() => matchOwnerDatabaseOid(badIdentity, '16384'));
  const accessorIdentity = fixture().identity;
  Object.defineProperty(accessorIdentity, 'databaseOid', { enumerable: true,
    get() { calls++; return 16384; } });
  reject(() => matchOwnerDatabaseOid(accessorIdentity, '16384'));
  assert.equal(calls, 0);
});

test('complete physical and security evidence rejects missing, extra, UUID, profile, alias and role drift', () => {
  const manifest = makePreparedAttestorManifest(fixture(true), invocation);
  const cases = [
    row => { delete row.indexes['station-mail-v1']; },
    row => { row.indexes['station-mail-extra'] = row.indexes['station-mail-v1']; },
    row => { row.indexes['station-mail-v1'].settings.index.uuid = 'wrong'; },
    row => { row.indexes['station-mail-v1'].aliases.alias = {}; },
    row => { row.indexes[`station-mail-v2-g${suffix(token)}`].mappings._meta.stationProfile = 'wrong'; },
    row => { row.roles.extra = row.roles.station_query; },
    row => { row.mappings.extra = row.mappings.station_query; },
  ];
  for (const mutate of cases) {
    const row = structuredClone(observed(manifest)); mutate(row);
    reject(() => compareReadyAttestorObservation(manifest.expected, row));
  }
  const source = observed(manifest);
  assert.equal(compareReadyAttestorObservation(manifest.expected, source), 'exact');
  assert.deepEqual(source, observed(manifest));
});

test('caller-supplied inventory requires primitive row fields before physical and policy comparison', () => {
  const manifest = makePreparedAttestorManifest(fixture(true), invocation);
  const physical = observed(manifest);
  const v2Index = `station-mail-v2-g${suffix(token)}`;
  for (const missing of [false, true]) {
    const malformed = structuredClone(manifest.expected);
    malformed.generations[1].presence = ['exact'];
    const actual = structuredClone(physical);
    if (missing) delete actual.indexes[v2Index];
    reject(() => compareReadyAttestorObservation(malformed, actual));
  }
  for (const [field, value] of [
    ['profile', ['station-mail-v2']], ['uuid', [manifest.expected.generations[1].uuid]],
    ['writerRole', [manifest.expected.generations[1].writerRole]],
    ['writerCertFingerprint', [manifest.expected.generations[1].writerCertFingerprint]],
  ]) {
    const malformed = structuredClone(manifest.expected);
    malformed.generations[1][field] = value;
    reject(() => compareReadyAttestorObservation(malformed, physical));
  }
  const extra = structuredClone(manifest.expected);
  extra.generations[1].unrecognized = 'x';
  reject(() => compareReadyAttestorObservation(extra, physical));
  assert.equal(compareReadyAttestorObservation(manifest.expected, physical), 'exact');
  const legacy = makePreparedAttestorManifest(fixture(), invocation);
  assert.equal(compareReadyAttestorObservation(legacy.expected, observed(legacy)), 'exact');
});
