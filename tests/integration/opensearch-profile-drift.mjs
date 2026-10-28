import assert from 'node:assert/strict';
import console from 'node:console';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { Client } from '@opensearch-project/opensearch';
import { openSearchAccess, SearchEngineError, SEARCH_INDEX } from '../../packages/search/dist/opensearch-runtime.js';

const endpoint = process.env.OPENSEARCH_URL;
const phase = process.env.SEARCH_DRIFT_PHASE;
assert.equal(endpoint, 'https://opensearch:9200');
assert.ok(['profile', 'restore', 'role', 'role-restore', 'shadow', 'shadow-restore',
  'delete-v1', 'assert-missing', 'extra-index', 'extra-index-restore',
  'candidate-index', 'candidate-index-restore',
  'alias', 'alias-restore', 'mapping-extra'].includes(phase));
const root = '/run/station-admin';
const [ca, cert, key] = await Promise.all(['ca.pem', 'admin.pem', 'admin.key'].map(name => readFile(`${root}/${name}`)));
const admin = new Client({ node: endpoint, ssl: { ca, cert, key, rejectUnauthorized: true },
  maxRetries: 0, requestTimeout: 5_000, sniffOnStart: false, sniffOnConnectionFault: false, sniffInterval: false });
const query = await openSearchAccess({ endpoint, identityDir: '/run/station-query', role: 'query' });
const adminAccess = await openSearchAccess({ endpoint, identityDir: '/run/station-admin', role: 'admin' });
const shadowPointer = '/indices:data~1read~1search';
const shadowPatch = (op, value) => admin.transport.request({ method: 'PATCH',
  path: '/_plugins/_security/api/actiongroups', body: [{ op, path: shadowPointer, ...(value ? { value } : {}) }] });
