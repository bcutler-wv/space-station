/* global structuredClone */
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm,
  symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy } from '../../packages/search/dist/opensearch-generation-policy.js';
import { OPENSEARCH_MAPPING } from '../../packages/search/dist/opensearch-compiler.js';
import { createV2IndexBody } from '../../packages/search/dist/opensearch-v2-profile.js';
import { prepareAttestor, runCombinedAttestor } from '../../scripts/search-attestor-command-core.mjs';
import { makePreparedAttestorManifest } from '../../scripts/search-attestor-pure.mjs';

const invocation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token = 'AB12CD34-0000-4000-8000-000000000001';
const suffix = token.replaceAll('-', '').toLowerCase();
const uuid = 'pinned_v2_uuid';
const at = () => new Date('2026-10-22T18:00:00.123Z');
const micro = '2026-10-22T18:00:00.123456Z';
const reject = async call => assert.rejects(call, { message: 'Private search attestor command failed.' });
const openssl = (...args) => execFileSync('openssl', args, { stdio: 'ignore', timeout: 15_000 });
const replaceReadOnly = async (path, bytes) => {
  await chmod(path, 0o600);
  try { await writeFile(path, bytes); } finally { await chmod(path, 0o400); }
};

test('dedicated attestor image has the reviewed OpenSSL package', () => {
  if (process.env.SEARCH_ATTESTOR_IMAGE_PROOF !== '1') return;
  assert.equal(execFileSync('dpkg-query', ['-W', '-f=${Version}', 'openssl'],
    { encoding: 'utf8', timeout: 5_000 }), '3.0.22-1~deb12u2');
  assert.equal(execFileSync('dpkg-query', ['-W', '-f=${Version}', 'libssl3'],
    { encoding: 'utf8', timeout: 5_000 }), '3.0.22-1~deb12u2');
  assert.match(execFileSync('/usr/bin/openssl', ['version'],
    { encoding: 'utf8', timeout: 5_000 }), /^OpenSSL 3\.0\.22\b/);
});

