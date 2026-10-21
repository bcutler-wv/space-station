import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createRawServer } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { once } from 'node:events';
import { Client } from '@opensearch-project/opensearch';
import { parseSearchQuery, SEARCH_PARSE_LIMITS } from '../../packages/search/dist/index.js';

const ENGINE_VERSION = '3.9.0';
const INDEX = 'station-fake-proof';
const OWNER = 'owner@example.com';
const ACCOUNT = 'account-example';
const ORBIT = 'orbit-example';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_MS = 5_000;
const READY_MS = 120_000;
const OUT = process.env.OPENSEARCH_PROOF_OUT;
const results = { engine: ENGINE_VERSION, fixtureOnly: true, checks: [], errors: [], metrics: {} };
const now = () => performance.now();

const term = (field, value) => ({ term: { [field]: value } });
const must = (...clauses) => ({ bool: { must: clauses } });
const either = (...clauses) => ({ bool: { should: clauses, minimum_should_match: 1 } });
const not = clause => ({ bool: { must_not: [clause] } });
const scope = [term('ownerId', OWNER), term('accountId', ACCOUNT), term('orbitIds', ORBIT)];
const scoped = (predicate, group = 'semantic') => ({ bool: { filter: [...scope, term('group', group)], must: [predicate] } });
const match = value => ({ match: { text: { query: value, operator: 'and', fuzziness: 1,
  max_expansions: 50, zero_terms_query: 'none' } } });
const strict = value => ({ match: { text: { query: value, operator: 'and', fuzziness: 0, zero_terms_query: 'none' } } });
const prefix = value => ({ match_bool_prefix: { text: { query: value, operator: 'and' } } });
const phrase = value => ({ match_phrase: { text: { query: value, slop: 0, zero_terms_query: 'none' } } });
const literal = value => ({ wildcard: { literal: { value: `*${value.replace(/[\\*?]/g, '\\$&')}*`, case_insensitive: false } } });

function assertEnvelope(input, predicate) {
  assert.ok(Buffer.byteLength(input, 'utf8') <= SEARCH_PARSE_LIMITS.utf8Bytes, 'input byte limit');
  let leaves = 0;
  function visit(node, depth) {
    assert.ok(depth <= SEARCH_PARSE_LIMITS.nesting, 'query depth limit');
    if (node.bool) {
      for (const kind of ['must', 'must_not', 'should', 'filter']) {
        for (const child of node.bool[kind] ?? []) visit(child, depth + 1);
      }
    } else {
      leaves++; assert.ok(leaves <= SEARCH_PARSE_LIMITS.leaves, 'leaf limit');
      const textMatch = node.match?.text;
      if (textMatch?.fuzziness) assert.ok(Number.isInteger(textMatch.max_expansions) &&
        textMatch.max_expansions > 0 && textMatch.max_expansions <= 50, 'fuzzy expansion limit');
    }
  }
  visit(predicate, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(predicate)) <= 16_384, 'DSL byte limit');
}

function validateSearch(body, size) {
  assert.equal(body.timed_out, false, 'timed out result is incomplete');
  assert.ok(Number.isInteger(body._shards?.total) && body._shards.total > 0, 'missing shard total');
  assert.ok(Number.isInteger(body._shards?.successful), 'missing successful shards');
  assert.ok(Number.isInteger(body._shards?.failed), 'missing failed shards');
  assert.equal(body._shards.failed, 0, 'failed shards are incomplete');
  assert.equal(body._shards?.successful, body._shards?.total, 'partial shard result');
  assert.ok(Array.isArray(body.hits?.hits) && body.hits.hits.length <= size, 'invalid hit array');
  assert.equal(body.hits?.total?.relation, 'eq', 'cutoff total is incomplete');
  assert.ok(Number.isInteger(body.hits.total.value) && body.hits.total.value >= body.hits.hits.length, 'invalid hit total');
  for (const hit of body.hits.hits) assert.ok(typeof hit._id === 'string' && hit._id.length <= 128);
  return body.hits.hits;
}

