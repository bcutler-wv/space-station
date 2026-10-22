import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { observerBudget } from './opensearch-observer-budget.js';
import { openSearchAdminObserver, SearchEngineError } from './opensearch-runtime.js';
import { PINNED_STATIC_ACTION_GROUPS } from './opensearch-static-action-groups.js';

let directory: string;
let certificate: Buffer;
let key: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(resolve('.cache/results/search-observer-'));
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(directory, 'admin.key'), '-out', join(directory, 'admin.pem'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext', 'extendedKeyUsage=serverAuth,clientAuth'], { stdio: 'ignore', timeout: 10_000 });
  if (result.status !== 0) throw new Error('Could not create fake loopback TLS identity.');
  await copyFile(join(directory, 'admin.pem'), join(directory, 'ca.pem'));
  [certificate, key] = await Promise.all([readFile(join(directory, 'admin.pem')), readFile(join(directory, 'admin.key'))]);
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const config = () => ({ config: { dynamic: {
  filtered_alias_mode: 'warn', disable_rest_auth: false, disable_intertransport_auth: false,
  respect_request_indices_options: false, do_not_fail_on_forbidden: false,
  multi_rolespan_enabled: true, hosts_resolver_mode: 'ip-only', do_not_fail_on_forbidden_empty: false,
  privileges_evaluation_ignore_unauthorized_indices: true,
  kibana: { multitenancy_enabled: true, private_tenant_enabled: true, default_tenant: '',
    preferred_tenants: [], server_username: 'kibanaserver', index: '.kibana' },
  http: { anonymous_auth_enabled: false, xff: { enabled: false,
    internalProxies: [String.raw`10\.\d{1,3}\.\d{1,3}\.\d{1,3}`,
      String.raw`192\.168\.\d{1,3}\.\d{1,3}`, String.raw`169\.254\.\d{1,3}\.\d{1,3}`,
      String.raw`127\.\d{1,3}\.\d{1,3}\.\d{1,3}`, String.raw`172\.1[6-9]{1}\.\d{1,3}\.\d{1,3}`,
      String.raw`172\.2[0-9]{1}\.\d{1,3}\.\d{1,3}`, String.raw`172\.3[0-1]{1}\.\d{1,3}\.\d{1,3}`].join('|'),
    remoteIpHeader: 'X-Forwarded-For' } },
  authc: { station_clientcert: { description: 'Station private client certificates', http_enabled: true,
    order: 0, http_authenticator: { type: 'clientcert', challenge: false,
      config: { username_attribute: 'cn' } }, authentication_backend: { type: 'noop', config: {} } } },
  authz: {}, auth_failure_listeners: {}, on_behalf_of: { enabled: false },
  api_tokens: { enabled: false, max_tokens: 100, max_duration_seconds: 7_776_000 },
} } });

const paths = ['/', '/_cluster/health', '/station-mail-*', '/_resolve/index/station-mail-*',
  '/_alias/station-mail-*', '/_plugins/_security/api/roles', '/_plugins/_security/api/rolesmapping',
  '/_plugins/_security/api/securityconfig', '/_plugins/_security/api/actiongroups'];
const answers: unknown[] = [
  { version: { distribution: 'opensearch', number: '3.9.0' } },
  { timed_out: false, status: 'green', number_of_data_nodes: 1 }, {},
  { indices: [], aliases: [], data_streams: [] }, {}, {}, {}, config(), PINNED_STATIC_ACTION_GROUPS,
];

async function fixture(overrides: Partial<Record<number, { status: number; body: unknown;
  stream?: 'trickle' | 'chunked' }>> = {}) {
  const requests: { method: string; path: string }[] = [];
  let closedBodies = 0;
  const server = createServer({ cert: certificate, key, ca: certificate,
    requestCert: true, rejectUnauthorized: true }, (request, response) => {
    const path = decodeURIComponent((request.url ?? '').split('?')[0]!);
    requests.push({ method: request.method ?? '', path });
    const slot = paths.indexOf(path);
    const reply = overrides[slot] ?? { status: 200, body: answers[slot] };
    if ('stream' in reply && reply.stream) {
      response.on('close', () => { closedBodies++; });
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      if (reply.stream === 'trickle') {
        response.write('{');
        const interval = setInterval(() => response.write(' '), 200);
        response.on('close', () => clearInterval(interval));
      } else {
        response.write('{');
        response.write(' '.repeat(65_000));
        response.write(' '.repeat(65_000));
        response.end('}');
      }
      return;
    }
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fake TLS port.');
  const observer = await openSearchAdminObserver({ endpoint: `https://127.0.0.1:${address.port}`,
    identityDir: directory });
  return { observer, requests, closedBodies: () => closedBodies, close: async () => {
    await observer.close();
    await new Promise<void>(done => server.close(() => done()));
  } };
}

test('observer sends exactly nine fixed GETs, returns complete raw collections and exposes no mutator', async () => {
  const { observer, requests, close } = await fixture();
  try {
    expect(Object.keys(observer).sort()).toEqual(['close', 'observe']);
    expect(await observer.observe()).toEqual({ indexes: {}, roles: {}, mappings: {} });
    expect(requests).toEqual(paths.map(path => ({ method: 'GET', path })));
  } finally { await close(); }
});

test('only exact bounded empty alias 404 is accepted; denials and ambiguous errors fail', async () => {
  const exact = await fixture({ 4: { status: 404,
    body: { error: 'alias [station-mail-*] missing', status: 404 } } });
  try { expect(await exact.observer.observe()).toEqual({ indexes: {}, roles: {}, mappings: {} }); }
  finally { await exact.close(); }
  for (const [status, body] of [
    [403, { error: 'forbidden', status: 403 }],
    [404, { error: 'index missing', status: 404 }],
  ] as const) {
    const denied = await fixture({ 4: { status, body } });
    try {
      await expect(denied.observer.observe()).rejects.toBeInstanceOf(SearchEngineError);
      expect(denied.requests).toHaveLength(5);
    } finally { await denied.close(); }
  }
});

test('alias and data-stream namespace evidence fail before any security collection read', async () => {
  for (const change of [
    { 3: { status: 200, body: { indices: [], aliases: [{ name: 'station-mail-shadow' }], data_streams: [] } } },
    { 3: { status: 200, body: { indices: [], aliases: [], data_streams: [{ name: 'station-mail-stream' }] } } },
    { 4: { status: 200, body: { 'other-index': { aliases: { 'station-mail-shadow': {} } } } } },
  ]) {
    const running = await fixture(change);
    try {
      await expect(running.observer.observe()).rejects.toBeInstanceOf(SearchEngineError);
      expect(running.requests.length).toBeLessThan(6);
    } finally { await running.close(); }
  }
});

test('alias error bodies and complete security collections remain bounded', async () => {
  const largeAlias = await fixture({ 4: { status: 404,
    body: { error: 'x'.repeat(129_000), status: 404 } } });
  try {
    await expect(largeAlias.observer.observe()).rejects.toMatchObject({ kind: 'response' });
    expect(largeAlias.requests).toHaveLength(5);
  } finally { await largeAlias.close(); }
  const largeRoles = await fixture({ 5: { status: 200,
    body: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`role_${i}`, {}])) } });
  try {
    await expect(largeRoles.observer.observe()).rejects.toMatchObject({ kind: 'response' });
    expect(largeRoles.requests).toHaveLength(7);
  } finally { await largeRoles.close(); }
});

