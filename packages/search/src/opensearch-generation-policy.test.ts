import { describe, expect, it } from 'vitest';
import { buildExpectedSecurityPolicy, compareObservedSecurityCollections,
  type RegistryExpectedInput } from './opensearch-generation-policy.js';
import { staticRoles } from './opensearch-static-roles.js';

const tokens = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const generation = (token: string, presence: 'exact' | 'absent' = 'exact') => {
  const suffix = token.replaceAll('-', '').toLowerCase();
  return { token, index: `station-mail-v2-g${suffix}`, profile: 'station-mail-v2' as const,
    presence, uuid: presence === 'exact' ? `uuid_${suffix}` : null,
    writerRole: `station_indexer_${suffix}`, queryRole: `station_query_${suffix}`,
    writerPrincipal: `station-search-indexer-${suffix}`,
    queryPrincipal: `station-search-query-${suffix}`,
    writerCertFingerprint: presence === 'exact' ? 'a'.repeat(64) : null,
    queryCertFingerprint: presence === 'exact' ? 'b'.repeat(64) : null };
};
const registry = (): RegistryExpectedInput => ({ version: 'station-generation-registry-v1',
  generations: [{ token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
    presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
    writerPrincipal: null, queryPrincipal: null, writerCertFingerprint: null,
    queryCertFingerprint: null }, ...tokens.map(value => generation(value))] });
const copy = <T>(value: T): T => structuredClone(value);
const compare = (policy: ReturnType<typeof buildExpectedSecurityPolicy>,
  roles: unknown = copy(policy.roles), mappings: unknown = copy(policy.mappings)) =>
  compareObservedSecurityCollections(policy, roles, mappings);

