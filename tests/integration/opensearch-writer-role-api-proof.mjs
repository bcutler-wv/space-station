/* global structuredClone */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import process from 'node:process';
import { Client } from '@opensearch-project/opensearch';
import Connection from '@opensearch-project/opensearch/lib/Connection.js';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy,
  compareObservedSecurityCollections } from '../../packages/search/dist/opensearch-generation-policy.js';
import { createLiteralV2IndexOnce } from '../../packages/search/dist/opensearch-create-index.js';
import { openSearchAdminObserver, boundedSearchSdkEnvelope,
  boundedSearchSdkRequest, verifyProfile } from '../../packages/search/dist/opensearch-runtime.js';
import { verifyV2IndexProfile } from '../../packages/search/dist/opensearch-v2-profile.js';
import { buildWriterRoleContract,
  compareWriterRoleStage } from '../../packages/search/dist/opensearch-writer-role-contract.js';
import { writerRoleShapeLine,
  writerRoleAmbiguousLine } from '../support/opensearch-writer-role-api-shape.mjs';

const endpoint = 'https://opensearch:9200';
const identityDir = '/run/station-admin';
const token = '33333333-3333-4333-8333-333333333333';
const suffix = token.replaceAll('-', '');
const candidateIndex = `station-mail-v2-g${suffix}`;
const target = `station_indexer_${suffix}`;
const rolePath = `/_plugins/_security/api/roles/${target}`;
const root = { version: 'station-generation-registry-v1', generations: [] };
const sha = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');
let client, observer, original, originalConnection, active, failed = false;
let checkpoint = 'setup';
const totals = { producer: 0, connection: 0 };

async function readIdentity(name) {
  const value = await readFile(`${identityDir}/${name}`);
  assert.ok(value.length >= 100 && value.length <= 16_384);
  return value;
}
async function observe() {
  return observer.observe();
}
function assertOriginal(state) {
  assert.deepEqual(Object.keys(state.indexes).sort(), ['station-mail-v1']);
  assert.equal(verifyProfile({ 'station-mail-v1': state.indexes['station-mail-v1'] }),
    original.uuid);
  assert.deepEqual(state.indexes['station-mail-v1'], original.index);
  assert.equal(compareObservedSecurityCollections(original.policy,
    state.roles, state.mappings), 'exact');
}
function assertStage(contract, stage) {
  return observe().then(state => {
    assert.equal(compareWriterRoleStage(contract, state, stage), 'exact');
    assert.deepEqual(state.indexes['station-mail-v1'], original.index);
    assert.equal(verifyV2IndexProfile({ [candidateIndex]: state.indexes[candidateIndex] },
      candidateIndex, contract.uuid), contract.uuid);
    assert.equal(Object.hasOwn(state.mappings, target), false);
    assert.equal(Object.hasOwn(state.roles, `station_query_${suffix}`), false);
    return state;
  });
}
async function rolePut(contract, phase) {
  active = { phase, producer: 0, connection: 0, body: contract.body };
  const envelope = await boundedSearchSdkEnvelope(options =>
    client.transport.request({ method: 'PUT', path: rolePath, body: contract.body }, options),
  32_768, 5_000);
  assert.deepEqual({ producer: active.producer, connection: active.connection },
    { producer: 1, connection: 1 });
  const counts = { producer: active.producer, connection: active.connection };
  active = null;
  return { envelope, counts };
}
async function cleanupOwned(attempted) {
  // The original baseline proved both names absent. Delete only these exact
  // fixture names, and verify their absence before the next isolated case.
  const current = await observe();
  if (attempted.role && Object.hasOwn(current.roles, target)) {
    await boundedSearchSdkRequest(options =>
      client.transport.request({ method: 'DELETE', path: rolePath }, options), 32_768, 5_000);
  }
  const afterRole = await observe();
  assert.equal(Object.hasOwn(afterRole.roles, target), false);
  if (attempted.index && Object.hasOwn(afterRole.indexes, candidateIndex)) {
    const result = await boundedSearchSdkRequest(options =>
      client.indices.delete({ index: candidateIndex }, options), 32_768, 5_000);
    assert.equal(result?.acknowledged, true);
  }
  assertOriginal(await observe());
}
async function instance(mode) {
  checkpoint = 'baseline';
  assertOriginal(await observe());
  const attempted = { index: false, role: false };
  const expectedPuts = mode === 'update' ? 2 : 3;
  let error = null;
  try {
    attempted.index = true;
    const created = await createLiteralV2IndexOnce(client.indices, candidateIndex);
    assert.match(created.uuid, /^[A-Za-z0-9_-]{1,128}$/);
    const candidate = { token, index: candidateIndex, profile: 'station-mail-v2',
      uuid: created.uuid, writerRole: target };
    const history = { generationToken: token, physicalIndex: candidateIndex,
      profileId: 'station-mail-v2', indexUuid: created.uuid, lifecycle: 'bound',
      writerRole: target, queryRole: `station_query_${suffix}`,
      writerPrincipal: `station-search-indexer-${suffix}`,
      queryPrincipal: `station-search-query-${suffix}`,
      writerCertFingerprint: null, queryCertFingerprint: null,
      createdAt: new Date('2026-10-22T00:00:00Z') };
    const contract = buildWriterRoleContract(root,
      candidate, searchGenerationDispatchSpec(history, 'writer_role'));
    await assertStage(contract, 'pre');
    attempted.role = true;
    if (mode === 'update') {
      checkpoint = 'first';
      const first = await rolePut(contract, 'first');
      process.stdout.write(`${writerRoleShapeLine('first', first.envelope, target, first.counts)}\n`);
      await assertStage(contract, 'post');
      checkpoint = 'update-send';
      const update = await rolePut(contract, 'update');
      checkpoint = 'update-shape';
      process.stdout.write(`${writerRoleShapeLine('update', update.envelope, target, update.counts)}\n`);
      checkpoint = 'update-readback';
      await assertStage(contract, 'post');
    } else {
      checkpoint = 'ambiguous';
      let lost = false, counts;
      try {
        const response = await rolePut(contract, 'ambiguous');
        counts = response.counts;
        // Discard only the original SDK return after the real PUT settled.
        throw Error('fixture-lost-return');
      } catch (reason) {
        if (reason?.message !== 'fixture-lost-return') throw reason;
        lost = true;
      }
      assert.equal(lost, true);
      await assertStage(contract, 'post');
      process.stdout.write(`${writerRoleAmbiguousLine(counts, true)}\n`);
    }
  } catch (reason) { error = reason; }
  const stageCheckpoint = checkpoint;
  const hadStageError = error !== null;
  checkpoint = 'cleanup';
  try { await cleanupOwned(attempted); }
  catch (reason) { error ??= reason; }
  if (hadStageError) checkpoint = stageCheckpoint;
  else assert.deepEqual(totals, { producer: expectedPuts, connection: expectedPuts });
  if (error) throw error;
}

