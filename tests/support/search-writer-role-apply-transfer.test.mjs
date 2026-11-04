/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { searchGenerationDispatchSpec, buildSearchGenerationManifest } from '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { makeCreateIntentProjection, sealCreateIntent, createPriorPublicFiles, digestCreatePriorPublic } from '../../scripts/search-create-intent-pure.mjs';
import { makeWriterRoleIntentProjection, sealWriterRoleIntent } from '../../scripts/search-writer-role-intent-pure.mjs';
import { transferWriterRoleApplyInputs } from '../../scripts/search-writer-role-apply-transfer-core.mjs';
import { openWriterRoleApplyInput } from '../../scripts/search-writer-role-apply-input.mjs';

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
function snapshot(bound, v2Source = false, fingerprints = { writer: 'f'.repeat(64), query: 'e'.repeat(64) }) {
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
    writerCertFingerprint: fingerprints.writer, queryCertFingerprint: fingerprints.query,
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
function observed(bound, v2Source = false, fingerprints = { writer: 'f'.repeat(64), query: 'e'.repeat(64) }) {
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
  const prior = buildSearchGenerationManifest(snapshot(false, v2Source, fingerprints).history)
    .filter(row => row.token !== token).map(row => ({ ...row, presence: 'exact' }));
  const policy = buildExpectedSecurityPolicy({ version: 'station-generation-registry-v1',
    generations: prior });
  return { indexes, roles: policy.roles, mappings: policy.mappings };
}

const sourceNames = { intentFile: 'intent.json', bindingFile: 'binding.json',
  createIntentFile: 'create-intent.json', createBindingFile: 'create-binding.json',
  passwordFile: 'password' };
const opts = { fixture: true, creatorUid: process.getuid(), targetUid: process.getuid() };
process.env.STATION_WRITER_ROLE_APPLY_FIXTURE = '1';

async function fixture(t, v2Source = false) {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/results/writer-apply-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.resolve('scripts/init-search-security.mjs')],
    { cwd: root, stdio: 'ignore', timeout: 30_000 });
  const security = path.join(root, '.cache/search-security');
  const publicRoot = path.join(root, 'public');
  const volumeRoot = path.join(root, 'volume');
  const scratch = path.join(root, '.cache/role-scratch');
  await mkdir(publicRoot, { mode: 0o700 });
  await mkdir(volumeRoot, { mode: 0o755 });
  await mkdir(scratch, { mode: 0o700 });
  const fingerprints = { writer: 'f'.repeat(64), query: 'e'.repeat(64) };
  const generationBytes = new Map();
  if (v2Source) {
    const ext = path.join(root, 'client.ext');
    await writeFile(ext, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n');
    for (const role of ['writer', 'query']) {
      const principal = `station-search-${role === 'writer' ? 'indexer' : 'query'}-${priorToken.replaceAll('-', '')}`;
      const key = path.join(root, `${role}.key`), csr = path.join(root, `${role}.csr`);
      const cert = path.join(root, `${role}.pem`);
      execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj',
        `/CN=${principal}`, '-keyout', key, '-out', csr], { stdio: 'ignore', timeout: 10_000 });
      execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', path.join(security, 'ca.pem'),
        '-CAkey', path.join(security, 'ca.key'), '-CAcreateserial', '-days', '30',
        '-extfile', ext, '-out', cert], { stdio: 'ignore', timeout: 10_000 });
      const bytes = await readFile(cert);
      generationBytes.set(role, bytes);
      fingerprints[role] = new X509Certificate(bytes).fingerprint256.replaceAll(':', '').toLowerCase();
    }
  }
  const initial = snapshot(false, v2Source, fingerprints);
  const bound = snapshot(true, v2Source, fingerprints);
  const rows = createPriorPublicFiles(initial, token);
  const bytes = new Map();
  for (const row of rows) {
    const content = row.token !== 'legacy-v1' ? generationBytes.get(row.role) :
      await readFile(path.join(security, row.path === 'ca.pem' ? 'ca.pem' : path.basename(row.path)));
    assert.ok(Buffer.isBuffer(content));
    bytes.set(row.path, content);
    const name = path.join(publicRoot, row.path);
    await mkdir(path.dirname(name), { recursive: true, mode: 0o700 });
    await writeFile(name, content, { mode: 0o400 });
  }
  const digests = await digestCreatePriorPublic(rows, bytes, new Date(), scratch);
  const create = sealCreateIntent(makeCreateIntentProjection(initial,
    observed(false, v2Source, fingerprints), state), digests,
  { project: path.basename(root), systemIdentifier: '123',
    dispatchId: createDispatchId, ownerId: createOwnerId });
  const oldBinding = { version: 1, invocationId: originalInvocationId,
    approvedSha256: create.sha256, dispatchId: createDispatchId, ownerId: createOwnerId };
  const createEvidence = { intent: create.intent, approvedSha256: create.sha256,
    binding: oldBinding };
  const projection = makeWriterRoleIntentProjection(bound,
    observed(true, v2Source, fingerprints), state, createEvidence, digests);
  const role = sealWriterRoleIntent(projection, { dispatchId, ownerId }, createEvidence);
  const newBinding = { version: 1, invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    approvedSha256: role.sha256, dispatchId, ownerId };
  const paths = { publicRoot, volumeRoot };
  for (const [key, leaf] of Object.entries(sourceNames)) {
    const dir = path.join(root, key);
    await mkdir(dir, { mode: 0o755 });
    paths[key] = path.join(dir, leaf);
  }
  for (const [key, value] of [['intentFile', role.intent], ['bindingFile', newBinding],
    ['createIntentFile', create.intent], ['createBindingFile', oldBinding]])
    await writeFile(paths[key], canonical(value), { mode: 0o400 });
  await writeFile(paths.passwordFile, 'A'.repeat(43), { mode: 0o400 });
  return { root, paths, scratch, rows, role, newBinding, create, oldBinding, bytes };
}