async function makeCertificates(root) {
  const keys = join(root, 'offline-keys');
  await mkdir(keys, { mode: 0o700 });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '5',
    '-subj', '/CN=station-search-ca', '-keyout', join(keys, 'ca.key'), '-out', join(keys, 'ca.pem'));
  const create = async (name, principal, usage = 'clientAuth',
    keyUsage = 'digitalSignature,keyEncipherment', extra = '') => {
    const ext = join(keys, `${name}.ext`);
    await writeFile(ext, `basicConstraints=CA:FALSE\nkeyUsage=${keyUsage}\nextendedKeyUsage=${usage}\n${extra}`, { mode: 0o600 });
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${principal}`,
      '-keyout', join(keys, `${name}.key`), '-out', join(keys, `${name}.csr`));
    openssl('x509', '-req', '-sha256', '-days', name.includes('v2') || name.includes('short') ? '2' : '5', '-in', join(keys, `${name}.csr`),
      '-CA', join(keys, 'ca.pem'), '-CAkey', join(keys, 'ca.key'), '-CAcreateserial',
      '-extfile', ext, '-out', join(keys, `${name}.pem`));
  };
  for (const [name, principal] of [
    ['admin', 'station-search-admin'], ['query', 'station-search-query'],
    ['indexer', 'station-search-indexer'],
    ['writer-v2', `station-search-indexer-${suffix}`],
    ['query-v2', `station-search-query-${suffix}`],
  ]) await create(name, principal);
  await create('writer-bad-usage', `station-search-indexer-${suffix}`, 'serverAuth');
  await create('writer-bad-ku', `station-search-indexer-${suffix}`, 'clientAuth', 'keyEncipherment');
  await create('writer-critical', `station-search-indexer-${suffix}`, 'clientAuth',
    'digitalSignature,keyEncipherment', '1.2.3.4=critical,DER:05:00\n');
  await create('query-short', 'station-search-query');
  const publicDir = join(root, 'public'), adminDir = join(root, 'admin');
  await mkdir(publicDir, { mode: 0o700 });
  await mkdir(join(publicDir, 'v1'), { mode: 0o700 });
  await mkdir(join(publicDir, 'generations'), { mode: 0o700 });
  await mkdir(join(publicDir, 'generations', suffix), { mode: 0o700 });
  await mkdir(adminDir, { mode: 0o700 });
  const copy = async (source, destination) => {
    await copyFile(join(keys, source), destination);
    await chmod(destination, destination.startsWith(publicDir) ? 0o400 : 0o600);
  };
  await copy('ca.pem', join(publicDir, 'ca.pem'));
  for (const name of ['admin', 'query', 'indexer'])
    await copy(`${name}.pem`, join(publicDir, 'v1', `${name}.pem`));
  await copy('writer-v2.pem', join(publicDir, 'generations', suffix, 'writer.pem'));
  await copy('query-v2.pem', join(publicDir, 'generations', suffix, 'query.pem'));
  await copy('ca.pem', join(adminDir, 'ca.pem'));
  await copy('admin.pem', join(adminDir, 'admin.pem'));
  return { publicDir, adminDir, keys, fingerprints: {
    writer: new X509Certificate(await readFile(join(keys, 'writer-v2.pem')))
      .fingerprint256.replaceAll(':', '').toLowerCase(),
    query: new X509Certificate(await readFile(join(keys, 'query-v2.pem')))
      .fingerprint256.replaceAll(':', '').toLowerCase(),
  } };
}

function snapshot(fingerprints) {
  const legacy = { generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1',
    profileId: 'station-mail-v1', indexUuid: 'legacy_uuid', lifecycle: 'roles_attested',
    writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
    writerCertFingerprint: null, queryCertFingerprint: null, createdAt: at() };
  const v2 = { generationToken: token, physicalIndex: `station-mail-v2-g${suffix}`,
    profileId: 'station-mail-v2', indexUuid: uuid, lifecycle: 'roles_attested',
    writerRole: `station_indexer_${suffix}`, queryRole: `station_query_${suffix}`,
    writerPrincipal: `station-search-indexer-${suffix}`,
    queryPrincipal: `station-search-query-${suffix}`,
    writerCertFingerprint: fingerprints.writer, queryCertFingerprint: fingerprints.query,
    createdAt: at() };
  const history = [legacy, v2];
  const dispatch = ['create_index', 'writer_role', 'writer_mapping', 'query_role', 'query_mapping']
    .map((operation, i) => ({ generationToken: token, operation,
      dispatchId: `11111111-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      ownerId: '22222222-0000-4000-8000-000000000001',
      ...searchGenerationDispatchSpec(v2, operation), state: 'response_confirmed', createdAt: at() }));
  const control = { singleton: 1, revision: 1, stage: 'roles_attested',
    transitionToken: '33333333-0000-4000-8000-000000000001',
    sourceGenerationToken: 'legacy-v1', generationToken: token,
    physicalIndex: v2.physicalIndex, indexUuid: uuid, profileId: 'station-mail-v2',
    publicationEnabled: false, servingReady: false, updatedAt: at() };
  return { control, history, dispatch,
    identity: { sessionUser: 'station_search_verifier', currentUser: 'station_search_verifier',
      database: 'station', databaseOid: 16384, databaseOwner: 'station' },
    exactTimestamps: { control: { singleton: 1, updatedAt: micro },
      history: history.map(row => ({ generationToken: row.generationToken, createdAt: micro })),
      dispatch: dispatch.map(row => ({ generationToken: row.generationToken,
        operation: row.operation, dispatchId: row.dispatchId, createdAt: micro })) } };
}

