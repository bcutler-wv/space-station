import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { Client } from '@opensearch-project/opensearch';
import { OPENSEARCH_MAPPING, OPENSEARCH_PROFILE, type SearchCompileResult } from './opensearch-compiler.js';
import { observerBudget } from './opensearch-observer-budget.js';
import { PINNED_STATIC_ACTION_GROUPS } from './opensearch-static-action-groups.js';

export const SEARCH_INDEX = OPENSEARCH_PROFILE;
export const SEARCH_ENGINE_VERSION = '3.9.0';
const REQUEST_MS = 5_000;
const RESPONSE_BYTES = 2 * 1024 * 1024;
const INDEX_SETTINGS = Object.freeze({ number_of_shards: 1, number_of_replicas: 0,
  max_result_window: 200, refresh_interval: '1s', mapping: { total_fields: { limit: 64 } },
  replication: { type: 'DOCUMENT' } });
type Role = 'admin' | 'query' | 'indexer';
type SDKOptions = NonNullable<Parameters<Client['info']>[1]>;
// The generated method types describe parsed bodies even with asStream:true.
// The pinned SDK actually returns the raw stream envelope in that mode.
type Abortable = Promise<unknown> & { abort(): void };

export class SearchEngineError extends Error {
  constructor(readonly kind: 'configuration' | 'transport' | 'timeout' | 'response' | 'status' | 'profile' | 'partial',
    readonly statusCode?: number,
    readonly check?: 'config' | 'query-role' | 'indexer-role' | 'role-mappings' | 'action-groups' | 'mapping' | 'settings') {
    super(`Private search engine ${kind}.`);
  }
}

function assertEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SearchEngineError('configuration'); }
  if (url.protocol !== 'https:' || !['opensearch', '127.0.0.1', 'localhost'].includes(url.hostname) ||
      (url.port !== '9200' && url.hostname === 'opensearch') ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new SearchEngineError('configuration');
  return url.origin;
}

async function readIdentity(directory: string, role: Role) {
  if (!directory.startsWith('/') || directory.includes('..')) throw new SearchEngineError('configuration');
  const [ca, cert, key] = await Promise.all(['ca.pem', `${role}.pem`, `${role}.key`].map(async file => {
    const data = await readFile(`${directory}/${file}`);
    if (data.length < 100 || data.length > 16_384) throw new SearchEngineError('configuration');
    return data;
  }));
  return { ca, cert, key };
}

async function boundedEnvelope<T>(invoke: (options: SDKOptions) => Abortable,
  cap = RESPONSE_BYTES, budget = REQUEST_MS,
  policy?: { alias404?: true; onChunk?: (bytes: number) => void }):
  Promise<{ body: T; statusCode: number; bytes: number }> {
  if (!Number.isInteger(cap) || cap < 1 || cap > RESPONSE_BYTES || !Number.isInteger(budget) || budget < 1 || budget > REQUEST_MS)
    throw new SearchEngineError('configuration');
  const deadline = performance.now() + budget;
  return new Promise<{ body: T; statusCode: number; bytes: number }>((resolve, reject) => {
    let settled = false;
    let request: Abortable | undefined;
    let body: Readable | undefined;
    const finish = (error?: unknown, value?: { body: T; statusCode: number; bytes: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value as { body: T; statusCode: number; bytes: number });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      const error = new SearchEngineError('timeout');
      finish(error);
      try { request?.abort(); } catch { /* The deadline already rejected. */ }
      body?.destroy();
    }, budget);
    try {
      request = invoke({ asStream: true, requestTimeout: budget, maxRetries: 0 });
      Promise.resolve(request).then(async envelope => {
        const response = record(envelope);
        body = response.body instanceof Readable ? response.body : undefined;
        if (!body || typeof response.statusCode !== 'number') throw new SearchEngineError('response');
        if (settled) { body?.destroy(); return; }
        const headers = response.headers ? record(response.headers) : {};
        const encoding = headers['content-encoding'];
        if (encoding && encoding !== 'identity') throw new SearchEngineError('response');
        const declared = Number(headers['content-length']);
        if (Number.isFinite(declared) && declared > cap) throw new SearchEngineError('response');
        if (response.statusCode >= 300 && response.statusCode < 400) throw new SearchEngineError('status', response.statusCode);
        if ((response.statusCode < 200 || response.statusCode >= 300) &&
            !(policy?.alias404 && response.statusCode === 404))
          throw new SearchEngineError('status', response.statusCode);
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const part of body) {
          const chunk = Buffer.from(part);
          bytes += chunk.byteLength;
          if (bytes > cap) throw new SearchEngineError('response');
          policy?.onChunk?.(chunk.byteLength);
          chunks.push(chunk);
          if (performance.now() > deadline) throw new SearchEngineError('timeout');
        }
        let raw: string;
        try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
        catch { throw new SearchEngineError('response'); }
        let parsed: T;
        try { parsed = JSON.parse(raw) as T; } catch { throw new SearchEngineError('response'); }
        if (performance.now() > deadline) throw new SearchEngineError('timeout');
        finish(undefined, { body: parsed, statusCode: response.statusCode, bytes });
      }).catch(error => {
        body?.destroy();
        finish(error instanceof SearchEngineError ? error : new SearchEngineError('transport'));
      });
    } catch { finish(new SearchEngineError('transport')); }
  });
}

