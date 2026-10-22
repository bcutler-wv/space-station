import { expect, test } from 'vitest';
import { OPENSEARCH_MAPPING_V2, OPENSEARCH_PROFILE_V2 } from './opensearch-compiler.js';
import { createV2IndexBody, verifyV2IndexProfile, V2_INDEX_PROFILE_ID } from './opensearch-v2-profile.js';

const name = 'station-mail-v2-g11111111111141118111111111111111';
const uuid = 'engine_uuid_1';
const expectedSettings = { number_of_shards: 1, number_of_replicas: 0, max_result_window: 200,
  refresh_interval: '1s', mapping: { total_fields: { limit: 64 } }, replication: { type: 'DOCUMENT' } };
function observed() {
  return { [name]: { aliases: {}, mappings: structuredClone(OPENSEARCH_MAPPING_V2), settings: { index: {
    number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
    refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
    replication: { type: 'DOCUMENT' }, uuid, creation_date: '1760000000000',
    provided_name: name, version: { created: '13927900' },
  } } } };
}

test('one frozen profile ID and create body match the generation fixture values', () => {
  expect(V2_INDEX_PROFILE_ID).toBe(OPENSEARCH_PROFILE_V2);
  const first = createV2IndexBody(name);
  expect(first).toEqual({ settings: expectedSettings, mappings: OPENSEARCH_MAPPING_V2 });
  Object.assign(first.settings.mapping.total_fields, { limit: 999 });
  Object.assign(first.mappings.properties.live, { type: 'altered' });
  expect(createV2IndexBody(name)).toEqual({ settings: expectedSettings, mappings: OPENSEARCH_MAPPING_V2 });
  expect(() => createV2IndexBody('station-mail-v1')).toThrow('Invalid private v2 index profile');
});

test('exact v2 GET accepts only generated metadata and the bound UUID', () => {
  expect(verifyV2IndexProfile(observed(), name, uuid)).toBe(uuid);
  const upgraded = observed();
  Object.assign(upgraded[name].settings.index.version, { upgraded: '13927901' });
  expect(verifyV2IndexProfile(upgraded, name, null)).toBe(uuid);
  expect(() => verifyV2IndexProfile(observed(), name, 'other_uuid')).toThrow();
});

test('v2 GET rejects changed name, UUID, mapping, settings, aliases and unknown response keys', () => {
  const mutate = (change: (body: ReturnType<typeof observed>) => void) => {
    const body = observed(); change(body);
    expect(() => verifyV2IndexProfile(body, name, uuid)).toThrow('Invalid private v2 index profile');
  };
  mutate(body => { body[name].settings.index.provided_name = 'other'; });
  mutate(body => { body[name].settings.index.uuid = 'other_uuid'; });
  mutate(body => { Object.assign(body[name].mappings.properties.live, { type: 'altered' }); });
  mutate(body => { body[name].settings.index.refresh_interval = '2s'; });
  mutate(body => { Object.assign(body[name].aliases, { alias: {} }); });
  mutate(body => { (body[name] as Record<string, unknown>).hidden = true; });
  mutate(body => { (body as Record<string, unknown>).extra = {}; });
  mutate(body => { (body[name].settings.index as Record<string, unknown>).semantic_extra = 'x'; });
  mutate(body => { body[name].settings.index.version = { created: '13927900', unknown: '1' } as { created: string }; });
});

test('malformed and oversized responses fail without invoking callbacks or mutating inputs', () => {
  const body = observed();
  const before = structuredClone(body);
  expect(verifyV2IndexProfile(body, name, null)).toBe(uuid);
  expect(body).toEqual(before);
  const huge = observed();
  (huge as Record<string, unknown>).padding = 'x'.repeat(128 * 1024);
  expect(() => verifyV2IndexProfile(huge, name, null)).toThrow();
  let called = 0;
  const accessor = Object.defineProperty(observed(), 'extra', { get() { called++; return true; }, enumerable: true });
  expect(() => verifyV2IndexProfile(accessor, name, null)).toThrow();
  expect(called).toBe(0);
  expect(() => verifyV2IndexProfile(Object.create({ [name]: observed()[name] }), name, null)).toThrow();
  expect(() => verifyV2IndexProfile(observed(), name, 'invalid uuid')).toThrow();
});

test('scalar identities reject coercion without calling user code', () => {
  let calls = 0;
  const poison = { toString() { calls++; return name; } };
  expect(() => createV2IndexBody(poison as unknown as string)).toThrow('Invalid private v2 index profile');
  expect(() => verifyV2IndexProfile(observed(), poison as unknown as string, null))
    .toThrow('Invalid private v2 index profile');
  expect(() => verifyV2IndexProfile(observed(), name, poison as unknown as string))
    .toThrow('Invalid private v2 index profile');
  expect(calls).toBe(0);
});

test('shared object graphs and cumulative oversized input fail before serialization', () => {
  let shared: unknown = { leaf: 'x' };
  for (let i = 0; i < 6; i++) shared = Array.from({ length: 32 }, () => shared);
  expect(() => verifyV2IndexProfile(shared, name, null)).toThrow('Invalid private v2 index profile');
  const aggregate = observed();
  (aggregate as Record<string, unknown>).padding = Array.from({ length: 128 }, (_, i) =>
    `${i}:${'x'.repeat(2048)}`);
  expect(() => verifyV2IndexProfile(aggregate, name, null)).toThrow('Invalid private v2 index profile');
});
