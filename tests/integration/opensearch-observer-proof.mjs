import assert from 'node:assert/strict';
import console from 'node:console';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import process from 'node:process';
import { join } from 'node:path';
import { Client } from '@opensearch-project/opensearch';
import { openSearchAdminObserver, createV2IndexBody, verifyV2IndexProfile } from '../../packages/search/dist/index.js';
import { boundedSearchSdkRequest, SearchEngineError, verifyProfile } from '../../packages/search/dist/opensearch-runtime.js';
import { buildExpectedSecurityPolicy, compareObservedSecurityCollections } from '../../packages/search/dist/opensearch-generation-policy.js';

assert.equal(process.env.OPENSEARCH_URL, 'https://opensearch:9200');
const endpoint = process.env.OPENSEARCH_URL;
const identityDir = '/run/station-admin';
const index = 'station-mail-v2-g33333333333343338333333333333333';
const hidden = 'station-mail-v2-g44444444444444448444444444444444';
const closed = 'station-mail-v2-g55555555555545558555555555555555';
const outside = 'station-fixture-observer-target';
const shadow = 'station-mail-v2-g66666666666646668666666666666666';
const ordinaryRole = 'station_fixture_observer_ordinary';
const hiddenRole = 'station_fixture_observer_hidden';
const owned = { indexes: [], aliases: [], roles: [], mappings: [], template: false, stream: false };
let admin;
let observer;
let baselineEvidence;
let queryCopy;
let phase = 'setup';
const check = result => assert.equal(result?.acknowledged, true);
const sdk = (invoke, cap = 128_000) => boundedSearchSdkRequest(invoke, cap, 5_000);
const get = (method, path, body) => sdk(options => admin.transport.request({ method, path,
  ...(body === undefined ? {} : { body }) }, options));