function boundedRequest<T>(invoke: (options: SDKOptions) => Abortable,
  cap = RESPONSE_BYTES, budget = REQUEST_MS): Promise<T> {
  return boundedEnvelope<T>(invoke, cap, budget).then(response => response.body);
}

// Test fixtures share the production SDK streaming deadline/cap without a
// second HTTP stack. The helper exports no client or credentials.
export { boundedRequest as boundedSearchSdkRequest };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SearchEngineError('response');
  return value as Record<string, unknown>;
}
function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]));
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function boundedJsonBytes(value: unknown, max: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && Buffer.byteLength(serialized) <= max;
  } catch { return false; }
}

export function verifyProfile(body: unknown): string {
  const index = record(record(body)[SEARCH_INDEX]);
  if (!sameJson(index.mappings, OPENSEARCH_MAPPING)) throw new SearchEngineError('profile', undefined, 'mapping');
  let settings: Record<string, unknown>;
  try { settings = record(record(index.settings).index); }
  catch { throw new SearchEngineError('profile', undefined, 'settings'); }
  const metadata = { ...settings };
  // These four values are created by the engine and cannot define text or
  // filter behavior. Every other index setting must match the fixed profile.
  if (typeof metadata.uuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(metadata.uuid) ||
      typeof metadata.creation_date !== 'string' || !/^\d{1,20}$/.test(metadata.creation_date) ||
      metadata.provided_name !== SEARCH_INDEX) throw new SearchEngineError('profile', undefined, 'settings');
  let version: Record<string, unknown>;
  try { version = record(metadata.version); }
  catch { throw new SearchEngineError('profile', undefined, 'settings'); }
  if (!Object.keys(version).every(key => ['created', 'upgraded'].includes(key)) ||
      typeof version.created !== 'string' || !/^\d{1,20}$/.test(version.created) ||
      (version.upgraded !== undefined && (typeof version.upgraded !== 'string' || !/^\d{1,20}$/.test(version.upgraded))))
    throw new SearchEngineError('profile', undefined, 'settings');
  delete metadata.uuid; delete metadata.creation_date; delete metadata.provided_name; delete metadata.version;
  if (!sameJson(metadata, { number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
    refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
    replication: { type: 'DOCUMENT' } })) throw new SearchEngineError('profile', undefined, 'settings');
  return settings.uuid as string;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new SearchEngineError('profile');
  return [...value].sort();
}
function sameStrings(value: unknown, expected: string[]): boolean {
  return sameJson(strings(value), [...expected].sort());
}
function stripFalseMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value };
  for (const key of ['reserved', 'hidden', 'static']) {
    if (result[key] !== undefined && result[key] !== false) throw new SearchEngineError('profile');
    delete result[key];
  }
  return result;
}
export function verifySecurityConfig(body: unknown): void {
  const root = record(body);
  if (!sameJson(Object.keys(root), ['config'])) throw new SearchEngineError('profile');
  const config = stripFalseMetadata(record(root.config));
  if (config._meta !== undefined && !sameJson(config._meta, { type: 'config', config_version: 2 }))
    throw new SearchEngineError('profile');
  delete config._meta; // The pinned document's type/version metadata carries no grants.
  const dynamic = { ...record(config.dynamic) };
  // Security 3.9.0.0 ConfigV7 materializes these constructor defaults in the
  // REST response. DefaultObjectMapper omits null fields; ConfigV7 annotates
  // sign_in_options NON_EMPTY. Reject every other field or value difference.
  const internalProxies = [
    String.raw`10\.\d{1,3}\.\d{1,3}\.\d{1,3}`,
    String.raw`192\.168\.\d{1,3}\.\d{1,3}`,
    String.raw`169\.254\.\d{1,3}\.\d{1,3}`,
    String.raw`127\.\d{1,3}\.\d{1,3}\.\d{1,3}`,
    String.raw`172\.1[6-9]{1}\.\d{1,3}\.\d{1,3}`,
    String.raw`172\.2[0-9]{1}\.\d{1,3}\.\d{1,3}`,
    String.raw`172\.3[0-1]{1}\.\d{1,3}\.\d{1,3}`,
  ].join('|');
  const expected = {
    filtered_alias_mode: 'warn', disable_rest_auth: false, disable_intertransport_auth: false,
    respect_request_indices_options: false, do_not_fail_on_forbidden: false,
    multi_rolespan_enabled: true, hosts_resolver_mode: 'ip-only', do_not_fail_on_forbidden_empty: false,
    privileges_evaluation_ignore_unauthorized_indices: true,
    kibana: { multitenancy_enabled: true, private_tenant_enabled: true, default_tenant: '',
      preferred_tenants: [], server_username: 'kibanaserver', index: '.kibana' },
    http: { anonymous_auth_enabled: false,
      xff: { enabled: false, internalProxies, remoteIpHeader: 'X-Forwarded-For' } },
    authc: { station_clientcert: { description: 'Station private client certificates', http_enabled: true,
      order: 0, http_authenticator: { type: 'clientcert', challenge: false,
        config: { username_attribute: 'cn' } }, authentication_backend: { type: 'noop', config: {} } } },
    authz: {}, auth_failure_listeners: {}, on_behalf_of: { enabled: false },
    api_tokens: { enabled: false, max_tokens: 100, max_duration_seconds: 7_776_000 },
  };
  if (!sameJson(Object.keys(config), ['dynamic']) || !sameJson(dynamic, expected)) throw new SearchEngineError('profile');
}
function verifyRole(body: unknown, name: 'station_query' | 'station_indexer'): void {
  const root = record(body);
  if (!sameJson(Object.keys(root), [name])) throw new SearchEngineError('profile');
  const role = stripFalseMetadata(record(root[name]));
  const cluster = name === 'station_query' ? ['cluster:monitor/main', 'cluster:monitor/health'] :
    ['cluster:monitor/main', 'cluster:monitor/health', 'indices:data/write/bulk*'];
  const actions = name === 'station_query' ?
    ['indices:data/read/search', 'indices:data/read/get', 'indices:admin/get', 'indices:admin/mappings/get'] :
    ['indices:data/write/index', 'indices:data/write/delete', 'indices:data/write/bulk*',
      'indices:admin/get', 'indices:admin/mappings/get'];
  const permissions = Array.isArray(role.index_permissions) && role.index_permissions.length === 1 ?
    { ...record(role.index_permissions[0]) } : undefined;
  if (!permissions) throw new SearchEngineError('profile');
  for (const [key, empty] of [['dls', ''], ['fls', []], ['masked_fields', []]] as const) {
    if (permissions[key] !== undefined && !sameJson(permissions[key], empty)) throw new SearchEngineError('profile');
    delete permissions[key];
  }
  if (!sameStrings(role.cluster_permissions, cluster) ||
      !sameStrings(permissions.index_patterns, [SEARCH_INDEX]) ||
      !sameStrings(permissions.allowed_actions, actions) ||
      !sameJson(Object.keys(permissions).sort(), ['allowed_actions', 'index_patterns']) ||
      !sameJson(role.tenant_permissions ?? [], []) ||
      !sameJson(Object.keys(role).sort(), ['cluster_permissions', 'index_permissions', 'tenant_permissions'].filter(key => key in role)))
    throw new SearchEngineError('profile');
}
function verifyRoleMapping(body: unknown, name: 'station_query' | 'station_indexer'): void {
  const mapping = stripFalseMetadata(record(record(body)[name]));
  const user = name === 'station_query' ? 'station-search-query' : 'station-search-indexer';
  if (!sameStrings(mapping.users, [user]) ||
      (mapping.backend_roles !== undefined && !sameStrings(mapping.backend_roles, [])) ||
      (mapping.hosts !== undefined && !sameStrings(mapping.hosts, [])) ||
      (mapping.and_backend_roles !== undefined && !sameStrings(mapping.and_backend_roles, [])) ||
      !sameJson(Object.keys(mapping).sort(), ['users', 'backend_roles', 'hosts', 'and_backend_roles'].filter(key => key in mapping).sort()))
    throw new SearchEngineError('profile');
}
export function verifyAllRoleMappings(body: unknown): void {
  const mappings = record(body);
  if (!sameJson(Object.keys(mappings).sort(), ['station_indexer', 'station_query'])) throw new SearchEngineError('profile');
  for (const name of ['station_query', 'station_indexer'] as const) verifyRoleMapping(mappings, name);
}

