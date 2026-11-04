import { createHash } from 'node:crypto';
import { buildExpectedSecurityPolicy, compareObservedSecurityCollections,
  type RegistryExpectedInput, type SecurityComparison, type SecurityPolicy } from './opensearch-generation-policy.js';
import { verifyProfile } from './opensearch-runtime.js';
import { verifyV2IndexProfile } from './opensearch-v2-profile.js';

type Candidate = Readonly<{ token: string; index: string; profile: 'station-mail-v2';
  uuid: string; writerRole: string }>;
type Dispatch = Readonly<{ target: string; bodyIdentity: string }>;
type RoleBody = Readonly<{ cluster_permissions: readonly string[];
  index_permissions: readonly Readonly<{ index_patterns: readonly string[];
    allowed_actions: readonly string[] }>[]; tenant_permissions: readonly never[] }>;
export type WriterRoleContract = Readonly<{ target: string; index: string; uuid: string;
  body: RoleBody; bodySha256: string; dispatchBodyIdentity: string;
  prior: RegistryExpectedInput; prePolicy: SecurityPolicy; postPolicy: SecurityPolicy }>;

const token = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const engineUuid = /^[A-Za-z0-9_-]{1,128}$/;
const digest = /^[0-9a-f]{64}$/;
const issued = new WeakSet<object>();
const invalid = (): never => { throw new Error('Invalid private writer role contract'); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) invalid();
  return value as Record<string, unknown>;
};
function safeJson(value: unknown, seen = new Set<object>(), depth = 0,
  budget = { nodes: 0, bytes: 0 }): void {
  if (++budget.nodes > 60_000 || depth > 12) invalid();
  if (value === null || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isSafeInteger(value)) return;
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > 2 * 1024 * 1024) invalid();
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value) ||
      Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) invalid();
  const node = value as object;
  seen.add(node);
  const keys = Reflect.ownKeys(node);
  if (keys.length > 1025 || keys.some(key => typeof key !== 'string')) invalid();
  if (Array.isArray(value) && (value.length > 1024 ||
      Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, i) => key !== String(i)))) invalid();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable || !('value' in descriptor) || key.length > 256) invalid();
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > 2 * 1024 * 1024) invalid();
    safeJson(descriptor.value, seen, depth + 1, budget);
  }
  seen.delete(node);
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Pure, fixed writer role body. Metadata identity and complete body digest are separate. */
export function deriveWriterRoleRequest(proposed: Candidate): Readonly<{
  target: string; body: RoleBody; bodySha256: string; dispatchBodyIdentity: string }> {
  safeJson(proposed);
  const c = exact(proposed, ['token', 'index', 'profile', 'uuid', 'writerRole']);
  if (typeof c.token !== 'string' || !token.test(c.token) ||
      typeof c.uuid !== 'string' || !engineUuid.test(c.uuid) ||
      c.profile !== 'station-mail-v2' || typeof c.index !== 'string' ||
      typeof c.writerRole !== 'string') invalid();
  const candidate = c as unknown as Candidate;
  const suffix = candidate.token.replaceAll('-', '').toLowerCase();
  if (c.index !== `station-mail-v2-g${suffix}` ||
      c.writerRole !== `station_indexer_${suffix}`) invalid();
  const indexActions = ['indices:data/write/index', 'indices:data/read/get',
    'indices:data/write/bulk[s]'];
  const clusterActions = ['indices:data/write/bulk'];
  const metadata = { operation: 'writer_role', target: c.writerRole, index: c.index,
    profile: c.profile, principal: null, actions: null,
    clusterActions, indexActions };
  const dispatchBodyIdentity = hash(metadata);
  const body = { cluster_permissions: clusterActions,
    index_permissions: [{ index_patterns: [c.index], allowed_actions: indexActions }],
    tenant_permissions: [] } as RoleBody;
  return freeze({ target: candidate.writerRole, body,
    bodySha256: hash(body), dispatchBodyIdentity });
}

