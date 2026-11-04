import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWriterPrepareRequestProbe } from
  '../integration/search-writer-role-prepare-fixture-probe.mjs';

test('disposable Connection probe preserves receiver, arguments, return, abort and throw', () => {
  const calls = [], markers = [];
  const result = { abort() { calls.push('abort'); } };
  class Connection {
    request(params, callback) {
      calls.push([this, params, callback]);
      if (params.fail) throw Error('original failure');
      return result;
    }
  }
  const original = Connection.prototype.request;
  const restore = installWriterPrepareRequestProbe(Connection, method => markers.push(method));
  const instance = new Connection();
  const callback = () => {};
  const params = { method: 'GET' };
  const returned = instance.request(params, callback);
  assert.equal(returned, result);
  returned.abort();
  assert.deepEqual(calls, [[instance, params, callback], 'abort']);
  assert.deepEqual(markers, ['GET']);
  assert.throws(() => instance.request({ method: 'PUT', fail: true }, callback),
    /original failure/);
  assert.deepEqual(markers, ['GET', 'OTHER']);
  restore();
  assert.equal(Connection.prototype.request, original);
});
