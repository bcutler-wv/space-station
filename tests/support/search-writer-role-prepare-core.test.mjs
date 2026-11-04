/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm,
  writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { searchGenerationDispatchSpec, buildSearchGenerationManifest } from '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { makeCreateIntentProjection, sealCreateIntent, createPriorPublicFiles, digestCreatePriorPublic } from '../../scripts/search-create-intent-pure.mjs';
import { runWriterRolePrepare } from '../../scripts/search-writer-role-prepare-core.mjs';
import { openWriterRolePrepareInput, parseWriterRolePrepareInvocation } from '../../scripts/search-writer-role-prepare-input.mjs';
import { parseWriterRolePrepareOutput } from '../../scripts/search-writer-role-prepare-output.mjs';
import { captureCreateIntentAdminVolume } from '../../scripts/search-create-intent-admin-volume.mjs';
const uid = process.getuid(), gid = process.getgid();
const token = '11111111-1111-4111-8111-111111111111';
const transitionToken = '22222222-2222-4222-8222-222222222222';
const createDispatchId = '33333333-3333-4333-8333-333333333333';
const createOwnerId = '44444444-4444-4444-8444-444444444444';
const dispatchId = '55555555-5555-4555-8555-555555555555';
const ownerId = '66666666-6666-4666-8666-666666666666';
const originalInvocationId = '77777777-7777-4777-8777-777777777777';
const index = `station-mail-v2-g${token.replaceAll('-', '')}`;
const priorToken = '88888888-8888-4888-8888-888888888888';
const priorIndex = `station-mail-v2-g${priorToken.replaceAll('-', '')}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => canonicalAttestorValue(value, 256 * 1024).bytes;
const state = { phase: 'ready', kind: 'complete', indexUuid: 'legacy_uuid' };
const date = () => new Date('2026-10-22T18:00:00.123Z');
const micro = '2026-10-22T18:00:00.123456Z';
function snapshot(bound, v2Source = false) {
  const history = [{ generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1',
    profileId: 'station-mail-v1', indexUuid: 'legacy_uuid', lifecycle: 'roles_attested',
    writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
    writerCertFingerprint: null, queryCertFingerprint: null, createdAt: date() },
  ...(v2Source ? [{ generationToken: priorToken, physicalIndex: priorIndex,
    profileId: 'station-mail-v2', indexUuid: 'retained_uuid', lifecycle: 'roles_attested',
    writerRole: `station_indexer_${priorToken.replaceAll('-', '')}`,
    queryRole: `station_query_${priorToken.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${priorToken.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${priorToken.replaceAll('-', '')}`,
    writerCertFingerprint: 'f'.repeat(64), queryCertFingerprint: 'e'.repeat(64),
    createdAt: date() }] : []),
  { generationToken: token, physicalIndex: index, profileId: 'station-mail-v2',
    indexUuid: bound ? 'created_uuid' : null, lifecycle: bound ? 'bound' : 'reserved',
    writerRole: `station_indexer_${token.replaceAll('-', '')}`,
    queryRole: `station_query_${token.replaceAll('-', '')}`,
    writerPrincipal: `station-search-indexer-${token.replaceAll('-', '')}`,
    queryPrincipal: `station-search-query-${token.replaceAll('-', '')}`,
    writerCertFingerprint: null, queryCertFingerprint: null, createdAt: date() }];
  const priorDispatch = v2Source ? ['create_index', 'writer_role', 'writer_mapping',
    'query_role', 'query_mapping'].map((operation, i) => ({
    generationToken: priorToken, operation,
    dispatchId: `99999999-9999-4999-8999-99999999999${i}`,
    ownerId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`,
    ...searchGenerationDispatchSpec(history[1], operation),
    state: 'response_confirmed', createdAt: date() })) : [];
  const dispatch = [...priorDispatch, ...(bound ? [{ generationToken: token, operation: 'create_index',
    dispatchId: createDispatchId, ownerId: createOwnerId,
    ...searchGenerationDispatchSpec(history.at(-1), 'create_index'),
    state: 'response_confirmed', createdAt: date() }] : [])];
  return { control: { singleton: 1, revision: bound ? 7 : 2,
    stage: bound ? 'uuid_bound' : 'disabled_intent', transitionToken,
    sourceGenerationToken: v2Source ? priorToken : 'legacy-v1', generationToken: token,
    physicalIndex: index, indexUuid: bound ? 'created_uuid' : null,
    profileId: 'station-mail-v2', publicationEnabled: false,
    servingReady: false, updatedAt: date() }, history, dispatch,
  identity: { sessionUser: 'station_search_transition', currentUser: 'station_search_transition',
    database: 'station', databaseOid: 16384, databaseOwner: 'station' },
  exactTimestamps: { control: { singleton: 1, updatedAt: micro },
    history: history.map(row => ({ generationToken: row.generationToken, createdAt: micro })),
    dispatch: dispatch.map(row => ({ generationToken: row.generationToken,
      operation: row.operation, dispatchId: row.dispatchId, createdAt: micro })) } };
}
function observed(bound, v2Source = false) {
  const indexes = { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0',
      max_result_window: '200', refresh_interval: '1s',
      mapping: { total_fields: { limit: '64' } }, replication: { type: 'DOCUMENT' },
      uuid: 'legacy_uuid', creation_date: '1760000000000',
      provided_name: 'station-mail-v1', version: { created: '13927900' } } } } };
  if (bound) indexes[index] = { aliases: {}, mappings: createV2IndexBody(index).mappings,
    settings: { index: { ...structuredClone(indexes['station-mail-v1'].settings.index),
      uuid: 'created_uuid', provided_name: index } } };
  if (v2Source) indexes[priorIndex] = { aliases: {},
    mappings: createV2IndexBody(priorIndex).mappings,
    settings: { index: { ...structuredClone(indexes['station-mail-v1'].settings.index),
      uuid: 'retained_uuid', provided_name: priorIndex } } };
  const prior = buildSearchGenerationManifest(snapshot(false, v2Source).history)
    .filter(row => row.token !== token).map(row => ({ ...row, presence: 'exact' }));
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
    generations: prior });
  return { indexes, roles: policy.roles, mappings: policy.mappings };
}

