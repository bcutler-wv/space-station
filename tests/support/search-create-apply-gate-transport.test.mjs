import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import Connection from '@opensearch-project/opensearch/lib/Connection.js';
import { installHeldCreateResponse } from './search-create-apply-gate-transport.mjs';

const index = 'station-mail-v2-g1234567890abcdef';
const wait = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(done => setTimeout(done, 20));
  }
  throw Error('Fixture response was not held');
};

test('real pinned TLS connection holds response, releases or aborts exactly once',
  { timeout: 12_000 }, async () => {
  const dir = await mkdtemp(resolve('.cache/results/create-apply-transport-'));
  const keyPath = join(dir, 'identity.key');
  const certPath = join(dir, 'identity.pem');
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-days', '1', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext', 'extendedKeyUsage=serverAuth,clientAuth'],
  { stdio: 'ignore', timeout: 10_000 });
  assert.equal(openssl.status, 0);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  let requests = 0;
  const server = createServer({ key, cert, ca: cert, requestCert: true,
    rejectUnauthorized: true }, (_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ acknowledged: true, shards_acknowledged: true, index }));
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const original = Connection.prototype.request;
  try {
    for (const abort of [false, true]) {
      const heldPath = join(dir, `held-${abort}`);
      const releasePath = join(dir, `release-${abort}`);
      const markers = [];
      const restore = installHeldCreateResponse(Connection, {
        marker: value => markers.push(value), heldPath, releasePath, ticks: 100, tickMs: 20 });
      const connection = new Connection({ url: new URL(`https://127.0.0.1:${address.port}`),
        ssl: { ca: cert, cert, key, rejectUnauthorized: true } });
      try {
        let callbacks = 0;
        let controller;
        const result = new Promise((done, reject) => {
          const handle = connection.request({ method: 'PUT', path: `/${index}`, body: '{}',
            headers: { 'content-type': 'application/json' } }, (error, response) => {
            callbacks++;
            done({ error, response });
          });
          controller = wait(() => markers.includes('TRANSPORT_REAL_RESPONSE_HELD')).then(async () => {
            assert.equal(callbacks, 0);
            if (abort) handle.abort();
            else await writeFile(releasePath, '1');
          }).catch(reject);
        });
        const { error, response } = await result;
        await controller;
        if (abort) assert.match(error?.message ?? '', /abort/i);
        else {
          assert.equal(error, null);
          assert.equal(response.statusCode, 200);
          response.resume();
        }
        await new Promise(done => setTimeout(done, 80));
        assert.equal(callbacks, 1);
        assert.equal(markers.includes('TRANSPORT_RELEASED'), !abort);
        assert.equal(markers.includes('TRANSPORT_ABORTED'), abort);
      } finally { restore(); await new Promise(done => connection.close(done)); }
    }
    assert.equal(requests, 2);
    assert.equal(Connection.prototype.request, original);
  } finally {
    Connection.prototype.request = original;
    await new Promise(done => server.close(done));
    await rm(dir, { recursive: true, force: true });
  }
});
