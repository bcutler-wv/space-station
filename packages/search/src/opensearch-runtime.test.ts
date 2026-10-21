import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { openSearchAccess, SearchEngineError } from './opensearch-runtime.js';

let directory: string;
let certificate: Buffer;
let key: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(resolve('.cache/results/search-fault-'));
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(directory, 'query.key'), '-out', join(directory, 'query.pem'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext', 'extendedKeyUsage=serverAuth,clientAuth'], { stdio: 'ignore', timeout: 10_000 });
  if (result.status !== 0) throw new Error('Could not create fake loopback TLS identity.');
  await copyFile(join(directory, 'query.pem'), join(directory, 'ca.pem'));
  [certificate, key] = await Promise.all([readFile(join(directory, 'query.pem')), readFile(join(directory, 'query.key'))]);
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function fixture(serve: Parameters<typeof createServer>[1]) {
  const server: Server = createServer({ cert: certificate, key, ca: certificate, requestCert: true, rejectUnauthorized: true }, serve);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fake TLS port.');
  const access = await openSearchAccess({ endpoint: `https://127.0.0.1:${address.port}`, identityDir: directory, role: 'query' });
  return { access, close: async () => { await access.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('pinned SDK stream path aborts a trickling header request at an absolute deadline without retry', async () => {
  let requests = 0;
  let closed = false;
  const { access, close } = await fixture((_request, response) => {
    requests++;
    response.socket?.on('close', () => { closed = true; });
    response.socket?.write('HTTP/1.1 200 OK\r\nX-trickle: ');
    const interval = setInterval(() => response.socket?.write('x'), 200);
    response.socket?.on('close', () => clearInterval(interval));
  });
  try {
    const start = performance.now();
    await expect(access.info()).rejects.toMatchObject({ kind: 'timeout' });
    expect(performance.now() - start).toBeLessThan(6_000);
    expect(requests).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  } finally { await close(); }
}, 8_000);

test('stream body and declared response size remain bounded through SDK completion', async () => {
  let mode: 'slow' | 'large' | 'redirect' | 'utf8' = 'slow';
  const { access, close } = await fixture((_request, response) => {
    if (mode === 'slow') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      const interval = setInterval(() => response.write(' '), 200);
      response.on('close', () => clearInterval(interval));
    } else if (mode === 'large') {
      response.writeHead(200, { 'content-length': '3000000' }); response.write('x');
    } else if (mode === 'redirect') {
      response.writeHead(302, { location: 'https://elsewhere.example.com/' }); response.end();
    } else {
      response.writeHead(200); response.end(Buffer.from([0xff]));
    }
  });
  try {
    await expect(access.info()).rejects.toMatchObject({ kind: 'timeout' });
    mode = 'large';
    await expect(access.info()).rejects.toBeInstanceOf(SearchEngineError);
    mode = 'redirect';
    await expect(access.info()).rejects.toMatchObject({ kind: 'status', statusCode: 302 });
    mode = 'utf8';
    await expect(access.info()).rejects.toMatchObject({ kind: 'response' });
  } finally { await close(); }
}, 12_000);
