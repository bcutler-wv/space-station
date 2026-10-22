import assert from 'node:assert/strict';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';
import { Client } from '@opensearch-project/opensearch';
import { makeV2Eligible, makeV2Fence, OPENSEARCH_MAPPING_V2 } from '../../packages/search/dist/index.js';
import { boundedSearchSdkRequest, SearchEngineError } from '../../packages/search/dist/opensearch-runtime.js';
import { assertCompleteSecurityCollections } from '../support/opensearch-generation-collections.mjs';

assert.equal(process.env.OPENSEARCH_URL, 'https://opensearch:9200');
const endpoint = process.env.OPENSEARCH_URL;
const tokens = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const generations = tokens.map((token, slot) => {
  const suffix = token.replaceAll('-', '');
  return { token, suffix, slot, index: `station-mail-v2-g${suffix}`,
    writerRole: `station_indexer_${suffix}`, queryRole: `station_query_${suffix}`,
    writerPrincipal: `station-search-indexer-${suffix}`,
    queryPrincipal: `station-search-query-${suffix}` };
});
const settings = { number_of_shards: 1, number_of_replicas: 0, max_result_window: 200,
  refresh_interval: '1s', mapping: { total_fields: { limit: 64 } }, replication: { type: 'DOCUMENT' } };
function assertSettings(index, actual) {
  const { uuid, creation_date: created, provided_name: name, version, ...semantic } = actual ?? {};
  assert.match(uuid ?? '', /^[A-Za-z0-9_-]{1,128}$/, 'bounded engine UUID');
  assert.match(created ?? '', /^\d{1,20}$/, 'bounded creation timestamp');
  assert.equal(name, index, 'literal provided index name');
  assert.match(version?.created ?? '', /^\d{1,20}$/, 'pinned creation version');
  assert.ok(Object.keys(version ?? {}).every(key => ['created', 'upgraded'].includes(key)),
    'no unknown version metadata');
  if (version?.upgraded !== undefined) assert.match(version.upgraded, /^\d{1,20}$/);
  assert.deepEqual(semantic, { number_of_shards: '1', number_of_replicas: '0',
    max_result_window: '200', refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
    replication: { type: 'DOCUMENT' } }, 'exact v2 settings');
}
const extraNames = ['station_fixture_ordinary', 'station_fixture_hidden'];
const read = async path => {
  const value = await readFile(path);
  assert.ok(value.length >= 100 && value.length <= 16_384, 'private proof identity bound');
  return value;
};
const clients = [];
async function client(directory, prefix) {
  const [ca, cert, key] = await Promise.all([
    read('/run/station-admin/ca.pem'), read(`${directory}/${prefix}.pem`), read(`${directory}/${prefix}.key`)]);
  const result = new Client({ node: endpoint, ssl: { ca, cert, key, rejectUnauthorized: true },
    maxRetries: 0, requestTimeout: 5_000, sniffOnStart: false,
    sniffOnConnectionFault: false, sniffInterval: false });
  clients.push(result);
  return result;
}
const sdk = (clientValue, invoke, cap = 32_768) => boundedSearchSdkRequest(
  options => invoke(clientValue, options), cap, 5_000);
const path = (clientValue, method, uri, body, cap = 32_768) => sdk(clientValue,
  (c, options) => c.transport.request({ method, path: uri, ...(body === undefined ? {} : { body }) }, options), cap);
const role = (index, kind, hidden = false) => ({ ...(hidden ? { hidden: true } : {}),
  cluster_permissions: kind === 'writer' ? ['indices:data/write/bulk'] : [], tenant_permissions: [],
  index_permissions: [{ index_patterns: [index], allowed_actions: kind === 'writer' ?
    ['indices:data/write/index', 'indices:data/read/get', 'indices:data/write/bulk[s]'] :
    ['indices:data/read/search', 'indices:data/read/get'] }] });
const mapping = (principal, hidden = false) => ({ ...(hidden ? { hidden: true } : {}),
  users: [principal], backend_roles: [], hosts: [] });
