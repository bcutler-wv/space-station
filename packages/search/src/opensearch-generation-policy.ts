import { staticRoles } from './opensearch-static-roles.js';

type Generation = Readonly<{
  token: string; index: string; profile: 'station-mail-v1' | 'station-mail-v2';
  presence: 'exact' | 'absent'; uuid: string | null;
  writerRole: string | null; queryRole: string | null;
  writerPrincipal: string | null; queryPrincipal: string | null;
  writerCertFingerprint: string | null; queryCertFingerprint: string | null;
}>;
export type RegistryExpectedInput = Readonly<{
  version: 'station-generation-registry-v1'; generations: readonly Generation[];
}>;
export type SecurityPolicy = Readonly<{
  version: 'opensearch-3.9.0.0-station-v2';
  roles: Readonly<Record<string, unknown>>; mappings: Readonly<Record<string, unknown>>;
}>;
export type SecurityComparison = 'exact' | 'mismatch' | 'limit';

const MAX_EXPECTED = 256 * 1024;
const MAX_OBSERVED = 128 * 1024;
const MAX_NAMES = 512;
const MAX_ARRAY = 128;
const MAX_STRING = 1024;
const token = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const indexName = /^station-mail-v2-g[a-z0-9]{16,64}$/;
const engineUuid = /^[A-Za-z0-9_-]{1,128}$/;
const fingerprint = /^[0-9a-f]{64}$/;
class Limit extends Error { constructor() { super('limit'); } }
class Mismatch extends Error { constructor() { super('mismatch'); } }
const limit = (): never => { throw new Limit(); };
const mismatch = (): never => { throw new Mismatch(); };
const text = (value: unknown): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_STRING;