try {
  assert.equal(process.env.OPENSEARCH_URL, endpoint);
  assert.deepEqual((await readdir(identityDir)).sort(), ['admin.key', 'admin.pem', 'ca.pem']);
  const [ca, cert, key] = await Promise.all(['ca.pem', 'admin.pem', 'admin.key'].map(readIdentity));
  client = new Client({ node: endpoint, ssl: { ca, cert, key, rejectUnauthorized: true },
    maxRetries: 0, requestTimeout: 5_000, sniffOnStart: false,
    sniffOnConnectionFault: false, sniffInterval: false });
  observer = await openSearchAdminObserver({ endpoint, identityDir });
  const baseline = await observe();
  checkpoint = 'baseline';
  assert.deepEqual(Object.keys(baseline.indexes).sort(), ['station-mail-v1']);
  const uuid = verifyProfile({ 'station-mail-v1': baseline.indexes['station-mail-v1'] });
  root.generations = [{ token: 'legacy-v1', index: 'station-mail-v1',
    profile: 'station-mail-v1', presence: 'exact', uuid,
    writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
    writerCertFingerprint: null, queryCertFingerprint: null }];
  const policy = buildExpectedSecurityPolicy(root);
  assert.equal(compareObservedSecurityCollections(policy, baseline.roles, baseline.mappings), 'exact');
  original = { uuid, index: structuredClone(baseline.indexes['station-mail-v1']), policy };
  originalConnection = Connection.prototype.request;
  Connection.prototype.request = function fixtureConnection(params, callback) {
    if (params.method === 'PUT' && params.path.startsWith('/_plugins/_security/api/roles/')) {
      assert.equal(params.path, rolePath);
      assert.ok(active);
      active.connection++;
      totals.connection++;
    }
    return originalConnection.call(this, params, callback);
  };
  const request = client.transport.request;
  client.transport.request = function fixtureProducer(params, options) {
    if (params.method === 'PUT' && params.path.startsWith('/_plugins/_security/api/roles/')) {
      assert.equal(params.path, rolePath);
      assert.ok(active);
      assert.equal(sha(params.body), sha(active.body));
      assert.deepEqual({ asStream: options.asStream, maxRetries: options.maxRetries,
        requestTimeout: options.requestTimeout },
      { asStream: true, maxRetries: 0, requestTimeout: 5_000 });
      active.producer++;
      totals.producer++;
    }
    const originalReturn = request.call(this, params, options);
    if (params.method === 'PUT' && params.path === rolePath) {
      assert.equal(typeof originalReturn.abort, 'function');
    }
    return originalReturn;
  };
  await instance('update');
  await instance('ambiguous');
  assertOriginal(await observe());
  assert.deepEqual(totals, { producer: 3, connection: 3 });
} catch {
  failed = true;
} finally {
  if (originalConnection) Connection.prototype.request = originalConnection;
  const closed = await Promise.allSettled([client?.close(), observer?.close()]);
  if (closed.some(value => value.status === 'rejected')) {
    failed = true;
    checkpoint = 'close';
  }
}
if (failed) {
  process.stderr.write(`Pinned writer role API shape proof failed at ${checkpoint}.\n`);
  process.exitCode = 1;
}
else process.stdout.write('Pinned writer role API shape proof passed.\n');
