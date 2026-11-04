import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@opensearch-project/opensearch';
import Transport from '@opensearch-project/opensearch/lib/Transport.js';
import Connection from '@opensearch-project/opensearch/lib/Connection.js';
import { boundedSearchSdkEnvelope, SearchEngineError } from
  '../../packages/search/dist/opensearch-runtime.js';
import { installWriterDeliveryProbe } from '../integration/search-writer-role-delivery-transport.mjs';

test('fixture preserves real TLS PUT, original 201 evidence and held abort before close',
  { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.resolve('.cache/results/writer-delivery-transport-'));
  const keyFile = path.join(root, 'key.pem'), certFile = path.join(root, 'cert.pem');
  const created = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-days', '1', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext', 'extendedKeyUsage=serverAuth,clientAuth'], { stdio: 'ignore', timeout: 10_000 });
  assert.equal(created.status, 0);
  const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
  const target = `station_indexer_${'1'.repeat(32)}`;
  let received = 0, closed = 0, socketsClosed = 0;
  const server = createServer({ key, cert, ca: cert, requestCert: true,
    rejectUnauthorized: true }, (request, response) => {
    assert.equal(request.method, 'PUT');
    assert.equal(request.url, `/_plugins/_security/api/roles/${target}`);
    received++;
    response.on('close', () => { closed++; });
    request.socket.once('close', () => { socketsClosed++; });
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'CREATED', message: `'${target}' created.` }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const cases = ['false-ack', 'lost-return', 'held-timeout', 'held-release'];
    for (const mode of cases) {
      const markers = [];
      let held = 0;
      const restore = installWriterDeliveryProbe(Transport, Connection,
        mode === 'held-release' ? 'held-timeout' : mode,
        value => markers.push(value), { publish: () => { held++; },
          exists: () => mode === 'held-release' && held > 0 });
      const client = new Client({ node: `https://127.0.0.1:${address.port}`,
        ssl: { ca: cert, cert, key, rejectUnauthorized: true }, maxRetries: 0,
        requestTimeout: 1000, sniffOnStart: false,
        sniffOnConnectionFault: false, sniffInterval: false });
      try {
        const request = () => boundedSearchSdkEnvelope(options => client.transport.request({
          method: 'PUT', path: `/_plugins/_security/api/roles/${target}`,
          body: { cluster_permissions: [] } }, options), 32_768, mode === 'held-timeout' ? 250 : 1000);
        if (mode === 'false-ack' || mode === 'held-release') {
          const response = await request();
          assert.equal(response.statusCode, mode === 'false-ack' ? 200 : 201);
          assert.deepEqual(response.body, mode === 'false-ack' ?
            { status: 'OK', message: `'${target}' updated.` } :
            { status: 'CREATED', message: `'${target}' created.` });
        } else await assert.rejects(request(), error => {
          if (mode === 'held-timeout') {
            assert.ok(error instanceof SearchEngineError);
            assert.equal(error.kind, 'timeout');
          }
          return true;
        });
        assert.equal(markers.filter(value => value === 'PRODUCER_PUT').length, 1);
        assert.equal(markers.filter(value => value === 'CONNECTION_PUT').length, 1);
        assert.equal(received, cases.indexOf(mode) + 1);
        if (mode === 'held-timeout') {
          for (let tick = 0; tick < 100 &&
              (!markers.includes('REAL_RESPONSE_CLOSED') || socketsClosed < 3); tick++)
            await delay(20);
          assert.equal(held, 1);
          assert.ok(markers.includes('REAL_RESPONSE_HELD'));
          assert.ok(markers.includes('ORIGINAL_ABORT'));
          assert.ok(markers.includes('REAL_RESPONSE_CLOSED'));
          assert.equal(closed, 3);
          assert.equal(socketsClosed, 3);
        } else if (mode === 'held-release') {
          assert.equal(held, 1);
          assert.ok(markers.includes('REAL_RESPONSE_HELD'));
          assert.ok(markers.includes('REAL_RESPONSE_RELEASED'));
          assert.equal(markers.includes('ORIGINAL_ABORT'), false);
        } else assert.ok(markers.includes('ORIGINAL_201_CREATED'));
      } finally { await client.close(); restore(); }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
