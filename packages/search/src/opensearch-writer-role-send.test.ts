import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { searchGenerationDispatchSpec } from '../../db/dist/search-generation-manifest.js';
import { openSearchAdminWriterRoleSender, SearchEngineError } from './opensearch-runtime.js';
import { buildWriterRoleContract, issuedWriterRoleRequest } from './opensearch-writer-role-contract.js';

const token = '11111111-1111-4111-8111-111111111111';
const suffix = token.replaceAll('-', '');
const index = `station-mail-v2-g${suffix}`;
const target = `station_indexer_${suffix}`;
const candidate = () => ({ token, index, profile: 'station-mail-v2' as const,
  uuid: 'candidate_uuid', writerRole: target });
const prior = () => ({ version: 'station-generation-registry-v1' as const,
  generations: [{ token: 'legacy-v1', index: 'station-mail-v1',
    profile: 'station-mail-v1' as const, presence: 'exact' as const,
    uuid: 'legacy_uuid', writerRole: null, queryRole: null,
    writerPrincipal: null, queryPrincipal: null,
    writerCertFingerprint: null, queryCertFingerprint: null }] });
const contract = () => buildWriterRoleContract(prior(), candidate(),
  searchGenerationDispatchSpec({ generationToken: token, physicalIndex: index,
    profileId: 'station-mail-v2', indexUuid: 'candidate_uuid', lifecycle: 'bound',
    writerRole: target, queryRole: `station_query_${suffix}`,
    writerPrincipal: `station-search-indexer-${suffix}`,
    queryPrincipal: `station-search-query-${suffix}`,
    writerCertFingerprint: null, queryCertFingerprint: null,
    createdAt: new Date('2026-10-22T00:00:00Z') }, 'writer_role'));

let directory: string;
let certificate: Buffer;
let key: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(resolve('.cache/results/writer-role-send-'));
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-days', '1', '-keyout', join(directory, 'admin.key'),
    '-out', join(directory, 'admin.pem'), '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext', 'extendedKeyUsage=serverAuth,clientAuth'],
  { stdio: 'ignore', timeout: 10_000 });
  expect(generated.status).toBe(0);
  await copyFile(join(directory, 'admin.pem'), join(directory, 'ca.pem'));
  [certificate, key] = await Promise.all([readFile(join(directory, 'admin.pem')),
    readFile(join(directory, 'admin.key'))]);
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

type Mode = 'created' | 'updated' | 'wrong-message' | 'extra' | 'missing' |
  'malformed' | 'oversize' | 'lost' | 'trickle';
