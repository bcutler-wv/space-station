import { describe, expect, it } from 'vitest';
import type { searchGenerationControl, searchGenerationDispatch, searchGenerationHistory } from './schema.js';
import { classifySearchGenerationRegistry } from './search-generation-oracle.js';
import { searchGenerationDispatchSpec } from './search-generation-manifest.js';

type Control = typeof searchGenerationControl.$inferSelect;
type History = typeof searchGenerationHistory.$inferSelect;
type Dispatch = typeof searchGenerationDispatch.$inferSelect;
const now = new Date('2026-10-22T00:00:00.000Z');
const token = 'AB12CD34-0000-4000-8000-000000000001';
const token2 = 'ab12cd34-0000-4000-8000-000000000002';
const transition = '12345678-0000-4000-8000-000000000099';
const ops = ['create_index', 'writer_role', 'writer_mapping', 'query_role', 'query_mapping'] as const;
const stages = ['disabled_intent', 'create_requested', 'uuid_bound', 'writer_role_requested',
  'writer_role_attested', 'writer_mapping_requested', 'writer_attested',
  'query_role_requested', 'query_role_attested', 'query_mapping_requested', 'roles_attested'] as const;
const completed = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5];
const suffix = (value: string) => value.replaceAll('-', '').toLowerCase();
const legacy = (): History => ({ generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1',
  profileId: 'station-mail-v1', indexUuid: 'legacy_uuid', lifecycle: 'roles_attested',
  writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
  writerCertFingerprint: null, queryCertFingerprint: null, createdAt: now });
const generation = (value = token, lifecycle = 'reserved'): History => ({
  generationToken: value, physicalIndex: `station-mail-v2-g${suffix(value)}`, profileId: 'station-mail-v2',
  indexUuid: ['bound', 'roles_attested', 'retired_retained'].includes(lifecycle) ? `uuid_${suffix(value)}` : null,
  lifecycle, writerRole: `station_indexer_${suffix(value)}`, queryRole: `station_query_${suffix(value)}`,
  writerPrincipal: `station-search-indexer-${suffix(value)}`,
  queryPrincipal: `station-search-query-${suffix(value)}`,
  writerCertFingerprint: lifecycle === 'roles_attested' || lifecycle === 'retired_retained' ? 'a'.repeat(64) : null,
  queryCertFingerprint: lifecycle === 'roles_attested' || lifecycle === 'retired_retained' ? 'b'.repeat(64) : null,
  createdAt: now,
});
const dispatch = (row: History, operation: typeof ops[number], state = 'response_confirmed'): Dispatch => ({
  generationToken: row.generationToken, operation,
  dispatchId: `11111111-0000-4000-8000-${String(ops.indexOf(operation) + 1 +
    (row.generationToken === token2 ? 10 : 0)).padStart(12, '0')}`,
  ownerId: '22222222-0000-4000-8000-000000000001',
  ...searchGenerationDispatchSpec(row, operation), state, createdAt: now,
});
const control = (): Control => ({ singleton: 1, revision: 1, stage: 'disabled',
  transitionToken: null, sourceGenerationToken: 'legacy-v1', generationToken: null,
  physicalIndex: null, indexUuid: null, profileId: null,
  publicationEnabled: false, servingReady: false, updatedAt: now });
function state(stageIndex: number, currentState?: string) {
  const row = generation(token, stageIndex >= 10 ? 'roles_attested' : stageIndex >= 2 ? 'bound' : 'reserved');
  const c = { ...control(), stage: stages[stageIndex]!, transitionToken: transition,
    generationToken: token, physicalIndex: row.physicalIndex,
    indexUuid: row.indexUuid, profileId: row.profileId };
  const d = ops.slice(0, completed[stageIndex]!).map(op => dispatch(row, op));
  const current = [null, ops[0], null, ops[1], null, ops[2], null, ops[3], null, ops[4], null][stageIndex];
  if (current && currentState) d.push(dispatch(row, current, currentState));
  return { control: c, history: [legacy(), row], dispatch: d };
}
const result = (input: { control: Control; history: History[]; dispatch: Dispatch[] }) =>
  classifySearchGenerationRegistry(input);

