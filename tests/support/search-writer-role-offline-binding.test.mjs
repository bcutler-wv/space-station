/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from
  'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { searchGenerationDispatchSpec, buildSearchGenerationManifest } from
  '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { canonicalAttestorValue, assessCreateIndexEvidence } from
  '../../scripts/search-attestor-pure.mjs';
import { makeCreateIntentProjection, sealCreateIntent, createPriorPublicFiles } from
  '../../scripts/search-create-intent-pure.mjs';
import { makeWriterRoleIntentProjection, sealWriterRoleIntent } from
  '../../scripts/search-writer-role-intent-pure.mjs';
import { parseWriterRoleApprovalArgs, readWriterRolePending } from
  '../../scripts/search-writer-role-pending.mjs';
import { bindWriterRoleOffline } from '../../scripts/search-writer-role-offline.mjs';
import { writeWriterRoleBinding } from '../../scripts/search-writer-role-binding.mjs';
import { writeCreateApplyBinding } from '../../scripts/search-create-apply-binding.mjs';
import { withSearchAdminJobLock } from '../../scripts/search-admin-job-lock.mjs';

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
const exists = name => lstat(name).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

async function fixture(t, { v2Source = false } = {}) {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.join(process.cwd(), '.cache/results/writer-binding-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const cache = path.join(repository, '.cache');
  await mkdir(cache, { mode: 0o755 });
  await mkdir(path.join(cache, 'search-db'), { mode: 0o700 });
  for (const root of ['search-create-intent', 'search-create-apply',
    'search-writer-role-intent']) await mkdir(path.join(cache, root), { mode: 0o700 });
  const initial = snapshot(false, v2Source), bound = snapshot(true, v2Source);
  const publicFiles = createPriorPublicFiles(initial, token);
  const publicDigests = publicFiles.map(row => ({ path: row.path, sha256: 'a'.repeat(64) }));
  if (v2Source) {
    const expectation = { phase: 'precreate', revision: 2, stage: 'disabled_intent',
      transitionToken, sourceToken: priorToken, sourceIndex: priorIndex,
      candidateToken: token, candidateIndex: index, dispatchId: null, ownerId: null,
      createdUuid: null };
    assert.equal(assessCreateIndexEvidence(initial, observed(false, true), expectation).status,
      'create-evidence');
  }
  const create = sealCreateIntent(makeCreateIntentProjection(initial,
    observed(false, v2Source), state),
    publicDigests,
  { project: path.basename(repository), systemIdentifier: '123',
    dispatchId: createDispatchId, ownerId: createOwnerId });
  const oldBinding = { version: 1, invocationId: originalInvocationId,
    approvedSha256: create.sha256, dispatchId: createDispatchId, ownerId: createOwnerId };
  const oldBindingBytes = canonical(oldBinding);
  const createEvidence = { intent: create.intent, approvedSha256: create.sha256,
    binding: oldBinding };
  const projection = makeWriterRoleIntentProjection(bound, observed(true, v2Source), state,
    createEvidence, publicDigests);
  const pending = sealWriterRoleIntent(projection, { dispatchId, ownerId },
    createEvidence).intent;
  const roleBytes = canonical(pending);
  const names = { role: path.join(cache, 'search-writer-role-intent/pending.json'),
    create: path.join(cache, 'search-create-intent/pending.json'),
    oldBinding: path.join(cache, 'search-create-apply/binding.json'),
    newBinding: path.join(cache, 'search-writer-role-apply/binding.json'),
    lock: path.join(cache, 'search-db/.job-operation.lock') };
  for (const [name, bytes] of [[names.role, roleBytes], [names.create, canonical(create.intent)],
    [names.oldBinding, oldBindingBytes]]) await writeFile(name, bytes, { mode: 0o400 });
  const args = [sha(roleBytes), '7', transitionToken,
    v2Source ? priorToken : 'legacy-v1', v2Source ? priorIndex : 'station-mail-v1',
    v2Source ? 'retained_uuid' : 'legacy_uuid', token, index, 'created_uuid'];
  return { repository, names, args, roleBytes, pending, oldBindingBytes };
}

test('fixed role approval binds once, retains lock, and refuses replay after lock loss', async t => {
  const f = await fixture(t);
  const approved = parseWriterRoleApprovalArgs(f.args);
  const captured = await readWriterRolePending(f.repository, uid, gid, approved);
  assert.equal(await captured.recheck(), true);
  const result = await bindWriterRoleOffline({ repository: f.repository, uid, gid, args: f.args });
  assert.equal(result.state, 'bound-offline');
  assert.equal((await lstat(f.names.lock)).mode & 0o777, 0o600);
  const binding = JSON.parse(await readFile(f.names.newBinding, 'utf8'));
  assert.deepEqual(binding, { version: 1, invocationId: result.invocationId,
    approvedSha256: f.args[0], dispatchId, ownerId });
  assert.equal((await lstat(f.names.newBinding)).mode & 0o777, 0o400);
  await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid, args: f.args }));
  await rm(f.names.lock);
  await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid, args: f.args }));
  assert.equal(await exists(f.names.newBinding), true);
  assert.equal(await exists(f.names.lock), true);
});

