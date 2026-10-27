import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { filteredDeliveryDiagnostics } from './search-attestor-delivery-diagnostic-filter.mjs';
import { AttestorOwnerDiagnosticError, capturedOwnerDiagnostic,
  ownerDiagnosticLine } from '../../scripts/search-attestor-owner-diagnostic.mjs';

const helper = fileURLToPath(new URL('./search-attestor-delivery-diagnostic-filter.mjs', import.meta.url));

test('failure output forwards only exact finite diagnostics, never a fake secret', async t => {
  await mkdir(path.resolve('.cache/results'), { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/results/attestor-diagnostic-filter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'private.log');
  const fakeSecret = 'FAKE_PRIVATE_SECRET_0123456789';
  const captured = 'Private search attestor owner operation failed; inspect private retained evidence.\n' +
    'Private search attestor owner diagnostic stage=transfer-run reason=wait-exit.\n';
  const body = [
    `Docker failed: ${fakeSecret}`,
    'Attestor delivery diagnostic lock-stage=prepare-dispatched.',
    'Attestor delivery diagnostic phase-1-count=1.',
    'Attestor delivery diagnostic phase-1-exit=137.',
    'Attestor delivery diagnostic phase-1-tmpfs-match=false.',
    'Attestor delivery diagnostic phase-2-cap-add-match=false.',
    'Attestor delivery diagnostic phase-2-host-mount-options-match=false.',
    'Attestor delivery diagnostic phase-2-network-id-match=false.',
    'Attestor delivery diagnostic phase-2-effective-mount-source-match=false.',
    'Attestor delivery diagnostic phase-2-volume-nocopy-match=false.',
    capturedOwnerDiagnostic(captured).trimEnd(),
    `Private search attestor owner diagnostic stage=transfer-run reason=${fakeSecret}.`,
    `Private search attestor owner diagnostic stage=${fakeSecret} reason=wait-exit.`,
    'Private search attestor owner diagnostic stage=transfer-run reason=arbitrary.',
    `Attestor delivery diagnostic lock-stage=${fakeSecret}.`,
    `Attestor delivery diagnostic scoped-config=valid.${fakeSecret}`,
    `Attestor delivery fixture failed at complete-cli.${fakeSecret}`,
    'Attestor delivery diagnostic arbitrary=true.',
    'Attestor delivery diagnostic phase-4-count=1.',
    'Attestor delivery fixture failed at complete-cli.',
  ].join('\n');
  await writeFile(log, body);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [helper, log], { encoding: 'utf8', env });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trimEnd().split('\n'), filteredDeliveryDiagnostics(body));
  assert.deepEqual(filteredDeliveryDiagnostics(body), [
    'Attestor delivery diagnostic lock-stage=prepare-dispatched.',
    'Attestor delivery diagnostic phase-1-count=1.',
    'Attestor delivery diagnostic phase-1-exit=137.',
    'Attestor delivery diagnostic phase-1-tmpfs-match=false.',
    'Attestor delivery diagnostic phase-2-cap-add-match=false.',
    'Attestor delivery diagnostic phase-2-host-mount-options-match=false.',
    'Attestor delivery diagnostic phase-2-network-id-match=false.',
    'Attestor delivery diagnostic phase-2-effective-mount-source-match=false.',
    'Attestor delivery diagnostic phase-2-volume-nocopy-match=false.',
    'Private search attestor owner diagnostic stage=transfer-run reason=wait-exit.',
    'Attestor delivery fixture failed at complete-cli.',
  ]);
  assert.equal(result.stdout.includes(fakeSecret), false);
  const forged = new AttestorOwnerDiagnosticError('transfer-run', 'wait-exit');
  forged.reason = fakeSecret;
  assert.equal(ownerDiagnosticLine(forged), '');
  assert.equal(ownerDiagnosticLine(new Error(fakeSecret)), '');
  assert.equal(capturedOwnerDiagnostic(captured),
    'Private search attestor owner diagnostic stage=transfer-run reason=wait-exit.\n');
  assert.deepEqual(filteredDeliveryDiagnostics(capturedOwnerDiagnostic(captured)),
    ['Private search attestor owner diagnostic stage=transfer-run reason=wait-exit.']);
  assert.equal(capturedOwnerDiagnostic(`${captured}${fakeSecret}\n`), '');
});
