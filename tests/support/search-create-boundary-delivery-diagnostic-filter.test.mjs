import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filteredCreateBoundaryDiagnostics } from './search-create-boundary-delivery-diagnostic-filter.mjs';
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