describe('pure search generation registry oracle', () => {
  it('accepts only enrolled v1 and complete v2 helper states as registry ready', () => {
    expect(result({ control: control(), history: [legacy()], dispatch: [] })).toMatchObject({ status: 'ready' });
    const terminal = result(state(10));
    expect(terminal).toMatchObject({ status: 'ready' });
    if (terminal.status === 'ready') {
      expect(terminal.expected.generations.map(row => row.token)).toEqual([token, 'legacy-v1']);
      expect(terminal.expected.generations[0]?.writerRole).toBe(`station_indexer_${suffix(token)}`);
    }
    expect(result({ control: { ...control(), sourceGenerationToken: null }, history: [], dispatch: [] }))
      .toEqual({ status: 'incomplete', reason: 'unenrolled_v1' });
  });

  it('keeps every finite stage and current dispatch state incomplete', () => {
    for (let i = 0; i < 10; i++) {
      expect(result(state(i)).status).toBe('incomplete');
      if (i % 2 === 1) {
        for (const [dispatchState, reason] of [
          ['armed', 'armed'], ['sent_unknown', 'sent_unknown'],
          ['response_confirmed', 'confirmed_awaiting_advance'],
          ['quiesced', 'quiesced_awaiting_evidence'],
        ]) expect(result(state(i, dispatchState))).toEqual({ status: 'incomplete', reason });
      }
    }
    expect(result(state(1, 'response_confirmed'))).toEqual({ status: 'incomplete', reason: 'confirmed_awaiting_advance' });
  });

  it('rejects historical partial, unknown and missing or stale terminal evidence', () => {
    const ready = state(10);
    ready.history.push(generation(token2));
    expect(result(ready)).toEqual({ status: 'incomplete', reason: 'historical_partial' });
    ready.history.pop();
    ready.dispatch[1] = { ...ready.dispatch[1]!, state: 'sent_unknown' };
    expect(result(ready)).toEqual({ status: 'incident', reason: 'registry_mismatch' });
    ready.dispatch[1] = { ...ready.dispatch[1]!, state: 'quiesced' };
    expect(result(ready)).toEqual({ status: 'incomplete', reason: 'quiesced_awaiting_evidence' });
    ready.dispatch.pop();
    expect(result(ready)).toEqual({ status: 'incident', reason: 'registry_mismatch' });
    const stale = state(10);
    stale.dispatch[1] = { ...stale.dispatch[1]!, bodyIdentity: '0'.repeat(64) };
    expect(result(stale)).toEqual({ status: 'incident', reason: 'stale_dispatch' });
  });

  it('treats clean abandoned names as absent, and tainted or unavailable evidence as incident', () => {
    const ready = { control: control(), history: [legacy(), generation(token, 'abandoned')], dispatch: [] };
    const clean = result(ready);
    expect(clean.status).toBe('ready');
    if (clean.status === 'ready')
      expect(clean.expected.generations.find(row => row.token === token)?.presence).toBe('absent');
    ready.history[1] = { ...ready.history[1]!, indexUuid: 'old_uuid' };
    expect(result(ready)).toEqual({ status: 'incident', reason: 'abandoned_unresolved' });
    ready.history[1] = generation(token, 'unavailable');
    expect(result(ready)).toEqual({ status: 'incident', reason: 'unavailable' });
    ready.history.unshift(generation(token2));
    expect(result(ready)).toEqual({ status: 'incident', reason: 'unavailable' });
  });

  it('validates every prior terminal intent during a later rotation', () => {
    const older = generation(token, 'roles_attested');
    const latest = generation(token2, 'roles_attested');
    const c = { ...control(), stage: 'roles_attested', transitionToken: transition,
      sourceGenerationToken: token, generationToken: token2,
      physicalIndex: latest.physicalIndex, profileId: latest.profileId,
      indexUuid: latest.indexUuid };
    const evidence = [...ops.map(op => dispatch(older, op)), ...ops.map(op => dispatch(latest, op))];
    const input = { control: c, history: [legacy(), older, latest], dispatch: evidence };
    expect(result(input).status).toBe('ready');
    input.dispatch[1] = { ...input.dispatch[1]!, bodyIdentity: 'f'.repeat(64) };
    expect(result(input)).toEqual({ status: 'incident', reason: 'stale_dispatch' });
    input.dispatch[1] = dispatch(older, ops[1]);
    input.dispatch[1] = { ...input.dispatch[1]!, state: 'sent_unknown' };
    expect(result(input)).toEqual({ status: 'incident', reason: 'registry_mismatch' });
  });

  it('rejects completed-prefix armed and unknown states but keeps quiesced non-ready', () => {
    for (const stage of [3, 5, 7, 9, 10]) {
      const completedPrefix = state(stage);
      completedPrefix.dispatch[0] = { ...completedPrefix.dispatch[0]!, state: 'armed' };
      expect(result(completedPrefix)).toEqual({ status: 'incident', reason: 'registry_mismatch' });
      completedPrefix.dispatch[0] = { ...completedPrefix.dispatch[0]!, state: 'sent_unknown' };
      expect(result(completedPrefix)).toEqual({ status: 'incident', reason: 'registry_mismatch' });
      completedPrefix.dispatch[0] = { ...completedPrefix.dispatch[0]!, state: 'quiesced' };
      expect(result(completedPrefix)).toEqual({ status: 'incomplete', reason: 'quiesced_awaiting_evidence' });
    }
  });

  it('rejects duplicate bound engine UUIDs and chooses reasons independent of row order', () => {
    const terminal = state(10);
    terminal.history[1] = { ...terminal.history[1]!, indexUuid: terminal.history[0]!.indexUuid };
    terminal.control.indexUuid = terminal.history[0]!.indexUuid;
    expect(result(terminal)).toEqual({ status: 'incident', reason: 'registry_mismatch' });

    const incident = { control: control(), history: [legacy(),
      { ...generation(token, 'abandoned'), indexUuid: 'old_uuid' },
      generation(token2, 'unavailable')], dispatch: [] };
    const expected = { status: 'incident', reason: 'abandoned_unresolved' };
    expect(result(incident)).toEqual(expected);
    expect(result({ ...incident, history: [...incident.history].reverse() })).toEqual(expected);

    const partial = state(1, 'sent_unknown');
    partial.history.push(generation(token2));
    expect(result(partial)).toEqual({ status: 'incomplete', reason: 'sent_unknown' });
    expect(result({ ...partial, history: [...partial.history].reverse() }))
      .toEqual({ status: 'incomplete', reason: 'sent_unknown' });

    const conflict = state(10);
    conflict.dispatch.push({ ...conflict.dispatch[0]!, dispatchId: '33333333-0000-4000-8000-000000000001',
      operation: 'unknown' });
    conflict.dispatch[1] = { ...conflict.dispatch[1]!, bodyIdentity: '0'.repeat(64) };
    expect(result(conflict)).toEqual({ status: 'incident', reason: 'stale_dispatch' });
    expect(result({ ...conflict, dispatch: [...conflict.dispatch].reverse() }))
      .toEqual({ status: 'incident', reason: 'stale_dispatch' });

    const duplicate = state(10);
    const current = duplicate.dispatch[0]!;
    const stale = { ...current, bodyIdentity: '0'.repeat(64) };
    for (const pair of [[current, stale], [stale, current]]) {
      expect(result({ ...duplicate, dispatch: [...pair, ...duplicate.dispatch.slice(1)] }))
        .toEqual({ status: 'incident', reason: 'stale_dispatch' });
    }
    const differentId = { ...stale, dispatchId: '44444444-0000-4000-8000-000000000001' };
    for (const pair of [[current, differentId], [differentId, current]]) {
      expect(result({ ...duplicate, dispatch: [...pair, ...duplicate.dispatch.slice(1)] }))
        .toEqual({ status: 'incident', reason: 'stale_dispatch' });
    }
    const sameId = state(3);
    const writer = dispatch(sameId.history[1]!, 'writer_role');
    const staleWriter = { ...writer, dispatchId: sameId.dispatch[0]!.dispatchId,
      bodyIdentity: '0'.repeat(64) };
    for (const pair of [[sameId.dispatch[0]!, staleWriter], [staleWriter, sameId.dispatch[0]!]]) {
      expect(result({ ...sameId, dispatch: pair }))
        .toEqual({ status: 'incident', reason: 'stale_dispatch' });
    }
  });

  it('never executes root accessors or decorated Date methods', () => {
    let callbacks = 0;
    const base = state(10);
    const root = { ...base };
    Object.defineProperty(root, 'control', { enumerable: true, get: () => { callbacks++; return base.control; } });
    expect(classifySearchGenerationRegistry(root)).toEqual({ status: 'incident', reason: 'registry_mismatch' });
    expect(callbacks).toBe(0);

    for (const name of ['toJSON', 'getTime']) {
      const decorated = new Date(now);
      Object.defineProperty(decorated, name, { configurable: true,
        value: () => { callbacks++; return name === 'toJSON' ? now.toISOString() : now.getTime(); } });
      expect(result({ ...base, control: { ...base.control, updatedAt: decorated } }))
        .toEqual({ status: 'incident', reason: 'registry_mismatch' });
      expect(callbacks).toBe(0);
    }
  });

  it('rejects decorated history arrays before inherited JSON or map callbacks run', () => {
    let callbacks = 0;
    const base = state(10);
    const history = [...base.history];
    const prototype = Object.create(Array.prototype) as Record<string, unknown>;
    prototype.toJSON = () => { callbacks++; return base.history; };
    prototype.map = () => { callbacks++; return base.history; };
    Object.setPrototypeOf(history, prototype);
    expect(result({ ...base, history })).toEqual({ status: 'incident', reason: 'registry_mismatch' });
    expect(callbacks).toBe(0);
    const accessors = Object.create(Array.prototype) as Record<string | symbol, unknown>;
    Object.defineProperty(accessors, 'toJSON', { get: () => { callbacks++; return () => []; } });
    Object.defineProperty(accessors, 'map', { get: () => { callbacks++; return () => []; } });
    Object.defineProperty(accessors, Symbol.for('fixture-history'),
      { get: () => { callbacks++; return 'unsafe'; } });
    const inherited = [...base.history];
    Object.setPrototypeOf(inherited, accessors);
    expect(result({ ...base, history: inherited })).toEqual({ status: 'incident', reason: 'registry_mismatch' });
    expect(callbacks).toBe(0);
    class AlteredArray<T> extends Array<T> { toJSON() { callbacks++; return []; } }
    const subclass = new AlteredArray(...base.history);
    expect(result({ ...base, history: subclass })).toEqual({ status: 'incident', reason: 'registry_mismatch' });
    expect(callbacks).toBe(0);
  });

  it('rejects orphan, duplicate, malformed, oversized and nonplain input without mutation or leaking detail', () => {
    const base = state(10);
    const original = structuredClone(base);
    expect(result(base).status).toBe('ready');
    expect(base).toEqual(original);
    expect(result({ ...base, history: [...base.history, { ...base.history[1]! }] }))
      .toEqual({ status: 'incident', reason: 'registry_mismatch' });
    expect(result({ ...base, dispatch: [...base.dispatch, { ...base.dispatch[0]!, generationToken: token2 }] }))
      .toEqual({ status: 'incident', reason: 'registry_mismatch' });
    expect(result({ ...base, dispatch: [...base.dispatch, { ...base.dispatch[0]! }] }))
      .toEqual({ status: 'incident', reason: 'registry_mismatch' });
    expect(result({ ...base, history: Array.from({ length: 513 }, () => base.history[1]!) }))
      .toEqual({ status: 'incident', reason: 'limit' });
    expect(result({ ...base, control: { ...base.control, stage: 'x'.repeat(270_000) } }))
      .toEqual({ status: 'incident', reason: 'limit' });
    const cyclic = { ...base, extra: null } as typeof base & { extra: unknown };
    cyclic.extra = cyclic;
    expect(classifySearchGenerationRegistry(cyclic)).toEqual({ status: 'incident', reason: 'registry_mismatch' });
    expect(result({ ...base, control: { ...base.control, updatedAt: new Date('invalid') } }))
      .toEqual({ status: 'incident', reason: 'registry_mismatch' });
    expect(result({ ...base, history: [{ ...base.history[0]!, createdAt: {} as Date }, base.history[1]!] }))
      .toEqual({ status: 'incident', reason: 'registry_mismatch' });
    const getter = { ...base.control };
    Object.defineProperty(getter, 'stage', { enumerable: true, get: () => 'roles_attested' });
    expect(result({ ...base, control: getter })).toEqual({ status: 'incident', reason: 'registry_mismatch' });
  });
});
