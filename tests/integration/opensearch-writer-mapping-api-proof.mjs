/* global structuredClone */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
import { buildWriterMappingContract, compareWriterMappingStage,
  compareWriterRoleStage, issuedWriterMappingRequest } from
  '../../packages/search/dist/opensearch-writer-role-contract.js';
import { writerMappingShapeLine, writerMappingExpectedShape,
  writerMappingAmbiguousLine } from
  '../support/opensearch-writer-mapping-api-shape.mjs';

const endpoint = 'https://opensearch:9200';
const require = createRequire(import.meta.url);
const identityDir = '/run/station-admin';
const token = '44444444-4444-4444-8444-444444444444';
const suffix = token.replaceAll('-', '');
const index = `station-mail-v2-g${suffix}`;
const target = `station_indexer_${suffix}`;
const mappingPath = `/_plugins/_security/api/rolesmapping/${target}`;
const root = { version: 'station-generation-registry-v1', generations: [] };
const hash = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const lines = [];
let client, observer, original, originalConnection, active, failed = false;
let checkpoint = 'setup';
const totals = { producer: 0, connection: 0 };

async function observe() { return observer.observe(); }
function assertOriginal(state) {
  assert.deepEqual(Object.keys(state.indexes).sort(), ['station-mail-v1']);
  assert.equal(verifyProfile({ 'station-mail-v1': state.indexes['station-mail-v1'] }),
    original.uuid);
  assert.deepEqual(state.indexes['station-mail-v1'], original.index);
  assert.equal(compareObservedSecurityCollections(original.policy,
    state.roles, state.mappings), 'exact');
  assert.deepEqual(state.roles, original.roles);
  assert.deepEqual(state.mappings, original.mappings);
}
function assertRawPrior(state, rolePresent, mappingPresent) {
  const roles = structuredClone(state.roles);
  const mappings = structuredClone(state.mappings);
  if (rolePresent) {
    assert.equal(Object.hasOwn(roles, target), true);
    delete roles[target];
  }
  if (mappingPresent) {
    assert.equal(Object.hasOwn(mappings, target), true);
    delete mappings[target];
  }
  assert.deepEqual(roles, original.roles);
  assert.deepEqual(mappings, original.mappings);
}
async function stage(contract, expected) {
  const state = await observe();
  assert.equal(compareWriterMappingStage(contract, state, expected), 'exact');
  assert.deepEqual(state.indexes['station-mail-v1'], original.index);
  assert.equal(verifyV2IndexProfile({ [index]: state.indexes[index] },
    index, contract.roleContract.uuid), contract.roleContract.uuid);
  assert.equal(Object.hasOwn(state.roles, `station_query_${suffix}`), false);
  assertRawPrior(state, true, expected === 'post');
  return state;
}
async function mappingPut(contract, phase) {
  const request = issuedWriterMappingRequest(contract);
  active = { phase, target: request.target, body: request.body,
    producer: 0, connection: 0 };
  try {
    const envelope = await boundedSearchSdkEnvelope(options =>
      client.security.createRoleMapping({ role: request.target, body: request.body },
        options), 32_768, 5_000);
    assert.deepEqual({ producer: active.producer, connection: active.connection },
      { producer: 1, connection: 1 });
    return { envelope, counts: { producer: active.producer,
      connection: active.connection } };
  } finally { active = null; }
}
async function cleanupOwned(attempted, contract) {
  // Only names proven absent at the original baseline may be removed.
  const current = await observe();
  if (contract) {
    const mapped = Object.hasOwn(current.mappings, target);
    const rolePresent = Object.hasOwn(current.roles, target);
    assertRawPrior(current, rolePresent, mapped);
    assert.equal(mapped && !attempted.mapping, false);
    assert.equal(rolePresent && !attempted.role, false);
    if (rolePresent) assert.equal(compareWriterMappingStage(contract, current,
      mapped ? 'post' : 'pre'), 'exact');
    else {
      assert.equal(mapped, false);
      assert.equal(compareWriterRoleStage(contract.roleContract, current, 'pre'),
        'exact');
    }
  } else if (attempted.index || attempted.role || attempted.mapping) {
    throw Error('Uncertain mapping proof ownership');
  } else assertOriginal(current);
  if (attempted.mapping && Object.hasOwn(current.mappings, target)) {
    await boundedSearchSdkRequest(options => client.security.deleteRoleMapping(
      { role: target }, options), 32_768, 5_000);
  }
  const withoutMapping = await observe();
  if (contract) assertRawPrior(withoutMapping,
    Object.hasOwn(withoutMapping.roles, target),
    Object.hasOwn(withoutMapping.mappings, target));
  if (contract && Object.hasOwn(withoutMapping.roles, target))
    assert.equal(compareWriterMappingStage(contract, withoutMapping, 'pre'), 'exact');
  else if (contract)
    assert.equal(compareWriterRoleStage(contract.roleContract, withoutMapping, 'pre'),
      'exact');
  else assertOriginal(withoutMapping);
  if (attempted.role && Object.hasOwn(withoutMapping.roles, target)) {
    await boundedSearchSdkRequest(options =>
      client.security.deleteRole({ role: target }, options), 32_768, 5_000);
  }
  const withoutRole = await observe();
  if (contract) assertRawPrior(withoutRole,
    Object.hasOwn(withoutRole.roles, target),
    Object.hasOwn(withoutRole.mappings, target));
  if (contract) {
    assert.equal(compareWriterRoleStage(contract.roleContract, withoutRole, 'pre'),
      'exact');
    assert.equal(Object.hasOwn(withoutRole.mappings, target), false);
  } else assertOriginal(withoutRole);
  if (attempted.index && Object.hasOwn(withoutRole.indexes, index)) {
    const deleted = await boundedSearchSdkRequest(options =>
      client.indices.delete({ index }, options), 32_768, 5_000);
    assert.equal(deleted?.acknowledged, true);
  }
  assertOriginal(await observe());
}
async function instance(mode) {
  checkpoint = 'baseline';
  assertOriginal(await observe());
  const attempted = { index: false, role: false, mapping: false };
  let contract, error = null;
  const start = { ...totals };
  try {
    checkpoint = 'candidate-create';
    attempted.index = true;
    const created = await createLiteralV2IndexOnce(client.indices, index);
    assert.match(created.uuid, /^[A-Za-z0-9_-]{1,128}$/);
    const candidate = { token, index, profile: 'station-mail-v2',
      uuid: created.uuid, writerRole: target,
      writerPrincipal: `station-search-indexer-${suffix}` };
    const history = { generationToken: token, physicalIndex: index,
      profileId: 'station-mail-v2', indexUuid: created.uuid, lifecycle: 'bound',
      writerRole: target, queryRole: `station_query_${suffix}`,
      writerPrincipal: candidate.writerPrincipal,
      queryPrincipal: `station-search-query-${suffix}`,
      writerCertFingerprint: null, queryCertFingerprint: null,
      createdAt: new Date('2026-11-04T00:00:00Z') };
    contract = buildWriterMappingContract(root, candidate,
      searchGenerationDispatchSpec(history, 'writer_role'),
      searchGenerationDispatchSpec(history, 'writer_mapping'));
    assert.equal(compareWriterRoleStage(contract.roleContract, await observe(),
      'pre'), 'exact');
    checkpoint = 'role-create';
    attempted.role = true;
    const roleResponse = await boundedSearchSdkEnvelope(options =>
      client.security.createRole({ role: target, body: contract.roleContract.body },
        options), 32_768, 5_000);
    assert.equal(roleResponse.statusCode, 201);
    assert.deepEqual(roleResponse.body,
      { status: 'CREATED', message: `'${target}' created.` });
    await stage(contract, 'pre');
    checkpoint = 'mapping-first';
    attempted.mapping = true;
    if (mode === 'replacement') {
      const first = await mappingPut(contract, 'first');
      const line = writerMappingShapeLine('first', first.envelope, target, first.counts);
      lines.push(line);
      // Source-backed expectation; exact pinned response remains to be measured.
      assert.equal(writerMappingExpectedShape('first', line), true);
      await stage(contract, 'post');
      checkpoint = 'mapping-replacement';
      const replacement = await mappingPut(contract, 'replacement');
      const replacedLine = writerMappingShapeLine('replacement',
        replacement.envelope, target, replacement.counts);
      lines.push(replacedLine);
      assert.equal(writerMappingExpectedShape('replacement', replacedLine), true);
      await stage(contract, 'post');
    } else {
      checkpoint = 'mapping-ambiguous';
      // Discard only the genuine settled original SDK return. The readback
      // establishes engine state, never an authorization to recover that ack.
      const lostReturn = Symbol('fixture-discard-original-return');
      let counts;
      try {
        const settled = await mappingPut(contract, 'ambiguous');
        const actualLine = writerMappingShapeLine('ambiguous-first',
          settled.envelope, target, settled.counts);
        lines.push(actualLine);
        assert.equal(writerMappingExpectedShape('ambiguous-first', actualLine), true);
        counts = settled.counts;
        throw lostReturn;
      } catch (reason) {
        if (reason !== lostReturn) throw reason;
      }
      await stage(contract, 'post');
      lines.push(writerMappingAmbiguousLine(counts, true));
    }
  } catch (reason) { error = reason; }
  const failingStep = checkpoint;
  const hadOriginalFailure = error !== null;
  checkpoint = 'cleanup';
  try { await cleanupOwned(attempted, contract); }
  catch (reason) { error ??= reason; }
  if (error) {
    if (hadOriginalFailure) checkpoint = failingStep;
    throw error;
  }
  assert.deepEqual({ producer: totals.producer - start.producer,
    connection: totals.connection - start.connection },
  { producer: mode === 'replacement' ? 2 : 1,
    connection: mode === 'replacement' ? 2 : 1 });
}