async function openCopied(f) {
  return openWriterRoleApplyInput(f.paths.volumeRoot, f.scratch,
    { uid: process.getuid(), gid: process.getgid() });
}

test('real legacy and retained-v2 certificates copy as exact private evidence', async t => {
  for (const v2 of [false, true]) {
    await t.test(v2 ? 'v2 source' : 'legacy source', async child => {
      const f = await fixture(child, v2);
      assert.deepEqual(await transferWriterRoleApplyInputs(f.paths, opts),
        { approvedSha256: f.role.sha256, invocationId: f.newBinding.invocationId });
      const copied = await openCopied(f);
      const value = await copied.readInput();
      assert.equal(value.intent.candidateUuid, 'created_uuid');
      assert.equal(value.intent.sourceToken, v2 ? priorToken : 'legacy-v1');
      assert.equal(value.approvedSha256, f.role.sha256);
      assert.equal(value.createEvidence.binding.invocationId, originalInvocationId);
      assert.deepEqual((await readdir(f.paths.volumeRoot)).sort(),
        ['binding.json', 'create-binding.json', 'create-intent.json', 'intent.json',
          'public', 'transition.password']);
      for (const name of ['intent.json', 'binding.json', 'create-intent.json',
        'create-binding.json', 'transition.password', ...f.rows.map(row => `public/${row.path}`)]) {
        const stat = await lstat(path.join(f.paths.volumeRoot, name));
        assert.equal(stat.mode & 0o777, 0o400);
        assert.equal(stat.uid, process.getuid());
      }
      assert.equal((await lstat(f.paths.volumeRoot)).mode & 0o777, 0o700);
      value.intent.candidateUuid = 'mutated';
      value.transitionPassword.fill(0);
      assert.equal((await copied.readInput()).intent.candidateUuid, 'created_uuid');
      assert.equal((await copied.readInput()).transitionPassword.toString('utf8'), 'A'.repeat(43));
      await copied.recheck();
      await assert.rejects(transferWriterRoleApplyInputs(f.paths, opts));
    });
  }
});

async function rewriteRole(f, intent, binding = f.newBinding) {
  await chmod(f.paths.intentFile, 0o600);
  await writeFile(f.paths.intentFile, canonical(intent));
  await chmod(f.paths.intentFile, 0o400);
  await chmod(f.paths.bindingFile, 0o600);
  await writeFile(f.paths.bindingFile, canonical(binding));
  await chmod(f.paths.bindingFile, 0o400);
}

