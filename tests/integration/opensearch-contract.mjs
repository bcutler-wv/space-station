import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { Client } from '@opensearch-project/opensearch';
import { compileSearchQuery } from '../../packages/search/dist/index.js';
import { openSearchAccess, SearchEngineError, SEARCH_INDEX } from '../../packages/search/dist/opensearch-runtime.js';

const endpoint = process.env.OPENSEARCH_URL;
assert.equal(endpoint, 'https://opensearch:9200');
const phase = process.env.SEARCH_CONTRACT_PHASE ?? 'initial';
assert.ok(['initial', 'retained', 'ready'].includes(phase));
const identity = async (role) => {
  const directory = `/run/station-${role}`;
  const [ca, cert, key] = await Promise.all(['ca.pem', `${role}.pem`, `${role}.key`].map(name => readFile(`${directory}/${name}`)));
  return { ca, cert, key, rejectUnauthorized: true };
};
const raw = async (role, includeCert = true) => {
  const ssl = await identity(role);
  if (!includeCert) { delete ssl.cert; delete ssl.key; }
  return new Client({ node: endpoint, ssl, maxRetries: 0, requestTimeout: 5_000,
    sniffOnStart: false, sniffOnConnectionFault: false, sniffInterval: false });
};
async function denied(request) {
  let response;
  try { response = await request; }
  catch (error) {
    assert.ok([401, 403].includes(error?.meta?.statusCode), 'unexpected denied-request failure');
    return;
  }
  response.body?.destroy?.();
  assert.ok([401, 403].includes(response.statusCode), `expected role denial; got ${response.statusCode}`);
}
function document(id, text, accountId = 'account-example') {
  return { id, stableId: id, ownerId: 'owner@example.com', accountId, orbitIds: ['orbit-example'],
    labelIds: [], kind: 'mail', mailboxes: ['inbox'], hasAttachment: false, unread: false,
    starred: false, sentAt: '2026-01-01T00:00:00.000Z', searchText: text,
    subjectValues: ['Budget meeting'], fromValues: ['sender@example.com'], toValues: [],
    ccValues: [], filenameValues: [] };
}
const context = { ownerId: 'owner@example.com', accountIds: ['account-example'], authorizedOrbitIds: ['orbit-example'],
  accountNames: [], orbitNames: [], labelNames: [], scope: 'accounts', nowUtc: '2026-01-02T00:00:00.000Z' };

if (phase === 'ready') {
  const deadline = performance.now() + 120_000;
  let ready = false;
  while (performance.now() < deadline) {
    let access;
    try {
      access = await openSearchAccess({ endpoint, identityDir: '/run/station-query', role: 'query' });
      await access.info(); await access.health(); await access.profile();
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 1_000)); }
    finally { await access?.close(); }
  }
  assert.ok(ready, 'retained OpenSearch did not become authenticated and profile-ready');
  console.info('Retained OpenSearch authenticated readiness passed.');
  process.exit(0);
}

const query = await openSearchAccess({ endpoint, identityDir: '/run/station-query', role: 'query' });
const indexer = await openSearchAccess({ endpoint, identityDir: '/run/station-indexer', role: 'indexer' });
const queryRaw = await raw('query');
const indexerRaw = await raw('indexer');
const outsider = await raw('outsider');
const missing = await raw('query', false);
try {
  await query.info(); await query.health(); await query.profile();
  await indexer.info(); await indexer.health(); await indexer.profile();
  await denied(queryRaw.index({ index: SEARCH_INDEX, id: 'forbidden', body: document('forbidden', 'secret') }, { asStream: true, maxRetries: 0 }));
  await denied(queryRaw.indices.putSettings({ index: SEARCH_INDEX, body: { index: { refresh_interval: '2s' } } }, { asStream: true, maxRetries: 0 }));
  await denied(indexerRaw.indices.putSettings({ index: SEARCH_INDEX, body: { index: { refresh_interval: '2s' } } }, { asStream: true, maxRetries: 0 }));
  await denied(indexerRaw.indices.putMapping({ index: SEARCH_INDEX, body: { properties: { forbidden: { type: 'keyword' } } } }, { asStream: true, maxRetries: 0 }));
  await denied(indexerRaw.indices.delete({ index: SEARCH_INDEX }, { asStream: true, maxRetries: 0 }));
  await denied(indexerRaw.indices.create({ index: 'station-other' }, { asStream: true, maxRetries: 0 }));
  const cross = await indexerRaw.bulk({ body: [{ index: { _index: 'station-other', _id: 'cross' } }, document('cross', 'secret')] },
    { asStream: true, maxRetries: 0 });
  if ([401, 403].includes(cross.statusCode)) cross.body.destroy();
  else {
    assert.equal(cross.statusCode, 200);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of cross.body) { bytes += chunk.length; assert.ok(bytes <= 32_768); chunks.push(chunk); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(result.errors, true);
    assert.ok([401, 403].includes(result.items?.[0]?.index?.status));
  }
  await denied(outsider.info({}, { asStream: true, maxRetries: 0 }));
  await assert.rejects(missing.info({}, { asStream: true, maxRetries: 0 }));

  if (phase === 'initial') {
    await indexer.index('account-example:budget', document('account-example:budget', 'budget meeting agenda'));
    await indexer.index('account-example:schedule', document('account-example:schedule', 'schedule update'));
    await indexer.index('other-account:budget', document('other-account:budget', 'budget meeting agenda', 'other-account'));
    await assert.rejects(indexer.bulk([{ id: 'account-example:valid', document: document('account-example:valid', 'budget plan') },
      { id: 'account-example:invalid', document: { ...document('account-example:invalid', 'budget plan'), unknownField: 'reject' } }]),
    error => error instanceof SearchEngineError && error.kind === 'partial');
  }
  for (const [expression, expected, absent] of [
    ['budget', 'account-example:budget', 'other-account:budget'],
    ['-budget', 'account-example:schedule', 'account-example:budget'],
    ['budget OR subject:"Budget meeting"', 'account-example:budget', 'other-account:budget'],
  ]) {
    const plan = compileSearchQuery(expression, context);
    assert.equal(plan.status, 'ok');
    const response = await query.search(plan, 10);
    const ids = response.hits.hits.map(hit => hit._id);
    assert.ok(ids.includes(expected), `compiled query omitted ${expected}`);
    assert.ok(!ids.includes(absent), `compiled query included ${absent}`);
  }
  console.info(`OpenSearch private ${phase} contract passed.`);
} finally {
  await Promise.all([query.close(), indexer.close(), queryRaw.close(), indexerRaw.close(), outsider.close(), missing.close()]);
}