function pureFixture(v2Source = false) {
  const initial = snapshot(false, v2Source);
  const current = { snapshot: snapshot(true, v2Source), state: structuredClone(state),
    observed: observed(true, v2Source) };
  const publicFiles = createPriorPublicFiles(initial, token);
  const publicDigests = publicFiles.map(row => ({ path: row.path, sha256: 'a'.repeat(64) }));
  const create = sealCreateIntent(makeCreateIntentProjection(initial,
    observed(false, v2Source), state), publicDigests,
  { project: 'stationfixture', systemIdentifier: '123',
    dispatchId: createDispatchId, ownerId: createOwnerId });
  const binding = { version: 1, invocationId: originalInvocationId,
    approvedSha256: create.sha256, dispatchId: createDispatchId, ownerId: createOwnerId };
  const createEvidence = { intent: create.intent, approvedSha256: create.sha256, binding };
  const invocation = { version: 1,
    invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    project: 'stationfixture', databaseOid: 16384, systemIdentifier: '123',
    createApprovedSha256: create.sha256,
    originalCreateBindingSha256: sha(canonical(binding)), dispatchId, ownerId };
  const adminPublic = { caSha256: 'a'.repeat(64), adminSha256: 'a'.repeat(64) };
  const counters = { input: 0, snapshot: 0, state: 0, observed: 0, admin: 0,
    inputRecheck: 0, adminRecheck: 0 };
  const deps = { readInput: async () => {
    counters.input++;
    return { invocation, createEvidence, publicDigests,
      recheck: async () => { counters.inputRecheck++; return true; } };
  }, readSnapshot: async () => { counters.snapshot++; return current.snapshot; },
  readState: async () => { counters.state++; return current.state; },
  observe: async () => { counters.observed++; return current.observed; },
  captureAdminPublic: async () => {
    counters.admin++;
    return { public: adminPublic,
      recheck: async () => { counters.adminRecheck++; return true; } };
  }, recheckSnapshot: async () => true };
  return { deps, counters, current, invocation, createEvidence, publicDigests, adminPublic };
}

test('fixed same-process reader seals legacy and retained-v2 source without readiness', async () => {
  for (const v2 of [false, true]) {
    const f = pureFixture(v2);
    const output = await runWriterRolePrepare(f.deps);
    const parsed = parseWriterRolePrepareOutput(Buffer.from(output), {
      invocation: f.invocation, createEvidence: f.createEvidence,
      publicDigests: f.publicDigests, adminPublic: f.adminPublic });
    assert.equal(parsed.intent.candidateUuid, 'created_uuid');
    assert.equal(parsed.intent.state.indexUuid, 'legacy_uuid');
    assert.equal(parsed.intent.sourceToken, v2 ? priorToken : 'legacy-v1');
    assert.equal(f.counters.snapshot, 4);
    assert.equal(f.counters.input, 4);
    assert.equal(f.counters.observed, 4);
    assert.equal(f.counters.admin, 4);
  }
});

