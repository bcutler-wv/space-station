import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writerRoleDeliverySummary } from './search-writer-role-delivery-summary.mjs';

test('writer delivery public summary is exact, finite and redacted', () => {
  const positive = 'Writer role delivery summary case=positive pair=default revision=5 ' +
    'create=unobserved start=unobserved put=inferred-one checked=true.';
  const versions = 'Writer role delivery versions docker=28.5.1 api=1.51 compose=v2.40.3 opensearch=3.9.0.';
  const fault = 'Writer role delivery summary case=held-timeout pair=runner revision=3 ' +
    'create=2 start=2 put=one checked=true.';
  const shape = 'Writer role delivery created-shape transfer=none apply=admin-internal fence=2.';
  const secret = 'private-credential-sentinel-DO-NOT-FORWARD';
  assert.equal(writerRoleDeliverySummary(`${secret}\n${positive}\n${versions}\n${secret}\n`,
    'positive', 'default'), `${positive}\n${versions}`);
  assert.equal(writerRoleDeliverySummary(`${secret}\n${fault}\n${versions}\n${shape}\n`,
    'held-timeout', 'runner'), `${fault}\n${versions}\n${shape}`);
  for (const raw of [`${positive}\n${versions}\n${positive}`,
    `${positive}\n${versions}\nWriter role delivery summary ${secret}`,
    `${positive}\n${versions}\nWriter role delivery created-shape transfer=none apply=admin-internal fence=2.`,
    `${fault}\n${versions}\nWriter role delivery created-shape transfer=none apply=admin-internal fence=1.`,
    `${positive}\n${versions}\x1b`,
    `${positive}\n${versions}\n${secret}`.repeat(100_000)]) {
    assert.throws(() => writerRoleDeliverySummary(raw, raw.includes('held-timeout') ?
      'held-timeout' : 'positive', raw.includes('held-timeout') ? 'runner' : 'default'));
  }
  assert.throws(() => writerRoleDeliverySummary(`${positive}\n${versions}`, 'other', 'default'));
});