test('inconsistent same-typed role, binding, and original-create edits reject before copy', async t => {
  for (const [name, change] of [
    ['role U', async f => rewriteRole(f, { ...f.role.intent, candidateUuid: 'other_uuid' })],
    ['role body digest', async f => rewriteRole(f, { ...f.role.intent, bodySha256: 'f'.repeat(64) },
      { ...f.newBinding, approvedSha256: sha(canonical({ ...f.role.intent,
        bodySha256: 'f'.repeat(64) })) })],
    ['role target', async f => rewriteRole(f, { ...f.role.intent, target: 'other_role' },
      { ...f.newBinding, approvedSha256: sha(canonical({ ...f.role.intent, target: 'other_role' })) })],
    ['role source', async f => rewriteRole(f, { ...f.role.intent, sourceUuid: 'other_uuid' },
      { ...f.newBinding, approvedSha256: sha(canonical({ ...f.role.intent, sourceUuid: 'other_uuid' })) })],
    ['role revision', async f => rewriteRole(f, { ...f.role.intent, revision: 8 },
      { ...f.newBinding, approvedSha256: sha(canonical({ ...f.role.intent, revision: 8 })) })],
    ['binding owner', async f => rewriteRole(f, f.role.intent,
      { ...f.newBinding, ownerId: createOwnerId })],
    ['binding invocation collision', async f => rewriteRole(f, f.role.intent,
      { ...f.newBinding, invocationId: originalInvocationId })],
    ['old binding', async f => {
      await chmod(f.paths.createBindingFile, 0o600);
      await writeFile(f.paths.createBindingFile,
        canonical({ ...f.oldBinding, invocationId: dispatchId }));
      await chmod(f.paths.createBindingFile, 0o400);
    }],
  ]) {
    await t.test(name, async child => {
      const f = await fixture(child);
      await change(f);
      await assert.rejects(transferWriterRoleApplyInputs(f.paths, opts));
      assert.deepEqual(await readdir(f.paths.volumeRoot), []);
    });
  }
});

