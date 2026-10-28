import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transferInvocationWritable } from './search-create-intent-gate-mount-policy.mjs';

test('exact transfer volume accepts Docker omitted false but rejects readonly or redirected mount', () => {
  const source = 'stationcreatedefaultaaaaaaaaaaaa_search_create_11111111111141118111111111111111';
  const host = { Type: 'volume', Source: source, Target: '/run/create-boundary',
    VolumeOptions: { NoCopy: true } };
  const effective = { Type: 'volume', Name: source, Destination: '/run/create-boundary', RW: true };
  assert.equal(transferInvocationWritable(host, effective, source), true);
  assert.equal(transferInvocationWritable({ ...host, ReadOnly: false }, effective, source), true);
  for (const changed of [{ ...host, ReadOnly: true }, { ...host, ReadOnly: 'false' },
    { ...host, Source: 'other' }, { ...host, VolumeOptions: { NoCopy: false } }])
    assert.equal(transferInvocationWritable(changed, effective, source), false);
  assert.equal(transferInvocationWritable(host, { ...effective, RW: false }, source), false);
  assert.equal(transferInvocationWritable(host, { ...effective, Destination: '/other' }, source), false);
});