test('inter-read mutation reaches second read and cannot rebase sealed baseline', async () => {
  const changes = {
    snapshot: f => { f.current.snapshot.control.revision++; },
    boundUuid: f => { f.current.snapshot.history.at(-1).indexUuid = 'other_uuid'; },
    microtime: f => { f.current.snapshot.exactTimestamps.control.updatedAt =
      '2026-10-22T18:00:00.123457Z'; },
    state: f => { f.current.state.indexUuid = 'changed_uuid'; },
    engine: f => { f.current.observed.indexes[index].settings.index.uuid = 'changed_uuid'; },
    oldCreate: f => { f.createEvidence.binding.ownerId = ownerId; },
    copiedInput: f => { f.invocation.systemIdentifier = '124'; },
    public: f => { f.publicDigests[0].sha256 = 'b'.repeat(64); },
    admin: f => { f.adminPublic.adminSha256 = 'b'.repeat(64); },
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = pureFixture();
    const original = f.deps.readSnapshot;
    f.deps.readSnapshot = async () => {
      if (f.counters.snapshot === 1) change(f);
      return original();
    };
    await assert.rejects(runWriterRolePrepare(f.deps),
      { message: 'Private writer role preparation failed.' }, name);
    assert.equal(f.counters.snapshot >= 2, true, name);
  }
});

test('snapshot recheck receives a defensive copy of the pinned baseline', async () => {
  const f = pureFixture();
  let reached = 0;
  f.deps.recheckSnapshot = async value => {
    reached++;
    value.control.revision = 999;
    value.exactTimestamps.control.updatedAt = '2026-10-22T18:00:00.123999Z';
    return true;
  };
  const output = await runWriterRolePrepare(f.deps);
  assert.equal(reached, 3);
  assert.equal(JSON.parse(output).intent.revision, 7);
});

test('inter-await public accessor mutation is rejected without calling its getter', async () => {
  const f = pureFixture();
  let getterCalls = 0, reached = 0;
  const readState = f.deps.readState;
  f.deps.readState = async () => {
    reached++;
    if (reached === 1) Object.defineProperty(f.publicDigests[0], 'sha256', {
      enumerable: true, configurable: true, get() { getterCalls++; return 'a'.repeat(64); },
    });
    return readState();
  };
  await assert.rejects(runWriterRolePrepare(f.deps),
    { message: 'Private writer role preparation failed.' });
  assert.equal(reached >= 2, true);
  assert.equal(getterCalls, 0);
});

test('fixed output and invocation reject changed fields and noncanonical bytes', async () => {
  const f = pureFixture();
  const output = Buffer.from(await runWriterRolePrepare(f.deps));
  const expected = { invocation: f.invocation, createEvidence: f.createEvidence,
    publicDigests: f.publicDigests, adminPublic: f.adminPublic };
  assert.throws(() => parseWriterRolePrepareOutput(Buffer.from(output.subarray(0, -1)),
    expected));
  assert.throws(() => parseWriterRolePrepareOutput(Buffer.concat([output,
    Buffer.from('\n')]), expected));
  const changed = structuredClone(expected);
  changed.invocation.dispatchId = originalInvocationId;
  assert.throws(() => parseWriterRolePrepareOutput(output, changed));
  for (const [name, mutate] of [
    ['source', intent => { intent.sourceUuid = 'other_uuid'; }],
    ['old digest', intent => { intent.createApprovedSha256 = 'b'.repeat(64); }],
    ['prior digest', intent => { intent.priorEvidenceDigest = 'b'.repeat(64); }],
    ['body', intent => { intent.bodySha256 = 'b'.repeat(64); }],
    ['revision', intent => { intent.revision++; }],
    ['public', intent => { intent.publicDigests[0].sha256 = 'b'.repeat(64); }],
  ]) {
    const result = JSON.parse(output.toString('utf8'));
    mutate(result.intent);
    result.sha256 = sha(canonical(result.intent));
    assert.throws(() => parseWriterRolePrepareOutput(Buffer.from(
      `${canonical(result).toString('utf8')}\n`), expected), name);
  }
  assert.deepEqual(parseWriterRolePrepareInvocation(canonical(f.invocation)), f.invocation);
  assert.throws(() => parseWriterRolePrepareInvocation(Buffer.from(`${JSON.stringify(f.invocation)}\n`)));
});