async function consume(stream, deadlineMs, cap = MAX_RESPONSE_BYTES) {
  let bytes = 0;
  const chunks = [];
  const timer = setTimeout(() => stream.destroy(new Error('response body deadline')), deadlineMs);
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > cap) { stream.destroy(); throw Error('response body exceeds cap'); }
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
}

async function call(receiver, method, params, cap = MAX_RESPONSE_BYTES, budgetMs = REQUEST_MS) {
  // The pinned SDK's stream option avoids its otherwise unbounded JSON buffer.
  // Its requestTimeout is an inactivity timeout, so abort the actual SDK request
  // at the wall-clock deadline, including while partial headers are arriving.
  assert.ok(Number.isInteger(budgetMs) && budgetMs > 0 && budgetMs <= REQUEST_MS);
  const deadline = performance.now() + budgetMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let stream;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      const error = Error('request wall-clock deadline');
      // Mark settled first: abort may synchronously trigger a rejection.
      finish(error);
      try { request?.abort(); } catch { /* Deadline rejection is already authoritative. */ }
      stream?.destroy(error);
    }, budgetMs);
    try {
      request = method.call(receiver, params, { asStream: true, requestTimeout: budgetMs, maxRetries: 0 });
      Promise.resolve(request).then(async response => {
        stream = response.body;
        if (settled) { stream?.destroy(); return; }
        const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
        const raw = await consume(stream, remaining, cap);
        assert.ok(!response.headers?.['content-encoding'] || response.headers['content-encoding'] === 'identity');
        let body;
        try { body = JSON.parse(raw); } catch { throw Error('invalid JSON response'); }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = Error(`OpenSearch status ${response.statusCode}`);
          error.statusCode = response.statusCode;
          throw error;
        }
        finish(null, body);
      }).catch(error => finish(error));
    } catch (error) { finish(error); }
  });
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(client) {
  const startedAt = Number(process.env.OPENSEARCH_ENGINE_STARTED_AT);
  assert.ok(Number.isSafeInteger(startedAt) && startedAt > 0);
  const deadline = startedAt + READY_MS;
  let last = 'not ready';
  while (Date.now() < deadline) {
    try {
      const info = await call(client, client.info, {}, 32_768, Math.min(REQUEST_MS, deadline - Date.now()));
      assert.equal(info.version?.distribution, 'opensearch');
      assert.equal(info.version?.number, ENGINE_VERSION);
      const health = await call(client.cluster, client.cluster.health,
        { wait_for_status: 'yellow', timeout: '3s' }, 32_768,
        Math.min(REQUEST_MS, deadline - Date.now()));
      assert.equal(health.timed_out, false);
      assert.ok(['yellow', 'green'].includes(health.status));
      assert.equal(health.number_of_data_nodes, 1);
      results.metrics.coldReadinessMs = Date.now() - startedAt;
      return;
    } catch (error) { last = String(error.message).slice(0, 160); }
    if (Date.now() < deadline) await pause(Math.min(1000, deadline - Date.now()));
  }
  throw Error(`readiness exceeded ${READY_MS}ms: ${last}`);
}

