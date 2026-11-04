import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { searchGenerationDispatchSpec } from '../../db/dist/search-generation-manifest.js';
import { OPENSEARCH_MAPPING, OPENSEARCH_MAPPING_V2 } from './opensearch-compiler.js';
import { buildWriterRoleContract, compareWriterRoleStage } from './opensearch-writer-role-contract.js';

const token = '11111111-1111-4111-8111-111111111111';
const suffix = token.replaceAll('-', '');
const index = `station-mail-v2-g${suffix}`;
const role = `station_indexer_${suffix}`;
const candidate = () => ({ token, index, profile: 'station-mail-v2' as const,
  uuid: 'candidate_uuid', writerRole: role });
const prior = () => ({ version: 'station-generation-registry-v1' as const,
  generations: [{ token: 'legacy-v1', index: 'station-mail-v1',
    profile: 'station-mail-v1' as const, presence: 'exact' as const,
    uuid: 'legacy_uuid', writerRole: null, queryRole: null,
    writerPrincipal: null, queryPrincipal: null,
    writerCertFingerprint: null, queryCertFingerprint: null }] });
const dispatch = () => searchGenerationDispatchSpec({
  generationToken: token, physicalIndex: index, profileId: 'station-mail-v2',
  indexUuid: 'candidate_uuid', lifecycle: 'bound', writerRole: role,
  queryRole: `station_query_${suffix}`,
  writerPrincipal: `station-search-indexer-${suffix}`,
  queryPrincipal: `station-search-query-${suffix}`,
  writerCertFingerprint: null, queryCertFingerprint: null,
  createdAt: new Date('2026-10-22T00:00:00Z'),
}, 'writer_role');
const clone = <T>(value: T): T => structuredClone(value);
const settings = (name: string, uuid: string) => ({ index: {
  number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
  refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
  replication: { type: 'DOCUMENT' }, uuid, creation_date: '1760000000000',
  provided_name: name, version: { created: '13927900' },
} });
function observed(post = false) {
  const contract = buildWriterRoleContract(prior(), candidate(), dispatch());
  return { indexes: {
    'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
      settings: settings('station-mail-v1', 'legacy_uuid') },
    [index]: { aliases: {}, mappings: OPENSEARCH_MAPPING_V2,
      settings: settings(index, 'candidate_uuid') },
  }, roles: clone(post ? contract.postPolicy.roles : contract.prePolicy.roles),
  mappings: clone(contract.prePolicy.mappings) };
}