try {
  assert.equal(process.env.OPENSEARCH_URL, endpoint);
  assert.equal(require('@opensearch-project/opensearch/package.json').version, '3.9.0');
  assert.deepEqual((await readdir(identityDir)).sort(), ['admin.key', 'admin.pem', 'ca.pem']);
  const identity = await Promise.all(['ca.pem', 'admin.pem', 'admin.key'].map(async name => {
    const value = await readFile(`${identityDir}/${name}`);
    assert.ok(value.length >= 100 && value.length <= 16_384);
    return value;
  }));
  client = new Client({ node: endpoint, ssl: { ca: identity[0], cert: identity[1],
    key: identity[2], rejectUnauthorized: true }, maxRetries: 0,
  requestTimeout: 5_000, sniffOnStart: false, sniffOnConnectionFault: false,
  sniffInterval: false });
  observer = await openSearchAdminObserver({ endpoint, identityDir });
  const baseline = await observe();
  assert.deepEqual(Object.keys(baseline.indexes).sort(), ['station-mail-v1']);
  const uuid = verifyProfile({ 'station-mail-v1': baseline.indexes['station-mail-v1'] });
  root.generations = [{ token: 'legacy-v1', index: 'station-mail-v1',
    profile: 'station-mail-v1', presence: 'exact', uuid,
    writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
    writerCertFingerprint: null, queryCertFingerprint: null }];
  const policy = buildExpectedSecurityPolicy(root);
  assert.equal(compareObservedSecurityCollections(policy,
    baseline.roles, baseline.mappings), 'exact');
  original = { uuid, index: structuredClone(baseline.indexes['station-mail-v1']),
    roles: structuredClone(baseline.roles),
    mappings: structuredClone(baseline.mappings), policy };
  const info = await boundedSearchSdkRequest(options => client.info({}, options),
    32_768, 5_000);
  assert.equal(info?.version?.distribution, 'opensearch');
  assert.equal(info.version.number, '3.9.0');
  const plugins = await boundedSearchSdkRequest(options => client.transport.request(
    { method: 'GET', path: '/_nodes/plugins?filter_path=_nodes.total,_nodes.successful,_nodes.failed,nodes.*.plugins.name,nodes.*.plugins.version' },
    options), 32_768, 5_000);
  assert.deepEqual(plugins?._nodes, { total: 1, successful: 1, failed: 0 });
  const nodes = Object.values(plugins.nodes ?? {});
  assert.equal(nodes.length, 1);
  const security = nodes[0].plugins?.filter(item => item.name === 'opensearch-security');
  assert.equal(security?.length, 1);
  assert.equal(security[0].version, '3.9.0.0');
  originalConnection = Connection.prototype.request;
  Connection.prototype.request = function fixtureConnection(params, callback) {
    if (params.method === 'PUT' && params.path.startsWith(
      '/_plugins/_security/api/rolesmapping/')) {
      assert.equal(params.path, mappingPath);
      assert.ok(active);
      active.connection++;
      totals.connection++;
    }
    return originalConnection.call(this, params, callback);
  };
  const originalRequest = client.transport.request;
  client.transport.request = function fixtureProducer(params, options) {
    const mapping = params.method === 'PUT' && params.path.startsWith(
      '/_plugins/_security/api/rolesmapping/');
    if (mapping) {
      assert.equal(params.path, mappingPath);
      assert.ok(active);
      assert.equal(hash(params.body), hash(active.body));
      assert.deepEqual({ asStream: options.asStream, maxRetries: options.maxRetries,
        requestTimeout: options.requestTimeout },
      { asStream: true, maxRetries: 0, requestTimeout: 5_000 });
      active.producer++;
      totals.producer++;
    }
    const actual = originalRequest.call(this, params, options);
    if (mapping) assert.equal(typeof actual.abort, 'function');
    return actual;
  };
  await instance('replacement');
  await instance('ambiguous');
  assertOriginal(await observe());
  assert.deepEqual(totals, { producer: 3, connection: 3 });
  lines.push('Writer mapping API versions opensearch=3.9.0 sdk=3.9.0');
  lines.push('Writer mapping API plugin security=3.9.0.0 nodes=1');
} catch { failed = true; }
finally {
  if (originalConnection) Connection.prototype.request = originalConnection;
  const settled = await Promise.allSettled([client?.close(), observer?.close()]);
  if (settled.some(item => item.status === 'rejected')) {
    failed = true; checkpoint = 'close';
  }
}
for (const line of lines) process.stdout.write(`${line}\n`);
if (failed) {
  process.stderr.write(`Pinned writer mapping API proof failed at ${checkpoint}.\n`);
  process.exitCode = 1;
} else process.stdout.write('Pinned writer mapping API proof passed.\n');
