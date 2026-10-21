import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { OPENSEARCH_MAPPING, OPENSEARCH_PROFILE } from './opensearch-compiler.js';
import { SearchEngineError, verifyActionGroups, verifyAllRoleMappings, verifyProfile, verifySearch, verifySecurityConfig } from './opensearch-runtime.js';
import { PINNED_STATIC_ACTION_GROUPS } from './opensearch-static-action-groups.js';

const profile = () => ({ [OPENSEARCH_PROFILE]: { mappings: OPENSEARCH_MAPPING, settings: { index: {
  number_of_shards: '1', number_of_replicas: '0', max_result_window: '200', refresh_interval: '1s',
  mapping: { total_fields: { limit: '64' } }, replication: { type: 'DOCUMENT' },
  uuid: 'abc_123', creation_date: '1234567890',
  provided_name: OPENSEARCH_PROFILE, version: { created: '139600' },
} } } });
// ConfigV7 serializes these pinned defaults after SecurityAdmin reads Station's
// small YAML. transport_enabled is a deprecated ignored input in that model.
const security = () => ({ config: { dynamic: {
  filtered_alias_mode: 'warn', disable_rest_auth: false, disable_intertransport_auth: false,
  respect_request_indices_options: false, do_not_fail_on_forbidden: false,
  multi_rolespan_enabled: true, hosts_resolver_mode: 'ip-only', do_not_fail_on_forbidden_empty: false,
  privileges_evaluation_ignore_unauthorized_indices: true,
  kibana: { multitenancy_enabled: true, private_tenant_enabled: true, default_tenant: '',
    preferred_tenants: [], server_username: 'kibanaserver', index: '.kibana' },
  http: { anonymous_auth_enabled: false, xff: { enabled: false,
    internalProxies: [String.raw`10\.\d{1,3}\.\d{1,3}\.\d{1,3}`,
      String.raw`192\.168\.\d{1,3}\.\d{1,3}`, String.raw`169\.254\.\d{1,3}\.\d{1,3}`,
      String.raw`127\.\d{1,3}\.\d{1,3}\.\d{1,3}`, String.raw`172\.1[6-9]{1}\.\d{1,3}\.\d{1,3}`,
      String.raw`172\.2[0-9]{1}\.\d{1,3}\.\d{1,3}`, String.raw`172\.3[0-1]{1}\.\d{1,3}\.\d{1,3}`].join('|'),
    remoteIpHeader: 'X-Forwarded-For' } },
  authc: { station_clientcert: { description: 'Station private client certificates', http_enabled: true,
    order: 0, http_authenticator: { type: 'clientcert', challenge: false,
      config: { username_attribute: 'cn' } }, authentication_backend: { type: 'noop', config: {} } } },
  authz: {}, auth_failure_listeners: {}, on_behalf_of: { enabled: false },
  api_tokens: { enabled: false, max_tokens: 100, max_duration_seconds: 7_776_000 },
} } });
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
  for (const mutate of [
    (value: ReturnType<typeof security>) => { value.config.dynamic.http.anonymous_auth_enabled = true; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.http.xff.enabled = true; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.http.xff.remoteIpHeader = 'X-User'; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.http.xff.internalProxies = '.*'; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.disable_rest_auth = true; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.disable_intertransport_auth = true; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.respect_request_indices_options = true; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.do_not_fail_on_forbidden = true; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.do_not_fail_on_forbidden_empty = true; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.multi_rolespan_enabled = false; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.on_behalf_of.enabled = true; },
    (value: ReturnType<typeof security>) => { (value.config.dynamic.on_behalf_of as Record<string, unknown>).signing_key = 'extra'; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.api_tokens.enabled = true; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.api_tokens.max_tokens = 1_000; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.privileges_evaluation_ignore_unauthorized_indices = false; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.authc.station_clientcert.http_enabled = false; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.authc.station_clientcert.http_authenticator.challenge = true; },
    (value: ReturnType<typeof security>) => { value.config.dynamic.authc.station_clientcert.authentication_backend.type = 'intern'; },
    (value: ReturnType<typeof security>) => { (value.config.dynamic.authc as Record<string, unknown>).extra = { http_enabled: true }; },
    (value: ReturnType<typeof security>) => { (value.config.dynamic as Record<string, unknown>).license = null; },
    (value: ReturnType<typeof security>) => { (value.config.dynamic.kibana as Record<string, unknown>).sign_in_options = []; },
  ]) { const changed = security(); mutate(changed); rejected(() => verifySecurityConfig(changed)); }
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
  const rejectedProfile = (body: unknown, check: 'mapping' | 'settings') => {
    let error: unknown;
    try { verifyProfile(body); } catch (cause) { error = cause; }
    expect(error).toMatchObject({ kind: 'profile', check });
  };
  const missingReplication = profile();
  delete (missingReplication[OPENSEARCH_PROFILE].settings.index as Record<string, unknown>).replication;
  rejectedProfile(missingReplication, 'settings');
  const changedReplication = profile();
  changedReplication[OPENSEARCH_PROFILE].settings.index.replication.type = 'SEGMENT';
  rejectedProfile(changedReplication, 'settings');
  const similarity = profile();
  (similarity[OPENSEARCH_PROFILE].settings.index as Record<string, unknown>).similarity = { default: { type: 'BM25', k1: 2 } };
  rejectedProfile(similarity, 'settings');
  const pipeline = profile();
  (pipeline[OPENSEARCH_PROFILE].settings.index as Record<string, unknown>).default_pipeline = 'altered';
  rejectedProfile(pipeline, 'settings');
  const changed = profile();
  changed[OPENSEARCH_PROFILE].settings.index.refresh_interval = '2s';
  rejectedProfile(changed, 'settings');
  const mapping = profile();
  rejectedProfile({ [OPENSEARCH_PROFILE]: { ...mapping[OPENSEARCH_PROFILE],
    mappings: { ...OPENSEARCH_MAPPING, dynamic: 'false' } } }, 'mapping');
  for (const altered of [false, undefined]) {
    const body = structuredClone(profile());
    const field = body[OPENSEARCH_PROFILE].mappings.properties.subjectValues as { doc_values?: boolean };
    if (altered === undefined) delete field.doc_values;
    else field.doc_values = altered;
    rejectedProfile(body, 'mapping');
  }
  const extraMapping = structuredClone(profile());
  (extraMapping[OPENSEARCH_PROFILE].mappings.properties.subjectValues as Record<string, unknown>).normalizer = 'keyword';
  rejectedProfile(extraMapping, 'mapping');
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
