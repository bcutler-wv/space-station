// Disposable fixture only: preserve the pinned SDK's original transport and abort handles.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const fixedPath = /^\/_plugins\/_security\/api\/roles\/station_indexer_[0-9a-f]{32}$/;
const modes = ['lost-return', 'false-ack', 'held-timeout'];
export function installWriterDeliveryProbe(Transport, Connection, mode, marker,
  { exists = existsSync, publish = writeFileSync, sleep = delay } = {}) {
  assert.ok(modes.includes(mode));
  let producer = 0, connection = 0;
  const originalTransport = Transport.prototype.request;
  const originalConnection = Connection.prototype.request;
  Connection.prototype.request = function countedConnection(params, callback) {
    if (params.method !== 'PUT' || !fixedPath.test(params.path))
      return originalConnection.call(this, params, callback);
    assert.equal(++connection, 1);
    marker('CONNECTION_PUT');
    if (mode !== 'held-timeout') return originalConnection.call(this, params, callback);
    let settled = false, heldResponse;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      if (error && heldResponse && !heldResponse.destroyed) heldResponse.destroy();
      callback(error, response);
    };
    const handle = originalConnection.call(this, params, (error, response) => {
      if (error) { finish(error, response); return; }
      if (settled) { response?.destroy(); return; }
      if (response?.statusCode !== 201) {
        response?.destroy(); finish(Error('Fixture expected real 201'), null); return;
      }
      heldResponse = response;
      response.once('close', () => marker('REAL_RESPONSE_CLOSED'));
      marker('REAL_RESPONSE_HELD');
      publish('/tmp/writer-delivery-response-held', '1', { flag: 'wx', mode: 0o600 });
      void (async () => {
        for (let tick = 0; tick < 300 && !settled; tick++) {
          if (exists('/tmp/writer-delivery-response-release')) {
            marker('REAL_RESPONSE_RELEASED'); finish(null, response); return;
          }
          await sleep(100);
        }
        finish(Error('Fixture hold expired'), null);
      })();
    });
    handle.once('abort', () => { marker('ORIGINAL_ABORT'); finish(Error('Fixture abort'), null); });
    handle.once('error', () => finish(Error('Fixture request error'), null));
    return handle;
  };
  Transport.prototype.request = function fixtureTransport(params, options, callback) {
    if (params.method !== 'PUT' || !fixedPath.test(params.path))
      return originalTransport.call(this, params, options, callback);
    assert.equal(++producer, 1);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.asStream, true);
    marker('PRODUCER_PUT');
    const original = originalTransport.call(this, params, options, callback);
    assert.equal(typeof original.abort, 'function');
    if (mode === 'held-timeout') return original;
    const changed = original.then(async response => {
      marker('REAL_RESPONSE_RECEIVED');
      assert.equal(response.statusCode, 201);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; assert.ok(size > 0 && size <= 32_768);
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.deepEqual(body, { status: 'CREATED', message: `'${params.path.split('/').at(-1)}' created.` });
      marker('ORIGINAL_201_CREATED');
      if (mode === 'lost-return') throw Error('Fixture discarded original return');
      const falseBody = Buffer.from(JSON.stringify({ status: 'OK', message:
        `'${params.path.split('/').at(-1)}' updated.` }));
      return { ...response, statusCode: 200, body: Readable.from([falseBody]),
        headers: { ...response.headers, 'content-length': String(falseBody.length) } };
    });
    changed.abort = (...args) => original.abort(...args);
    return changed;
  };
  return () => { Transport.prototype.request = originalTransport;
    Connection.prototype.request = originalConnection; };
}
