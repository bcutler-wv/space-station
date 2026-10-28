import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { runCreateBoundaryOwner } from '../../scripts/search-create-boundary-owner-core.mjs';
import { isCreateBoundaryDiagnosticLine, createBoundaryDiagnosticLine } from '../../scripts/search-create-boundary-owner-diagnostic.mjs';

async function fixture(fault) {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.join(process.cwd(), '.cache/results/create-owner-'));
  const cache = path.join(repository, '.cache');
  await mkdir(cache, { mode: 0o755 });
  await mkdir(path.join(cache, 'search-db'), { mode: 0o700 });
  const sent = [], actions = [];
  let invocationId, invocationRoot, ownerChecks = 0, infrastructureChecks = 0;
  const adapterFactory = async ({ invocationId: id }) => {
    invocationId = id;
    return {
      async verifyOwner() { actions.push('verify'); },
      async captureOwner() { return { project: 'fixture', databaseOid: '16384',
        systemIdentifier: '12345678901234567890', owner: 'station' }; },
      async recheckOwner() {
        ownerChecks++;
        if (fault === 'owner-drift' && ownerChecks === 2) throw Error('private injected secret');
      },
      async preflight(value) {
        invocationRoot = value.invocationRoot;
        if (fault === 'preflight') throw Error('private injected secret');
        if (fault === 'preflight-replacement') {
          await rename(invocationRoot, `${invocationRoot}-moved`);
          await mkdir(invocationRoot, { mode: 0o700 });
          throw Error('private injected secret');
        }
      },
      async volumeAbsent() { actions.push('absent'); },
      async recheckInfrastructure() {
        actions.push('infrastructure'); infrastructureChecks++;
        if (fault === 'infrastructure-drift' && infrastructureChecks === 1)
          throw Error('private injected secret');
      },
      async createVolume() {
        actions.push('volume-create');
        if (fault === 'lost-volume') throw Error('private injected secret');
        return { name: 'fixture-volume' };
      },
      async checkVolume() {},
      async runPhase(phase) {
        sent.push(phase);
        if (fault === `lost-${phase}`) throw Error('private injected secret');
        return { phase, id: phase };
      },
      async cleanupRemote() {
        actions.push('cleanup');
        if (fault === 'cleanup') throw Error('private injected secret');
      },
    };
  };
  return { repository, sent, actions,
    run: () => runCreateBoundaryOwner({ repository, uid: process.getuid(),
      gid: process.getgid(), adapterFactory }),
    lock: () => path.join(cache, 'search-db/.job-operation.lock'),
    marker: () => path.join(cache, 'search-create-invocations', invocationId, 'invocation'),
    root: () => invocationRoot,
    dispose: () => rm(repository, { recursive: true, force: true }) };
}

test('fixed two-phase owner sends once, retains unknowns and cleans only confirmed success', async () => {
  for (const [fault, expected, retained] of [
    [undefined, ['transfer', 'inspect'], false],
    ['preflight', [], false],
    ['preflight-replacement', [], true],
    ['lost-volume', [], true],
    ['lost-transfer', ['transfer'], true],
    ['infrastructure-drift', ['transfer'], true],
    ['owner-drift', ['transfer'], true],
    ['lost-inspect', ['transfer', 'inspect'], true],
    ['cleanup', ['transfer', 'inspect'], true],
  ]) {
    const item = await fixture(fault);
    try {
      if (fault) await assert.rejects(item.run(), error => {
        assert.equal(error.message, 'Private create boundary owner operation failed.');
        const line = createBoundaryDiagnosticLine(error);
        assert.equal(isCreateBoundaryDiagnosticLine(line.trim()), true);
        assert.equal(line.includes('secret'), false);
        return true;
      });
      else assert.equal((await item.run()).state, 'observed');
      assert.deepEqual(item.sent, expected, fault);
      assert.equal(await lstat(item.lock()).then(() => true, () => false), retained, fault);
      if (retained && fault !== 'preflight-replacement') {
        const marker = JSON.parse(await readFile(item.marker(), 'utf8'));
        assert.equal(marker.invocationId, path.basename(item.root()));
        assert.equal((await stat(item.marker())).mode & 0o777, 0o400);
      }
    } finally { await item.dispose(); }
  }
});

test('owner rejects noncanonical host identity before any send', async () => {
  const item = await fixture();
  try {
    const run = () => runCreateBoundaryOwner({ repository: item.repository,
      uid: process.getuid(), gid: process.getgid(), adapterFactory: async () => ({
        verifyOwner: async () => {},
        captureOwner: async () => ({ project: 'fixture', databaseOid: '01',
          systemIdentifier: '123', owner: 'station' }),
      }) });
    await assert.rejects(run(), { message: 'Private create boundary owner operation failed.' });
    assert.deepEqual(item.sent, []);
  } finally { await item.dispose(); }
});