function sampleDocs() {
  const base = { ownerId: OWNER, accountId: ACCOUNT, orbitIds: [ORBIT], group: 'semantic',
    unread: false, sentAt: '2026-01-01T00:00:00.000Z', labelIds: [], literal: '' };
  const rows = [
    ['apple', 'apple fruit', [], ''], ['appl', 'appl fruit', [], ''],
    ['foo-bar', 'foo-bar', ['work'], ''], ['foo-gap-bar', 'foo extra bar', [], ''],
    ['bar', 'bar only', [], ''], ['cjk', '東京大学', [], ''],
    ['phrase', 'one two three four five six seven eight nine ten eleven', [], ''],
    ['literal-star', 'literal example', [], 'path*a'],
    ['literal-question', 'literal example', [], 'path?a'],
    ['literal-slash', 'literal example', [], 'path\\a'],
    ['literal-quote', 'literal example', [], 'path"a'],
    ['arabic', 'مرحبا بالعالم', [], ''], ['korean', '한국어 형태소', [], ''],
    ['date-before', 'calendar', [], ''], ['date-at', 'calendar', [], ''],
    ['date-after', 'calendar', [], ''],
    ['unrelated', 'quiet robin', [], ''],
  ];
  const documents = rows.map(([id, text, labelIds, literalValue], seq) => ({
    ...base, id: `${ACCOUNT}:${id}`, stableId: `${ACCOUNT}:${id}`, seq,
    text, labelIds, literal: literalValue,
    unread: id === 'apple',
    sentAt: id === 'date-before' ? '2025-12-31T23:59:59.999Z' :
      id === 'date-after' ? '2026-01-02T00:00:00.000Z' : base.sentAt,
  }));
  for (const [kind, scopeChange] of [
    ['owner', { ownerId: 'other@example.com' }],
    ['account', { accountId: 'other-account' }],
    ['orbit', { orbitIds: ['other-orbit'] }],
  ]) documents.push({ ...documents[0], ...scopeChange, id: `outside-${kind}`, stableId: `outside-${kind}`, seq: 100 + documents.length });
  return documents;
}

function bulkDocs() {
  const out = [];
  const texts = [
    'sample budget meeting fox', 'sample budget report fox',
    '東京大学 研究', '中文测试 项目', 'مرحبا بالعالم رسالة', '한국어 형태소 분석',
    'sample archive planning fox', 'sample budget invoice fox',
    'budget meeting notes fox', 'sample quiet calendar fox',
  ];
  for (let index = 0; index < 10_000; index++) {
    const id = `${ACCOUNT}:bulk-${String(index).padStart(5, '0')}`;
    out.push({ id, stableId: id, seq: 1_000 + index, ownerId: OWNER, accountId: ACCOUNT,
      orbitIds: [ORBIT], group: 'bulk', text: `${texts[index % texts.length]} number ${index % 997}`,
      literal: `invoice-${index}.pdf`, labelIds: index % 2 ? ['work'] : [],
      unread: index % 3 === 0, sentAt: `2026-01-${String(index % 28 + 1).padStart(2, '0')}T00:00:00.000Z` });
  }
  return out;
}

async function search(client, predicate, { group = 'semantic', size = 100, searchAfter, sort } = {}) {
  assertEnvelope('fake bounded query', predicate);
  assert.ok(size > 0 && size <= 200);
  const body = { size, track_total_hits: true, timeout: '5s', _source: false,
    query: scoped(predicate, group), ...(sort ? { sort } : {}),
    ...(searchAfter ? { search_after: searchAfter } : {}) };
  const response = await call(client, client.search, { index: INDEX, body, allow_partial_search_results: false }, 256 * 1024);
  return { hits: validateSearch(response, size), total: response.hits.total.value, took: response.took };
}

async function ids(client, predicate) {
  const result = await search(client, predicate);
  assert.ok(result.total <= 100, 'semantic fixture result cutoff');
  return result.hits.map(hit => hit._id).sort();
}

function names(idsList) { return idsList.map(id => id.replace(`${ACCOUNT}:`, '')).sort(); }
async function expectIds(client, label, predicate, expected) {
  const actual = names(await ids(client, predicate));
  assert.deepEqual(actual, expected.slice().sort(), label);
  results.checks.push(label);
}