describe('pure staged writer role contract', () => {
  it('binds the official fixed role body and a distinct complete-body digest to DB metadata', () => {
    const contract = buildWriterRoleContract(prior(), candidate(), dispatch());
    expect(contract.target).toBe(role);
    expect(contract.dispatchBodyIdentity).toBe(dispatch().bodyIdentity);
    expect(contract.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(contract.bodySha256).toBe(createHash('sha256').update(JSON.stringify(contract.body)).digest('hex'));
    expect(contract.bodySha256).not.toBe(contract.dispatchBodyIdentity);
    expect(contract.body).toEqual({ cluster_permissions: ['indices:data/write/bulk'],
      index_permissions: [{ index_patterns: [index], allowed_actions: [
        'indices:data/write/index', 'indices:data/read/get', 'indices:data/write/bulk[s]'] }],
      tenant_permissions: [] });
    expect(Object.isFrozen(contract.body.index_permissions[0]?.allowed_actions)).toBe(true);
    expect(Object.isFrozen(contract.body.tenant_permissions)).toBe(true);
    expect(compareWriterRoleStage(contract, observed(), 'pre')).toBe('exact');
    expect(compareWriterRoleStage(contract, observed(true), 'post')).toBe('exact');
    expect(compareWriterRoleStage(contract, observed(true), 'pre')).toBe('mismatch');
    expect(compareWriterRoleStage(contract, observed(), 'post')).toBe('mismatch');
  });

  it('rejects changed immutable candidate identity and stored metadata', () => {
    const base = candidate(), d = dispatch();
    for (const change of [
      { ...base, uuid: 'bad/uuid' }, { ...base, index: 'station-mail-v2-gwrong' },
      { ...base, writerRole: 'station_indexer_wrong' },
      { ...base, profile: 'station-mail-v1' as 'station-mail-v2' },
    ]) expect(() => buildWriterRoleContract(prior(), change, d)).toThrow();
    for (const changed of [{ ...d, target: 'station_indexer_wrong' },
      { ...d, bodyIdentity: '0'.repeat(64) }])
      expect(() => buildWriterRoleContract(prior(), base, changed)).toThrow();
    const present = prior();
    expect(() => buildWriterRoleContract({ ...present, generations: [...present.generations,
      { ...present.generations[0]!, token, index }] }, base, d)).toThrow();
  });

  it('rejects copied, forged and accessor contracts before reading their fields', () => {
    const genuine = buildWriterRoleContract(prior(), candidate(), dispatch());
    const evidence = observed(true);
    const copied = clone(genuine);
    expect(compareWriterRoleStage(copied, evidence, 'post')).toBe('mismatch');
    ((copied.postPolicy.roles as Record<string, unknown>)[role] as Record<string, unknown>)
      .cluster_permissions = ['*'];
    const widened = observed(true);
    ((widened.roles as Record<string, unknown>)[role] as Record<string, unknown>)
      .cluster_permissions = ['*'];
    expect(compareWriterRoleStage(copied, widened, 'post')).toBe('mismatch');
    let called = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'prior', { get: () => { called++; return genuine.prior; } });
    expect(compareWriterRoleStage(accessor as unknown as typeof genuine, evidence, 'post'))
      .toBe('mismatch');
    expect(called).toBe(0);
    expect(compareWriterRoleStage(genuine, evidence, 'post')).toBe('exact');
  });

  it('rejects preexisting role, changed grants and extra or hidden security resources', () => {
    const contract = buildWriterRoleContract(prior(), candidate(), dispatch());
    const pre = observed();
    (pre.roles as Record<string, unknown>)[role] = clone(contract.body);
    expect(compareWriterRoleStage(contract, pre, 'pre')).toBe('mismatch');
    const post = observed(true);
    const writer = (post.roles as Record<string, unknown>)[role] as { cluster_permissions: string[] };
    writer.cluster_permissions = ['*'];
    expect(compareWriterRoleStage(contract, post, 'post')).toBe('mismatch');
    for (const hidden of [false, true]) {
      const extra = observed(true);
      (extra.roles as Record<string, unknown>)[`extra_${hidden}`] = { hidden, cluster_permissions: ['*'] };
      expect(compareWriterRoleStage(contract, extra, 'post')).toBe('mismatch');
      const mapping = observed(true);
      (mapping.mappings as Record<string, unknown>)[`extra_${hidden}`] = { hidden, users: ['x'] };
      expect(compareWriterRoleStage(contract, mapping, 'post')).toBe('mismatch');
    }
  });

  it('requires exact original and candidate UUID/profile and no extra indexes or aliases', () => {
    const contract = buildWriterRoleContract(prior(), candidate(), dispatch());
    const changes = [
      (x: ReturnType<typeof observed>) => { x.indexes['station-mail-v1'].settings.index.uuid = 'changed'; },
      (x: ReturnType<typeof observed>) => { x.indexes[index]!.settings.index.uuid = 'changed'; },
      (x: ReturnType<typeof observed>) => { x.indexes[index]!.settings.index.number_of_shards = '2'; },
      (x: ReturnType<typeof observed>) => { (x.indexes[index]!.aliases as Record<string, unknown>).extra = {}; },
      (x: ReturnType<typeof observed>) => { (x.indexes as Record<string, unknown>)['.hidden'] = {}; },
      (x: ReturnType<typeof observed>) => { delete (x.indexes as Record<string, unknown>)['station-mail-v1']; },
    ];
    for (const change of changes) {
      const evidence = observed(true); change(evidence);
      expect(compareWriterRoleStage(contract, evidence, 'post')).toBe('mismatch');
    }
    const getter = observed(true) as unknown as Record<string, unknown>;
    let called = 0;
    Object.defineProperty(getter, 'indexes', { enumerable: true, get: () => { called++; return {}; } });
    expect(compareWriterRoleStage(contract, getter, 'post')).toBe('mismatch');
    expect(called).toBe(0);
  });

  it('retains a fully attested historical generation in both staged inventories', () => {
    const previous = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const oldSuffix = previous.replaceAll('-', '');
    const oldIndex = `station-mail-v2-g${oldSuffix}`;
    const original = prior();
    const withHistory = { ...original, generations: [...original.generations, {
      token: previous, index: oldIndex, profile: 'station-mail-v2' as const,
      presence: 'exact' as const, uuid: 'historical_uuid',
      writerRole: `station_indexer_${oldSuffix}`, queryRole: `station_query_${oldSuffix}`,
      writerPrincipal: `station-search-indexer-${oldSuffix}`,
      queryPrincipal: `station-search-query-${oldSuffix}`,
      writerCertFingerprint: 'a'.repeat(64), queryCertFingerprint: 'b'.repeat(64),
    }] };
    const contract = buildWriterRoleContract(withHistory, candidate(), dispatch());
    const evidence = observed(true);
    evidence.roles = clone(contract.postPolicy.roles);
    evidence.mappings = clone(contract.postPolicy.mappings);
    (evidence.indexes as Record<string, unknown>)[oldIndex] = { aliases: {},
      mappings: clone(OPENSEARCH_MAPPING_V2), settings: settings(oldIndex, 'historical_uuid') };
    expect(compareWriterRoleStage(contract, evidence, 'post')).toBe('exact');
    ((evidence.indexes as Record<string, { settings: ReturnType<typeof settings> }>)[oldIndex]!).settings
      .index.uuid = 'replacement_uuid';
    expect(compareWriterRoleStage(contract, evidence, 'post')).toBe('mismatch');
  });

  it('keeps an abandoned historical generation absent in both stages', () => {
    const retained = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const retainedSuffix = retained.replaceAll('-', '');
    const retainedIndex = `station-mail-v2-g${retainedSuffix}`;
    const previous = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const oldSuffix = previous.replaceAll('-', '');
    const oldIndex = `station-mail-v2-g${oldSuffix}`;
    const original = prior();
    const withAbsent = { ...original, generations: [...original.generations, {
      token: retained, index: retainedIndex, profile: 'station-mail-v2' as const,
      presence: 'exact' as const, uuid: 'historical_uuid',
      writerRole: `station_indexer_${retainedSuffix}`,
      queryRole: `station_query_${retainedSuffix}`,
      writerPrincipal: `station-search-indexer-${retainedSuffix}`,
      queryPrincipal: `station-search-query-${retainedSuffix}`,
      writerCertFingerprint: 'a'.repeat(64), queryCertFingerprint: 'b'.repeat(64),
    }, {
      token: previous, index: oldIndex, profile: 'station-mail-v2' as const,
      presence: 'absent' as const, uuid: null,
      writerRole: `station_indexer_${oldSuffix}`, queryRole: `station_query_${oldSuffix}`,
      writerPrincipal: `station-search-indexer-${oldSuffix}`,
      queryPrincipal: `station-search-query-${oldSuffix}`,
      writerCertFingerprint: null, queryCertFingerprint: null,
    }] };
    const contract = buildWriterRoleContract(withAbsent, candidate(), dispatch());
    for (const stage of ['pre', 'post'] as const) {
      const evidence = observed(stage === 'post');
      evidence.roles = clone(stage === 'pre' ? contract.prePolicy.roles : contract.postPolicy.roles);
      evidence.mappings = clone(contract.prePolicy.mappings);
      (evidence.indexes as Record<string, unknown>)[retainedIndex] = { aliases: {},
        mappings: clone(OPENSEARCH_MAPPING_V2),
        settings: settings(retainedIndex, 'historical_uuid') };
      expect(compareWriterRoleStage(contract, evidence, stage)).toBe('exact');
      const withIndex = clone(evidence);
      (withIndex.indexes as Record<string, unknown>)[oldIndex] = { aliases: {},
        mappings: clone(OPENSEARCH_MAPPING_V2), settings: settings(oldIndex, 'abandoned_uuid') };
      expect(compareWriterRoleStage(contract, withIndex, stage)).toBe('mismatch');
      const withRole = clone(evidence);
      (withRole.roles as Record<string, unknown>)[`station_indexer_${oldSuffix}`] =
        clone(contract.body);
      expect(compareWriterRoleStage(contract, withRole, stage)).toBe('mismatch');
      const withMapping = clone(evidence);
      (withMapping.mappings as Record<string, unknown>)[`station_indexer_${oldSuffix}`] =
        { users: [`station-search-indexer-${oldSuffix}`], backend_roles: [], hosts: [] };
      expect(compareWriterRoleStage(contract, withMapping, stage)).toBe('mismatch');
    }
  });
});