// Inspect descriptors before serializing or reading values. The boundary is
// JSON-only: Dates, callbacks, accessors and custom prototypes are invalid.
function safe(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 8) limit();
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') { if (!text(value)) limit(); return; }
  if (!value || typeof value !== 'object' || value instanceof Date) mismatch();
  const object = value as object;
  if (seen.has(object)) mismatch();
  if (Array.isArray(object) && Object.getPrototypeOf(object) !== Array.prototype) mismatch();
  if (!Array.isArray(object) && Object.getPrototypeOf(object) !== Object.prototype) mismatch();
  if (Array.isArray(object) && (object.length > MAX_NAMES ||
      Object.keys(object).length !== object.length ||
      Object.keys(object).some((key, i) => key !== String(i)))) limit();
  const keys = Reflect.ownKeys(object);
  if (keys.length > MAX_NAMES + (Array.isArray(object) ? 1 : 0)) limit();
  if (keys.some(key => typeof key === 'symbol')) mismatch();
  seen.add(object);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(object))) {
    if (Array.isArray(object) && key === 'length') continue;
    if (!descriptor.enumerable || !('value' in descriptor)) mismatch();
    if (!text(key)) limit();
    safe(descriptor.value, seen, depth + 1);
  }
  seen.delete(object);
}
function bounded(value: unknown, max: number): void {
  safe(value);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > max) limit();
}
function record(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) mismatch();
  const result = value as Record<string, unknown>;
  if (allowed && Object.keys(result).some(key => !allowed.includes(key))) mismatch();
  return result;
}
function list(value: unknown, omitted = false): string[] {
  if (omitted && value === undefined) return [];
  if (!Array.isArray(value)) mismatch();
  const items = value as unknown[];
  if (items.length > MAX_ARRAY) limit();
  if (!items.every(item => text(item)) || new Set(items).size !== items.length) mismatch();
  return [...items as string[]].sort();
}
function flag(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') mismatch();
  return value as boolean;
}
function description(value: unknown): string | null {
  if (value === undefined) return null;
  if (!text(value)) mismatch();
  return value as string;
}
function entries(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) mismatch();
  const items = value as unknown[];
  if (items.length > MAX_ARRAY) limit();
  return items.map(item => record(item));
}
function empty(value: unknown, expected: '' | []): void {
  if (value === undefined) return;
  if (expected === '' ? value !== '' : !Array.isArray(value) || value.length !== 0) mismatch();
}
function normalizedRole(value: unknown): unknown {
  const role = record(value, ['reserved', 'hidden', 'static', 'description',
    'cluster_permissions', 'index_permissions', 'tenant_permissions']);
  const index = entries(role.index_permissions).map(entry => {
    const item = record(entry, ['index_patterns', 'allowed_actions', 'dls', 'fls', 'masked_fields']);
    empty(item.dls, ''); empty(item.fls, []); empty(item.masked_fields, []);
    return { index_patterns: list(item.index_patterns), allowed_actions: list(item.allowed_actions) };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const tenant = entries(role.tenant_permissions).map(entry => {
    const item = record(entry, ['tenant_patterns', 'allowed_actions']);
    return { tenant_patterns: list(item.tenant_patterns), allowed_actions: list(item.allowed_actions) };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { reserved: flag(role.reserved), hidden: flag(role.hidden), static: flag(role.static),
    description: description(role.description), cluster_permissions: list(role.cluster_permissions, true),
    index_permissions: index, tenant_permissions: tenant };
}
function normalizedMapping(value: unknown): unknown {
  const mapping = record(value, ['reserved', 'hidden', 'static', 'description',
    'users', 'backend_roles', 'and_backend_roles', 'hosts']);
  return { reserved: flag(mapping.reserved), hidden: flag(mapping.hidden), static: flag(mapping.static),
    description: description(mapping.description), users: list(mapping.users, true),
    backend_roles: list(mapping.backend_roles, true),
    and_backend_roles: list(mapping.and_backend_roles, true), hosts: list(mapping.hosts, true) };
}

const v1Roles = {
  station_query: { cluster_permissions: ['cluster:monitor/main', 'cluster:monitor/health'],
    index_permissions: [{ index_patterns: ['station-mail-v1'], allowed_actions: [
      'indices:data/read/search', 'indices:data/read/get', 'indices:admin/get', 'indices:admin/mappings/get'] }] },
  station_indexer: { cluster_permissions: ['cluster:monitor/main', 'cluster:monitor/health',
    'indices:data/write/bulk*'], index_permissions: [{ index_patterns: ['station-mail-v1'], allowed_actions: [
      'indices:data/write/index', 'indices:data/write/delete', 'indices:data/write/bulk*',
      'indices:admin/get', 'indices:admin/mappings/get'] }] },
};
const mapping = (principal: string) => ({ users: [principal], backend_roles: [], hosts: [] });
const v1Mappings = { station_query: mapping('station-search-query'),
  station_indexer: mapping('station-search-indexer') };
const role = (index: string, kind: 'writer' | 'query') => ({
  cluster_permissions: kind === 'writer' ? ['indices:data/write/bulk'] : [], tenant_permissions: [],
  index_permissions: [{ index_patterns: [index], allowed_actions: kind === 'writer' ?
    ['indices:data/write/index', 'indices:data/read/get', 'indices:data/write/bulk[s]'] :
    ['indices:data/read/search', 'indices:data/read/get'] }],
});

/** A ready registry input only; construction never observes the engine. */
export function buildExpectedSecurityPolicy(input: RegistryExpectedInput): SecurityPolicy {
  bounded(input, MAX_EXPECTED);
  const root = record(input, ['version', 'generations']);
  if (root.version !== 'station-generation-registry-v1' || !Array.isArray(root.generations) ||
      root.generations.length > MAX_NAMES) mismatch();
  // Each policy owns its values. A caller changing a returned object must not
  // change the pinned baseline used by a later attestation.
  const roles: Record<string, unknown> = { ...structuredClone(staticRoles), ...structuredClone(v1Roles) };
  const mappings: Record<string, unknown> = structuredClone(v1Mappings);
  const seen = new Set<string>();
  const seenIndexes = new Set<string>();
  let legacy = false;
  const rows = [...root.generations as unknown[]];
  if (!rows.every(value => typeof record(value).token === 'string')) mismatch();
  rows.sort((a, b) => (a as { token: string }).token.localeCompare((b as { token: string }).token));
  for (const value of rows) {
    const row = record(value, ['token', 'index', 'profile', 'presence', 'uuid', 'writerRole',
      'queryRole', 'writerPrincipal', 'queryPrincipal', 'writerCertFingerprint', 'queryCertFingerprint']);
    if (typeof row.token !== 'string' || seen.has(row.token)) mismatch();
    seen.add(row.token as string);
    if (typeof row.index !== 'string' || seenIndexes.has(row.index)) mismatch();
    seenIndexes.add(row.index as string);
    if (row.token === 'legacy-v1') {
      if (legacy || row.index !== 'station-mail-v1' || row.profile !== 'station-mail-v1' ||
          row.presence !== 'exact' || typeof row.uuid !== 'string' || !engineUuid.test(row.uuid) ||
          row.writerRole !== null || row.queryRole !== null || row.writerPrincipal !== null ||
          row.queryPrincipal !== null || row.writerCertFingerprint !== null ||
          row.queryCertFingerprint !== null) mismatch();
      legacy = true;
      continue;
    }
    if (!token.test(row.token as string) || typeof row.index !== 'string' || !indexName.test(row.index as string) ||
        row.profile !== 'station-mail-v2' || !['exact', 'absent'].includes(String(row.presence))) mismatch();
    const suffix = (row.token as string).replaceAll('-', '').toLowerCase();
    if (row.writerRole !== `station_indexer_${suffix}` || row.queryRole !== `station_query_${suffix}` ||
        row.writerPrincipal !== `station-search-indexer-${suffix}` ||
        row.queryPrincipal !== `station-search-query-${suffix}`) mismatch();
    if (row.presence === 'absent') {
      if (row.uuid !== null || row.writerCertFingerprint !== null || row.queryCertFingerprint !== null)
        mismatch();
      continue;
    }
    if (typeof row.uuid !== 'string' || !engineUuid.test(row.uuid) ||
        typeof row.writerCertFingerprint !== 'string' || !fingerprint.test(row.writerCertFingerprint) ||
        typeof row.queryCertFingerprint !== 'string' || !fingerprint.test(row.queryCertFingerprint)) mismatch();
    if (Object.hasOwn(roles, row.writerRole as string) || Object.hasOwn(roles, row.queryRole as string)) mismatch();
    roles[row.writerRole as string] = role(row.index as string, 'writer');
    roles[row.queryRole as string] = role(row.index as string, 'query');
    mappings[row.writerRole as string] = mapping(row.writerPrincipal as string);
    mappings[row.queryRole as string] = mapping(row.queryPrincipal as string);
  }
  if (!legacy) mismatch();
  const result = { version: 'opensearch-3.9.0.0-station-v2' as const, roles, mappings };
  bounded(result, MAX_EXPECTED);
  return result;
}

/** Exact complete collections; result never contains observed names or values. */
export function compareObservedSecurityCollections(policy: SecurityPolicy,
  actualRoles: unknown, actualMappings: unknown): SecurityComparison {
  try {
    bounded(policy, MAX_EXPECTED);
    bounded(actualRoles, MAX_OBSERVED);
    bounded(actualMappings, MAX_OBSERVED);
    const expected = record(policy, ['version', 'roles', 'mappings']);
    if (expected.version !== 'opensearch-3.9.0.0-station-v2') mismatch();
    const compare = (wanted: unknown, observed: unknown, normalize: (value: unknown) => unknown) => {
      const a = record(wanted), b = record(observed);
      if (Object.keys(a).length > MAX_NAMES || Object.keys(b).length > MAX_NAMES) limit();
      const names = Object.keys(a).sort();
      if (JSON.stringify(names) !== JSON.stringify(Object.keys(b).sort())) mismatch();
      for (const name of names)
        if (JSON.stringify(normalize(a[name])) !== JSON.stringify(normalize(b[name]))) mismatch();
    };
    compare(expected.roles, actualRoles, normalizedRole);
    compare(expected.mappings, actualMappings, normalizedMapping);
    return 'exact';
  } catch (error) { return error instanceof Limit ? 'limit' : 'mismatch'; }
}
