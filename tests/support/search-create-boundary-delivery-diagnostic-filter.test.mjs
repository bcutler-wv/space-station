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