async function fixture() {
  let mode: Mode = 'created';
  const received: { method: string; path: string; body: unknown }[] = [];
  let closed = 0;
  const server: Server = createServer({ cert: certificate, key, ca: certificate,
    requestCert: true, rejectUnauthorized: true }, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    received.push({ method: request.method ?? '', path: request.url ?? '',
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.on('close', () => { closed++; });
    if (mode === 'lost') { response.destroy(); return; }
    if (mode === 'trickle') {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.write('{');
      const timer = setInterval(() => response.write(' '), 100);
      response.on('close', () => clearInterval(timer));
      return;
    }
    const status = mode === 'updated' ? 200 : 201;
    const body = mode === 'updated' ? { status: 'OK', message: `'${target}' updated.` } :
      mode === 'wrong-message' ? { status: 'CREATED', message: 'other created.' } :
      mode === 'extra' ? { status: 'CREATED', message: `'${target}' created.`, extra: true } :
      mode === 'missing' ? { status: 'CREATED' } :
      { status: 'CREATED', message: `'${target}' created.` };
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(mode === 'malformed' ? '{' : mode === 'oversize' ? 'x'.repeat(40_000) :
      JSON.stringify(body));
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing local TLS address');
  const input = { endpoint: `https://127.0.0.1:${address.port}`, identityDir: directory };
  return { input, received, get closed() { return closed; },
    setMode(next: Mode) { mode = next; },
    async close() { server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done())); } };
}

test('constructor-issued request rejects copies and accessors before input or credential access', async () => {
  const genuine = contract();
  const request = issuedWriterRoleRequest(genuine);
  expect(Object.isFrozen(request)).toBe(true);
  expect(request.target).toBe(target);
  expect(request.bodySha256).toBe(genuine.bodySha256);
  expect(request.dispatchBodyIdentity).toBe(genuine.dispatchBodyIdentity);
  let reads = 0;
  const input = Object.defineProperties({}, {
    endpoint: { get() { reads++; return 'https://localhost:9200'; } },
    identityDir: { get() { reads++; return directory; } },
  }) as { endpoint: string; identityDir: string };
  const copied = structuredClone(genuine);
  const forged = Object.defineProperty({}, 'target', {
    get() { reads++; return target; },
  }) as typeof genuine;
  for (const invalid of [copied, forged, new Proxy(genuine, {})]) {
    expect(() => issuedWriterRoleRequest(invalid)).toThrow();
    await expect(openSearchAdminWriterRoleSender(input, invalid)).rejects.toThrow();
  }
  expect(reads).toBe(0);
});

test('one fixed real TLS PUT accepts only original first-create acknowledgment', async () => {
  const local = await fixture();
  try {
    const genuine = contract();
    const closedBeforeSend = await openSearchAdminWriterRoleSender(local.input, genuine);
    await closedBeforeSend.close();
    await expect(closedBeforeSend.sendOnce()).rejects.toMatchObject({ kind: 'configuration' });
    expect(local.received).toHaveLength(0);
    const sender = await openSearchAdminWriterRoleSender(local.input, genuine);
    await expect((sender.sendOnce as (...args: unknown[]) => Promise<unknown>)({
      path: '/wrong', body: {} })).rejects.toMatchObject({ kind: 'configuration' });
    expect(local.received).toHaveLength(0);
    await expect(sender.sendOnce()).resolves.toEqual({ created: true });
    expect(local.received).toEqual([{ method: 'PUT',
      path: `/_plugins/_security/api/roles/${target}`, body: genuine.body }]);
    await expect(sender.sendOnce()).rejects.toMatchObject({ kind: 'configuration' });
    expect(local.received).toHaveLength(1);
    await sender.close();
    await expect(sender.sendOnce()).rejects.toMatchObject({ kind: 'configuration' });
    const overlapping = await openSearchAdminWriterRoleSender(local.input, genuine);
    const beforeOverlap = local.received.length;
    const pair = await Promise.allSettled([overlapping.sendOnce(), overlapping.sendOnce()]);
    expect(pair.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(pair.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(local.received).toHaveLength(beforeOverlap + 1);
    await overlapping.close();
    for (const [mode, kind] of [
      ['updated', 'partial'], ['wrong-message', 'partial'], ['extra', 'partial'],
      ['missing', 'partial'], ['malformed', 'response'], ['oversize', 'response'],
      ['lost', 'transport'],
    ] as const) {
      local.setMode(mode);
      const next = await openSearchAdminWriterRoleSender(local.input, genuine);
      const before = local.received.length;
      await expect(next.sendOnce()).rejects.toMatchObject({ kind });
      expect(local.received).toHaveLength(before + 1);
      await expect(next.sendOnce()).rejects.toMatchObject({ kind: 'configuration' });
      expect(local.received).toHaveLength(before + 1);
      await next.close();
    }
    expect(local.received.every(row => row.method === 'PUT')).toBe(true);
  } finally { await local.close(); }
}, 15_000);

test('trickling original SDK response times out, aborts and cannot be resent', async () => {
  const local = await fixture();
  let sender: Awaited<ReturnType<typeof openSearchAdminWriterRoleSender>> | undefined;
  try {
    local.setMode('trickle');
    sender = await openSearchAdminWriterRoleSender(local.input, contract());
    await expect(sender.sendOnce()).rejects.toMatchObject({ kind: 'timeout' });
    expect(local.received).toHaveLength(1);
    await expect(sender.sendOnce()).rejects.toBeInstanceOf(SearchEngineError);
    expect(local.received).toHaveLength(1);
    for (let attempt = 0; attempt < 20 && local.closed === 0; attempt++)
      await new Promise(done => setTimeout(done, 25));
    expect(local.closed).toBe(1);
  } finally { await sender?.close(); await local.close(); }
}, 9_000);
