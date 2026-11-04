/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import Connection from '@opensearch-project/opensearch/lib/Connection.js';
import Transport from '@opensearch-project/opensearch/lib/Transport.js';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildWriterMappingContract } from
  '../../packages/search/dist/opensearch-writer-role-contract.js';
import { openSearchAdminWriterMappingSender, SearchEngineError,
  verifyWriterMappingFirstResponse } from '../../packages/search/dist/opensearch-runtime.js';

const token = '11111111-1111-4111-8111-111111111111';
const suffix = token.replaceAll('-', '');
const index = `station-mail-v2-g${suffix}`;
const target = `station_indexer_${suffix}`;
const principal = `station-search-indexer-${suffix}`;
const mappingPath = `/_plugins/_security/api/rolesmapping/${target}`;
const prior = { version: 'station-generation-registry-v1', generations: [{
  token: 'legacy-v1', index: 'station-mail-v1', profile: 'station-mail-v1',
  presence: 'exact', uuid: 'legacy_uuid', writerRole: null, queryRole: null,
  writerPrincipal: null, queryPrincipal: null, writerCertFingerprint: null,
  queryCertFingerprint: null,
}] };
const candidate = { token, index, profile: 'station-mail-v2', uuid: 'candidate_uuid',
  writerRole: target, writerPrincipal: principal };
const dispatch = operation => searchGenerationDispatchSpec({
  generationToken: token, physicalIndex: index, profileId: 'station-mail-v2',
  indexUuid: 'candidate_uuid', lifecycle: 'bound', writerRole: target,
  queryRole: `station_query_${suffix}`, writerPrincipal: principal,
  queryPrincipal: `station-search-query-${suffix}`,
  writerCertFingerprint: null, queryCertFingerprint: null,
  createdAt: new Date('2026-10-22T00:00:00Z'),
}, operation);
const contract = () => buildWriterMappingContract(prior, candidate,
  dispatch('writer_role'), dispatch('writer_mapping'));
const created = () => ({ status: 'CREATED', message: `'${target}' created.` });

let directory, key, cert;
before(async () => {
  await mkdir('.cache/results', { recursive: true });
  directory = await mkdtemp(resolve('.cache/results/writer-mapping-sender-'));
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-nodes', '-days', '1', '-keyout', join(directory, 'admin.key'),
    '-out', join(directory, 'admin.pem'), '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext', 'extendedKeyUsage=serverAuth,clientAuth'],
  { stdio: 'ignore', timeout: 10_000 });
  assert.equal(generated.status, 0);
  await copyFile(join(directory, 'admin.pem'), join(directory, 'ca.pem'));
  [key, cert] = await Promise.all([readFile(join(directory, 'admin.key')),
    readFile(join(directory, 'admin.pem'))]);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function fixture(serve) {
  const server = createServer({ key, cert, ca: cert, requestCert: true,
    rejectUnauthorized: true }, serve);
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { input: { endpoint: `https://127.0.0.1:${address.port}`,
    identityDir: directory }, close: async () => {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  } };
}
function traceSdk() {
  const originalTransport = Transport.prototype.request;
  const originalConnection = Connection.prototype.request;
  const counts = { producer: 0, connection: 0 };
  Transport.prototype.request = function tracedTransport(params, options, callback) {
    const request = Reflect.apply(originalTransport, this, [params, options, callback]);
    if (params.method === 'PUT' && params.path === mappingPath) {
      counts.producer++;
      assert.equal(options.maxRetries, 0);
      assert.equal(options.asStream, true);
      assert.equal(typeof request.abort, 'function');
    }
    return request;
  };
  Connection.prototype.request = function tracedConnection(params, callback) {
    if (params.method === 'PUT' && params.path === mappingPath) counts.connection++;
    return Reflect.apply(originalConnection, this, [params, callback]);
  };
  return { counts, restore: () => {
    Transport.prototype.request = originalTransport;
    Connection.prototype.request = originalConnection;
  } };
}
const failureKind = kind => error => {
  assert.ok(error instanceof SearchEngineError);
  assert.equal(error.kind, kind);
  return true;
};

test('first-create parser is exact and descriptor-safe', () => {
  const accepted = verifyWriterMappingFirstResponse(201, created(), target);
  assert.deepEqual(accepted, { created: true });
  assert.equal(Object.isFrozen(accepted), true);
  for (const [status, body] of [
    [200, { status: 'OK', message: `'${target}' updated.` }],
    [201, { status: 'CREATED' }],
    [201, { ...created(), extra: true }],
    [201, { status: 'CREATED', message: "'other' created." }],
  ]) assert.throws(() => verifyWriterMappingFirstResponse(status, body, target),
    failureKind('partial'));
  let getters = 0;
  const accessor = { status: 'CREATED' };
  Object.defineProperty(accessor, 'message', { enumerable: true,
    get() { getters++; return `'${target}' created.`; } });
  assert.throws(() => verifyWriterMappingFirstResponse(201, accessor, target),
    failureKind('partial'));
  const hidden = created();
  Object.defineProperty(hidden, 'extra', { value: true });
  assert.throws(() => verifyWriterMappingFirstResponse(201, hidden, target),
    failureKind('partial'));
  assert.equal(getters, 0);
});

test('unissued mapping contracts reject before input getters or credential access', async () => {
  const valid = contract();
  let getterCalls = 0;
  const hostileInput = { get endpoint() { getterCalls++; throw Error('private'); },
    get identityDir() { getterCalls++; throw Error('private'); } };
  for (const forged of [structuredClone(valid), { ...valid, target: 'wrong' },
    Object.defineProperty({}, 'body', { get() { getterCalls++; return valid.body; } })])
    await assert.rejects(openSearchAdminWriterMappingSender(hostileInput, forged));
  assert.equal(getterCalls, 0);
});