const v1Roles = {
  station_query: { cluster_permissions: ['cluster:monitor/main', 'cluster:monitor/health'],
    index_permissions: [{ index_patterns: ['station-mail-v1'], allowed_actions: [
      'indices:data/read/search', 'indices:data/read/get', 'indices:admin/get', 'indices:admin/mappings/get'] }] },
  station_indexer: { cluster_permissions: ['cluster:monitor/main', 'cluster:monitor/health',
    'indices:data/write/bulk*'], index_permissions: [{ index_patterns: ['station-mail-v1'], allowed_actions: [
      'indices:data/write/index', 'indices:data/write/delete', 'indices:data/write/bulk*',
      'indices:admin/get', 'indices:admin/mappings/get'] }] },
};
const v1Mappings = { station_query: mapping('station-search-query'),
  station_indexer: mapping('station-search-indexer') };
const staticRoles = JSON.parse(await readFile(new URL('../fixtures/opensearch-static-roles-3.9.0.0.json', import.meta.url), 'utf8'));
const genRoles = Object.fromEntries(generations.flatMap(g => [
  [g.writerRole, role(g.index, 'writer')], [g.queryRole, role(g.index, 'query')]]));
const genMappings = Object.fromEntries(generations.flatMap(g => [
  [g.writerRole, mapping(g.writerPrincipal)], [g.queryRole, mapping(g.queryPrincipal)]]));