export function verifyActionGroups(body: unknown): void {
  const groups = record(body);
  const expected = PINNED_STATIC_ACTION_GROUPS as Record<string, { allowed_actions: readonly string[] }>;
  if (!sameJson(Object.keys(groups).sort(), Object.keys(expected).sort())) throw new SearchEngineError('profile');
  for (const [name, pinned] of Object.entries(expected)) {
    const actual = record(groups[name]);
    if (!sameJson(Object.keys(actual).sort(), Object.keys(pinned).sort()) ||
        !sameStrings(actual.allowed_actions, [...pinned.allowed_actions]) ||
        !sameJson({ ...actual, allowed_actions: [] }, { ...pinned, allowed_actions: [] }))
      throw new SearchEngineError('profile');
  }
}

export function verifySearch(body: unknown, size: number): unknown {
  const response = record(body);
  const shards = record(response._shards);
  const total = record(record(response.hits).total);
  const hits = record(response.hits).hits;
  if (response.timed_out !== false || !Number.isSafeInteger(shards.total) || (shards.total as number) < 1 ||
      !Number.isSafeInteger(shards.successful) || !Number.isSafeInteger(shards.failed) || shards.failed !== 0 ||
      shards.successful !== shards.total || total.relation !== 'eq' || !Number.isSafeInteger(total.value) ||
      (total.value as number) < 0 || !Array.isArray(hits) || hits.length > size || hits.length > (total.value as number) ||
      hits.some(hit => {
        if (!hit || typeof hit !== 'object' || Array.isArray(hit)) return true;
        const row = hit as Record<string, unknown>;
        return typeof row._id !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(row._id) || row._index !== SEARCH_INDEX;
      }))
    throw new SearchEngineError('partial');
  return response;
}