test('copied original create and real public certificates stay on their original inodes', async t => {
  await mkdir('.cache/results', { recursive: true });
  const sandbox = await mkdtemp(path.join(process.cwd(), '.cache/results/writer-prepare-'));
  const repository = path.join(sandbox, 'stationfixture');
  await mkdir(repository, { mode: 0o700 });
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const setup = spawnSync(process.execPath, [path.resolve('scripts/init-search-security.mjs')],
    { cwd: repository, stdio: 'ignore', timeout: 30_000 });
  assert.equal(setup.status, 0);
  const scratch = path.join(repository, '.cache/role-scratch');
  const inputRoot = path.join(repository, 'copied-input');
  await mkdir(scratch, { mode: 0o700 });
  await mkdir(inputRoot, { mode: 0o700 });
  await mkdir(path.join(inputRoot, 'public'), { mode: 0o700 });
  await mkdir(path.join(inputRoot, 'public/v1'), { mode: 0o700 });
  const files = createPriorPublicFiles(snapshot(false), token);
  const source = path.join(repository, '.cache/search-security');
  const publicBytes = new Map();
  for (const row of files) {
    const leaf = path.basename(row.path);
    const bytes = await readFile(path.join(source, leaf));
    publicBytes.set(row.path, bytes);
    await writeFile(path.join(inputRoot, 'public', row.path), bytes, { mode: 0o400 });
  }
  const digests = await digestCreatePriorPublic(files, publicBytes, new Date(), scratch);
  const create = sealCreateIntent(makeCreateIntentProjection(snapshot(false),
    observed(false), state), digests,
  { project: path.basename(repository), systemIdentifier: '123',
    dispatchId: createDispatchId, ownerId: createOwnerId });
  const binding = { version: 1, invocationId: originalInvocationId,
    approvedSha256: create.sha256, dispatchId: createDispatchId, ownerId: createOwnerId };
  const invocation = { version: 1,
    invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    project: path.basename(repository), databaseOid: 16384, systemIdentifier: '123',
    createApprovedSha256: create.sha256,
    originalCreateBindingSha256: sha(canonical(binding)), dispatchId, ownerId };
  const filesToWrite = [['create-intent.json', canonical(create.intent)],
    ['create-binding.json', canonical(binding)],
    ['invocation.json', canonical(invocation)],
    ['transition.password', Buffer.from('a'.repeat(43))]];
  for (const [name, bytes] of filesToWrite)
    await writeFile(path.join(inputRoot, name), bytes, { mode: 0o400 });
  const previous = process.env.STATION_WRITER_ROLE_PREPARE_FIXTURE;
  process.env.STATION_WRITER_ROLE_PREPARE_FIXTURE = '1';
  t.after(() => { if (previous === undefined) delete process.env.STATION_WRITER_ROLE_PREPARE_FIXTURE;
    else process.env.STATION_WRITER_ROLE_PREPARE_FIXTURE = previous; });
  const captured = await openWriterRolePrepareInput(inputRoot, scratch, { uid, gid });
  const input = await captured.readInput();
  assert.equal(input.createEvidence.approvedSha256, create.sha256);
  assert.equal(await captured.recheck(), true);
  const adminRoot = path.join(repository, 'mounted-admin');
  await mkdir(adminRoot, { mode: 0o700 });
  for (const name of ['ca.pem', 'admin.pem', 'admin.key']) {
    const target = path.join(adminRoot, name);
    await copyFile(path.join(source, name), target);
    await chmod(target, 0o600);
  }
  const captureAdmin = () => captureCreateIntentAdminVolume(adminRoot,
    { uid, gid, dirMode: 0o700, fileMode: 0o600 }, scratch);
  const output = await runWriterRolePrepare({ readInput: captured.readInput,
    readSnapshot: async () => snapshot(true), readState: async () => state,
    observe: async () => observed(true), recheckSnapshot: async () => true,
    captureAdminPublic: captureAdmin });
  const adminPublic = (await captureAdmin()).public;
  assert.equal(parseWriterRolePrepareOutput(Buffer.from(output), {
    invocation, createEvidence: input.createEvidence, publicDigests: digests,
    adminPublic }).intent.candidateUuid, 'created_uuid');
  const copiedBinding = path.join(inputRoot, 'create-binding.json');
  await chmod(copiedBinding, 0o600);
  await assert.rejects(captured.recheck());
  await chmod(copiedBinding, 0o400);
  const again = await openWriterRolePrepareInput(inputRoot, scratch, { uid, gid });
  const extra = path.join(inputRoot, 'unexpected');
  await writeFile(extra, Buffer.from('x'), { mode: 0o400 });
  await assert.rejects(again.recheck());
  await rm(extra);
  assert.equal(await again.recheck(), true);
  const leaf = path.join(inputRoot, 'public/v1/indexer.pem');
  const originalLeaf = path.join(repository, 'original-indexer.pem');
  const originalStat = await lstat(leaf);
  await rename(leaf, originalLeaf);
  await copyFile(originalLeaf, leaf);
  await chmod(leaf, 0o400);
  assert.notEqual((await lstat(leaf)).ino, originalStat.ino);
  assert.deepEqual((await readdir(path.dirname(leaf))).sort(),
    ['admin.pem', 'indexer.pem', 'query.pem']);
  await assert.rejects(again.recheck(),
    { message: 'Private writer role preparation input failed.' });
});