test('one original pinned SDK mapping PUT accepts first creation and latches overlap, args and close',
  { timeout: 12_000 }, async () => {
  const received = [];
  const f = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ method: request.method, path: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      authorized: request.client.authorized });
    await delay(50);
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify(created()));
  });
  const trace = traceSdk();
  let sender;
  try {
    sender = await openSearchAdminWriterMappingSender(f.input, contract());
    await assert.rejects(sender.sendOnce('caller-body'), failureKind('configuration'));
    assert.deepEqual(trace.counts, { producer: 0, connection: 0 });
    const first = sender.sendOnce();
    await assert.rejects(sender.sendOnce(), failureKind('configuration'));
    const result = await first;
    assert.deepEqual(result, { created: true });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(received, [{ method: 'PUT', path: mappingPath,
      body: { users: [principal], backend_roles: [], hosts: [] }, authorized: true }]);
    assert.deepEqual(trace.counts, { producer: 1, connection: 1 });
    await assert.rejects(sender.sendOnce(), failureKind('configuration'));
    await sender.close(); sender = null;
    const closed = await openSearchAdminWriterMappingSender(f.input, contract());
    await assert.rejects(closed.close('caller-option'), failureKind('configuration'));
    await closed.close();
    await assert.rejects(closed.sendOnce(), failureKind('configuration'));
    assert.deepEqual(trace.counts, { producer: 1, connection: 1 });
  } finally {
    if (sender) await sender.close();
    trace.restore();
    await f.close();
  }
});

test('a caught producer fault leaves the same sender permanently attempted', async () => {
  let received = 0, calls = 0;
  const f = await fixture((_request, response) => { received++; response.end(); });
  const original = Transport.prototype.request;
  Transport.prototype.request = function failingProducer(params, options, callback) {
    if (params.method === 'PUT' && params.path === mappingPath) {
      calls++;
      throw Error('private producer detail');
    }
    return Reflect.apply(original, this, [params, options, callback]);
  };
  let sender;
  try {
    sender = await openSearchAdminWriterMappingSender(f.input, contract());
    await assert.rejects(sender.sendOnce(), failureKind('transport'));
    await assert.rejects(sender.sendOnce(), failureKind('configuration'));
    assert.equal(calls, 1);
    assert.equal(received, 0);
  } finally {
    if (sender) await sender.close();
    Transport.prototype.request = original;
    await f.close();
  }
});

test('replacement, partial, unknown, malformed, oversize and lost responses never confirm or replay',
  { timeout: 15_000 }, async () => {
  let mode = 'replacement', received = 0;
  const f = await fixture(async (request, response) => {
    for await (const chunk of request) assert.ok(Buffer.byteLength(chunk) <= 4096);
    received++;
    if (mode === 'lost') { request.socket.destroy(); return; }
    response.writeHead(mode === 'replacement' ? 200 : 201,
      { 'content-type': 'application/json',
        ...(mode === 'oversize' ? { 'content-length': '40000' } : {}) });
    const bodies = { replacement: { status: 'OK', message: `'${target}' updated.` },
      partial: { status: 'CREATED' },
      unknown: { status: 'CREATED', message: "'wrong' created." },
      extra: { ...created(), extra: true } };
    response.end(mode === 'malformed' ? '{' : mode === 'oversize' ? 'x'.repeat(40_000) :
      JSON.stringify(bodies[mode]));
  });
  const trace = traceSdk();
  try {
    for (const [nextMode, kind] of [
      ['replacement', 'partial'], ['partial', 'partial'], ['unknown', 'partial'],
      ['extra', 'partial'], ['malformed', 'response'],
      ['oversize', 'response'], ['lost', 'transport'],
    ]) {
      mode = nextMode;
      const sender = await openSearchAdminWriterMappingSender(f.input, contract());
      const before = { ...trace.counts, received };
      try {
        await assert.rejects(sender.sendOnce(), failureKind(kind));
        await assert.rejects(sender.sendOnce(), failureKind('configuration'));
        assert.deepEqual(trace.counts, { producer: before.producer + 1,
          connection: before.connection + 1 }, mode);
        assert.equal(received, before.received + 1, mode);
      } finally { await sender.close(); }
    }
  } finally { trace.restore(); await f.close(); }
});

test('trickling original response times out and closes its socket before explicit sender close',
  { timeout: 12_000 }, async () => {
  let received = 0, socketClosed = false;
  const f = await fixture(async (request, response) => {
    for await (const chunk of request) assert.ok(Buffer.byteLength(chunk) <= 4096);
    received++;
    request.socket.on('close', () => { socketClosed = true; });
    response.writeHead(201, { 'content-type': 'application/json' });
    response.write('{');
    const interval = setInterval(() => response.write(' '), 40);
    request.socket.on('close', () => clearInterval(interval));
  });
  const trace = traceSdk();
  const sender = await openSearchAdminWriterMappingSender(f.input, contract());
  try {
    await assert.rejects(sender.sendOnce(), failureKind('timeout'));
    for (let count = 0; count < 20 && !socketClosed; count++) await delay(25);
    assert.equal(socketClosed, true);
    assert.equal(received, 1);
    assert.deepEqual(trace.counts, { producer: 1, connection: 1 });
    await assert.rejects(sender.sendOnce(), failureKind('configuration'));
  } finally { await sender.close(); trace.restore(); await f.close(); }
});