async function semantics(client) {
  const universe = sampleDocs().filter(doc => doc.ownerId === OWNER && doc.accountId === ACCOUNT && doc.orbitIds.includes(ORBIT)).map(doc => doc.id).sort();
  async function complement(label, leaf) {
    const positive = await ids(client, leaf);
    const negative = await ids(client, not(leaf));
    assert.deepEqual([...positive, ...negative].sort(), universe, `${label} complement`);
    assert.equal(positive.filter(id => negative.includes(id)).length, 0, `${label} overlap`);
    results.checks.push(`${label} complement`);
  }
  const apple = match('apple');
  const app = prefix('app');
  const compound = strict('foo-bar');
  const cjk = strict('東京大学');
  for (const [label, leaf, expected] of [
    ['fuzzy apple/appl', apple, ['apple', 'appl']],
    ['prefix app', app, ['apple', 'appl']],
    ['compound foo-bar', compound, ['foo-bar', 'foo-gap-bar']],
    ['CJK 東京大学', cjk, ['cjk']],
  ]) {
    await expectIds(client, label, leaf, expected);
    await complement(label, leaf);
  }
  await expectIds(client, 'mixed text/filter OR', either(apple, term('labelIds', 'work')), ['apple', 'appl', 'foo-bar']);
  await expectIds(client, 'AND', must(compound, term('labelIds', 'work')), ['foo-bar']);
  await expectIds(client, 'nested NOT', not(either(apple, term('labelIds', 'work'))),
    names(universe).filter(value => !['apple', 'appl', 'foo-bar'].includes(value)));
  await expectIds(client, 'double NOT', not(not(apple)), ['apple', 'appl']);
  await expectIds(client, 'negative only', not(apple), names(universe).filter(value => !['apple', 'appl'].includes(value)));
  const longPhrase = phrase('one two three four five six seven eight nine ten eleven');
  await expectIds(client, 'eleven-word phrase', longPhrase, ['phrase']);
  await complement('eleven-word phrase', longPhrase);
  await expectIds(client, 'no-term explicit match_none', strict('!!!'), []);
  await expectIds(client, 'no-term negation scoped universe', not(strict('!!!')), names(universe));
  for (const [label, value, id] of [
    ['literal star', 'path*a', 'literal-star'], ['literal question', 'path?a', 'literal-question'],
    ['literal backslash', 'path\\a', 'literal-slash'], ['literal quote', 'path"a', 'literal-quote'],
  ]) {
    const leaf = literal(value);
    await expectIds(client, label, leaf, [id]);
    await complement(label, leaf);
  }
  await expectIds(client, 'typed unread', term('unread', true), ['apple']);
  await expectIds(client, 'UTC inclusive/exclusive date',
    { range: { sentAt: { gte: '2026-01-01T00:00:00.000Z', lt: '2026-01-02T00:00:00.000Z' } } },
    names(universe).filter(value => !['date-before', 'date-after'].includes(value)));
  await expectIds(client, 'Arabic analysis', strict('مرحبا بالعالم'), ['arabic']);
  await expectIds(client, 'Korean analysis', strict('한국어 형태소'), ['korean']);
}

async function ingest(client, documents) {
  for (let start = 0; start < documents.length; start += 250) {
    const body = [];
    for (const doc of documents.slice(start, start + 250)) body.push({ index: { _index: INDEX, _id: doc.id } }, doc);
    const result = await call(client, client.bulk, { body, refresh: false });
    assert.equal(result.errors, false, `bulk failed at ${start}`);
  }
  await call(client.indices, client.indices.refresh, { index: INDEX }, 32_768);
}

async function pagination(client) {
  const expected = bulkDocs().map(doc => doc.id).sort();
  const actual = [];
  let after;
  const sort = [{ stableId: 'asc' }];
  for (let page = 0; page < 51; page++) {
    const result = await search(client, { match_all: {} }, { group: 'bulk', size: 200, searchAfter: after, sort });
    assert.equal(result.total, 10_000);
    if (!result.hits.length) break;
    for (const hit of result.hits) {
      assert.ok(hit._id.startsWith(`${ACCOUNT}:bulk-`));
      actual.push(hit._id);
    }
    after = result.hits.at(-1).sort;
    assert.ok(Array.isArray(after) && after.length === 1);
  }
  assert.deepEqual(actual, expected);
  results.checks.push('stable scoped 10k pagination');
}