test('constructor-approved v2 source retains original legacy E0b identity', async t => {
  const f = await fixture(t, { v2Source: true });
  assert.equal(f.pending.sourceUuid, 'retained_uuid');
  assert.equal(f.pending.state.indexUuid, 'legacy_uuid');
  const result = await bindWriterRoleOffline({ repository: f.repository, uid, gid,
    args: f.args });
  assert.equal(result.state, 'bound-offline');
  assert.equal(await exists(f.names.newBinding), true);
  assert.equal(await exists(f.names.lock), true);
});

test('typed values and original binding digest reject changed approval before binding', async t => {
  const f = await fixture(t);
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    const args = [...f.args]; args[i] = i === 0 ? '0'.repeat(64) : i === 1 ? '8' :
      i === 5 || i === 8 ? 'wrong_uuid' : '88888888-8888-4888-8888-888888888888';
    await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid, args }));
    assert.equal(await exists(f.names.newBinding), false);
  }
  const changed = { ...JSON.parse(f.oldBindingBytes.toString('utf8')),
    invocationId: '88888888-8888-4888-8888-888888888888' };
  await chmod(f.names.oldBinding, 0o600);
  await writeFile(f.names.oldBinding, canonical(changed));
  await chmod(f.names.oldBinding, 0o400);
  await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid, args: f.args }));
  assert.equal(await exists(f.names.newBinding), false);
});

test('noncanonical pending and parent or inode replacement reject', async t => {
  for (const mutate of [
    async f => { await chmod(f.names.role, 0o600);
      await writeFile(f.names.role, Buffer.concat([f.roleBytes, Buffer.from('\n')]));
      await chmod(f.names.role, 0o400); },
    async f => { await rm(f.names.role); await symlink(f.names.create, f.names.role); },
    async f => { await writeFile(path.join(path.dirname(f.names.role), 'extra'), 'x'); },
  ]) {
    const f = await fixture(t); await mutate(f);
    await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid, args: f.args }));
    assert.equal(await exists(f.names.newBinding), false);
  }
  const f = await fixture(t);
  const captured = await readWriterRolePending(f.repository, uid, gid,
    parseWriterRoleApprovalArgs(f.args));
  await rename(f.names.role, `${f.names.role}.old`);
  await writeFile(f.names.role, f.roleBytes, { mode: 0o400 });
  await assert.rejects(captured.recheck());
});

test('attempted append and fsync faults retain one role lock', async t => {
  for (const fault of ['writer-binding-after-append', 'writer-binding-after-file-sync']) {
    const f = await fixture(t);
    const old = process.env.STATION_JOB_LOCK_FIXTURE;
    process.env.STATION_JOB_LOCK_FIXTURE = '1';
    try {
      await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid,
        args: f.args, lock: (options, work) => withSearchAdminJobLock(
          { ...options, fixtureFaultAt: fault }, work) }));
    } finally {
      if (old === undefined) delete process.env.STATION_JOB_LOCK_FIXTURE;
      else process.env.STATION_JOB_LOCK_FIXTURE = old;
    }
    assert.equal(await exists(f.names.lock), true);
    assert.equal(await exists(f.names.newBinding), false);
    const records = (await readFile(f.names.lock, 'utf8')).trim().split(/\n+/).map(JSON.parse);
    assert.equal(records.at(-1).role, 'writer-role-apply');
    assert.equal(records.at(-1).phase, 'binding');
    assert.equal(records.at(-1).state, 'attempted');
  }
});

