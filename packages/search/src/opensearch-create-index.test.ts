import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Client } from '@opensearch-project/opensearch';
import { createLiteralV2IndexOnce } from './opensearch-create-index.js';
import { createV2IndexBody } from './opensearch-v2-profile.js';

const index = 'station-mail-v2-g11111111111141118111111111111111';
const readback = () => ({ [index]: { aliases: {}, mappings: createV2IndexBody(index).mappings,
  settings: { index: { number_of_shards: '1', number_of_replicas: '0', max_result_window: '200',
    refresh_interval: '1s', mapping: { total_fields: { limit: '64' } },
    replication: { type: 'DOCUMENT' }, uuid: 'fixed_uuid', creation_date: '1760000000000',
    provided_name: index, version: { created: '13927900' } } } } });
function envelope(value: unknown) {
  return Object.assign(Promise.resolve({ body: Readable.from([Buffer.from(JSON.stringify(value))]),
    statusCode: 200, headers: {} }), { abort() {} });
}
function fake(created: unknown, found: unknown = readback()) {
  const calls: { method: string; args: unknown; options: unknown }[] = [];
  const indices = {
    create: (args: unknown, options: unknown) => { calls.push({ method: 'create', args, options }); return envelope(created); },
    get: (args: unknown, options: unknown) => { calls.push({ method: 'get', args, options }); return envelope(found); },
  } as unknown as Pick<Client['indices'], 'create' | 'get'>;
  return { indices, calls };
}

describe('fixed uncalled v2 create adapter', () => {
  it('sends one complete literal body, then one bounded readback', async () => {
    const fixture = fake({ acknowledged: true, shards_acknowledged: true, index });
    await expect(createLiteralV2IndexOnce(fixture.indices, index)).resolves.toEqual({ uuid: 'fixed_uuid' });
    expect(fixture.calls.map(call => call.method)).toEqual(['create', 'get']);
    expect(fixture.calls[0]?.args).toEqual({ index, body: createV2IndexBody(index) });
    for (const call of fixture.calls) expect(call.options).toMatchObject({
      asStream: true, maxRetries: 0, requestTimeout: 5_000 });
  });
  it('never reads back or retries an ambiguous original response', async () => {
    for (const response of [
      { acknowledged: false, shards_acknowledged: true, index },
      { acknowledged: true, shards_acknowledged: false, index },
      { acknowledged: true, shards_acknowledged: true, index: 'other' },
      {}, null,
    ]) {
      const fixture = fake(response);
      await expect(createLiteralV2IndexOnce(fixture.indices, index)).rejects.toThrow();
      expect(fixture.calls.map(call => call.method)).toEqual(['create']);
    }
  });
  it('rejects alias, UUID and profile drift without another create', async () => {
    for (const change of [
      (value: ReturnType<typeof readback>) => { value[index]!.aliases = { rogue: {} } as never; },
      (value: ReturnType<typeof readback>) => { value[index]!.settings.index.uuid = 'bad uuid'; },
      (value: ReturnType<typeof readback>) => { value[index]!.settings.index.number_of_shards = '2'; },
    ]) {
      const found = readback(); change(found);
      const fixture = fake({ acknowledged: true, shards_acknowledged: true, index }, found);
      await expect(createLiteralV2IndexOnce(fixture.indices, index)).rejects.toThrow();
      expect(fixture.calls.map(call => call.method)).toEqual(['create', 'get']);
    }
    const fixture = fake({ acknowledged: true, shards_acknowledged: true, index });
    await expect(createLiteralV2IndexOnce(fixture.indices, 'invalid')).rejects.toThrow();
    expect(fixture.calls).toHaveLength(0);
  });
});