async function searchClient(input: { endpoint: string; identityDir: string; role: Role }) {
  const endpoint = assertEndpoint(input.endpoint);
  const identity = await readIdentity(input.identityDir, input.role);
  return new Client({ node: endpoint, ssl: { ...identity, rejectUnauthorized: true },
    maxRetries: 0, requestTimeout: REQUEST_MS, sniffOnStart: false, sniffOnConnectionFault: false,
    sniffInterval: false });
}

export async function openSearchAccess(input: { endpoint: string; identityDir: string; role: Role }) {
  const client = await searchClient(input);
  const json = <T>(invoke: (options: SDKOptions) => Abortable, cap?: number) => boundedRequest<T>(invoke, cap);
  const info = async () => {
    const response = record(await json(options => client.info({}, options) as unknown as Abortable, 32_768));
    const version = record(response.version);
    if (version.distribution !== 'opensearch' || version.number !== SEARCH_ENGINE_VERSION) throw new SearchEngineError('profile');
    return response;
  };
  const health = async () => {
    const response = record(await json(options => client.cluster.health({ wait_for_status: 'yellow', timeout: '3s' }, options) as unknown as Abortable, 32_768));
    if (response.timed_out !== false || !['yellow', 'green'].includes(String(response.status)) || response.number_of_data_nodes !== 1)
      throw new SearchEngineError('partial');
    return response;
  };
  const profile = async () => {
    const response = await json(options => client.indices.get({ index: SEARCH_INDEX }, options) as unknown as Abortable, 128_000);
    return verifyProfile(response);
  };
  const verifySecurity = async () => {
    if (input.role !== 'admin') throw new SearchEngineError('configuration');
    const get = (path: string) => json(options => client.transport.request({ method: 'GET', path }, options) as unknown as Abortable, 128_000);
    const check = async (name: NonNullable<SearchEngineError['check']>, work: () => Promise<void>) => {
      try { await work(); }
      catch (error) {
        if (error instanceof SearchEngineError) throw new SearchEngineError(error.kind, error.statusCode, name);
        throw error;
      }
    };
    await check('config', async () => verifySecurityConfig(await get('/_plugins/_security/api/securityconfig')));
    for (const name of ['station_query', 'station_indexer'] as const) {
      await check(name === 'station_query' ? 'query-role' : 'indexer-role',
        async () => verifyRole(await get(`/_plugins/_security/api/roles/${name}`), name));
    }
    await check('role-mappings', async () => verifyAllRoleMappings(await get('/_plugins/_security/api/rolesmapping')));
    await check('action-groups', async () => verifyActionGroups(await get('/_plugins/_security/api/actiongroups')));
  };
  const createProfileStrict = async () => {
    if (input.role !== 'admin') throw new SearchEngineError('configuration');
    const result = record(await json(options => client.indices.create({ index: SEARCH_INDEX,
      body: { settings: INDEX_SETTINGS, mappings: OPENSEARCH_MAPPING } }, options) as unknown as Abortable, 32_768));
    if (result.acknowledged !== true || result.shards_acknowledged !== true || result.index !== SEARCH_INDEX)
      throw new SearchEngineError('partial');
    return profile();
  };
  const search = async (plan: Extract<SearchCompileResult, { status: 'ok' }>, size = 100) => {
    if (input.role !== 'query' || plan?.status !== 'ok' || plan.profile !== OPENSEARCH_PROFILE ||
        !boundedJsonBytes(plan.query, 65_536) ||
        !Number.isInteger(size) || size < 1 || size > 200) throw new SearchEngineError('configuration');
    const response = await json(options => client.search({ index: SEARCH_INDEX, allow_partial_search_results: false,
      body: { size, track_total_hits: true, timeout: '5s', _source: false, query: plan.query } }, options) as unknown as Abortable, 256_000);
    return verifySearch(response, size);
  };
  const index = async (id: string, document: Record<string, unknown>) => {
    if (input.role !== 'indexer' || !/^[A-Za-z0-9:._-]{1,128}$/.test(id) ||
        !boundedJsonBytes(document, 256_000)) throw new SearchEngineError('configuration');
    const result = record(await json(options => client.index({ index: SEARCH_INDEX, id, body: document, refresh: 'wait_for' }, options) as unknown as Abortable, 32_768));
    if (!['created', 'updated'].includes(String(result.result)) || record(result._shards).failed !== 0) throw new SearchEngineError('partial');
  };
  const remove = async (id: string) => {
    if (input.role !== 'indexer' || !/^[A-Za-z0-9:._-]{1,128}$/.test(id)) throw new SearchEngineError('configuration');
    const result = record(await json(options => client.delete({ index: SEARCH_INDEX, id, refresh: 'wait_for' }, options) as unknown as Abortable, 32_768));
    if (!['deleted', 'not_found'].includes(String(result.result)) || record(result._shards).failed !== 0) throw new SearchEngineError('partial');
  };
  const bulk = async (documents: readonly { id: string; document: Record<string, unknown> }[]) => {
    if (input.role !== 'indexer' || documents.length < 1 || documents.length > 100 ||
        documents.some(row => !/^[A-Za-z0-9:._-]{1,128}$/.test(row.id)) ||
        !boundedJsonBytes(documents, 256_000)) throw new SearchEngineError('configuration');
    const operations = documents.flatMap(row => [{ index: { _index: SEARCH_INDEX, _id: row.id } }, row.document]);
    const result = record(await json(options => client.bulk({ body: operations, refresh: 'wait_for' }, options) as unknown as Abortable, 256_000));
    if (result.errors !== false || !Array.isArray(result.items) || result.items.length !== documents.length ||
        result.items.some(item => { const entry = record(record(item).index); return ![200, 201].includes(Number(entry.status)); }))
      throw new SearchEngineError('partial');
    return result;
  };
  const refresh = async () => {
    if (input.role !== 'admin') throw new SearchEngineError('configuration');
    const result = record(await json(options => client.indices.refresh({ index: SEARCH_INDEX }, options) as unknown as Abortable, 32_768));
    const shards = record(result._shards);
    if (shards.failed !== 0 || shards.successful !== shards.total) throw new SearchEngineError('partial');
  };
  return { info, health, profile, verifySecurity, createProfileStrict, search, index, remove, bulk, refresh,
    close: () => client.close() };
}