test('coherent new role seal and binding are only self-consistent copied evidence', async t => {
  const f = await fixture(t);
  const changed = { ...f.role.intent, dispatchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ownerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
  const binding = { ...f.newBinding, dispatchId: changed.dispatchId,
    ownerId: changed.ownerId, approvedSha256: sha(canonical(changed)) };
  await rewriteRole(f, changed, binding);
  assert.equal((await transferWriterRoleApplyInputs(f.paths, opts)).approvedSha256,
    binding.approvedSha256);
  assert.equal((await openCopied(f)).readInput instanceof Function, true);
  // External operator approval of these new bytes is intentionally outside this reader.
});

test('source path, inventory, ownership mode, and public PEM drift reject', async t => {
  for (const [name, change] of [
    ['symlink', async f => {
      await rm(f.paths.bindingFile);
      await symlink(f.paths.intentFile, f.paths.bindingFile);
    }],
    ['hardlink', async f => {
      const other = path.join(f.root, 'outside-binding');
      await link(f.paths.bindingFile, other);
    }],
    ['wrong mode', async f => chmod(f.paths.intentFile, 0o600)],
    ['extra public', async f => writeFile(path.join(f.paths.publicRoot, 'extra.pem'), 'x')],
    ['changed public', async f => {
      const name = path.join(f.paths.publicRoot, f.rows[0].path);
      await chmod(name, 0o600); await writeFile(name, Buffer.alloc(200, 65));
      await chmod(name, 0o400);
    }],
    ['changed password', async f => {
      await chmod(f.paths.passwordFile, 0o600);
      await writeFile(f.paths.passwordFile, 'B'.repeat(42));
      await chmod(f.paths.passwordFile, 0o400);
    }],
  ]) {
    await t.test(name, async child => {
      const f = await fixture(child);
      await change(f);
      await assert.rejects(transferWriterRoleApplyInputs(f.paths, opts));
    });
  }
});

test('partial output and reached source replacement retain unusable volume', async t => {
  const f = await fixture(t);
  let reached = 0;
  await assert.rejects(transferWriterRoleApplyInputs(f.paths, { ...opts,
    beforeWrite: async relative => {
      reached++;
      if (relative === 'create-binding.json') throw Error('fixture fsync boundary');
    } }));
  assert.ok(reached >= 3);
  assert.ok((await readdir(f.paths.volumeRoot)).length > 0);
  await assert.rejects(transferWriterRoleApplyInputs(f.paths, opts));
  const g = await fixture(t);
  let replaced = false;
  await assert.rejects(transferWriterRoleApplyInputs(g.paths, { ...opts,
    beforeWrite: async () => {
      if (!replaced) {
        replaced = true;
        const old = path.join(g.root, 'old-intent');
        const bytes = await readFile(g.paths.intentFile);
        await rename(g.paths.intentFile, old);
        await writeFile(g.paths.intentFile, bytes, { mode: 0o400 });
      }
    } }));
  assert.equal(replaced, true);
  const h = await fixture(t);
  let beforeSyncReached = false;
  await assert.rejects(transferWriterRoleApplyInputs(h.paths, { ...opts,
    beforeSync: async relative => {
      if (relative === 'intent.json') {
        beforeSyncReached = true;
        throw Error('fixture write-before-fsync failure');
      }
    } }));
  assert.equal(beforeSyncReached, true);
  assert.ok((await readdir(h.paths.volumeRoot)).includes('intent.json'));
  await assert.rejects(transferWriterRoleApplyInputs(h.paths, opts));
});

test('copied reader pins original bytes and inodes across recheck', async t => {
  const f = await fixture(t);
  await transferWriterRoleApplyInputs(f.paths, opts);
  const copied = await openCopied(f);
  const name = path.join(f.paths.volumeRoot, 'binding.json');
  const before = await lstat(name);
  const bytes = await readFile(name);
  await rename(name, path.join(f.root, 'removed-binding'));
  await writeFile(name, bytes, { mode: 0o400 });
  assert.notEqual((await lstat(name)).ino, before.ino);
  assert.deepEqual((await readdir(f.paths.volumeRoot)).sort(),
    ['binding.json', 'create-binding.json', 'create-intent.json', 'intent.json',
      'public', 'transition.password']);
  await assert.rejects(copied.recheck());
  await assert.rejects(copied.readInput());
});

test('copied reader rejects altered public bytes and hidden destination leaf', async t => {
  const f = await fixture(t);
  await transferWriterRoleApplyInputs(f.paths, opts);
  const publicName = path.join(f.paths.volumeRoot, 'public', f.rows[0].path);
  await chmod(publicName, 0o600);
  await writeFile(publicName, Buffer.alloc(200, 65));
  await chmod(publicName, 0o400);
  await assert.rejects(openCopied(f));
  const g = await fixture(t);
  await transferWriterRoleApplyInputs(g.paths, opts);
  await writeFile(path.join(g.paths.volumeRoot, 'hidden'), 'x', { mode: 0o400 });
  await assert.rejects(openCopied(g));
});

test('exclusive-open destination file cannot be replaced by same approved bytes', async t => {
  const f = await fixture(t);
  let reached = false;
  await assert.rejects(transferWriterRoleApplyInputs(f.paths, { ...opts,
    beforeSync: async relative => {
      if (relative !== 'intent.json') return;
      reached = true;
      const name = path.join(f.paths.volumeRoot, relative);
      const original = await lstat(name), bytes = await readFile(name);
      await rename(name, path.join(f.root, 'moved-output-intent'));
      await writeFile(name, bytes, { mode: 0o400 });
      assert.notEqual((await lstat(name)).ino, original.ino);
    } }));
  assert.equal(reached, true);
  assert.equal((await readdir(f.paths.volumeRoot)).includes('moved-output-intent'), false);
  await assert.rejects(transferWriterRoleApplyInputs(f.paths, opts));
});

test('new public directory cannot be replaced by an exact empty tree', async t => {
  const f = await fixture(t);
  let reached = false;
  await assert.rejects(transferWriterRoleApplyInputs(f.paths, { ...opts,
    beforeSync: async relative => {
      if (relative !== 'intent.json') return;
      reached = true;
      const publicRoot = path.join(f.paths.volumeRoot, 'public');
      const original = await lstat(publicRoot);
      await rename(publicRoot, path.join(f.root, 'moved-output-public'));
      await mkdir(publicRoot, { mode: 0o700 });
      for (const row of f.rows) await mkdir(path.dirname(path.join(publicRoot, row.path)),
        { recursive: true, mode: 0o700 });
      assert.notEqual((await lstat(publicRoot)).ino, original.ino);
    } }));
  assert.equal(reached, true);
  assert.equal((await readdir(f.paths.volumeRoot)).includes('moved-output-public'), false);
  await assert.rejects(transferWriterRoleApplyInputs(f.paths, opts));
});
