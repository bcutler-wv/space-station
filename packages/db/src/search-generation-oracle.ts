import type { searchGenerationControl, searchGenerationDispatch, searchGenerationHistory } from './schema.js';
import { buildSearchGenerationManifest, searchGenerationDispatchSpec,
  type SearchGenerationOperation } from './search-generation-manifest.js';

type Control = typeof searchGenerationControl.$inferSelect;
type History = typeof searchGenerationHistory.$inferSelect;
type Dispatch = typeof searchGenerationDispatch.$inferSelect;

export type RegistryExpected = Readonly<{ version: 'station-generation-registry-v1'; generations: readonly Readonly<{
  token: string; index: string; profile: 'station-mail-v1' | 'station-mail-v2';
  presence: 'exact' | 'absent'; uuid: string | null;
  writerRole: string | null; queryRole: string | null;
  writerPrincipal: string | null; queryPrincipal: string | null;
  writerCertFingerprint: string | null; queryCertFingerprint: string | null;
}>[] }>;
export type RegistryResult =
  | Readonly<{ status: 'ready'; expected: RegistryExpected }>
  | Readonly<{ status: 'incomplete'; reason: 'unenrolled_v1' | 'historical_partial' |
      'transition_in_progress' | 'armed' | 'sent_unknown' |
      'confirmed_awaiting_advance' | 'quiesced_awaiting_evidence' }>
  | Readonly<{ status: 'incident'; reason: 'unavailable' | 'abandoned_unresolved' |
      'registry_mismatch' | 'stale_dispatch' | 'limit' }>;

const LIMIT_BYTES = 256 * 1024;
const operations = ['create_index', 'writer_role', 'writer_mapping', 'query_role', 'query_mapping'] as const;
const stages = [
  'disabled_intent', 'create_requested', 'uuid_bound', 'writer_role_requested',
  'writer_role_attested', 'writer_mapping_requested', 'writer_attested',
  'query_role_requested', 'query_role_attested', 'query_mapping_requested', 'roles_attested',
] as const;
const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const engineUuid = /^[A-Za-z0-9_-]{1,128}$/;
const fingerprint = /^[0-9a-f]{64}$/;
const hash = /^[0-9a-f]{64}$/;
const controlKeys = ['singleton', 'revision', 'stage', 'transitionToken', 'sourceGenerationToken',
  'generationToken', 'physicalIndex', 'indexUuid', 'profileId', 'publicationEnabled', 'servingReady', 'updatedAt'];
const historyKeys = ['generationToken', 'physicalIndex', 'profileId', 'indexUuid', 'lifecycle',
  'writerRole', 'queryRole', 'writerPrincipal', 'queryPrincipal', 'writerCertFingerprint',
  'queryCertFingerprint', 'createdAt'];
const dispatchKeys = ['generationToken', 'operation', 'dispatchId', 'ownerId', 'target',
  'bodyIdentity', 'state', 'createdAt'];

class OracleFailure extends Error {
  constructor(readonly reason: Extract<RegistryResult, { status: 'incident' }>['reason']) { super('registry'); }
}
const fail = (reason: OracleFailure['reason']): never => { throw new OracleFailure(reason); };
const validString = (value: unknown, max = 128): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max;
const optionalString = (value: unknown, max = 128): value is string | null =>
  value === null || validString(value, max);
const exactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const isDate = (value: unknown): value is Date =>
  value instanceof Date && Object.getPrototypeOf(value) === Date.prototype &&
  Reflect.ownKeys(value).length === 0 && Number.isFinite(Date.prototype.getTime.call(value));