const OBSERVE_MS = 20_000;
const OBSERVE_BYTES = 4 * 1024 * 1024;
const APP_PATTERN = 'station-mail-*';
const APP_NAME = /^station-mail-[a-z0-9_-]{1,128}$/;

// Only this fixed alias request may turn a bounded 404 body into empty evidence.
function emptyAlias404(value: unknown): boolean {
  const response = record(value);
  if (response.status !== 404 || !sameJson(Object.keys(response).sort(), ['error', 'status'])) return false;
  const reason = `aliases [${APP_PATTERN}] missing`;
  if (response.error === `alias [${APP_PATTERN}] missing`) return true;
  const error = record(response.error);
  if (error.type !== 'aliases_not_found_exception' || error.reason !== reason ||
      !Array.isArray(error.root_cause) || error.root_cause.length !== 1) return false;
  const cause = record(error.root_cause[0]);
  const check = (part: Record<string, unknown>) =>
    part.type === 'aliases_not_found_exception' && part.reason === reason &&
    part['resource.type'] === 'aliases' && part['resource.id'] === APP_PATTERN &&
    sameJson(Object.keys(part).sort(), ['reason', 'resource.id', 'resource.type', 'type']);
  const summary = Object.fromEntries(Object.entries(error).filter(([key]) => key !== 'root_cause'));
  return check(cause) && check(summary) &&
    sameJson(Object.keys(error).sort(), ['reason', 'resource.id', 'resource.type', 'root_cause', 'type']);
}