const extraRoles = {
  [extraNames[0]]: role(generations[0].index, 'writer'),
  [extraNames[1]]: role(generations[1].index, 'writer', true),
};
const extraMappings = {
  [extraNames[0]]: mapping(generations[0].queryPrincipal),
  [extraNames[1]]: mapping(generations[1].queryPrincipal, true),
};
const expectedRoles = { ...staticRoles, ...v1Roles, ...genRoles };
const expectedMappings = { ...v1Mappings, ...genMappings };
const collection = async admin => Promise.all([
  path(admin, 'GET', '/_plugins/_security/api/roles', undefined, 128_000),
  path(admin, 'GET', '/_plugins/_security/api/rolesmapping', undefined, 128_000),
]);
async function denied(work, category) {
  phase = category.replaceAll(' ', '_');
  try { await work(); }
  catch (error) {
    assert.ok(error instanceof SearchEngineError && [401, 403].includes(error.statusCode),
      `${category} expected authorization denial`);
    return;
  }
  assert.fail(`${category} unexpectedly allowed`);
}
async function assertMissing(adminClient, index) {
  await assert.rejects(
    sdk(adminClient, (c, options) => c.indices.get({ index }, options)),
    error => error instanceof SearchEngineError && error.kind === 'status' && error.statusCode === 404,
    'implicit target must remain absent');
}
async function assertDocMissing(adminClient, index, id) {
  await assert.rejects(sdk(adminClient, (c, options) => c.get({ index, id }, options)),
    error => error instanceof SearchEngineError && error.kind === 'status' && error.statusCode === 404,
    'bulk forbidden document must remain absent');
}
async function deniedBulk(work, action, category) {
  phase = category.replaceAll(' ', '_');
  try {
    const result = await work();
    assert.equal(result.errors, true, 'bulk must report item denial');
    assert.ok(result.items?.length === 1 && [401, 403].includes(result.items[0]?.[action]?.status),
      'bulk item must be forbidden');
  } catch (error) {
    if (error instanceof SearchEngineError && [401, 403].includes(error.statusCode)) return;
    throw error;
  }
}
const identity = (g, item, revision) => {
  const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const stableId = item === 'first' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' :
    item === 'second' ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' : randomUUID();
  return { id: `mail:${accountId}:${stableId}`, stableId, accountId, generationToken: g.token, revision };
};
const fence = (g, item, revision = 1) => {
  const result = makeV2Fence(identity(g, item, revision));
  assert.equal(result.status, 'ok');
  return result.document;
};
const live = (g, item) => {
  const result = makeV2Eligible(identity(g, item, 1), {
    ownerId: 'fixture-owner', orbitIds: [], labelIds: [], kind: 'mail',
    mailboxes: ['inbox'], hasAttachment: false, unread: true, starred: false,
    sentAt: '2026-01-01T00:00:00.000Z', searchText: 'Fixture subject\nFixture body',
    subjectValues: ['Fixture subject'], fromValues: ['sender@example.com'],
    toValues: ['recipient@example.com'], ccValues: [], filenameValues: [],
  });
  assert.equal(result.status, 'ok');
  return result.document;
};
const owned = { indexes: [], roles: [], mappings: [] };
let phase = 'identity', failure = null, cleanupFailed = false;
let admin;
try {
  for (const [directory, names] of [
    ['/run/station-admin', ['admin.key', 'admin.pem', 'ca.pem']],
    ['/run/station-query', ['ca.pem', 'query.key', 'query.pem']],
    ['/run/station-indexer', ['ca.pem', 'indexer.key', 'indexer.pem']],
    ['/run/generation-a', ['query.key', 'query.pem', 'writer.key', 'writer.pem']],
    ['/run/generation-b', ['query.key', 'query.pem', 'writer.key', 'writer.pem']],
  ]) assert.deepEqual((await readdir(directory)).sort(), names, 'exact networked identity files');
  admin = await client('/run/station-admin', 'admin');
  phase = 'reviewed baseline';
  const [baselineRoles, baselineMappings] = await collection(admin);
  assertCompleteSecurityCollections(baselineRoles, baselineMappings,
    { ...staticRoles, ...v1Roles }, v1Mappings);

  phase = 'fixture setup';
  for (const g of generations) {
    const created = await sdk(admin, (c, options) => c.indices.create({ index: g.index,
      body: { settings, mappings: OPENSEARCH_MAPPING_V2 } }, options));
    assert.equal(created.acknowledged, true);
    owned.indexes.push(g.index);
    const profile = await sdk(admin, (c, options) => c.indices.get({ index: g.index }, options), 128_000);
    assert.deepEqual(profile[g.index]?.mappings, OPENSEARCH_MAPPING_V2, 'exact v2 mapping');
    assertSettings(g.index, profile[g.index]?.settings?.index);
    for (const name of [g.writerRole, g.queryRole]) {
      await path(admin, 'PUT', `/_plugins/_security/api/roles/${name}`, genRoles[name]);
      owned.roles.push(name);
      await path(admin, 'PUT', `/_plugins/_security/api/rolesmapping/${name}`, genMappings[name]);
      owned.mappings.push(name);
    }
  }
  const [registeredRoles, registeredMappings] = await collection(admin);
  assertCompleteSecurityCollections(registeredRoles, registeredMappings, expectedRoles, expectedMappings);

  phase = 'hidden and ordinary collection visibility';
  for (const name of extraNames) {
    await path(admin, 'PUT', `/_plugins/_security/api/roles/${name}`, extraRoles[name]);
    owned.roles.push(name);
    await path(admin, 'PUT', `/_plugins/_security/api/rolesmapping/${name}`, extraMappings[name]);
    owned.mappings.push(name);
    const [allRoles, allMappings] = await collection(admin);
    assert.throws(() => assertCompleteSecurityCollections(allRoles, registeredMappings,
      expectedRoles, expectedMappings), /roles collection unknown field/,
    `${name} role must fail intended collection`);
    assert.throws(() => assertCompleteSecurityCollections(registeredRoles, allMappings,
      expectedRoles, expectedMappings), /role mappings collection unknown field/,
    `${name} mapping must fail intended collection`);
    assertCompleteSecurityCollections(allRoles, allMappings,
      { ...expectedRoles, [name]: extraRoles[name] },
      { ...expectedMappings, [name]: extraMappings[name] });
    if (name === extraNames[1]) {
      assert.equal(allRoles[name]?.hidden, true, 'hidden role observed in full collection');
      assert.equal(allMappings[name]?.hidden, true, 'hidden mapping observed in full collection');
    }
    await path(admin, 'DELETE', `/_plugins/_security/api/rolesmapping/${name}`);
    owned.mappings = owned.mappings.filter(value => value !== name);
    await path(admin, 'DELETE', `/_plugins/_security/api/roles/${name}`);
    owned.roles = owned.roles.filter(value => value !== name);
    const [restoredRoles, restoredMappings] = await collection(admin);
    assertCompleteSecurityCollections(restoredRoles, restoredMappings, expectedRoles, expectedMappings);
  }

  phase = 'old-generation immutable role replay';
  const before = await collection(admin);
  for (const name of [generations[0].writerRole, generations[0].queryRole]) {
    await path(admin, 'PUT', `/_plugins/_security/api/roles/${name}`, genRoles[name]);
    await path(admin, 'PUT', `/_plugins/_security/api/rolesmapping/${name}`, genMappings[name]);
  }
  const after = await collection(admin);
  assertCompleteSecurityCollections(after[0], after[1], expectedRoles, expectedMappings);
  for (const name of [generations[1].writerRole, generations[1].queryRole]) {
    assert.deepEqual(after[0][name], before[0][name], 'B role unaffected by A replay');
    assert.deepEqual(after[1][name], before[1][name], 'B mapping unaffected by A replay');
  }

  phase = 'effective identity permissions';
  const writer = await Promise.all(generations.map(g => client(`/run/generation-${g.slot === 0 ? 'a' : 'b'}`, 'writer')));
  const query = await Promise.all(generations.map(g => client(`/run/generation-${g.slot === 0 ? 'a' : 'b'}`, 'query')));
  const v1Writer = await client('/run/station-indexer', 'indexer');
  const v1Query = await client('/run/station-query', 'query');
  for (const g of generations) {
    const i = g.slot, other = generations[1 - i], item = i === 0 ? 'first' : 'second';
    const liveDoc = live(g, item), doc = fence(g, item, 2);
    phase = `generation_${i}_external_live`;
    const liveWrite = await sdk(writer[i], (c, options) => c.index({ index: g.index, id: doc.id,
      body: liveDoc, version: 1, version_type: 'external', refresh: 'wait_for' }, options));
    assert.equal(liveWrite.result, 'created', 'strict external live created');
    assert.equal(liveWrite._version, 1, 'strict external live version');
    const liveRead = await sdk(writer[i], (c, options) => c.get({ index: g.index, id: doc.id }, options));
    assert.equal(liveRead._version, 1);
    assert.deepEqual(liveRead._source, liveDoc, 'bounded live source');
    const liveFound = await sdk(query[i], (c, options) => c.search({ index: g.index,
      allow_partial_search_results: false, body: { query: { term: { live: true } }, size: 10 } }, options));
    assert.equal(liveFound._shards?.failed, 0);
    assert.ok(liveFound.hits?.hits?.some(hit => hit._id === doc.id), 'query sees live external document');
    phase = `generation_${i}_external_fence`;
    const fenceWrite = await sdk(writer[i], (c, options) => c.index({ index: g.index, id: doc.id,
      body: doc, version: 2, version_type: 'external', refresh: 'wait_for' }, options));
    assert.equal(fenceWrite.result, 'updated', 'strict external fence updated');
    assert.equal(fenceWrite._version, 2, 'strict external fence version');
    const fenceRead = await sdk(writer[i], (c, options) => c.get({ index: g.index, id: doc.id }, options));
    assert.equal(fenceRead._version, 2);
    assert.deepEqual(fenceRead._source, doc, 'bounded content-free fence source');
    assert.equal((await sdk(query[i], (c, options) => c.get({ index: g.index, id: doc.id }, options))).found, true);
    const found = await sdk(query[i], (c, options) => c.search({ index: g.index,
      allow_partial_search_results: false, body: { query: { match_all: {} }, size: 10 } }, options));
    assert.equal(found._shards?.failed, 0);
    assert.ok(found.hits?.hits?.some(hit => hit._id === doc.id), 'query own-index fence search');
    const filtered = await sdk(query[i], (c, options) => c.search({ index: g.index,
      allow_partial_search_results: false, body: { query: { term: { live: true } }, size: 10 } }, options));
    assert.ok(!filtered.hits?.hits?.some(hit => hit._id === doc.id), 'fence excludes live search');

    phase = `generation_${i}_own_bulk_index`;
    const bulkDocs = [fence(g, 'bulk-index-one'), fence(g, 'bulk-index-two')];
    const indexed = await sdk(writer[i], (c, options) => c.bulk({ refresh: 'wait_for',
      body: bulkDocs.flatMap(value => [{ index: { _index: g.index, _id: value.id } }, value]) }, options));
    assert.equal(indexed.errors, false, 'own bulk INDEX succeeds');
    assert.equal(indexed.items?.length, 2, 'own bulk INDEX returns every item');
    for (let n = 0; n < bulkDocs.length; n++) {
      assert.equal(indexed.items[n]?.index?.status, 201, 'own bulk INDEX item created');
      assert.equal(indexed.items[n]?.index?._version, 1, 'own bulk INDEX item version');
      const stored = await sdk(admin, (c, options) => c.get({ index: g.index, id: bulkDocs[n].id }, options));
      assert.equal(stored._version, 1);
      assert.deepEqual(stored._source, bulkDocs[n], 'own bulk INDEX source');
    }
    phase = `generation_${i}_own_bulk_create`;
    const createdDoc = live(g, 'bulk-create');
    const created = await sdk(writer[i], (c, options) => c.bulk({ refresh: 'wait_for',
      body: [{ create: { _index: g.index, _id: createdDoc.id } }, createdDoc] }, options));
    assert.equal(created.errors, false, 'own bulk CREATE succeeds');
    assert.equal(created.items?.length, 1);
    assert.equal(created.items[0]?.create?.status, 201);
    const createdStored = await sdk(admin, (c, options) => c.get({ index: g.index, id: createdDoc.id }, options));
    assert.equal(createdStored._version, 1);
    assert.deepEqual(createdStored._source, createdDoc, 'own bulk CREATE source');

    await deniedBulk(() => sdk(writer[i], (c, options) => c.bulk({ body: [
      { delete: { _index: g.index, _id: doc.id } }] }, options)),
    'delete', `generation ${i} own bulk DELETE`);
    await deniedBulk(() => sdk(writer[i], (c, options) => c.bulk({ body: [
      { update: { _index: g.index, _id: doc.id } }, { doc: { live: true } }] }, options)),
    'update', `generation ${i} own bulk UPDATE`);
    const unchanged = await sdk(admin, (c, options) => c.get({ index: g.index, id: doc.id }, options));
    assert.equal(unchanged._version, 2, 'forbidden bulk mutation retained version');
    assert.deepEqual(unchanged._source, doc, 'forbidden bulk mutation retained source');

    await deniedBulk(() => sdk(query[i], (c, options) => c.bulk({ body: [
      { index: { _index: g.index, _id: `query-bulk-${i}` } }, doc] }, options)),
    'index', `generation ${i} query bulk INDEX`);
    await assertDocMissing(admin, g.index, `query-bulk-${i}`);
    await denied(() => sdk(query[i], (c, options) => c.index({ index: g.index, id: 'query-write',
      body: doc }, options)), 'query write');
    await denied(() => sdk(writer[i], (c, options) => c.search({ index: g.index,
      body: { query: { match_all: {} } } }, options)), 'writer search');
    await denied(() => sdk(writer[i], (c, options) => c.delete({ index: g.index, id: doc.id }, options)), 'writer delete');
    await denied(() => sdk(writer[i], (c, options) => c.indices.putSettings({ index: g.index,
      body: { index: { refresh_interval: '2s' } } }, options)), 'writer settings');
    await denied(() => sdk(writer[i], (c, options) => c.indices.putMapping({ index: g.index,
      body: { properties: { unwanted: { type: 'keyword' } } } }, options)), 'writer mapping');
    await denied(() => sdk(writer[i], (c, options) => c.indices.updateAliases({ body: { actions: [
      { add: { index: g.index, alias: 'station-proof-unwanted' } }] } }, options)), 'writer alias');
    await denied(() => sdk(writer[i], (c, options) => c.indices.delete({ index: g.index }, options)), 'writer index delete');
    await denied(() => path(writer[i], 'GET', '/_plugins/_security/api/roles'), 'writer security admin');
    await denied(() => sdk(writer[i], (c, options) => c.get({ index: other.index, id: doc.id }, options)),
      'cross-generation writer get');
    await denied(() => sdk(query[i], (c, options) => c.search({ index: other.index,
      body: { query: { match_all: {} } } }, options)), 'cross-generation query search');
    await denied(() => sdk(writer[i], (c, options) => c.index({ index: other.index, id: doc.id,
      body: doc }, options)), 'cross-generation writer index');
    await denied(() => sdk(query[i], (c, options) => c.get({ index: other.index, id: doc.id }, options)),
      'cross-generation query get');
    await denied(() => sdk(writer[i], (c, options) => c.index({ index: 'station-mail-v1', id: doc.id,
      body: doc }, options)), 'generation writer v1 index');
    await denied(() => sdk(query[i], (c, options) => c.search({ index: 'station-mail-v1',
      body: { query: { match_all: {} } } }, options)), 'generation query v1 search');
    await denied(() => sdk(v1Writer, (c, options) => c.index({ index: g.index, id: doc.id,
      body: doc }, options)), 'v1 writer v2 index');
    await denied(() => sdk(v1Query, (c, options) => c.search({ index: g.index,
      body: { query: { match_all: {} } } }, options)), 'v1 query v2 search');

    const foreignDoc = fence(other, 'foreign-bulk');
    await deniedBulk(() => sdk(writer[i], (c, options) => c.bulk({ body: [
      { index: { _index: other.index, _id: foreignDoc.id } }, foreignDoc] }, options)),
    'index', `generation ${i} pure foreign bulk INDEX`);
    await assertDocMissing(admin, other.index, foreignDoc.id);
    const v1ForeignId = `v1-foreign-bulk-${i}`;
    await deniedBulk(() => sdk(writer[i], (c, options) => c.bulk({ body: [
      { index: { _index: 'station-mail-v1', _id: v1ForeignId } }, doc] }, options)),
    'index', `generation ${i} v1 foreign bulk INDEX`);
    await assertDocMissing(admin, 'station-mail-v1', v1ForeignId);
    await deniedBulk(() => sdk(v1Writer, (c, options) => c.bulk({ body: [
      { index: { _index: g.index, _id: `v1-to-v2-bulk-${i}` } }, doc] }, options)),
    'index', `v1 writer generation ${i} bulk INDEX`);
    await assertDocMissing(admin, g.index, `v1-to-v2-bulk-${i}`);
    phase = `generation_${i}_mixed_bulk`;
    const mixedOwn = fence(g, 'mixed-own'), mixedForeign = fence(other, 'mixed-foreign');
    let mixed, wholeRequestDenied = false;
    try {
      mixed = await sdk(writer[i], (c, options) => c.bulk({ refresh: 'wait_for', body: [
        { index: { _index: g.index, _id: mixedOwn.id } }, mixedOwn,
        { index: { _index: other.index, _id: mixedForeign.id } }, mixedForeign] }, options));
    } catch (error) {
      if (!(error instanceof SearchEngineError && [401, 403].includes(error.statusCode))) throw error;
      // The plugin may reject the whole mixed request before individual items.
      // Accept that only when neither requested effect exists.
      await assertDocMissing(admin, g.index, mixedOwn.id);
      await assertDocMissing(admin, other.index, mixedForeign.id);
      wholeRequestDenied = true;
    }
    if (!wholeRequestDenied) {
      assert.ok(mixed && typeof mixed === 'object' && !Array.isArray(mixed),
        'mixed bulk successful response must be an object');
      assert.equal(mixed.items?.length, 2, 'mixed bulk reports both items');
      assert.ok([401, 403].includes(mixed.items[1]?.index?.status), 'mixed foreign item denied');
      assert.equal(mixed.errors, true, 'mixed bulk reports forbidden item');
      const ownStatus = mixed.items[0]?.index?.status;
      assert.ok([201, 401, 403].includes(ownStatus), 'mixed own item has explicit bounded outcome');
      if (ownStatus === 201) {
        const stored = await sdk(admin, (c, options) => c.get({ index: g.index, id: mixedOwn.id }, options));
        assert.deepEqual(stored._source, mixedOwn, 'mixed allowed own item effect');
        assert.equal(stored._version, 1);
      } else await assertDocMissing(admin, g.index, mixedOwn.id);
      await assertDocMissing(admin, other.index, mixedForeign.id);
    }
  }
  phase = 'missing granted literal and implicit-create denial';
  for (const g of generations) {
    const i = g.slot, doc = fence(g, i === 0 ? 'first' : 'second');
    const removed = await sdk(admin, (c, options) => c.indices.delete({ index: g.index }, options));
    assert.equal(removed.acknowledged, true);
    owned.indexes = owned.indexes.filter(value => value !== g.index);
    await assertMissing(admin, g.index);
    for (const [category, body, extra] of [
      ['ordinary', doc, {}], ['external', doc, { version: 1, version_type: 'external' }],
      ['fence', fence(g, 'second'), { version: 2, version_type: 'external' }],
    ]) {
      await denied(() => sdk(writer[i], (c, options) => c.index({ index: g.index,
        id: `${category}-${i}`, body, ...extra }, options)), `implicit create ${category}`);
      await assertMissing(admin, g.index);
    }
    const bulkIndexDoc = fence(g, 'missing-bulk-index');
    await deniedBulk(() => sdk(writer[i], (c, options) => c.bulk({ body: [
      { index: { _index: g.index, _id: bulkIndexDoc.id } }, bulkIndexDoc] }, options)),
    'index', `missing granted literal generation ${i} bulk INDEX`);
    await assertMissing(admin, g.index);
    const bulkCreateDoc = live(g, 'missing-bulk-create');
    await deniedBulk(() => sdk(writer[i], (c, options) => c.bulk({ body: [
      { create: { _index: g.index, _id: bulkCreateDoc.id } }, bulkCreateDoc] }, options)),
    'create', `missing granted literal generation ${i} bulk CREATE`);
    await assertMissing(admin, g.index);
  }
  console.info('Pinned two-generation permissions, complete hidden collections and immutable-role separation passed.');
} catch (error) {
  const label = typeof error?.message === 'string' ? error.message.split('\n', 1)[0] : '';
  const knownAssertion = /^(?:roles|role mappings) (?:collection|[a-z0-9_]+ exact grants)$|^(?:hidden role observed in full collection|hidden mapping observed in full collection|exact v2 mapping|exact v2 settings|implicit target must remain absent)$/.test(label)
    ? label.replaceAll(' ', '_') : 'assertion';
  failure = `${phase}/${error instanceof SearchEngineError ? `${error.kind}/${error.statusCode ?? 'none'}` : knownAssertion}`;
} finally {
  if (admin) {
    for (const name of [...owned.mappings].reverse()) {
      try { await path(admin, 'DELETE', `/_plugins/_security/api/rolesmapping/${name}`); }
      catch { cleanupFailed = true; }
    }
    for (const name of [...owned.roles].reverse()) {
      try { await path(admin, 'DELETE', `/_plugins/_security/api/roles/${name}`); }
      catch { cleanupFailed = true; }
    }
    for (const name of [...owned.indexes].reverse()) {
      try { await sdk(admin, (c, options) => c.indices.delete({ index: name }, options)); }
      catch { cleanupFailed = true; }
    }
  }
  const closed = await Promise.allSettled(clients.map(value => value.close()));
  if (closed.some(result => result.status === 'rejected')) cleanupFailed = true;
}
if (failure || cleanupFailed) {
  console.error(`Pinned generation proof failed: ${failure ?? 'cleanup'}/${cleanupFailed ? 'cleanup' : 'clean'}.`);
  process.exitCode = 1;
}
