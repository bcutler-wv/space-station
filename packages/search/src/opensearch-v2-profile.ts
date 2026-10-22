import { OPENSEARCH_MAPPING_V2, OPENSEARCH_PROFILE_V2 } from './opensearch-compiler.js';

const physicalName = /^station-mail-v2-g[a-z0-9]{16,64}$/;
const engineUuid = /^[A-Za-z0-9_-]{1,128}$/;
const digits = /^\d{1,20}$/;
const responseCap = 128 * 1024;
const settings = Object.freeze({ number_of_shards: 1, number_of_replicas: 0,
  max_result_window: 200, refresh_interval: '1s',
  mapping: Object.freeze({ total_fields: Object.freeze({ limit: 64 }) }),
  replication: Object.freeze({ type: 'DOCUMENT' }) });
const observedSettings = { number_of_shards: '1', number_of_replicas: '0',
  max_result_window: '200', refresh_interval: '1s',
  mapping: { total_fields: { limit: '64' } }, replication: { type: 'DOCUMENT' } };
const invalid = (): never => { throw new Error('Invalid private v2 index profile'); };

function plain(value: unknown, depth = 0,
  budget = { nodes: 0, bytes: 0, seen: new Set<object>() }): void {
  if (++budget.nodes > 4096) invalid();
  if (depth > 8) invalid();
  if (value === null || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > responseCap) invalid();
    return;
  }
  if (!value || typeof value !== 'object' || budget.seen.has(value) ||
      Object.getPrototypeOf(value) !== Object.prototype &&
      (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)) invalid();
  const node = value as object;
  budget.seen.add(node);
  const keys = Reflect.ownKeys(node);
  if (keys.length > 1025 || keys.some(key => typeof key !== 'string')) invalid();
  budget.bytes += 16 * keys.length;
  if (budget.bytes > responseCap) invalid();
  if (Array.isArray(value) && (value.length > 1024 || Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, i) => key !== String(i)))) invalid();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable || !('value' in descriptor) || key.length > 256) invalid();
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > responseCap) invalid();
    plain(descriptor.value, depth + 1, budget);
  }
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function equal(left: unknown, right: unknown): boolean {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)])) : value;
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

/** The frozen v2 create body; each caller gets its own mutable copy. */
export function createV2IndexBody(physicalIndex: string): { settings: typeof settings; mappings: typeof OPENSEARCH_MAPPING_V2 } {
  if (typeof physicalIndex !== 'string' || !physicalName.test(physicalIndex)) invalid();
  return { settings: structuredClone(settings), mappings: structuredClone(OPENSEARCH_MAPPING_V2) };
}

/** Compare a bounded GET response against the frozen definition, never against a previous GET. */
export function verifyV2IndexProfile(body: unknown, physicalIndex: string, boundUuid: string | null): string {
  if (typeof physicalIndex !== 'string' || !physicalName.test(physicalIndex) ||
      boundUuid !== null && (typeof boundUuid !== 'string' || !engineUuid.test(boundUuid))) invalid();
  plain(body);
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > responseCap) invalid();
  const root = object(body, [physicalIndex]);
  if (Object.keys(root).length !== 1) invalid();
  const index = object(root[physicalIndex], ['aliases', 'mappings', 'settings']);
  if (!equal(index.mappings, OPENSEARCH_MAPPING_V2)) invalid();
  if (index.aliases !== undefined && !equal(index.aliases, {})) invalid();
  const settingsRoot = object(index.settings, ['index']);
  const metadata = object(settingsRoot.index, [...Object.keys(observedSettings),
    'uuid', 'creation_date', 'provided_name', 'version']);
  if (typeof metadata.uuid !== 'string' || !engineUuid.test(metadata.uuid) ||
      boundUuid !== null && metadata.uuid !== boundUuid ||
      typeof metadata.creation_date !== 'string' || !digits.test(metadata.creation_date) ||
      metadata.provided_name !== physicalIndex) invalid();
  const version = object(metadata.version, ['created', 'upgraded']);
  if (typeof version.created !== 'string' || !digits.test(version.created) ||
      version.upgraded !== undefined && (typeof version.upgraded !== 'string' || !digits.test(version.upgraded))) invalid();
  const semantic = { ...metadata };
  for (const key of ['uuid', 'creation_date', 'provided_name', 'version']) delete semantic[key];
  if (!equal(semantic, observedSettings)) invalid();
  return metadata.uuid as string;
}

export const V2_INDEX_PROFILE_ID = OPENSEARCH_PROFILE_V2;
