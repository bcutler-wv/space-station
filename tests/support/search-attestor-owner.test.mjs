import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { makePreparedAttestorManifest } from '../../scripts/search-attestor-pure.mjs';
import { runAttestorOwner } from '../../scripts/search-attestor-owner-core.mjs';
import { ownerDiagnosticLine } from '../../scripts/search-attestor-owner-diagnostic.mjs';

const instant = new Date('2026-10-22T18:00:00.123Z');
const micro = '2026-10-22T18:00:00.123456Z';
const legacy = { generationToken: 'legacy-v1', physicalIndex: 'station-mail-v1',
  profileId: 'station-mail-v1', indexUuid: 'legacy_uuid', lifecycle: 'roles_attested',
  writerRole: null, queryRole: null, writerPrincipal: null, queryPrincipal: null,
  writerCertFingerprint: null, queryCertFingerprint: null, createdAt: instant };
const snapshot = { control: { singleton: 1, revision: 1, stage: 'disabled',
  transitionToken: null, sourceGenerationToken: 'legacy-v1', generationToken: null,
  physicalIndex: null, indexUuid: null, profileId: null,
  publicationEnabled: false, servingReady: false, updatedAt: instant },
  history: [legacy], dispatch: [],
  identity: { sessionUser: 'station_search_verifier', currentUser: 'station_search_verifier',
    database: 'station', databaseOid: 16384, databaseOwner: 'station' },
  exactTimestamps: { control: { singleton: 1, updatedAt: micro },
    history: [{ generationToken: 'legacy-v1', createdAt: micro }], dispatch: [] } };

async function write(file, bytes, mode) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function fixture(fault) {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.join(process.cwd(), '.cache/results/attestor-owner-'));
  const cache = path.join(repository, '.cache');
  await mkdir(cache, { mode: 0o700 });
  await mkdir(path.join(cache, 'search-db'), { mode: 0o700 });
  const sent = [], actions = [];
  let invocationId, localRoot, volumeName, ownerChecks = 0;
  const adapterFactory = async ({ invocationId: id }) => {
    invocationId = id;
    return {
      async verifyOwner() { actions.push('verify'); },
      async captureOwner() { return { project: 'fixture', databaseOid: '16384' }; },
      async recheckOwner() {
        ownerChecks++;
        if (fault === 'postflight-drift' && ownerChecks === 2) throw Error('injected');
      },
      async preflight(input) {
        localRoot = input.invocationRoot;
        volumeName = input.volumeName;
        if (fault === 'preflight') throw Error('injected');
        if (fault === 'preflight-replaced-artifact') {
          await rename(localRoot, `${localRoot}-moved`);
          await mkdir(localRoot, { mode: 0o700 });
          throw Error('injected');
        }
      },
      async runPhase(phase) {
        sent.push(phase);
        if (phase === 'prepare') {
          const manifest = makePreparedAttestorManifest(snapshot, invocationId);
          await write(path.join(localRoot, 'manifest/manifest.json'),
            `${JSON.stringify(manifest)}\n`, 0o600);
        }
        if (fault === `lost-${phase}`) throw Error('injected');
        if (fault === 'replaced-artifact' && phase === 'attestor') {
          await rename(localRoot, `${localRoot}-moved`);
          await mkdir(localRoot, { mode: 0o700 });
        }
        return { phase, id: phase };
      },
      async volumeAbsent() {
        if (fault === 'ambiguous-absence') throw Error('injected');
      },
      async createVolume() {
        actions.push('create-volume');
        if (fault === 'lost-volume-create') throw Error('injected');
        return { name: volumeName };
      },
      async checkVolume() {
        if (fault === 'ambiguous-post-create' || fault === 'replaced-volume' &&
            sent.includes('transfer')) throw Error('injected');
      },
      async cleanupRemote() {
        actions.push('cleanup');
        if (fault === 'outstanding-reference' || fault === 'cleanup-refusal')
          throw Error('injected');
      },
    };
  };
  const stage = async () => ({ root: path.join(cache, 'search-attestor-public', invocationId),
    async recheck() { actions.push('stage-recheck'); },
    async cleanup() { actions.push('stage-cleanup'); } });
  const run = () => runAttestorOwner({ repository, uid: process.getuid(),
    gid: process.getgid(), adapterFactory, stage });
  return { repository, sent, actions, run,
    lock: () => path.join(cache, 'search-db/.job-operation.lock'),
    invocation: () => path.join(cache, 'search-attestor-invocations', invocationId),
    dispose: () => rm(repository, { recursive: true, force: true }) };
}

test('fixed three-phase success and conservative uncertain outcomes', async () => {
  for (const [fault, expectedSent, retained] of [
    [undefined, ['prepare', 'transfer', 'attestor'], false],
    ['preflight', [], false],
    ['preflight-replaced-artifact', [], true],
    ['lost-prepare', ['prepare'], true],
    ['postflight-drift', ['prepare'], true],
    ['ambiguous-absence', ['prepare'], true],
    ['lost-volume-create', ['prepare'], true],
    ['ambiguous-post-create', ['prepare'], true],
    ['lost-transfer', ['prepare', 'transfer'], true],
    ['replaced-volume', ['prepare', 'transfer'], true],
    ['lost-attestor', ['prepare', 'transfer', 'attestor'], true],
    ['replaced-artifact', ['prepare', 'transfer', 'attestor'], true],
    ['outstanding-reference', ['prepare', 'transfer', 'attestor'], true],
    ['cleanup-refusal', ['prepare', 'transfer', 'attestor'], true],
  ]) {
    const item = await fixture(fault);
    try {
      if (fault) await assert.rejects(item.run(), { message: 'Private search attestor owner operation failed.' });
      else assert.equal((await item.run()).state, 'verified');
      assert.deepEqual(item.sent, expectedSent, fault);
      assert.equal(await lstat(item.lock()).then(() => true, () => false), retained, fault);
      if (!retained) assert.equal(await lstat(item.invocation()).then(() => true, () => false), false);
      if (retained) assert.ok((await readdir(path.dirname(item.lock()))).includes('.job-operation.lock'));
    } finally { await item.dispose(); }
  }
});

test('direct failure retains exact phase stage and suppresses injected message', async () => {
  const item = await fixture('lost-transfer');
  try {
    await assert.rejects(item.run(), error => {
      assert.equal(error.stage, 'transfer-run');
      assert.equal(error.reason, 'unknown');
      assert.equal(ownerDiagnosticLine(error),
        'Private search attestor owner diagnostic stage=transfer-run reason=unknown.\n');
      assert.equal(ownerDiagnosticLine(error).includes('injected'), false);
      return true;
    });
    assert.deepEqual(item.sent, ['prepare', 'transfer']);
  } finally { await item.dispose(); }
});