test('reached binding write and file-sync faults retain lock without confirmation', async t => {
  for (const hook of ['afterFileWrite', 'afterFileSync']) {
    const f = await fixture(t);
    let reached = 0;
    const old = process.env.STATION_WRITER_ROLE_FIXTURE;
    process.env.STATION_WRITER_ROLE_FIXTURE = '1';
    try {
      await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid,
        args: f.args, writeBinding: (...args) => writeWriterRoleBinding(...args,
          { [hook]: () => { reached++; throw Error('fixture reached'); } }) }));
    } finally {
      if (old === undefined) delete process.env.STATION_WRITER_ROLE_FIXTURE;
      else process.env.STATION_WRITER_ROLE_FIXTURE = old;
    }
    assert.equal(reached, 1);
    assert.equal(await exists(f.names.lock), true);
    assert.equal(await exists(f.names.newBinding), true);
    await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid,
      args: f.args }));
  }
});

test('role binding writer cannot use create operation token', async t => {
  const f = await fixture(t);
  await withSearchAdminJobLock({ root: path.join(f.repository,
    '.cache/search-db'), uid }, async token => {
    const create = token.beginCreateApply({ approvedSha256: f.args[0], dispatchId, ownerId });
    await create.markBindingAttempted();
    await assert.rejects(writeWriterRoleBinding(f.repository, uid, gid, create,
      { approvedSha256: f.args[0], dispatchId, ownerId }));
  });
  assert.equal(await exists(f.names.newBinding), false);
  assert.equal(await exists(f.names.lock), true);
  const other = await fixture(t);
  await withSearchAdminJobLock({ root: path.join(other.repository,
    '.cache/search-db'), uid }, async token => {
    const role = token.beginWriterRoleApply({ approvedSha256: other.args[0],
      dispatchId, ownerId });
    await role.markBindingAttempted();
    await assert.rejects(writeCreateApplyBinding(other.repository, uid, gid, role,
      { approvedSha256: other.args[0], dispatchId, ownerId }));
  });
  assert.equal(await exists(other.names.lock), true);
});

test('binding write ambiguity and same-byte original replacement retain the attempted lock', async t => {
  const partial = await fixture(t);
  await assert.rejects(bindWriterRoleOffline({ repository: partial.repository, uid, gid,
    args: partial.args, writeBinding: async (...args) => {
      await writeWriterRoleBinding(...args);
      throw Error('fixture lost binding return');
    } }));
  assert.equal(await exists(partial.names.newBinding), true);
  assert.equal(await exists(partial.names.lock), true);
  const replaced = await fixture(t);
  const before = (await lstat(replaced.names.oldBinding)).ino;
  await assert.rejects(bindWriterRoleOffline({ repository: replaced.repository, uid, gid,
    args: replaced.args, writeBinding: async (...args) => {
      const binding = await writeWriterRoleBinding(...args);
      const bytes = await readFile(replaced.names.oldBinding);
      await rename(replaced.names.oldBinding, `${replaced.names.oldBinding}.old`);
      await writeFile(replaced.names.oldBinding, bytes, { mode: 0o400 });
      await rm(`${replaced.names.oldBinding}.old`);
      return binding;
    } }));
  assert.notEqual((await lstat(replaced.names.oldBinding)).ino, before);
  assert.equal(await exists(replaced.names.lock), true);
  const lockChanged = await fixture(t);
  const originalLock = `${lockChanged.names.lock}.original`;
  await assert.rejects(bindWriterRoleOffline({ repository: lockChanged.repository, uid, gid,
    args: lockChanged.args, writeBinding: async (...args) => {
      const binding = await writeWriterRoleBinding(...args);
      const bytes = await readFile(lockChanged.names.lock);
      await rename(lockChanged.names.lock, originalLock);
      await writeFile(lockChanged.names.lock, bytes, { mode: 0o600 });
      return binding;
    } }));
  assert.equal(await exists(lockChanged.names.lock), true);
  assert.equal(await exists(lockChanged.names.newBinding), true);
});