/** One registry-free, admin-TLS, GET-only observation; no SDK or path is exposed. */
export async function openSearchAdminObserver(input: { endpoint: string; identityDir: string }) {
  const client = await searchClient({ ...input, role: 'admin' });
  const observe = async () => {
    const budget = observerBudget({ milliseconds: OBSERVE_MS, bytes: OBSERVE_BYTES },
      () => performance.now(), kind => { throw new SearchEngineError(kind); });
    let names = 0;
    const check = budget.check;
    const read = async <T>(invoke: (options: SDKOptions) => Abortable, cap: number, alias404 = false) => {
      const remaining = budget.remaining(REQUEST_MS);
      const result = await boundedEnvelope<T>(invoke, cap, remaining, {
        ...(alias404 ? { alias404: true as const } : {}),
        onChunk: bytes => budget.chunk(bytes),
      });
      check();
      return result;
    };
    const info = record((await read(options => client.info({}, options) as unknown as Abortable, 32_768)).body);
    const version = record(info.version);
    if (version.distribution !== 'opensearch' || version.number !== SEARCH_ENGINE_VERSION)
      throw new SearchEngineError('profile');
    check();
    const health = record((await read(options => client.cluster.health({ wait_for_status: 'yellow', timeout: '3s' }, options) as unknown as Abortable,
      32_768)).body);
    if (health.timed_out !== false || typeof health.status !== 'string' ||
        !['yellow', 'green'].includes(health.status) ||
        health.number_of_data_nodes !== 1) throw new SearchEngineError('partial');
    check();
    const indexes = record((await read(options => client.indices.get({ index: APP_PATTERN,
      expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: false, include_defaults: false }, options) as unknown as Abortable,
      RESPONSE_BYTES)).body);
    const physical = Object.keys(indexes).sort();
    if (physical.length > 512 || physical.some(name => {
      if (!APP_NAME.test(name)) return true;
      const value = record(indexes[name]);
      if (!sameJson(Object.keys(value).sort(), ['aliases', 'mappings', 'settings']) ||
          !sameJson(Object.keys(record(value.aliases)), [])) return true;
      record(value.mappings);
      const settings = record(record(value.settings).index);
      return typeof settings.uuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(settings.uuid) ||
        settings.provided_name !== name;
    }))
      throw new SearchEngineError('response');
    names += physical.length;
    check();
    const resolved = record((await read(options => client.indices.resolveIndex({ name: APP_PATTERN,
      expand_wildcards: 'all' }, options) as unknown as Abortable, 128_000)).body);
    if (!sameJson(Object.keys(resolved).sort(), ['aliases', 'data_streams', 'indices']) ||
        !Array.isArray(resolved.aliases) || !Array.isArray(resolved.data_streams) ||
        !Array.isArray(resolved.indices) || resolved.aliases.length || resolved.data_streams.length ||
        resolved.indices.length > 512) throw new SearchEngineError('response');
    const resolvedNames = resolved.indices.map(item => {
      const value = record(item);
      if (!sameJson(Object.keys(value).sort(), ['attributes', 'name']) ||
          !Array.isArray(value.attributes) || value.attributes.length < 1 || value.attributes.length > 2 ||
          value.attributes.some(attribute => typeof attribute !== 'string' ||
            !['open', 'closed', 'hidden'].includes(attribute)) ||
          new Set(value.attributes).size !== value.attributes.length ||
          !value.attributes.includes('open') || value.attributes.includes('closed'))
        throw new SearchEngineError('response');
      return value.name;
    });
    if (resolvedNames.some(name => typeof name !== 'string' || !APP_NAME.test(name)) ||
        new Set(resolvedNames).size !== resolvedNames.length ||
        !sameJson([...resolvedNames].sort(), physical)) throw new SearchEngineError('response');
    names += resolvedNames.length;
    check();
    const alias = await read(options => client.indices.getAlias({ name: APP_PATTERN,
      expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: false }, options) as unknown as Abortable,
      128_000, true);
    if (alias.statusCode === 404) {
      if (!emptyAlias404(alias.body)) throw new SearchEngineError('response');
    } else if (alias.statusCode !== 200 || Object.keys(record(alias.body)).length !== 0)
      throw new SearchEngineError('response');
    check();
    const get = (path: string, cap: number) => read(options => client.transport.request({ method: 'GET', path }, options) as unknown as Abortable,
      cap).then(result => result.body);
    const roles = record(await get('/_plugins/_security/api/roles', 128_000));
    const mappings = record(await get('/_plugins/_security/api/rolesmapping', 128_000));
    if (Object.keys(roles).length > 512 || Object.keys(mappings).length > 512)
      throw new SearchEngineError('response');
    names += Object.keys(roles).length + Object.keys(mappings).length;
    if (names > 2_048) throw new SearchEngineError('response');
    check();
    verifySecurityConfig(await get('/_plugins/_security/api/securityconfig', 128_000));
    check();
    verifyActionGroups(await get('/_plugins/_security/api/actiongroups', 128_000));
    check();
    return { indexes, roles, mappings };
  };
  return { observe, close: () => client.close() };
}
