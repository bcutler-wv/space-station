import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { OPENSEARCH_MAPPING, OPENSEARCH_PROFILE } from './opensearch-compiler.js';
import { SearchEngineError, verifyActionGroups, verifyAllRoleMappings, verifyProfile, verifySearch, verifySecurityConfig } from './opensearch-runtime.js';
import { PINNED_STATIC_ACTION_GROUPS } from './opensearch-static-action-groups.js';

const profile = () => ({ [OPENSEARCH_PROFILE]: { mappings: OPENSEARCH_MAPPING, settings: { index: {
  number_of_shards: '1', number_of_replicas: '0', max_result_window: '200', refresh_interval: '1s',
  mapping: { total_fields: { limit: '64' } }, uuid: 'abc_123', creation_date: '1234567890',
  provided_name: OPENSEARCH_PROFILE, version: { created: '139600' },
} } } });
const security = () => ({ config: { dynamic: { authz: {}, auth_failure_listeners: {},
  http: { anonymous_auth_enabled: false }, authc: { station_clientcert: {
    description: 'Station private client certificates', http_enabled: true, transport_enabled: false,
    order: 0, http_authenticator: { type: 'clientcert', challenge: false,
      config: { username_attribute: 'cn' } }, authentication_backend: { type: 'noop' },
  } } } } });
const mappings = () => ({ station_query: { users: ['station-search-query'], backend_roles: [], hosts: [] },
  station_indexer: { users: ['station-search-indexer'], backend_roles: [], hosts: [] } });
const result = () => ({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 },
  hits: { total: { relation: 'eq', value: 1 }, hits: [{ _id: 'account-example:one', _index: OPENSEARCH_PROFILE }] } });
const rejected = (fn: () => void) => expect(fn).toThrow(SearchEngineError);

test('compiled ESM imports in each independent Node order', () => {
  for (const name of ['opensearch-compiler', 'opensearch-runtime', 'index']) {
    const url = pathToFileURL(resolve(`packages/search/dist/${name}.js`)).href;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
      { encoding: 'utf8', timeout: 5_000 });
    expect(run.status, `${name}: ${run.stderr}`).toBe(0);
  }
});

test('security config and complete role mappings reject extra authority and fields', () => {
  expect(() => verifySecurityConfig(security())).not.toThrow();
  expect(() => verifyAllRoleMappings(mappings())).not.toThrow();
  const authz = security();
  (authz.config.dynamic as Record<string, unknown>).authz = { ldap: { http_enabled: true } };
  rejected(() => verifySecurityConfig(authz));
  const unknown = security();
  (unknown.config.dynamic as Record<string, unknown>).unexpected = true;
  rejected(() => verifySecurityConfig(unknown));
  const backend = mappings() as Record<string, unknown>;
  backend.extra = { users: [], backend_roles: ['administrators'] };
  rejected(() => verifyAllRoleMappings(backend));
  const extraField = mappings();
  (extraField.station_query as Record<string, unknown>).and_backend_roles = ['administrators'];
  rejected(() => verifyAllRoleMappings(extraField));
  const otherExtra = mappings();
  (otherExtra.station_query as Record<string, unknown>).unknown = false;
  rejected(() => verifyAllRoleMappings(otherExtra));
});

test('only the pinned static action groups are accepted', () => {
  const pristine = structuredClone(PINNED_STATIC_ACTION_GROUPS) as Record<string, unknown>;
  expect(() => verifyActionGroups(pristine)).not.toThrow();
  const shadow = { ...pristine, 'indices:data/read/search': { allowed_actions: ['indices:admin/settings/update'],
    hidden: false, reserved: false, static: false, type: 'index' } };
  rejected(() => verifyActionGroups(shadow));
  const changed = structuredClone(pristine) as Record<string, { allowed_actions: string[] }>;
  changed.search!.allowed_actions.push('indices:admin/settings/update');
  rejected(() => verifyActionGroups(changed));
  const forged = structuredClone(pristine) as Record<string, Record<string, unknown>>;
  forged.search!.static = false;
  rejected(() => verifyActionGroups(forged));
});

test('full profile rejects semantic settings beyond engine metadata', () => {
  expect(() => verifyProfile(profile())).not.toThrow();
  const similarity = profile();
  (similarity[OPENSEARCH_PROFILE].settings.index as Record<string, unknown>).similarity = { default: { type: 'BM25', k1: 2 } };
  rejected(() => verifyProfile(similarity));
  const pipeline = profile();
  (pipeline[OPENSEARCH_PROFILE].settings.index as Record<string, unknown>).default_pipeline = 'altered';
  rejected(() => verifyProfile(pipeline));
  const changed = profile();
  changed[OPENSEARCH_PROFILE].settings.index.refresh_interval = '2s';
  rejected(() => verifyProfile(changed));
});

test('search response rejects impossible totals, malformed hits and shards', () => {
  expect(() => verifySearch(result(), 10)).not.toThrow();
  for (const bad of [-1, 0]) {
    const value = result(); value.hits.total.value = bad;
    rejected(() => verifySearch(value, 10));
  }
  for (const hit of [null, {}, { _id: '', _index: OPENSEARCH_PROFILE },
    { _id: 'bad/id', _index: OPENSEARCH_PROFILE }, { _id: 'good', _index: 'other' }]) {
    const value = result(); (value.hits.hits as unknown[])[0] = hit;
    rejected(() => verifySearch(value, 10));
  }
  for (const shard of [{ total: 0, successful: 0, failed: 0 },
    { total: 2, successful: 1, failed: 0 }, { total: 1, successful: -1, failed: 0 },
    { total: 1, successful: 1, failed: -1 }]) {
    const value = result(); value._shards = shard;
    rejected(() => verifySearch(value, 10));
  }
});