// Validate descriptors before JSON serialization so getters, cycles and non-plain
// values cannot execute code or be silently dropped by JSON.stringify.
function safeJson(value: unknown, visited = new Set<object>(), depth = 0): void {
  if (depth > 5) fail('limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail('registry_mismatch');
  if (isDate(value)) return;
  if (value instanceof Date) fail('registry_mismatch');
  const object = value as object;
  if (visited.has(object)) fail('registry_mismatch');
  if (Array.isArray(object) && Object.getPrototypeOf(object) !== Array.prototype)
    fail('registry_mismatch');
  if (!Array.isArray(object) && Object.getPrototypeOf(object) !== Object.prototype)
    fail('registry_mismatch');
  if (Array.isArray(object) && (Object.keys(object).length !== object.length ||
      Object.keys(object).some((key, index) => key !== String(index))))
    fail('registry_mismatch');
  visited.add(object);
  const descriptors = Object.getOwnPropertyDescriptors(object);
  if (Object.getOwnPropertySymbols(object).length || Object.keys(descriptors).length > 2_600)
    fail('limit');
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(object) && key === 'length') continue;
    if (!('value' in descriptor) || !descriptor.enumerable) fail('registry_mismatch');
    safeJson(descriptor.value, visited, depth + 1);
  }
  visited.delete(object);
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return Date.prototype.toISOString.call(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

function validateRows(input: Readonly<{ control: Control; history: readonly History[]; dispatch: readonly Dispatch[] }>): void {
  if (!exactKeys(input, ['control', 'history', 'dispatch'])) fail('registry_mismatch');
  // Inspect the original root before reading its properties: a root getter is
  // itself invalid evidence and must never execute.
  safeJson(input);
  const { control, history, dispatch } = input;
  if (!Array.isArray(history) || !Array.isArray(dispatch) || history.length > 512 ||
      dispatch.length > 2_560) fail('limit');
  if (Buffer.byteLength(JSON.stringify(canonical(input)), 'utf8') > LIMIT_BYTES)
    fail('limit');
  if (!exactKeys(control, controlKeys) || control.singleton !== 1 ||
      !Number.isSafeInteger(control.revision) || control.revision < 1 ||
      control.revision > 2_147_483_647 ||
      !validString(control.stage) || !optionalString(control.transitionToken) ||
      !optionalString(control.sourceGenerationToken) || !optionalString(control.generationToken) ||
      !optionalString(control.physicalIndex) || !optionalString(control.indexUuid) ||
      !optionalString(control.profileId) || !isDate(control.updatedAt) ||
      control.publicationEnabled !== false || control.servingReady !== false)
    fail('registry_mismatch');
  for (const row of history) {
    if (!exactKeys(row, historyKeys) || !validString(row.generationToken) ||
        !validString(row.physicalIndex) || !validString(row.profileId) ||
        !optionalString(row.indexUuid) || !validString(row.lifecycle) ||
        !optionalString(row.writerRole) || !optionalString(row.queryRole) ||
        !optionalString(row.writerPrincipal) || !optionalString(row.queryPrincipal) ||
        !optionalString(row.writerCertFingerprint, 64) ||
        !optionalString(row.queryCertFingerprint, 64) || !isDate(row.createdAt))
      fail('registry_mismatch');
  }
  for (const row of dispatch) {
    if (!exactKeys(row, dispatchKeys) || !validString(row.generationToken) ||
        !validString(row.operation) || !validString(row.dispatchId) ||
        !validString(row.ownerId) || !validString(row.target) ||
        !validString(row.bodyIdentity, 64) || !validString(row.state) || !isDate(row.createdAt))
      fail('registry_mismatch');
  }
}

const incomplete = (reason: Extract<RegistryResult, { status: 'incomplete' }>['reason']):
  Extract<RegistryResult, { status: 'incomplete' }> =>
  ({ status: 'incomplete', reason });
const priority: Record<Extract<RegistryResult, { status: 'incident' | 'incomplete' }>['reason'], number> = {
  limit: 120, stale_dispatch: 110, registry_mismatch: 100,
  abandoned_unresolved: 90, unavailable: 80,
  quiesced_awaiting_evidence: 70, sent_unknown: 60, armed: 50,
  historical_partial: 40, confirmed_awaiting_advance: 30,
  transition_in_progress: 20, unenrolled_v1: 10,
};

/** Pure registry classifier. No engine readback can settle an incomplete result. */
export function classifySearchGenerationRegistry(input: Readonly<{
  control: Control; history: readonly History[]; dispatch: readonly Dispatch[];
}>): RegistryResult {
  try { return classify(input); }
  catch (error) { return { status: 'incident', reason: error instanceof OracleFailure ? error.reason : 'registry_mismatch' }; }
}

function classify(input: Readonly<{
  control: Control; history: readonly History[]; dispatch: readonly Dispatch[];
}>): RegistryResult {
  validateRows(input);
  const { control, history, dispatch } = input;
  const manifest = (() => {
    try { return buildSearchGenerationManifest(history); }
    catch { return fail('registry_mismatch'); }
  })();
  const byToken = new Map(history.map(row => [row.generationToken, row]));
  const identities = new Set<string>();
  for (const row of history) {
    for (const name of [row.writerRole, row.queryRole, row.writerPrincipal, row.queryPrincipal]) {
      if (!name) continue;
      if (identities.has(name)) fail('registry_mismatch');
      identities.add(name);
    }
  }
  const map = new Map<string, Map<SearchGenerationOperation, Dispatch>>();
  const dispatchIds = new Set<string>();
  let malformedDispatch = false;
  let staleDispatch = false;
  for (const row of dispatch) {
    if (!byToken.has(row.generationToken) || row.generationToken === 'legacy-v1' ||
        !operations.includes(row.operation as SearchGenerationOperation) ||
        !['armed', 'sent_unknown', 'response_confirmed', 'quiesced'].includes(row.state) ||
        !uuid.test(row.dispatchId) || !uuid.test(row.ownerId) || !hash.test(row.bodyIdentity)) {
      malformedDispatch = true; continue;
    }
    const per = map.get(row.generationToken) ?? new Map<SearchGenerationOperation, Dispatch>();
    const expected = (() => {
      try { return searchGenerationDispatchSpec(byToken.get(row.generationToken)!, row.operation as SearchGenerationOperation); }
      catch { malformedDispatch = true; return null; }
    })();
    if (expected && (row.target !== expected.target || row.bodyIdentity !== expected.bodyIdentity))
      staleDispatch = true;
    // Even a duplicate is a complete stored intent and may be stale. Check
    // its hash before suppressing insertion, so array order cannot choose the
    // reported reason.
    if (dispatchIds.has(row.dispatchId) || per.has(row.operation as SearchGenerationOperation) ||
        per.size >= 5) { malformedDispatch = true; continue; }
    dispatchIds.add(row.dispatchId);
    per.set(row.operation as SearchGenerationOperation, row);
    map.set(row.generationToken, per);
  }
  // Independent of dispatch array order. A stored stale hash is never hidden
  // by another malformed dispatch row in the same complete snapshot.
  if (staleDispatch) fail('stale_dispatch');
  if (malformedDispatch) fail('registry_mismatch');
  if (control.sourceGenerationToken && !byToken.has(control.sourceGenerationToken) ||
      control.generationToken && !byToken.has(control.generationToken) ||
      control.sourceGenerationToken && control.sourceGenerationToken === control.generationToken)
    fail('registry_mismatch');
  if (control.transitionToken !== null && !uuid.test(control.transitionToken))
    fail('registry_mismatch');
  const candidate = control.generationToken ? byToken.get(control.generationToken)! : null;
  const source = control.sourceGenerationToken ? byToken.get(control.sourceGenerationToken)! : null;
  if (candidate && (candidate.physicalIndex !== control.physicalIndex ||
      candidate.profileId !== control.profileId || candidate.indexUuid !== control.indexUuid) ||
      !candidate && (control.physicalIndex !== null || control.profileId !== null || control.indexUuid !== null))
    fail('registry_mismatch');

  let globalReason: Exclude<RegistryResult, { status: 'ready' }> | null = null;
  const boundUuids = new Set<string>();
  const offer = (result: Exclude<RegistryResult, { status: 'ready' }>) => {
    if (!globalReason || priority[result.reason] > priority[globalReason.reason]) globalReason = result;
  };
  for (const row of history) {
    const per = map.get(row.generationToken);
    if (row.indexUuid !== null && !engineUuid.test(row.indexUuid) ||
        row.writerCertFingerprint !== null && !fingerprint.test(row.writerCertFingerprint) ||
        row.queryCertFingerprint !== null && !fingerprint.test(row.queryCertFingerprint) ||
        (row.writerCertFingerprint === null) !== (row.queryCertFingerprint === null) ||
        row.lifecycle === 'reserved' &&
          (row.writerCertFingerprint !== null || row.queryCertFingerprint !== null))
      fail('registry_mismatch');
    if (row.indexUuid !== null) {
      if (boundUuids.has(row.indexUuid)) fail('registry_mismatch');
      boundUuids.add(row.indexUuid);
    }
    if (row.lifecycle === 'abandoned') {
      if (row.indexUuid !== null || row.writerCertFingerprint !== null ||
          row.queryCertFingerprint !== null || per?.size)
        offer({ status: 'incident', reason: 'abandoned_unresolved' });
    } else if (row.lifecycle === 'unavailable') {
      offer({ status: 'incident', reason: 'unavailable' });
    } else if (row.lifecycle === 'roles_attested' || row.lifecycle === 'retired_retained') {
      if (row.generationToken !== 'legacy-v1') {
        if (!row.indexUuid || !row.writerCertFingerprint || !row.queryCertFingerprint ||
            !per || per.size !== 5) fail('registry_mismatch');
        for (const op of operations) if (!per!.has(op)) fail('registry_mismatch');
        if ([...per!.values()].some(item => item.state === 'armed' || item.state === 'sent_unknown'))
          fail('registry_mismatch');
      }
    } else if (row.lifecycle === 'reserved' || row.lifecycle === 'bound') {
      if (row.generationToken !== control.generationToken)
        offer(incomplete('historical_partial'));
    } else fail('registry_mismatch');
    if (per) {
      for (const item of per.values()) {
        if (item.state === 'quiesced') offer(incomplete('quiesced_awaiting_evidence'));
        else if (item.state === 'sent_unknown') offer(incomplete('sent_unknown'));
        else if (item.state === 'armed')
          offer(incomplete('armed'));
      }
    }
  }
  if (control.stage === 'unavailable') {
    offer({ status: 'incident', reason: 'unavailable' });
    return globalReason!;
  }

  if (control.stage === 'disabled') {
    if (control.transitionToken !== null || candidate !== null ||
        source && (source.generationToken !== 'legacy-v1' || source.lifecycle !== 'roles_attested'))
      fail('registry_mismatch');
    if (!source) offer(incomplete('unenrolled_v1'));
  } else {
    const stageIndex = stages.indexOf(control.stage as typeof stages[number]);
    if (stageIndex < 0 || !source || source.lifecycle !== 'roles_attested' || !candidate ||
        candidate.generationToken === 'legacy-v1' || control.transitionToken === null)
      fail('registry_mismatch');
    const bound = stageIndex >= 2;
    if (candidate!.lifecycle !== (stageIndex === 10 ? 'roles_attested' : bound ? 'bound' : 'reserved') ||
        (bound ? candidate!.indexUuid === null : candidate!.indexUuid !== null))
      fail('registry_mismatch');
    const per = map.get(candidate!.generationToken);
    const completed = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5][stageIndex]!;
    const current = [null, operations[0], null, operations[1], null, operations[2],
      null, operations[3], null, operations[4], null][stageIndex];
    for (let i = 0; i < operations.length; i++) {
      const item = per?.get(operations[i]!);
      if (i < completed && (!item || item.state === 'armed' || item.state === 'sent_unknown') ||
          i >= completed && operations[i] !== current && item)
        fail('registry_mismatch');
    }
    if (current) {
      const state = per?.get(current)?.state;
      if (state === 'armed') offer(incomplete('armed'));
      if (state === 'sent_unknown') offer(incomplete('sent_unknown'));
      if (state === 'response_confirmed') offer(incomplete('confirmed_awaiting_advance'));
      if (state === 'quiesced') offer(incomplete('quiesced_awaiting_evidence'));
    }
    if (stageIndex !== 10) offer(incomplete('transition_in_progress'));
  }
  if (globalReason) return globalReason;

  const expected: RegistryExpected = { version: 'station-generation-registry-v1',
    generations: manifest.map(row => ({ token: row.token, index: row.index,
      profile: row.profile as 'station-mail-v1' | 'station-mail-v2',
      presence: row.presence === 'absent' ? 'absent' : 'exact', uuid: row.uuid,
      writerRole: row.writerRole, queryRole: row.queryRole,
      writerPrincipal: row.writerPrincipal, queryPrincipal: row.queryPrincipal,
      writerCertFingerprint: row.writerCertFingerprint,
      queryCertFingerprint: row.queryCertFingerprint })) };
  if (Buffer.byteLength(JSON.stringify(expected), 'utf8') > LIMIT_BYTES) fail('limit');
  return { status: 'ready', expected };
}