const observe = () => observer.observe();
const nameSet = observation => Object.keys(observation.indexes).sort();
const compareNames = (observation, expected) => assert.deepEqual(nameSet(observation), [...expected].sort());
async function preflight() {
  const initial = await observe();
  compareNames(initial, ['station-mail-v1']);
  for (const name of [index, hidden, closed, outside, shadow, 'station-mail-observer-stream']) {
    await assert.rejects(sdk(options => admin.indices.get({ index: name }, options)),
      error => error instanceof SearchEngineError && error.kind === 'status' && error.statusCode === 404,
      'fixture name already exists');
  }
  for (const path of ['/_index_template/station-observer-template', '/_data_stream/station-mail-observer-stream'])
    await assert.rejects(get('GET', path),
      error => error instanceof SearchEngineError && error.kind === 'status' && error.statusCode === 404,
      'fixture template or data stream already exists');
  await assert.rejects(get('GET', '/_alias/station-observer-outside-alias'),
    error => error instanceof SearchEngineError && error.kind === 'status' && error.statusCode === 404,
    'fixture outside alias already exists');
  for (const name of [ordinaryRole, hiddenRole]) {
    assert.equal(Object.hasOwn(initial.roles, name) || Object.hasOwn(initial.mappings, name), false,
      'fixture security name already exists');
  }
  return initial;
}
async function create(name, body = createV2IndexBody(name)) {
  owned.indexes.push(name); // An uncertain create result remains fixture-owned after absence preflight.
  check(await sdk(options => admin.indices.create({ index: name, body }, options)));
}
async function remove(name) {
  check(await sdk(options => admin.indices.delete({ index: name }, options)));
  owned.indexes = owned.indexes.filter(value => value !== name);
}
async function rejectsObservation() {
  await assert.rejects(observe(), error => error && ['response', 'status', 'profile', 'partial'].includes(error.kind));
}
async function cleanup() {
  const errors = [];
  const attempt = async work => { try { await work(); } catch { errors.push(true); } };
  if (owned.stream) await attempt(async () => { await get('DELETE', '/_data_stream/station-mail-observer-stream'); owned.stream = false; });
  if (owned.template) await attempt(async () => { await get('DELETE', '/_index_template/station-observer-template'); owned.template = false; });
  for (const [target, alias] of [...owned.aliases].reverse())
    await attempt(async () => { await sdk(options => admin.indices.deleteAlias({ index: target, name: alias }, options)); });
  for (const name of [...owned.mappings].reverse())
    await attempt(async () => { await get('DELETE', `/_plugins/_security/api/rolesmapping/${name}`); });
  for (const name of [...owned.roles].reverse())
    await attempt(async () => { await get('DELETE', `/_plugins/_security/api/roles/${name}`); });
  for (const name of [...owned.indexes].reverse()) await attempt(async () => {
    try { await sdk(options => admin.indices.get({ index: name }, options)); }
    catch (error) {
      if (error instanceof SearchEngineError && error.kind === 'status' && error.statusCode === 404) return;
      throw error;
    }
    await sdk(options => admin.indices.open({ index: name }, options));
    check(await sdk(options => admin.indices.delete({ index: name }, options)));
  });
  if (errors.length) throw new Error('Owned observer fixture cleanup failed.');
}
try {
  const [ca, cert, key] = await Promise.all(['ca.pem', 'admin.pem', 'admin.key'].map(name => readFile(`${identityDir}/${name}`)));
  admin = new Client({ node: endpoint, ssl: { ca, cert, key, rejectUnauthorized: true },
    maxRetries: 0, requestTimeout: 5_000, sniffOnStart: false,
    sniffOnConnectionFault: false, sniffInterval: false });
  observer = await openSearchAdminObserver({ endpoint, identityDir });
  assert.deepEqual(Object.keys(observer).sort(), ['close', 'observe']);
  const baseline = await preflight();
  baselineEvidence = baseline;
  const v1Uuid = baseline.indexes['station-mail-v1']?.settings?.index?.uuid;
  assert.match(v1Uuid, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(verifyProfile({ 'station-mail-v1': baseline.indexes['station-mail-v1'] }), v1Uuid);
  phase = 'query identity denial';
  queryCopy = await mkdtemp('/tmp/station-observer-query-');
  await Promise.all([
    copyFile('/run/station-query/ca.pem', join(queryCopy, 'ca.pem')),
    copyFile('/run/station-query/query.pem', join(queryCopy, 'admin.pem')),
    copyFile('/run/station-query/query.key', join(queryCopy, 'admin.key')),
  ]);
  const deniedObserver = await openSearchAdminObserver({ endpoint, identityDir: queryCopy });
  try {
    await assert.rejects(deniedObserver.observe(), error => error instanceof SearchEngineError &&
      error.kind === 'status' && error.statusCode === 403 && error.message === 'Private search engine status.');
  } finally { await deniedObserver.close(); }
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1', generations: [{
    token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1', presence: 'exact', uuid: v1Uuid,
    writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
    writerCertFingerprint: null, queryCertFingerprint: null,
  }] });
  assert.equal(compareObservedSecurityCollections(policy, baseline.roles, baseline.mappings), 'exact');
  phase = 'open and profile';
  await create(index);
  const open = await observe();
  assert.ok(Object.hasOwn(open.indexes, index));
  assert.notDeepEqual(nameSet(open), nameSet(baseline));
  const uuid = verifyV2IndexProfile({ [index]: open.indexes[index] }, index, null);
  assert.throws(() => verifyV2IndexProfile({ [index]: open.indexes[index] }, index, 'wrong-uuid'));
  await sdk(options => admin.indices.putSettings({ index, body: { index: { refresh_interval: '2s' } } }, options));
  const changed = await observe();
  assert.throws(() => verifyV2IndexProfile({ [index]: changed.indexes[index] }, index, uuid));
  await sdk(options => admin.indices.putSettings({ index, body: { index: { refresh_interval: '1s' } } }, options));
  verifyV2IndexProfile({ [index]: (await observe()).indexes[index] }, index, uuid);
  phase = 'closed and hidden';
  await create(closed);
  await sdk(options => admin.indices.close({ index: closed }, options));
  await assert.rejects(observe(), error => error instanceof SearchEngineError && error.kind === 'response',
    'closed expected index must produce a fixed incomplete-observation failure');
  await sdk(options => admin.indices.open({ index: closed }, options));
  await create(hidden, { ...createV2IndexBody(hidden), settings: { ...createV2IndexBody(hidden).settings,
    index: { ...createV2IndexBody(hidden).settings.index, hidden: true } } });
  assert.ok(Object.hasOwn((await observe()).indexes, hidden));
  phase = 'missing physical and alias shadow';
  await create(shadow);
  const expectedSynthetic = nameSet(await observe());
  await remove(shadow);
  const missingSynthetic = await observe();
  assert.ok(!Object.hasOwn(missingSynthetic.indexes, shadow));
  assert.notDeepEqual(nameSet(missingSynthetic), expectedSynthetic);
  await create(outside, { settings: { index: { number_of_shards: 1, number_of_replicas: 0 } } });
  owned.aliases.push([outside, shadow]);
  await sdk(options => admin.indices.putAlias({ index: outside, name: shadow }, options));
  await rejectsObservation();
  await sdk(options => admin.indices.deleteAlias({ index: outside, name: shadow }, options));
  owned.aliases = [];
  owned.aliases.push([index, 'station-observer-outside-alias']);
  await sdk(options => admin.indices.putAlias({ index, name: 'station-observer-outside-alias' }, options));
  await rejectsObservation();
  await sdk(options => admin.indices.deleteAlias({ index, name: 'station-observer-outside-alias' }, options));
  owned.aliases = [];
  phase = 'security collection';
  for (const [name, isHidden] of [[ordinaryRole, false], [hiddenRole, true]]) {
    owned.roles.push(name);
    await get('PUT', `/_plugins/_security/api/roles/${name}`, { ...(isHidden ? { hidden: true } : {}),
      cluster_permissions: [], index_permissions: [], tenant_permissions: [] });
    owned.mappings.push(name);
    await get('PUT', `/_plugins/_security/api/rolesmapping/${name}`, { ...(isHidden ? { hidden: true } : {}),
      users: [`${name}-principal`], backend_roles: [], hosts: [] });
    const raw = await observe();
    assert.ok(Object.hasOwn(raw.roles, name) && Object.hasOwn(raw.mappings, name));
    assert.equal(compareObservedSecurityCollections(policy, raw.roles, raw.mappings), 'mismatch');
    await get('DELETE', `/_plugins/_security/api/rolesmapping/${name}`);
    owned.mappings = owned.mappings.filter(value => value !== name);
    await get('DELETE', `/_plugins/_security/api/roles/${name}`);
    owned.roles = owned.roles.filter(value => value !== name);
    const restoredPair = await observe();
    assert.equal(compareObservedSecurityCollections(policy, restoredPair.roles, restoredPair.mappings), 'exact');
    assert.equal(verifyProfile({ 'station-mail-v1': restoredPair.indexes['station-mail-v1'] }), v1Uuid);
    assert.deepEqual(restoredPair.roles, baseline.roles);
    assert.deepEqual(restoredPair.mappings, baseline.mappings);
  }
  phase = 'data stream';
  owned.template = true;
  await get('PUT', '/_index_template/station-observer-template?create=true', { index_patterns: ['station-mail-observer-stream*'],
    data_stream: {}, template: { settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: { properties: { '@timestamp': { type: 'date' } } } } });
  owned.stream = true;
  await get('PUT', '/_data_stream/station-mail-observer-stream');
  await rejectsObservation();
  console.info('GET-only observer pinned TLS fixture passed.');
} catch {
  console.error(`GET-only observer fixture failed at ${phase}.`);
  process.exitCode = 1;
} finally {
  if (admin) {
    let cleaned = true;
    try { await cleanup(); } catch { console.error('GET-only observer fixture cleanup failed.'); process.exitCode = 1; cleaned = false; }
    if (baselineEvidence && cleaned) {
      try {
        const restored = await observe();
        assert.deepEqual(nameSet(restored), nameSet(baselineEvidence));
        assert.equal(verifyProfile({ 'station-mail-v1': restored.indexes['station-mail-v1'] }),
          baselineEvidence.indexes['station-mail-v1'].settings.index.uuid);
        assert.deepEqual(restored.roles, baselineEvidence.roles);
        assert.deepEqual(restored.mappings, baselineEvidence.mappings);
      } catch { console.error('GET-only observer fixture restore evidence failed.'); process.exitCode = 1; }
    }
  }
  const closed = await Promise.allSettled([observer?.close(), admin?.close()]);
  if (closed.some(result => result.status === 'rejected')) {
    console.error('GET-only observer fixture client close failed.'); process.exitCode = 1;
  }
  if (queryCopy) {
    try { await rm(queryCopy, { recursive: true }); }
    catch { console.error('GET-only observer private denial identity cleanup failed.'); process.exitCode = 1; }
  }
}
