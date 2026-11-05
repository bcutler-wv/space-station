import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { createApplyPrepareDiagnostic, createBoundaryRejectionDiagnostic,
  filteredCreateBoundaryDiagnostics, persistWriterRolePrepareSummary,
  writerPrecreateDiagnostic, writerRolePrepareSummary } from
  './search-create-boundary-delivery-diagnostic-filter.mjs';
import { writerDeliveryTrace, writerDeliveryShape, writerDeliveryMethodTracker } from
  './search-writer-role-delivery-diagnostic.mjs';
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
test('all four create-boundary rejection modes preserve their finite failing substep', () => {
  const steps = ['state-mode', 'snapshot', 'owner-command', 'owner-output',
    'owner-exit', 'owner-assert', 'state-unchanged', 'retained',
    'combined-evidence', 'cleanup', 'restore', 'restored-state', 'db', 'engine'];
  for (const mode of ['fresh', 'unintroduced', 'incomplete', 'wrong-uuid']) {
    let checkpoint = 'unrelated';
    const diagnostic = createBoundaryRejectionDiagnostic(mode, value => {
      checkpoint = value;
    });
    assert.equal(checkpoint, `${mode}-rejection`);
    for (const step of steps) {
      diagnostic.step(step);
      const safe = `Create boundary delivery fixture failed at ${mode}-rejection-${step}.`;
      assert.equal(checkpoint, `${mode}-rejection-${step}`);
      assert.deepEqual(filteredCreateBoundaryDiagnostics(`${safe}\n` +
        'Create boundary delivery fixture failed at incomplete-rejection-secret.\n' +
        `${safe}private-secret\n${safe}`), [safe]);
    }
    assert.throws(() => diagnostic.step('private-secret'));
    assert.equal(checkpoint, `${mode}-rejection-engine`);
    diagnostic.restore();
    assert.equal(checkpoint, `${mode}-rejection`);
  }
  assert.throws(() => createBoundaryRejectionDiagnostic('private-secret', () => {}));
  assert.throws(() => createBoundaryRejectionDiagnostic('incomplete', null));
  assert.deepEqual(filteredCreateBoundaryDiagnostics([
    'Create boundary delivery fixture failed at incomplete-rejection-owner-command.private-secret',
    'Create boundary delivery fixture failed at incomplete-rejection-owner-command-secret.',
    'Create boundary delivery fixture failed at incomplete-rejection-owner-command/.',
  ].join('\n')), []);
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
test('writer delivery failure forwards one finite case and step without hostile details', () => {
  const safe = 'Writer role delivery fixture case=held-timeout step=consumer-markers.';
  const hostile = 'private-secret-do-not-print';
  assert.deepEqual(filteredCreateBoundaryDiagnostics([
    hostile, safe, safe,
    `Writer role delivery fixture case=held-timeout step=${hostile}.`,
    `Writer role delivery fixture case=${hostile} step=owner.`,
    `Writer role delivery fixture case=held-timeout step=owner.${hostile}`,
  ].join('\n')), [safe]);
  assert.deepEqual(filteredCreateBoundaryDiagnostics(
    'Writer role delivery fixture case=positive step=owner.'),
  ['Writer role delivery fixture case=positive step=owner.']);
  assert.deepEqual(filteredCreateBoundaryDiagnostics(
    'Writer role preparation fixture failed at writer-delivery-prestart.'),
  ['Writer role preparation fixture failed at writer-delivery-prestart.']);
});
test('writer delivery trace and actual created shape are finite and duplicate-safe', () => {
  const trace = writerDeliveryTrace({ caseName: 'lost-return', method: 'run-apply',
    phase: 'apply', command: 'container-inspect', outcome: 'returned-zero',
    last: 'run-transfer', create: 2, inspect: 2, fence: 1, start: 1 });
  const transfer = writerDeliveryShape({ caseName: 'lost-return', phase: 'transfer',
    state: 'created', running: 'false', started: 'zero', finished: 'zero',
    network: 'none', stateFields: 'empty', networkFields: 'empty' });
  const apply = writerDeliveryShape({ caseName: 'lost-return', phase: 'apply',
    state: 'other', running: 'other', started: 'missing', finished: 'nonzero',
    network: 'other', stateFields: 'other', networkFields: 'nonempty' });
  const checkpoint = 'Writer role delivery fixture case=lost-return step=phase-registry.';
  assert.deepEqual(filteredCreateBoundaryDiagnostics([
    'private-secret-do-not-print', trace, transfer, apply, checkpoint,
    trace, transfer, apply, `${trace} private-secret-do-not-print`,
    trace.replace('create=2', 'create=3'),
    trace.replace('method=run-apply', 'method=secret'),
    apply.replace('network=other', 'network=private-secret'),
    `\u001b[31m${trace}`, 'x'.repeat(201),
  ].join('\n')), [trace, transfer, apply, checkpoint]);
  assert.throws(() => writerDeliveryTrace({ caseName: 'lost-return',
    method: 'run-apply', phase: 'apply', command: 'other', outcome: 'threw',
    last: 'none', create: 3, inspect: 0, fence: 0, start: 0 }));
  assert.match(writerDeliveryTrace({ caseName: 'lost-return', method: 'run-apply',
    phase: 'apply', command: 'container-start', outcome: 'returned-zero',
    last: 'fence-apply', create: 'many', inspect: 2, fence: 2, start: 2 }),
  /create=many/);
  let accessed = false;
  const hostile = { caseName: 'prestart', method: 'none', phase: 'owner',
    command: 'none', outcome: 'none', last: 'none', create: 0, inspect: 0,
    fence: 0, start: 0 };
  Object.defineProperty(hostile, 'method', { get() { accessed = true; return 'none'; } });
  assert.throws(() => writerDeliveryTrace(hostile));
  assert.equal(accessed, false);
});
test('writer delivery nested recheck preserves the post-fence phase failure boundary', async () => {
  const diagnostic = { method: 'none', last: 'none' };
  const run = writerDeliveryMethodTracker(diagnostic);
  const reached = [];
  await assert.rejects(run('run-apply', async () => {
    await run('fence-apply', async () => {
      await run('recheck-owner', async () => { reached.push('recheck-owner'); });
      assert.equal(diagnostic.method, 'fence-apply');
      await run('check-volume', async () => { reached.push('check-volume'); });
      assert.equal(diagnostic.method, 'fence-apply');
    });
    reached.push('post-fence');
    assert.equal(diagnostic.method, 'run-apply');
    throw Error('private post-fence failure');
  }), /private post-fence failure/);
  assert.deepEqual(reached, ['recheck-owner', 'check-volume', 'post-fence']);
  assert.equal(diagnostic.method, 'run-apply');
  assert.equal(diagnostic.last, 'fence-apply');
  await assert.rejects(run('run-transfer', async () => run('fence-transfer',
    async () => run('check-volume', async () => { throw Error('private fence failure'); }))));
  assert.equal(diagnostic.method, 'check-volume');
});
test('precreate diagnostic preserves the failing finite substep until successful restore', () => {
  let checkpoint = 'setup';
  const trace = [];
  const diagnostic = writerPrecreateDiagnostic(value => {
    checkpoint = value; trace.push(value);
  });
  diagnostic.step('registry-rows-command');
  diagnostic.step('registry-micro-shape');
  diagnostic.step('engine-observe');
  assert.equal(checkpoint, 'precreate-baseline-engine-observe');
  assert.deepEqual(filteredCreateBoundaryDiagnostics(
    `Writer role preparation fixture failed at ${checkpoint}.`),
  [`Writer role preparation fixture failed at ${checkpoint}.`]);
  assert.deepEqual(filteredCreateBoundaryDiagnostics([
    'Writer role preparation fixture failed at precreate-baseline-engine-observe.private-secret.',
    'Writer role preparation fixture failed at precreate-baseline-secret.',
    'Writer role preparation fixture failed at precreate-baseline-host-networks/',
  ].join('\n')), []);
  assert.throws(() => diagnostic.step('secret/private'));
  assert.equal(checkpoint, 'precreate-baseline-engine-observe');
  diagnostic.restore();
  assert.equal(checkpoint, 'precreate-baseline');
  assert.deepEqual(trace, ['precreate-baseline', 'precreate-baseline-registry-rows-command',
    'precreate-baseline-registry-micro-shape', 'precreate-baseline-engine-observe',
    'precreate-baseline']);
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