test('concurrent role owners have one winner before binding send authority', async t => {
  const f = await fixture(t);
  let release;
  let reached;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const first = bindWriterRoleOffline({ repository: f.repository, uid, gid, args: f.args,
    writeBinding: async (...args) => {
      reached(); await held; return writeWriterRoleBinding(...args);
    } });
  await entered;
  await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid, args: f.args }));
  release();
  const result = await first;
  assert.equal(result.state, 'bound-offline');
  assert.equal(await exists(f.names.newBinding), true);
});

test('even a matching typed SHA cannot approve noncanonical intent bytes or a wrapper', async t => {
  for (const bytesFor of [
    f => Buffer.concat([f.roleBytes, Buffer.from('\n')]),
    f => Buffer.from(JSON.stringify({ intent: f.pending, sha256: sha(f.roleBytes) })),
    f => canonical({ ...f.pending, extra: true }),
  ]) {
    const f = await fixture(t);
    const bytes = bytesFor(f);
    await chmod(f.names.role, 0o600);
    await writeFile(f.names.role, bytes);
    await chmod(f.names.role, 0o400);
    const args = [sha(bytes), ...f.args.slice(1)];
    await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid, args }));
    assert.equal(await exists(f.names.newBinding), false);
  }
});

test('descriptor-invalid approval, linked input and changed parent fail closed', async t => {
  const f = await fixture(t);
  let called = 0;
  const args = [...f.args];
  Object.defineProperty(args, '0', { enumerable: true,
    get() { called++; return f.args[0]; } });
  assert.throws(() => parseWriterRoleApprovalArgs(args));
  assert.equal(called, 0);
  for (const change of [
    async x => { await link(x.names.role, `${x.names.role}.link`); },
    async x => { await rm(x.names.role); await symlink(x.names.create, x.names.role); },
    async x => { await chmod(path.dirname(x.names.role), 0o755); },
  ]) {
    const x = await fixture(t); await change(x);
    await assert.rejects(bindWriterRoleOffline({ repository: x.repository, uid, gid, args: x.args }));
    assert.equal(await exists(x.names.newBinding), false);
  }
});

test('constructor-backed pending rejects malformed E0b, calendar and role identities with matching typed SHA', async t => {
  for (const change of [
    intent => { intent.state.phase = 'unknown'; },
    intent => { intent.state.indexUuid = 'wrong'; },
    intent => { intent.boundControlUpdatedAt = '2026-02-30T18:00:00.123456Z'; },
    intent => { intent.bodyIdentity = '0'.repeat(64); },
    intent => { intent.bodySha256 = '0'.repeat(64); },
  ]) {
    const f = await fixture(t);
    const intent = structuredClone(f.pending); change(intent);
    const bytes = canonical(intent);
    await chmod(f.names.role, 0o600);
    await writeFile(f.names.role, bytes);
    await chmod(f.names.role, 0o400);
    await assert.rejects(bindWriterRoleOffline({ repository: f.repository, uid, gid,
      args: [sha(bytes), ...f.args.slice(1)] }));
    assert.equal(await exists(f.names.newBinding), false);
  }
  const v2 = await fixture(t, { v2Source: true });
  const intent = structuredClone(v2.pending);
  intent.state.indexUuid = 123;
  const bytes = canonical(intent);
  await chmod(v2.names.role, 0o600);
  await writeFile(v2.names.role, bytes);
  await chmod(v2.names.role, 0o400);
  await assert.rejects(bindWriterRoleOffline({ repository: v2.repository, uid, gid,
    args: [sha(bytes), ...v2.args.slice(1)] }));
  assert.equal(await exists(v2.names.newBinding), false);
});
