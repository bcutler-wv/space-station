import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { buildAttestorPublicFiles } from '../../scripts/search-attestor-pure.mjs';
import { runCreateIntentPrepareOwner } from '../../scripts/search-create-intent-owner-core.mjs';

const token = '11111111-1111-4111-8111-111111111111';
const index = `station-mail-v2-g${token.replaceAll('-', '')}`;
const candidate = { generationToken: token, physicalIndex: index,
  profileId: 'station-mail-v2', indexUuid: null, lifecycle: 'reserved',
  writerRole: `station_indexer_${token.replaceAll('-', '')}`,
  queryRole: `station_query_${token.replaceAll('-', '')}`,
  writerPrincipal: `station-search-indexer-${token.replaceAll('-', '')}`,
  queryPrincipal: `station-search-query-${token.replaceAll('-', '')}`,
  writerCertFingerprint: null, queryCertFingerprint: null };
const files = buildAttestorPublicFiles({ generations: [{ token: 'legacy-v1', presence: 'exact' }] });
const digests = files.map(row => ({ path: row.path, sha256: row.path === 'ca.pem' ?
  'a'.repeat(64) : row.path === 'v1/admin.pem' ? 'b'.repeat(64) : 'c'.repeat(64) }));
const projection = { version: 1, revision: 2, stage: 'disabled_intent',
  transitionToken: '22222222-2222-4222-8222-222222222222',
  sourceToken: 'legacy-v1', sourceIndex: 'station-mail-v1', sourceUuid: 'legacy_uuid',
  candidateToken: token, candidateIndex: index, databaseOid: 16384,
  priorObservationDigest: 'd'.repeat(64), publicFiles: files,
  ...searchGenerationDispatchSpec(candidate, 'create_index') };

async function fixture(fault) {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.join(process.cwd(), '.cache/results/intent-owner-'));
  await mkdir(path.join(repository, '.cache'), { mode: 0o755 });
  await mkdir(path.join(repository, '.cache/search-db'), { mode: 0o700 });
  const sent = [];
  let cleanupRan = false;
  let replaced = false;
  const adapterFactory = async () => ({
    verifyOwner: async () => {},
    captureOwner: async () => ({ project: 'fixture', databaseOid: '16384',
      systemIdentifier: '123', owner: 'station' }),
    recheckOwner: async () => {
      if (fault === 'pending-replaced-final-owner' && cleanupRan && !replaced) {
        replaced = true;
        const pending = path.join(repository, '.cache/search-create-intent/pending.json');
        await rename(pending, `${pending}.moved`);
        await copyFile(`${pending}.moved`, pending);
      }
    },
    recheckInfrastructure: async () => {},
    preflight: async () => {},
    volumeAbsent: async () => {},
    createVolume: async () => ({ name: 'fixture' }),
    checkVolume: async () => {},
    runPhase: async phase => {
      sent.push(phase);
      if (fault === `lost-${phase}`) throw new Error('private secret');
      return { phase, id: phase, ...(phase === 'prepare' ? { projection: {
        projection, adminPublic: { caSha256: fault === 'admin-mismatch' ? '0'.repeat(64) :
          'a'.repeat(64), adminSha256: 'b'.repeat(64) },
      } } : {}) };
    },
    cleanupRemote: async () => { cleanupRan = true; if (fault === 'cleanup') throw new Error('private secret'); },
  });
  const capturePublic = async () => ({ publicDigests: digests, recheck: async () => {
    if (fault === 'public-drift-cleanup' && cleanupRan) throw new Error('private secret');
    return true;
  } });
  return { repository, sent,
    run: () => runCreateIntentPrepareOwner({ repository, uid: process.getuid(),
      gid: process.getgid(), adapterFactory, capturePublic }),
    lock: path.join(repository, '.cache/search-db/.job-operation.lock'),
    pending: path.join(repository, '.cache/search-create-intent/pending.json'),
    dispose: () => rm(repository, { recursive: true, force: true }) };
}

test('one read-only owner prepare seals pending only after both confirmed phases and cleanup', async () => {
  const item = await fixture();
  try {
    const result = await item.run();
    assert.equal(result.state, 'prepared');
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(item.sent, ['transfer', 'prepare']);
    assert.equal(await lstat(item.lock).then(() => true, () => false), false);
    assert.equal((await lstat(item.pending)).mode & 0o777, 0o400);
    const pending = JSON.parse(await readFile(item.pending, 'utf8'));
    assert.equal(pending.project, 'fixture');
    assert.equal(pending.databaseOid, 16384);
    assert.notEqual(pending.dispatchId, pending.ownerId);
    assert.equal(JSON.stringify(pending).includes('secret'), false);
    await assert.rejects(item.run(), { message: 'Private create intent owner preparation failed.' });
    assert.deepEqual(item.sent, ['transfer', 'prepare']);
  } finally { await item.dispose(); }
});

test('uncertain prepare and cleanup retain global lock; cleanup ambiguity retains pending', async () => {
  for (const [fault, expected, hasPending] of [
    ['lost-transfer', ['transfer'], false],
    ['lost-prepare', ['transfer', 'prepare'], false],
    ['admin-mismatch', ['transfer', 'prepare'], false],
    ['cleanup', ['transfer', 'prepare'], true],
    ['public-drift-cleanup', ['transfer', 'prepare'], true],
    ['pending-replaced-final-owner', ['transfer', 'prepare'], true],
  ]) {
    const item = await fixture(fault);
    try {
      await assert.rejects(item.run(), { message: 'Private create intent owner preparation failed.' });
      assert.deepEqual(item.sent, expected);
      assert.equal(await lstat(item.lock).then(() => true, () => false), true);
      assert.equal(await lstat(item.pending).then(() => true, () => false), hasPending);
    } finally { await item.dispose(); }
  }
});
