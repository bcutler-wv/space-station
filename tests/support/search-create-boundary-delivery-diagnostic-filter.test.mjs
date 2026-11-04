import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { createApplyPrepareDiagnostic,
  filteredCreateBoundaryDiagnostics, persistWriterRolePrepareSummary,
  writerRolePrepareSummary } from
  './search-create-boundary-delivery-diagnostic-filter.mjs';
test('only fixed checkpoint and owner diagnostic reach public CI output', () => {
  const log = ['private-secret-do-not-print',
    'Create boundary delivery fixture failed at complete-cli.',
    'Private create boundary owner diagnostic stage=transfer-run reason=dispatch-stderr.',
    'Private create boundary owner diagnostic stage=secret reason=secret.',
    'Create boundary delivery fixture failed at private-secret-do-not-print.'].join('\n');
  assert.deepEqual(filteredCreateBoundaryDiagnostics(log), [
    'Create boundary delivery fixture failed at complete-cli.',
    'Private create boundary owner diagnostic stage=transfer-run reason=dispatch-stderr.']);
});
test('only fixed intent checkpoint is forwarded and fake secret suffix is discarded', () => {
  const secret = 'fixture-private-secret-do-not-print';
  const log = [secret,
    'Create intent prepare fixture failed at intent-pending-inode.',
    `Create intent prepare fixture failed at intent-cli.${secret}`,
    `Create intent prepare fixture failed at intent-${secret}.`].join('\n');
  assert.deepEqual(filteredCreateBoundaryDiagnostics(log),
    ['Create intent prepare fixture failed at intent-pending-inode.']);
});
test('fixed pending mutation checkpoints are forwarded without accepting arbitrary suffixes', () => {
  for (const checkpoint of ['intent-fixture-scratch', 'intent-pending-inode-mutation',
    'intent-pending-inode-retained', 'intent-pending-same-size-mutation']) {
    const line = `Create intent prepare fixture failed at ${checkpoint}.`;
    assert.deepEqual(filteredCreateBoundaryDiagnostics([line,
      'Create intent prepare fixture failed at intent-pending-inode-private-secret.'].join('\n')),
    [line]);
  }
});
test('expired certificate setup and owner stages remain finite and redacted', () => {
  for (const checkpoint of ['intent-expired-admin-request', 'intent-expired-admin-issue',
    'intent-expired-admin-profile', 'intent-expired-admin-expiry',
    'intent-expired-admin-public-retained', 'intent-expired-admin-restoration']) {
    const line = `Create intent prepare fixture failed at ${checkpoint}.`;
    assert.deepEqual(filteredCreateBoundaryDiagnostics([line,
      'Create intent prepare fixture failed at intent-expired-admin-private-secret.'].join('\n')),
    [line]);
  }
});
test('apply prepare keeps its explicit parent and precise failing step until success', () => {
  let checkpoint = 'unrelated';
  const trace = [];
  const diagnostic = createApplyPrepareDiagnostic('presend-public-inode', value => {
    checkpoint = value; trace.push(value);
  });
  diagnostic.step('db-snapshot');
  diagnostic.step('owner-run');
  diagnostic.step('owner-exit');
  assert.equal(checkpoint, 'presend-public-inode-prepare-owner-exit');
  assert.deepEqual(filteredCreateBoundaryDiagnostics(
    `Create apply runtime fixture failed at ${checkpoint}.`),
  [`Create apply runtime fixture failed at ${checkpoint}.`]);
  diagnostic.restore();
  assert.equal(checkpoint, 'presend-public-inode');
  assert.deepEqual(trace, ['presend-public-inode',
    'presend-public-inode-prepare-db-snapshot',
    'presend-public-inode-prepare-owner-run',
    'presend-public-inode-prepare-owner-exit', 'presend-public-inode']);
});
test('apply diagnostics reject dynamic case, step and hostile suffix', () => {
  assert.throws(() => createApplyPrepareDiagnostic('case-secret', () => {}));
  const diagnostic = createApplyPrepareDiagnostic('e0b-drift', () => {});
  assert.throws(() => diagnostic.step('private-secret'));
  const log = ['Create apply runtime fixture failed at e0b-drift-prepare-owner-run.',
    'Create apply runtime fixture failed at e0b-drift-prepare-owner-run.private-secret',
    'Create apply runtime fixture failed at case-secret-prepare-owner-run.',
    'Create apply runtime fixture failed at e0b-drift-prepare-private-secret.'].join('\n');
  assert.deepEqual(filteredCreateBoundaryDiagnostics(log),
    ['Create apply runtime fixture failed at e0b-drift-prepare-owner-run.']);
});
test('preexisting candidate substeps are finite and redact dynamic details', () => {
  for (const step of ['probe-create', 'engine', 'readiness', 'owner', 'evidence']) {
    const line = `Create apply runtime fixture failed at preexisting-candidate-${step}.`;
    assert.deepEqual(filteredCreateBoundaryDiagnostics(`${line}\n` +
      'Create apply runtime fixture failed at preexisting-candidate-private-secret.'), [line]);
  }
});
test('writer preparation diagnostics and retained summary are finite', () => {
  const safe = 'Writer role preparation summary variant=runner transfer=17 read=14 get=42 head=3 cleanup=4.';
  assert.equal(writerRolePrepareSummary(`secret\n${safe}\n`, 'runner'), `${safe}\n`);
  for (const line of [`${safe} secret`, safe.replace('42', 'private'),
    safe.replace('runner', 'default'), `${safe}\n${safe}`])
    assert.throws(() => writerRolePrepareSummary(line, 'runner'));
  const log = ['hostile-private-value',
    'Writer role preparation fixture failed at fault-mounted-e0b.',
    'Writer role preparation fixture failed at fault-mounted-e0b.private-secret',
    'Writer role preparation fixture failed at fault-private-secret.'].join('\n');
  assert.deepEqual(filteredCreateBoundaryDiagnostics(log),
    ['Writer role preparation fixture failed at fault-mounted-e0b.']);
});
test('writer summary survives explicit cleanup and EXIT cleanup without raw output', async t => {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache/results/writer-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privateLog = path.join(root, 'private.log');
  const summary = path.join(root, 'summary.txt');
  const line = 'Writer role preparation summary variant=runner transfer=2 read=3 get=4 head=5 cleanup=6.\n';
  await writeFile(privateLog, `private-secret-never-print\n${line}`);
  const command = 'set -euo pipefail\n' +
    'cleanup_pair() { "$NODE_BIN" "$FILTER" --writer-summary "$PRIVATE_LOG" "$SUMMARY" runner; }\n' +
    'trap cleanup_pair EXIT\ncleanup_pair\n';
  const result = spawnSync('bash', ['-c', command], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env,
      NODE_BIN: process.execPath,
      FILTER: path.join(process.cwd(), 'tests/support/search-create-boundary-delivery-diagnostic-filter.mjs'),
      PRIVATE_LOG: privateLog, SUMMARY: summary },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(await readFile(summary, 'utf8'), line);
  assert.equal((await stat(summary)).mode & 0o777, 0o600);
  const emit = spawnSync(process.execPath,
    ['tests/support/search-create-boundary-delivery-diagnostic-filter.mjs',
      '--writer-emit', summary, 'runner'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(emit.status, 0, emit.stderr);
  assert.equal(emit.stdout, line);
  assert.equal(emit.stderr, '');
  await writeFile(summary, `${line}private-secret-never-print\n`);
  await assert.rejects(persistWriterRolePrepareSummary(summary,
    await readFile(privateLog, 'utf8'), 'runner'));
  const hostile = spawnSync(process.execPath,
    ['tests/support/search-create-boundary-delivery-diagnostic-filter.mjs',
      '--writer-emit', summary, 'runner'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(hostile.status, 0);
  assert.equal(hostile.stdout, '');
  assert.equal(hostile.stderr, '');
});