export function buildWriterRoleContract(prior: RegistryExpectedInput,
  proposed: Candidate, stored: Dispatch): WriterRoleContract {
  safeJson(stored);
  const d = exact(stored, ['target', 'bodyIdentity']);
  if (typeof d.bodyIdentity !== 'string' || !digest.test(d.bodyIdentity)) invalid();
  const candidate = exact(proposed, ['token', 'index', 'profile', 'uuid', 'writerRole']) as unknown as Candidate;
  const request = deriveWriterRoleRequest(candidate);
  if (d.target !== request.target || d.bodyIdentity !== request.dispatchBodyIdentity) invalid();
  const prePolicy = buildExpectedSecurityPolicy(prior);
  const suffix = candidate.token.replaceAll('-', '').toLowerCase();
  if (prior.generations.some(row => row.token === candidate.token || row.index === candidate.index ||
      row.writerRole === candidate.writerRole || row.queryRole === `station_query_${suffix}`)) invalid();
  const roles = { ...prePolicy.roles, [candidate.writerRole]: request.body };
  const postPolicy = { version: prePolicy.version, roles,
    mappings: { ...prePolicy.mappings } } as SecurityPolicy;
  // Reuse the comparator's strict JSON and size limits for the staged policy.
  if (compareObservedSecurityCollections(postPolicy, roles, postPolicy.mappings) !== 'exact') invalid();
  const result = freeze({ target: candidate.writerRole, index: candidate.index, uuid: candidate.uuid,
    body: request.body, bodySha256: request.bodySha256,
    dispatchBodyIdentity: request.dispatchBodyIdentity, prior: structuredClone(prior),
    prePolicy, postPolicy });
  issued.add(result);
  return result;
}

/** Return only the fixed request from a constructor-issued, same-process contract. */
export function issuedWriterRoleRequest(contract: WriterRoleContract): Readonly<{
  target: string; body: RoleBody; bodySha256: string; dispatchBodyIdentity: string }> {
  if (!contract || typeof contract !== 'object' || !issued.has(contract)) invalid();
  return Object.freeze({ target: contract.target, body: contract.body,
    bodySha256: contract.bodySha256, dispatchBodyIdentity: contract.dispatchBodyIdentity });
}

/** Only same-process constructor output is accepted; serialized callers must reconstruct it.
 * Complete visible evidence still requires separate pinned-engine hidden-resource proof. */
export function compareWriterRoleStage(contract: WriterRoleContract, observed: unknown,
  stage: 'pre' | 'post'): SecurityComparison {
  try {
    if (!contract || typeof contract !== 'object' || !issued.has(contract)) invalid();
    if (stage !== 'pre' && stage !== 'post') invalid();
    safeJson(observed);
    if (Buffer.byteLength(JSON.stringify(observed), 'utf8') > 2 * 1024 * 1024) invalid();
    const root = exact(observed, ['indexes', 'roles', 'mappings']);
    const indexes = root.indexes;
    if (!indexes || typeof indexes !== 'object' || Array.isArray(indexes) ||
        Object.getPrototypeOf(indexes) !== Object.prototype) invalid();
    const expectedNames = [...contract.prior.generations.filter(row => row.presence === 'exact')
      .map(row => row.index), contract.index].sort();
    if (JSON.stringify(Object.keys(indexes as object).sort()) !== JSON.stringify(expectedNames)) invalid();
    for (const row of contract.prior.generations.filter(row => row.presence === 'exact')) {
      const entry = exact((indexes as Record<string, unknown>)[row.index],
        ['aliases', 'mappings', 'settings']);
      if (Object.keys(exact(entry.aliases, [])).length !== 0) invalid();
      const body = { [row.index]: entry };
      const actual = row.profile === 'station-mail-v1' ? verifyProfile(body) :
        verifyV2IndexProfile(body, row.index, row.uuid);
      if (actual !== row.uuid) invalid();
    }
    const entry = exact((indexes as Record<string, unknown>)[contract.index],
      ['aliases', 'mappings', 'settings']);
    if (Object.keys(exact(entry.aliases, [])).length !== 0) invalid();
    if (verifyV2IndexProfile({ [contract.index]: entry }, contract.index,
    contract.uuid) !== contract.uuid) invalid();
    return compareObservedSecurityCollections(stage === 'pre' ? contract.prePolicy :
      contract.postPolicy, root.roles, root.mappings);
  } catch { return 'mismatch'; }
}