async function writes(client) {
  const id = `${ACCOUNT}:versioned`;
  const body = { ...sampleDocs()[0], id, stableId: id, text: 'version one', group: 'writes' };
  await call(client, client.index, { index: INDEX, id, body, version: 100, version_type: 'external', refresh: true });
  async function conflict(params) {
    try { await call(client, client.index, params); assert.fail('stale write succeeded'); }
    catch (error) { assert.equal(error.statusCode, 409); }
  }
  await conflict({ index: INDEX, id, body: { ...body, text: 'stale' }, version: 99, version_type: 'external', refresh: true });
  await call(client, client.index, { index: INDEX, id, body: { ...body, text: 'version two' }, version: 101, version_type: 'external', refresh: true });
  await conflict({ index: INDEX, id, body: { ...body, text: 'same retry' }, version: 101, version_type: 'external', refresh: true });
  assert.deepEqual((await search(client, strict('version two'), { group: 'writes' })).hits.map(hit => hit._id), [id]);
  results.checks.push('versioned update visible after refresh');
  await call(client, client.delete, { index: INDEX, id, version: 102, version_type: 'external', refresh: true });
  await conflict({ index: INDEX, id, body, version: 101, version_type: 'external', refresh: true });
  const gone = await search(client, { ids: { values: [id] } }, { group: 'writes' });
  assert.equal(gone.total, 0);
  results.checks.push('external version update/delete/retry/stale recreate');
}

