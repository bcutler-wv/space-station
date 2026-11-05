import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWriterMappingPrepareRequestProbe } from
  '../integration/search-writer-mapping-prepare-fixture-probe.mjs';

test('mapping fixture probe forwards original receiver, params, callback, return and throw', () => {
  const events = [], returned = { abort() {} };
  class Connection {
    request(params, callback) {
      events.push(['original', this, params, callback]);
      if (params.method === 'POST') throw Error('original throw');
      return returned;
    }
  }
  const original = Connection.prototype.request;
  const restore = installWriterMappingPrepareRequestProbe(Connection,
    method => events.push(['probe', method]));
  const instance = new Connection(), params = { method: 'GET', path: '/_search' };
  const callback = () => {};
  assert.equal(instance.request(params, callback), returned);
  assert.deepEqual(events, [['probe', 'GET'], ['original', instance, params, callback]]);
  events.length = 0;
  assert.throws(() => instance.request({ method: 'POST' }, callback), /original throw/);
  assert.deepEqual(events.map(value => value[0]), ['probe', 'original']);
  assert.equal(events[0][1], 'OTHER');
  restore();
  assert.equal(Connection.prototype.request, original);
});
