import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setInterval, clearInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '@opensearch-project/opensearch';
import Connection from '@opensearch-project/opensearch/lib/Connection.js';
import { boundedSearchSdkEnvelope, SearchEngineError } from '../../packages/search/dist/opensearch-runtime.js';

test('pinned SDK role envelope bounds real mTLS streams and aborts without replay',
  { timeout: 12_000 }, async () => {
  const directory = await mkdtemp(resolve('.cache/results/writer-role-transport-'));
  const keyPath = join(directory, 'identity.key'), certPath = join(directory, 'identity.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-days', '1', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext', 'extendedKeyUsage=serverAuth,clientAuth'],
  { stdio: 'ignore', timeout: 10_000 });
  assert.equal(generated.status, 0);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  let phase = 'normal', received = 0, closed = 0, aborts = 0;
  let producers = 0, connections = 0;
  const originalConnection = Connection.prototype.request;
  const server = createServer({ key, cert, ca: cert, requestCert: true,
    rejectUnauthorized: true }, (_request, response) => {
    received++;
    response.on('close', () => { closed++; });
    response.writeHead(200, { 'content-type': 'application/json' });
    if (phase === 'normal') response.end('{"status":"CREATED"}');
    else if (phase === 'oversize') response.end(JSON.stringify({ x: 'a'.repeat(10_000) }));
    else if (phase === 'malformed') response.end('{');
    else {
      response.write('{');
      const interval = setInterval(() => response.write(' '), 30);
      response.on('close', () => clearInterval(interval));
    }
  });
  let client;
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    client = new Client({ node: `https://127.0.0.1:${address.port}`,
      ssl: { ca: cert, cert, key, rejectUnauthorized: true }, maxRetries: 0,
      requestTimeout: 1_000, sniffOnStart: false,
      sniffOnConnectionFault: false, sniffInterval: false });
    Connection.prototype.request = function countedConnection(params, callback) {
      if (params.method === 'PUT' && params.path.startsWith('/_plugins/_security/api/roles/'))
        connections++;
      return originalConnection.call(this, params, callback);
    };
    const request = client.transport.request;
    client.transport.request = function counted(params, options) {
      producers++;
      assert.equal(options.maxRetries, 0);
      assert.equal(options.asStream, true);
      const result = request.call(this, params, options);
      assert.equal(typeof result.abort, 'function');
      const abort = result.abort;
      result.abort = function countedAbort() { aborts++; return abort.call(this); };
      return result;
    };
    const send = (cap, budget) => boundedSearchSdkEnvelope(options =>
      client.transport.request({ method: 'PUT', path: '/_plugins/_security/api/roles/station_indexer_' +
        '1'.repeat(32), body: { cluster_permissions: [] } }, options), cap, budget);
    const normal = await send(1024, 1000);
    assert.deepEqual(normal.body, { status: 'CREATED' });
    assert.equal(normal.statusCode, 200);
    assert.deepEqual([producers, connections, received], [1, 1, 1]);
    phase = 'oversize';
    await assert.rejects(send(1024, 1000), error => {
      assert.ok(error instanceof SearchEngineError);
      assert.equal(error.kind, 'response');
      return true;
    });
    assert.deepEqual([producers, connections, received], [2, 2, 2]);
    phase = 'malformed';
    await assert.rejects(send(1024, 1000), error => {
      assert.ok(error instanceof SearchEngineError);
      assert.equal(error.kind, 'response');
      return true;
    });
    assert.deepEqual([producers, connections, received], [3, 3, 3]);
    phase = 'trickle';
    let lateSuccess = 0;
    await assert.rejects(send(1024, 250).then(() => { lateSuccess++; }), error => {
      assert.ok(error instanceof SearchEngineError);
      assert.equal(error.kind, 'timeout');
      return true;
    });
    assert.deepEqual([producers, connections, received], [4, 4, 4]);
    await delay(150);
    assert.equal(lateSuccess, 0);
    assert.equal(producers, 4);
    assert.equal(connections, 4);
    assert.equal(received, 4);
    assert.equal(closed, 4);
    assert.ok(aborts >= 1);
  } finally {
    Connection.prototype.request = originalConnection;
    if (client) await client.close();
    await new Promise(done => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});