function observation(manifest) {
  const indexes = { 'station-mail-v1': { aliases: {}, mappings: OPENSEARCH_MAPPING,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0',
      max_result_window: '200', refresh_interval: '1s',
      mapping: { total_fields: { limit: '64' } }, replication: { type: 'DOCUMENT' },
      uuid: 'legacy_uuid', creation_date: '1760000000000', provided_name: 'station-mail-v1',
      version: { created: '13927900' } } } } };
  const body = createV2IndexBody(`station-mail-v2-g${suffix}`);
  indexes[`station-mail-v2-g${suffix}`] = { aliases: {}, mappings: body.mappings,
    settings: { index: { number_of_shards: '1', number_of_replicas: '0',
      max_result_window: '200', refresh_interval: '1s',
      mapping: { total_fields: { limit: '64' } }, replication: { type: 'DOCUMENT' },
      uuid, creation_date: '1760000000000', provided_name: `station-mail-v2-g${suffix}`,
      version: { created: '13927900' } } } };
  const policy = buildExpectedSecurityPolicy(manifest.expected);
  return { indexes, roles: policy.roles, mappings: policy.mappings };
}

test('fixed prepare and combined read-only path accepts complete and legacy evidence, rejects drift', async t => {
  const scratchRoot = process.env.SEARCH_ATTESTOR_TEST_SCRATCH === '/tmp'
    ? '/tmp' : resolve('.cache/results');
  if (scratchRoot !== '/tmp') await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, 'search-attestor-command-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const certs = await makeCertificates(root);
  const invokeDir = join(root, 'invocation');
  const manifestDir = join(root, 'manifest');
  await mkdir(invokeDir, { mode: 0o700 });
  await mkdir(manifestDir, { mode: 0o700 });
  const input = { uid: process.getuid(), gid: process.getgid(), invocationFile: join(invokeDir, 'invocation'),
    manifestFile: join(manifestDir, 'manifest.json'), publicDirectory: certs.publicDir,
    adminDirectory: certs.adminDir, stateDirectory: join(root, 'state') };
  await writeFile(input.invocationFile, `${invocation}\n`, { mode: 0o400 });
  let current = snapshot(certs.fingerprints);
  const prepared = makePreparedAttestorManifest(current, invocation);
  const observed = observation(prepared);
  let state = { phase: 'ready', kind: 'complete', indexUuid: 'legacy_uuid' };
  let observeCalls = 0, reads = 0;
  const deps = { readSnapshot: async () => { reads++; return structuredClone(current); },
    readState: async () => state, now: () => new Date(),
    adminOwnership: { uid: process.getuid(), gid: process.getgid(), directoryMode: 0o700, fileMode: 0o600 },
    scratchRoot,
    observe: async () => { observeCalls++; return structuredClone(observed); } };
  assert.equal(await prepareAttestor(input, deps), true);
  assert.equal((await lstat(input.manifestFile)).mode & 0o777, 0o600);
  assert.equal((await readdir(manifestDir)).join('|'), 'manifest.json');
  await reject(() => prepareAttestor(input, deps));
  assert.equal(await runCombinedAttestor(input, deps), true);
  assert.equal(reads, 4);
  assert.equal(observeCalls, 1);
  const ordinaryScratch = (await readdir(scratchRoot))
    .filter(name => name.startsWith('station-attestor-purpose-'));
  deps.purposeExec = async (_binary, _args, options) => {
    assert.equal(options.killSignal, 'SIGKILL');
    throw new Error('fake OpenSSL failure');
  };
  await reject(() => runCombinedAttestor(input, deps));
  assert.deepEqual((await readdir(scratchRoot))
    .filter(name => name.startsWith('station-attestor-purpose-')), ordinaryScratch);
  const movedScratch = join(root, 'moved-purpose-origin');
  let replacementScratch;
  deps.purposeExec = async (_binary, args, options) => {
    assert.equal(options.killSignal, 'SIGKILL');
    const leaf = args.find(value => typeof value === 'string' && value.endsWith('/leaf-0.pem'));
    assert.ok(leaf);
    replacementScratch = resolve(leaf, '..');
    await rename(replacementScratch, movedScratch);
    await mkdir(replacementScratch, { mode: 0o700 });
    await rename(join(movedScratch, 'leaf-0.pem'), join(replacementScratch, 'leaf-0.pem'));
    throw new Error('fake OpenSSL failure after parent replacement');
  };
  await reject(() => runCombinedAttestor(input, deps));
  assert.ok((await lstat(join(replacementScratch, 'leaf-0.pem'))).isFile());
  assert.ok((await readFile(join(replacementScratch, 'leaf-0.pem'))).length > 0);
  await rm(replacementScratch, { recursive: true });
  await rm(movedScratch, { recursive: true });
  delete deps.purposeExec;
  state = { phase: 'ready', kind: 'legacy' };
  assert.equal(await runCombinedAttestor(input, deps), true);
  for (const bad of [
    { phase: 'fresh', kind: 'unintroduced' }, { phase: 'ready', kind: 'incomplete' },
    { phase: 'ready', kind: 'unintroduced' },
    { phase: 'ready', kind: 'complete', indexUuid: 'wrong' },
  ]) { state = bad; await reject(() => runCombinedAttestor(input, deps)); }
  state = { phase: 'ready', kind: 'complete', indexUuid: 'legacy_uuid' };
  const originalManifest = await readFile(input.manifestFile);
  const changed = JSON.parse(originalManifest.toString('utf8'));
  changed.expected.generations[1].writerRole = 'changed';
  await writeFile(input.manifestFile, `${JSON.stringify(changed)}\n`);
  await reject(() => runCombinedAttestor(input, deps));
  await writeFile(input.manifestFile, '{malformed}\n');
  await reject(() => runCombinedAttestor(input, deps));
  await writeFile(input.manifestFile, originalManifest);
  await replaceReadOnly(input.invocationFile, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\n');
  await reject(() => runCombinedAttestor(input, deps));
  await replaceReadOnly(input.invocationFile, `${invocation}\n`);
  const target = join(certs.publicDir, 'generations', suffix, 'writer.pem');
  const originalCert = await readFile(target);
  await replaceReadOnly(target, await readFile(join(certs.keys, 'query-v2.pem')));
  await reject(() => runCombinedAttestor(input, deps));
  await replaceReadOnly(target, originalCert);
  await chmod(target, 0o644);
  await reject(() => runCombinedAttestor(input, deps));
  await chmod(target, 0o400);
  const extra = join(certs.publicDir, 'extra.pem');
  await writeFile(extra, originalCert, { mode: 0o600 });
  await reject(() => runCombinedAttestor(input, deps));
  await rm(extra);
  await rm(target);
  await reject(() => runCombinedAttestor(input, deps));
  execFileSync('mkfifo', [target], { stdio: 'ignore', timeout: 5_000 });
  await reject(() => runCombinedAttestor(input, deps));
  await rm(target);
  await symlink(join(certs.keys, 'writer-v2.pem'), target);
  await reject(() => runCombinedAttestor(input, deps));
  await rm(target);
  await copyFile(join(certs.keys, 'writer-v2.pem'), target);
  await chmod(target, 0o400);
  await reject(() => runCombinedAttestor({ ...input, uid: input.uid + 1 }, deps));
  const secondLink = join(root, 'second-link');
  await link(target, secondLink);
  await reject(() => runCombinedAttestor(input, deps));
  await rm(secondLink);
  for (const name of ['writer-bad-usage', 'writer-bad-ku', 'writer-critical']) {
    const badDir = join(root, `${name}-manifest`);
    await mkdir(badDir, { mode: 0o700 });
    const badInput = { ...input, manifestFile: join(badDir, 'manifest.json') };
    const badBytes = await readFile(join(certs.keys, `${name}.pem`));
    await replaceReadOnly(target, badBytes);
    current = snapshot(certs.fingerprints);
    current.history[1].writerCertFingerprint = new X509Certificate(badBytes)
      .fingerprint256.replaceAll(':', '').toLowerCase();
    await prepareAttestor(badInput, deps);
    await reject(() => runCombinedAttestor(badInput, deps));
  }
  current = snapshot(certs.fingerprints);
  await replaceReadOnly(target, originalCert);
  const v1Query = join(certs.publicDir, 'v1', 'query.pem');
  const originalV1Query = await readFile(v1Query);
  await replaceReadOnly(v1Query, await readFile(join(certs.keys, 'indexer.pem')));
  await reject(() => runCombinedAttestor(input, deps));
  await replaceReadOnly(v1Query, originalV1Query);
  const adminPem = join(certs.adminDir, 'admin.pem');
  const originalAdmin = await readFile(adminPem);
  await writeFile(adminPem, await readFile(join(certs.keys, 'query.pem')));
  await reject(() => runCombinedAttestor(input, deps));
  await writeFile(adminPem, originalAdmin);
  const caPem = join(certs.publicDir, 'ca.pem');
  const originalCa = await readFile(caPem);
  await replaceReadOnly(caPem, await readFile(join(certs.keys, 'query.pem')));
  await reject(() => runCombinedAttestor(input, deps));
  await replaceReadOnly(caPem, originalCa);
  deps.now = () => new Date(Date.now() + 3 * 86_400_000);
  await reject(() => runCombinedAttestor(input, deps));
  deps.now = () => new Date();
  let clock = new Date();
  deps.now = () => clock;
  deps.observe = async () => { clock = new Date(Date.now() + 3 * 86_400_000);
    return structuredClone(observed); };
  await reject(() => runCombinedAttestor(input, deps));
  await replaceReadOnly(v1Query, await readFile(join(certs.keys, 'query-short.pem')));
  clock = new Date();
  await reject(() => runCombinedAttestor(input, deps));
  await replaceReadOnly(v1Query, originalV1Query);
  clock = new Date();
  deps.observe = async () => { clock = new Date(Date.now() + 6 * 86_400_000);
    return structuredClone(observed); };
  await reject(() => runCombinedAttestor(input, deps));
  deps.now = () => new Date();
  deps.observe = async () => structuredClone(observed);
  assert.equal(await runCombinedAttestor(input, deps), true);
  const initial = structuredClone(current);
  for (const change of [
    row => { row.exactTimestamps.control.updatedAt = '2026-10-22T18:00:00.123457Z'; },
    row => { row.exactTimestamps.history[0].createdAt = '2026-10-22T18:00:00.123457Z'; },
    row => { row.exactTimestamps.dispatch[0].createdAt = '2026-10-22T18:00:00.123457Z'; },
  ]) {
    current = structuredClone(initial);
    deps.observe = async () => { change(current); return structuredClone(observed); };
    await reject(() => runCombinedAttestor(input, deps));
  }
  current = initial;
  deps.observe = async () => { await replaceReadOnly(v1Query, await readFile(join(certs.keys, 'indexer.pem')));
    return structuredClone(observed); };
  await reject(() => runCombinedAttestor(input, deps));
  await replaceReadOnly(v1Query, originalV1Query);
  const originalInvocation = join(root, 'original-invocation');
  deps.observe = async () => {
    await rename(input.invocationFile, originalInvocation);
    await writeFile(input.invocationFile, `${invocation}\n`, { mode: 0o400 });
    return structuredClone(observed);
  };
  await reject(() => runCombinedAttestor(input, deps));
  await rm(input.invocationFile);
  await rename(originalInvocation, input.invocationFile);
  const originalPrepared = join(root, 'original-manifest');
  deps.observe = async () => {
    await rename(input.manifestFile, originalPrepared);
    await writeFile(input.manifestFile, originalManifest, { mode: 0o600 });
    return structuredClone(observed);
  };
  await reject(() => runCombinedAttestor(input, deps));
  await rm(input.manifestFile);
  await rename(originalPrepared, input.manifestFile);
  deps.observe = async () => { state = { phase: 'ready', kind: 'incomplete' };
    return structuredClone(observed); };
  await reject(() => runCombinedAttestor(input, deps));
  state = { phase: 'ready', kind: 'complete', indexUuid: 'legacy_uuid' };
  const drift = structuredClone(initial);
  deps.observe = async () => { current = drift; current.control.revision++; return structuredClone(observed); };
  await reject(() => runCombinedAttestor(input, deps));
  current = initial;
  deps.observe = async () => ({ ...structuredClone(observed), indexes: {} });
  await reject(() => runCombinedAttestor(input, deps));
  deps.observe = async () => { throw new Error('fake observer denial'); };
  await reject(() => runCombinedAttestor(input, deps));
});