describe('pure pinned generation security policy', () => {
  it('uses one eight-role static baseline and exact v1/two-generation grants', () => {
    const input = registry();
    const original = copy(input);
    const policy = buildExpectedSecurityPolicy(input);
    expect(input).toEqual(original);
    expect(Object.keys(staticRoles)).toHaveLength(8);
    expect(Object.keys(policy.roles)).toHaveLength(8 + 2 + 4);
    expect(Object.keys(policy.mappings)).toHaveLength(2 + 4);
    const writer = policy.roles[generation(tokens[0]!).writerRole] as {
      cluster_permissions: string[]; index_permissions: { allowed_actions: string[] }[] };
    expect(writer.cluster_permissions).toEqual(['indices:data/write/bulk']);
    expect(writer.index_permissions[0]?.allowed_actions).toEqual([
      'indices:data/write/index', 'indices:data/read/get', 'indices:data/write/bulk[s]']);
    const observedRoles = copy(policy.roles), observedMappings = copy(policy.mappings);
    const unchanged = [copy(observedRoles), copy(observedMappings)];
    expect(compare(policy, observedRoles, observedMappings)).toBe('exact');
    expect([observedRoles, observedMappings]).toEqual(unchanged);
    const abandoned = buildExpectedSecurityPolicy({ ...input,
      generations: [...input.generations, generation('33333333-3333-4333-8333-333333333333', 'absent')] });
    expect(Object.keys(abandoned.roles)).toHaveLength(Object.keys(policy.roles).length);
    const mutable = policy.roles.all_access as { cluster_permissions: string[] };
    mutable.cluster_permissions[0] = 'tampered';
    expect(buildExpectedSecurityPolicy(input).roles.all_access).toEqual(staticRoles.all_access);
  });

  it('rejects ordinary and hidden extra or missing roles and mappings independently', () => {
    const policy = buildExpectedSecurityPolicy(registry());
    for (const hidden of [false, true]) {
      const roles = copy(policy.roles) as Record<string, unknown>;
      roles[`extra_${hidden}`] = { hidden, cluster_permissions: ['*'] };
      expect(compare(policy, roles)).toBe('mismatch');
      const mappings = copy(policy.mappings) as Record<string, unknown>;
      mappings[`extra_${hidden}`] = { hidden, users: ['someone@example.com'] };
      expect(compare(policy, undefined, mappings)).toBe('mismatch');
    }
    const roles = copy(policy.roles) as Record<string, unknown>;
    delete roles[generation(tokens[0]!).writerRole];
    expect(compare(policy, roles)).toBe('mismatch');
    const mappings = copy(policy.mappings) as Record<string, unknown>;
    delete mappings[generation(tokens[1]!).queryRole];
    expect(compare(policy, undefined, mappings)).toBe('mismatch');
  });

  it('keeps reviewed omitted/empty equivalences while denying meaningful drift', () => {
    const policy = buildExpectedSecurityPolicy(registry());
    const name = generation(tokens[0]!).writerRole;
    const roles = copy(policy.roles) as Record<string, Record<string, unknown>>;
    roles[name] = { ...roles[name], hidden: false, reserved: false, static: false };
    const permission = (roles[name]!.index_permissions as Record<string, unknown>[])[0]!;
    permission.dls = ''; permission.fls = []; permission.masked_fields = [];
    expect(compare(policy, roles)).toBe('exact');
    permission.dls = '{"term":{"account":"other"}}';
    expect(compare(policy, roles)).toBe('mismatch');
    permission.dls = ''; permission.fls = ['secret'];
    expect(compare(policy, roles)).toBe('mismatch');
    permission.fls = []; permission.masked_fields = ['subject'];
    expect(compare(policy, roles)).toBe('mismatch');
    permission.masked_fields = []; permission.unknown_action = true;
    expect(compare(policy, roles)).toBe('mismatch');
    delete permission.unknown_action;
    roles[name]!.hidden = true;
    expect(compare(policy, roles)).toBe('mismatch');
    roles[name]!.hidden = false; roles[name]!.description = 'changed';
    expect(compare(policy, roles)).toBe('mismatch');
    const mappings = copy(policy.mappings) as Record<string, Record<string, unknown>>;
    mappings[name] = { ...mappings[name], hidden: false, reserved: false, static: false,
      description: 'changed' };
    expect(compare(policy, undefined, mappings)).toBe('mismatch');
    delete mappings[name]!.description;
    expect(compare(policy, undefined, mappings)).toBe('exact');
  });

  it('denies duplicate arrays, malformed values and observed caps with fixed results', () => {
    const policy = buildExpectedSecurityPolicy(registry());
    const roles = copy(policy.roles) as Record<string, Record<string, unknown>>;
    const name = generation(tokens[0]!).writerRole;
    roles[name]!.cluster_permissions = ['indices:data/write/bulk', 'indices:data/write/bulk'];
    expect(compare(policy, roles)).toBe('mismatch');
    roles[name]!.cluster_permissions = Array.from({ length: 129 }, (_, i) => `action_${i}`);
    expect(compare(policy, roles)).toBe('limit');
    roles[name]!.cluster_permissions = ['indices:data/write/bulk'];
    roles[name]!.index_permissions = [{ index_patterns: ['x'], allowed_actions: null }];
    expect(compare(policy, roles)).toBe('mismatch');
    expect(compare(policy, { ...policy.roles, huge: { description: 'x'.repeat(130_000) } })).toBe('limit');
    const circular: Record<string, unknown> = { ...policy.roles };
    circular.self = circular;
    expect(compare(policy, circular)).toBe('mismatch');
    expect(compare(policy, new Date())).toBe('mismatch');
    const mapping = copy(policy.mappings) as Record<string, Record<string, unknown>>;
    mapping[name]!.users = ['same', 'same'];
    expect(compare(policy, undefined, mapping)).toBe('mismatch');
    const badRegistry = registry();
    const sameIndex = { ...badRegistry.generations[2]!, index: badRegistry.generations[1]!.index };
    expect(() => buildExpectedSecurityPolicy({ ...badRegistry,
      generations: [badRegistry.generations[0]!, badRegistry.generations[1]!, sameIndex] }))
      .toThrow('mismatch');
  });

  it('never runs input accessors or JSON callbacks', () => {
    const policy = buildExpectedSecurityPolicy(registry());
    let called = 0;
    const roles = { ...policy.roles };
    Object.defineProperty(roles, 'trap', { enumerable: true,
      get: () => { called++; return {}; } });
    expect(compare(policy, roles)).toBe('mismatch');
    expect(called).toBe(0);
    const decorated = { ...policy.roles, toJSON: () => { called++; return policy.roles; } };
    expect(compare(policy, decorated)).toBe('mismatch');
    expect(called).toBe(0);
    const input = registry() as RegistryExpectedInput & { trap?: unknown };
    Object.defineProperty(input, 'trap', { enumerable: true,
      get: () => { called++; return {}; } });
    expect(() => buildExpectedSecurityPolicy(input)).toThrow('mismatch');
    expect(called).toBe(0);
  });

  it('rejects inherited array callbacks in both builder and comparator before execution', () => {
    let called = 0;
    const prototype = Object.create(Array.prototype) as unknown[] & { toJSON?: () => unknown };
    prototype.toJSON = () => { called++; return []; };
    prototype.map = () => { called++; return []; };
    const input = registry();
    const generations = [...input.generations];
    Object.setPrototypeOf(generations, prototype);
    expect(() => buildExpectedSecurityPolicy({ ...input, generations })).toThrow('mismatch');
    expect(called).toBe(0);

    const policy = buildExpectedSecurityPolicy(input);
    const roles = copy(policy.roles) as Record<string, Record<string, unknown>>;
    const name = generation(tokens[0]!).writerRole;
    const grants = roles[name]!.cluster_permissions as string[];
    Object.setPrototypeOf(grants, prototype);
    expect(compare(policy, roles)).toBe('mismatch');
    expect(called).toBe(0);

    const accessors = Object.create(Array.prototype) as Record<string | symbol, unknown>;
    Object.defineProperty(accessors, 'toJSON', { get: () => { called++; return () => []; } });
    Object.defineProperty(accessors, 'map', { get: () => { called++; return () => []; } });
    Object.defineProperty(accessors, Symbol.for('fixture-array'),
      { get: () => { called++; return 'unsafe'; } });
    const inherited = [...input.generations];
    Object.setPrototypeOf(inherited, accessors);
    expect(() => buildExpectedSecurityPolicy({ ...input, generations: inherited })).toThrow('mismatch');
    expect(called).toBe(0);
    const accessorRoles = copy(policy.roles) as Record<string, Record<string, unknown>>;
    Object.setPrototypeOf(accessorRoles[name]!.cluster_permissions as string[], accessors);
    expect(compare(policy, accessorRoles)).toBe('mismatch');
    expect(called).toBe(0);

    class AlteredArray<T> extends Array<T> {
      toJSON() { called++; return []; }
    }
    const subclass = new AlteredArray(...input.generations);
    expect(() => buildExpectedSecurityPolicy({ ...input, generations: subclass })).toThrow('mismatch');
    expect(called).toBe(0);

    const ownSymbol = copy(policy.roles) as Record<string, Record<string, unknown>>;
    const ownGrants = ownSymbol[name]!.cluster_permissions as string[];
    Object.defineProperty(ownGrants, Symbol.for('fixture-own-array'),
      { get: () => { called++; return 'unsafe'; } });
    expect(compare(policy, ownSymbol)).toBe('mismatch');
    expect(called).toBe(0);
  });
});