const percentile = (values, fraction) => values[Math.ceil(values.length * fraction) - 1];
async function measure(client) {
  const classes = {
    ordinary: [strict('sample budget'), match('budge'), prefix('bud'), strict('budget meeting'), strict('archive planning')],
    boolean: [either(must(strict('sample'), term('unread', true)), not(term('labelIds', 'work'))),
      must(strict('budget'), term('unread', true)), not(either(term('labelIds', 'work'), term('unread', true))),
      either(prefix('bud'), term('unread', true))],
    substring: [literal('invoice-123'), literal('invoice-7'), literal('.pdf'), literal('invoice-9999')],
    multilingual: [strict('東京大学'), strict('中文测试'), strict('مرحبا بالعالم'), strict('한국어 형태소')],
  };
  for (const [name, queries] of Object.entries(classes)) {
    for (let index = 0; index < 20; index++) await search(client, queries[index % queries.length], { group: 'bulk', size: 20 });
    const times = [];
    for (let index = 0; index < 200; index++) {
      const start = now();
      await search(client, queries[index % queries.length], { group: 'bulk', size: 20 });
      times.push(now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = +percentile(times, .95).toFixed(2);
    results.metrics[name] = { corpus: '10k fake bulk', variants: queries.length, count: times.length,
      p50Ms: +percentile(times, .50).toFixed(2), p95Ms: p95,
      p99Ms: +percentile(times, .99).toFixed(2), p95Under100Ms: p95 <= 100 };
  }
  return Object.keys(classes).every(name => results.metrics[name].p95Under100Ms);
}

async function resourceSnapshot(client, name) {
  const stats = await call(client.nodes, client.nodes.stats, { metric: 'jvm,process' }, 256 * 1024);
  const nodes = Object.values(stats.nodes ?? {});
  assert.equal(nodes.length, 1, 'expected one engine node for resource sample');
  results.metrics[name] = nodes.map(node => {
    const heapUsedBytes = node.jvm?.mem?.heap_used_in_bytes;
    const heapMaxBytes = node.jvm?.mem?.heap_max_in_bytes;
    assert.ok(Number.isSafeInteger(heapUsedBytes) && Number.isSafeInteger(heapMaxBytes));
    return { heapUsedBytes, heapMaxBytes,
      processVirtualBytes: node.process?.mem?.total_virtual_in_bytes ?? null };
  });
}

async function selfTest() {
  assert.equal(parseSearchQuery('x'.repeat(4097)).status, 'error');
  assert.equal(parseSearchQuery(Array.from({ length: 65 }, (_, i) => `word${i}`).join(' ')).status, 'error');
  assert.throws(() => assertEnvelope('x'.repeat(4097), strict('x')), /byte limit/);
  assert.throws(() => assertEnvelope('fake', either(...Array.from({ length: 65 }, (_, i) => term('labelIds', `x${i}`)))), /leaf limit/);
  assert.throws(() => assertEnvelope('fake', { match: { text: { query: 'x', fuzziness: 1, max_expansions: 51 } } }), /fuzzy expansion limit/);
  let deep = term('labelIds', 'x');
  for (let index = 0; index < 9; index++) deep = not(deep);
  assert.throws(() => assertEnvelope('fake', deep), /depth limit/);
  assert.throws(() => validateSearch({ timed_out: true }, 10), /timed out/);
  assert.throws(() => validateSearch({ timed_out: false, _shards: { total: 1, successful: 0, failed: 1 } }, 10), /failed shards/);
  assert.throws(() => validateSearch({ timed_out: false, _shards: { failed: 0, successful: 1, total: 2 } }, 10), /partial shard/);
  assert.throws(() => validateSearch({ timed_out: false, _shards: { total: 1, failed: 0 } }, 10), /missing successful/);
  assert.throws(() => validateSearch({ timed_out: false, _shards: { failed: 0, successful: 1, total: 1 }, hits: { hits: [], total: { relation: 'gte' } } }, 10), /cutoff/);
  await assert.rejects(() => consume(Readable.from([Buffer.alloc(9)]), 100, 8), /exceeds cap/);
  await assert.rejects(() => consume(Readable.from([Buffer.from([0xff])]), 100, 8), /encoded/);
  const stalled = new PassThrough();
  await assert.rejects(() => consume(stalled, 20, 8), /deadline/);
  assert.equal(sampleDocs().length, 20);
  assert.equal(bulkDocs().length, 10_000);
  assert.equal(parseSearchQuery('bogus:term').status, 'error');
  assert.ok(bulkDocs().filter(doc => /東京大学|中文测试|مرحبا|한국어/.test(doc.text)).length >= 4_000);
  assert.deepEqual(literal('a*b?c\\d').wildcard.literal.value, '*a\\*b\\?c\\\\d*');
  let mode = 'ok';
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (mode === 'headers-delay') {
      setTimeout(() => { if (!response.destroyed) { response.writeHead(200); response.end('{"ok":true}'); } }, 200);
      return;
    }
    if (mode === 'redirect') {
      response.writeHead(302, { location: 'http://127.0.0.1/other', 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (mode === 'compression') {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(mode === 'status' ? 503 : 200, { 'content-type': 'application/json' });
    if (mode === 'oversize') response.end('x'.repeat(100));
    else if (mode === 'invalid-utf8') response.end(Buffer.from([0xff]));
    else if (mode === 'malformed-json') response.end('{oops');
    else if (mode === 'delay') { response.write('{'); setTimeout(() => response.end('}'), 200); }
    else response.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const mock = new Client({ node: `http://127.0.0.1:${server.address().port}`, maxRetries: 0, requestTimeout: 100 });
  const request = () => call(mock, mock.search, { index: 'fake', body: { query: { match_all: {} } } }, 32, 100);
  try {
    assert.deepEqual(await request(), { ok: true });
    mode = 'status';
    const beforeStatus = requests;
    await assert.rejects(request, error => error.statusCode === 503);
    assert.equal(requests, beforeStatus + 1, 'SDK silently retried failed request');
    mode = 'redirect';
    await assert.rejects(request, error => error.statusCode === 302);
    mode = 'compression';
    await assert.rejects(request, /content-encoding|encoded/);
    mode = 'oversize';
    await assert.rejects(request, /exceeds cap/);
    mode = 'invalid-utf8';
    await assert.rejects(request, /encoded/);
    mode = 'malformed-json';
    await assert.rejects(request, /invalid JSON/);
    mode = 'delay';
    await assert.rejects(request, /deadline|timed out|TimeoutError/i);
    mode = 'headers-delay';
    await assert.rejects(request, /timed out|TimeoutError|deadline/i);
  } finally { await mock.close(); server.close(); await once(server, 'close'); }
  const rawServer = createRawServer(socket => {
    socket.write('HTTP/1.1 200 OK\r\n');
    let count = 0;
    const drip = setInterval(() => {
      if (!socket.destroyed) socket.write(`X-Proof-${count++}: value\r\n`);
    }, 25);
    socket.on('error', () => { clearInterval(drip); socket.destroy(); });
    socket.once('close', () => clearInterval(drip));
  });
  rawServer.listen(0, '127.0.0.1');
  await once(rawServer, 'listening');
  const rawMock = new Client({ node: `http://127.0.0.1:${rawServer.address().port}`,
    maxRetries: 0, requestTimeout: 100 });
  let peer;
  try {
    const connected = once(rawServer, 'connection');
    const started = performance.now();
    const pending = call(rawMock, rawMock.search,
      { index: 'fake', body: { query: { match_all: {} } } }, 32, 100);
    [peer] = await connected;
    const closed = new Promise(resolve => peer.once('close', resolve));
    await assert.rejects(pending, /wall-clock deadline/);
    assert.ok(performance.now() - started < 200, 'trickled headers exceeded total deadline');
    await Promise.race([closed, pause(300).then(() => { throw Error('aborted SDK socket stayed open'); })]);
  } finally {
    peer?.destroy();
    await rawMock.close();
    rawServer.close();
    await once(rawServer, 'close');
  }
  console.log('OpenSearch proof source, limits, failure and fake-corpus self-check passed.');
}

async function main() {
  if (process.argv.includes('--self-test')) { await selfTest(); return; }
  assert.ok(OUT?.startsWith('/out/') && process.env.OPENSEARCH_URL === 'http://station-opensearch:9200');
  const client = new Client({ node: process.env.OPENSEARCH_URL, maxRetries: 0, requestTimeout: REQUEST_MS,
    sniffOnStart: false, sniffOnConnectionFault: false, suggestCompression: false });
  try {
    await ready(client);
    await resourceSnapshot(client, 'coldNode');
    await call(client.indices, client.indices.create, { index: INDEX, body: {
      settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: '1s' },
      mappings: { dynamic: 'strict', properties: {
        id: { type: 'keyword' }, stableId: { type: 'keyword' }, seq: { type: 'integer' },
        ownerId: { type: 'keyword' }, accountId: { type: 'keyword' }, orbitIds: { type: 'keyword' },
        group: { type: 'keyword' }, text: { type: 'text', analyzer: 'standard' },
        literal: { type: 'wildcard' }, labelIds: { type: 'keyword' }, unread: { type: 'boolean' },
        sentAt: { type: 'date', format: 'strict_date_time' },
      } },
    } });
    const docs = [...sampleDocs(), ...bulkDocs()];
    await ingest(client, docs);
    results.metrics.documentCount = docs.length;
    await resourceSnapshot(client, 'indexedNode');
    await semantics(client);
    await pagination(client);
    await writes(client);
    const latencyWithinTarget = await measure(client);
    await resourceSnapshot(client, 'warmNode');
    assert.ok(latencyWithinTarget, 'engine-request p95 exceeded 100ms fixture target');
    results.status = 'pass';
  } catch (error) {
    results.status = 'fail';
    results.errors.push(String(error.message).slice(0, 500));
    throw error;
  } finally {
    await new Promise((resolve, reject) => {
      const stream = createWriteStream(OUT, { mode: 0o600 });
      stream.end(JSON.stringify(results, null, 2), error => error ? reject(error) : resolve());
    });
    await client.close();
  }
}

await main();