async function querySettingsStatus() {
  const queryRaw = new Client({ node: endpoint, ssl: { ca, cert: await readFile('/run/station-query/query.pem'),
    key: await readFile('/run/station-query/query.key'), rejectUnauthorized: true }, maxRetries: 0, requestTimeout: 5_000 });
  try {
    try {
      const result = await queryRaw.indices.putSettings({ index: SEARCH_INDEX, body: { index: { refresh_interval: '1s' } } });
      return result.statusCode;
    } catch (error) {
      if (error?.meta?.statusCode === 403) return 403;
      throw error;
    }
  } finally { await queryRaw.close(); }
}
async function interval() {
  const response = await admin.indices.getSettings({ index: SEARCH_INDEX });
  return response.body?.[SEARCH_INDEX]?.settings?.index?.refresh_interval;
}
try {
  if (phase === 'profile') {
    await adminAccess.verifySecurity();
    await admin.indices.putSettings({ index: SEARCH_INDEX, body: { index: { refresh_interval: '2s' } } });
    await assert.rejects(query.profile(), error => error instanceof SearchEngineError && error.kind === 'profile');
    assert.equal(await interval(), '2s');
    console.info('OpenSearch semantic profile drift was detected.');
  } else if (phase === 'restore') {
    await adminAccess.verifySecurity();
    assert.equal(await interval(), '2s', 'bootstrap silently repaired the altered semantic profile');
    await admin.indices.putSettings({ index: SEARCH_INDEX, body: { index: { refresh_interval: '1s' } } });
    await query.profile();
    console.info('OpenSearch profile drift remained unchanged until explicit fixture restore.');
  } else if (phase === 'shadow') {
    await adminAccess.verifySecurity();
    await shadowPatch('add', { allowed_actions: ['indices:admin/settings/update'], type: 'index' });
    await assert.rejects(adminAccess.verifySecurity(), error => error instanceof SearchEngineError && error.kind === 'profile');
    assert.equal(await querySettingsStatus(), 200, 'shadow action group did not grant query settings authority');
    console.info('OpenSearch shadow action group expanded the unchanged query role and was detected.');
  } else if (phase === 'shadow-restore') {
    await assert.rejects(adminAccess.verifySecurity(), error => error instanceof SearchEngineError && error.kind === 'profile');
    assert.equal(await querySettingsStatus(), 200, 'security bootstrap silently removed shadow action group');
    await shadowPatch('remove');
    await adminAccess.verifySecurity();
    assert.equal(await querySettingsStatus(), 403, 'query identity retained settings authority after fixture restore');
    console.info('OpenSearch shadow action group was restored only by explicit fixture cleanup.');
  } else if (phase === 'role-restore') {
    await admin.transport.request({ method: 'DELETE', path: '/_plugins/_security/api/rolesmapping/station_fixture_excess' });
    await admin.transport.request({ method: 'DELETE', path: '/_plugins/_security/api/roles/station_fixture_excess' });
    await adminAccess.verifySecurity();
    await query.profile();
    console.info('OpenSearch fixture excess role was explicitly removed.');
  } else if (phase === 'delete-v1') {
    await adminAccess.verifySecurity();
    await query.profile();
    const result = await admin.indices.delete({ index: SEARCH_INDEX });
    assert.equal(result.body?.acknowledged, true);
    await assert.rejects(admin.indices.get({ index: SEARCH_INDEX }), error => error?.meta?.statusCode === 404);
    console.info('Disposable v1 index was deleted for retained-loss proof.');
  } else if (phase === 'extra-index') {
    await adminAccess.verifySecurity();
    const result = await admin.indices.create({ index: 'station-mail-fixture-extra',
      body: { settings: { number_of_shards: 1, number_of_replicas: 0 } } });
    assert.equal(result.body?.acknowledged, true);
    assert.ok((await admin.indices.get({ index: 'station-mail-fixture-extra' })).body?.['station-mail-fixture-extra']);
    console.info('Disposable extra index created for exact-inventory denial.');
  } else if (phase === 'extra-index-restore') {
    const result = await admin.indices.delete({ index: 'station-mail-fixture-extra' });
    assert.equal(result.body?.acknowledged, true);
    await adminAccess.verifySecurity();
    console.info('Disposable extra index removed after denial.');
  } else if (phase === 'candidate-index') {
    await adminAccess.verifySecurity();
    const result = await admin.indices.create({
      index: 'station-mail-v2-g11111111111141118111111111111111',
      body: { settings: { number_of_shards: 1, number_of_replicas: 0 } } });
    assert.equal(result.body?.acknowledged, true);
    assert.ok((await admin.indices.get({ index: 'station-mail-v2-g11111111111141118111111111111111' }))
      .body?.['station-mail-v2-g11111111111141118111111111111111']);
    console.info('Reserved candidate unexpectedly present for precreate denial.');
  } else if (phase === 'candidate-index-restore') {
    const result = await admin.indices.delete({ index: 'station-mail-v2-g11111111111141118111111111111111' });
    assert.equal(result.body?.acknowledged, true);
    await adminAccess.verifySecurity();
    console.info('Reserved candidate fixture index removed after denial.');
  } else if (phase === 'alias') {
    await adminAccess.verifySecurity();
    const result = await admin.indices.putAlias({ index: SEARCH_INDEX, name: 'station-mail-fixture-alias' });
    assert.equal(result.body?.acknowledged, true);
    assert.ok((await admin.indices.getAlias({ name: 'station-mail-fixture-alias' })).body?.[SEARCH_INDEX]
      ?.aliases?.['station-mail-fixture-alias']);
    console.info('Disposable index alias created for exact-inventory denial.');
  } else if (phase === 'alias-restore') {
    const result = await admin.indices.deleteAlias({ index: SEARCH_INDEX, name: 'station-mail-fixture-alias' });
    assert.equal(result.body?.acknowledged, true);
    await adminAccess.verifySecurity();
    console.info('Disposable index alias removed after denial.');
  } else if (phase === 'mapping-extra') {
    await adminAccess.verifySecurity();
    const result = await admin.indices.putMapping({ index: SEARCH_INDEX,
      body: { properties: { station_fixture_extra_field: { type: 'keyword' } } } });
    assert.equal(result.body?.acknowledged, true);
    assert.equal((await admin.indices.getMapping({ index: SEARCH_INDEX })).body?.[SEARCH_INDEX]
      ?.mappings?.properties?.station_fixture_extra_field?.type, 'keyword');
    console.info('Disposable v1 mapping changed for terminal denial.');
  } else if (phase === 'assert-missing') {
    await adminAccess.verifySecurity();
    await assert.rejects(admin.indices.get({ index: SEARCH_INDEX }), error => error?.meta?.statusCode === 404);
    console.info('Disposable v1 remained absent after both failed bootstrap paths.');
  } else {
    await adminAccess.verifySecurity();
    await query.profile();
    await admin.transport.request({ method: 'PUT', path: '/_plugins/_security/api/roles/station_fixture_excess', body: {
      cluster_permissions: [], index_permissions: [{ index_patterns: [SEARCH_INDEX], allowed_actions: [
        'indices:data/write/index', 'indices:admin/settings/update'] }], tenant_permissions: [],
    } });
    await admin.transport.request({ method: 'PUT', path: '/_plugins/_security/api/rolesmapping/station_fixture_excess', body: {
      users: ['station-search-query'], backend_roles: [], hosts: [],
    } });
    await assert.rejects(adminAccess.verifySecurity(), error => error instanceof SearchEngineError && error.kind === 'profile');
    assert.equal(await querySettingsStatus(), 200, 'extra role did not grant query settings authority');
    console.info('OpenSearch extra effective role authority was detected.');
  }
} finally { await Promise.all([admin.close(), query.close(), adminAccess.close()]); }