test('physical envelopes and resolve state fail closed, including a closed expected index', async () => {
  const name = 'station-mail-v1';
  const row = { aliases: {}, mappings: {}, settings: { index: { uuid: 'uuid_1', provided_name: name } } };
  for (const [physical, resolved] of [
    [{ [name]: { aliases: {} } }, { indices: [{ name, attributes: ['open'] }], aliases: [], data_streams: [] }],
    [{ [name]: row }, { indices: [{ name, attributes: ['closed'] }], aliases: [], data_streams: [] }],
    [{ [name]: row }, { indices: [{ name, attributes: ['open', ['hidden']] }], aliases: [], data_streams: [] }],
    [{ [name]: row }, { indices: [{ name, attributes: ['open'], data_stream: 'unknown' }], aliases: [], data_streams: [] }],
    [{ [name]: row }, { indices: [{ name, attributes: ['open'], surprise: true }], aliases: [], data_streams: [] }],
  ] as const) {
    const running = await fixture({ 2: { status: 200, body: physical }, 3: { status: 200, body: resolved } });
    try {
      await expect(running.observer.observe()).rejects.toMatchObject({ kind: 'response' });
      expect(running.requests.length).toBeLessThan(5);
    } finally { await running.close(); }
  }
});

test('complete hidden physical records remain visible for later profile comparison', async () => {
  const name = 'station-mail-v2-g33333333333343338333333333333333';
  const row = { aliases: {}, mappings: {}, settings: { index: { uuid: 'uuid_1', provided_name: name } } };
  const running = await fixture({
    2: { status: 200, body: { [name]: row } },
    3: { status: 200, body: { indices: [{ name, attributes: ['open', 'hidden'] }],
      aliases: [], data_streams: [] } },
  });
  try {
    expect((await running.observer.observe()).indexes).toEqual({ [name]: row });
    expect(running.requests).toHaveLength(9);
  } finally { await running.close(); }
});

test('health status requires a primitive pinned value', async () => {
  const running = await fixture({ 1: { status: 200,
    body: { timed_out: false, status: ['green'], number_of_data_nodes: 1 } } });
  try {
    await expect(running.observer.observe()).rejects.toMatchObject({ kind: 'partial' });
    expect(running.requests).toHaveLength(2);
  } finally { await running.close(); }
});

test('internal aggregate accounting uses actual chunks and overall elapsed time', () => {
  let clock = 0;
  const budget = observerBudget({ milliseconds: 20, bytes: 3 }, () => clock,
    kind => { throw new SearchEngineError(kind); });
  expect(budget.remaining(5)).toBe(5);
  budget.chunk(2);
  clock = 4;
  budget.chunk(1);
  expect(() => budget.chunk(1)).toThrow(SearchEngineError);
  clock = 19;
  expect(budget.remaining(5)).toBe(1);
  clock = 20;
  expect(() => budget.remaining(5)).toThrow(SearchEngineError);
});

test('trickling alias 404 remains under the stream deadline and starts no later GET', async () => {
  const running = await fixture({ 4: { status: 404, body: {}, stream: 'trickle' } });
  try {
    await expect(running.observer.observe()).rejects.toMatchObject({ kind: 'timeout' });
    expect(running.requests).toHaveLength(5);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(running.closedBodies()).toBe(1);
  } finally { await running.close(); }
}, 8_000);

test('chunked alias 404 exceeding its cap fails and cancels before later reads', async () => {
  const running = await fixture({ 4: { status: 404, body: {}, stream: 'chunked' } });
  try {
    await expect(running.observer.observe()).rejects.toMatchObject({ kind: 'response' });
    expect(running.requests).toHaveLength(5);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(running.closedBodies()).toBe(1);
  } finally { await running.close(); }
});
