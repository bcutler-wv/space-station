import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writerMappingDeliverySummary } from './search-writer-mapping-delivery-summary.mjs';

test('writer mapping delivery public summary is exact, finite and redacted', () => {
  const positive = 'Writer mapping delivery summary case=positive pair=default revision=5 ' +
    'create=unobserved start=unobserved put=inferred-one checked=true.';
  const versions = 'Writer mapping delivery versions docker=28.5.1 api=1.51 compose=v2.40.3 opensearch=3.9.0 security=3.9.0.0 sdk=3.9.0.';
  const fault = 'Writer mapping delivery summary case=held-timeout pair=runner revision=3 ' +
    'create=2 start=2 put=one checked=true.';
  const shape = 'Writer mapping delivery created-shape transfer=none apply=admin-internal fence=2.';
  const secret = 'private-credential-sentinel-DO-NOT-FORWARD';
  assert.equal(writerMappingDeliverySummary(`${secret}\n${positive}\n${versions}\n${secret}\n`,
    'positive', 'default'), `${positive}\n${versions}`);
  assert.equal(writerMappingDeliverySummary(`${secret}\n${fault}\n${versions}\n${shape}\n`,
    'held-timeout', 'runner'), `${fault}\n${versions}\n${shape}`);
  for (const raw of [`${positive}\n${versions}\n${positive}`,
    `${positive}\n${versions}\nWriter mapping delivery summary ${secret}`,
    `${positive}\n${versions}\nWriter mapping delivery created-shape transfer=none apply=admin-internal fence=2.`,
    `${fault}\n${versions}\nWriter mapping delivery created-shape transfer=none apply=admin-internal fence=1.`,
    `${positive}\n${versions}\x1b`,
    `${positive}\nWriter mapping delivery versions docker=${'9'.repeat(10_000)}.5.1 api=1.51 compose=v2.40.3 opensearch=3.9.0 security=3.9.0.0 sdk=3.9.0.`,
    `${positive}\n${versions}\n${secret}`.repeat(100_000)]) {
    assert.throws(() => writerMappingDeliverySummary(raw, raw.includes('held-timeout') ?
      'held-timeout' : 'positive', raw.includes('held-timeout') ? 'runner' : 'default'));
  }
  assert.throws(() => writerMappingDeliverySummary(`${positive}\n${versions}`, 'other', 'default'));
});
