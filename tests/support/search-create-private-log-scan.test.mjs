import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { captureCreatePrivateMarkers, scanCreatePrivateLog } from
  './search-create-private-log-scan.mjs';

test('private scan covers teardown output, partial setup and generated secrets', async t => {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache/results/private-log-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'gate.log');
  await writeFile(log, 'safe setup\nsafe teardown\n');
  assert.equal(await scanCreatePrivateLog(root, log), true);
  await mkdir(path.join(root, '.cache/search-db/initial-v1'), { recursive: true });
  await mkdir(path.join(root, '.cache/search-security'), { recursive: true });
  await writeFile(path.join(root, '.env'),
    'POSTGRES_PASSWORD=generated-secret-password\nSTATION_MASTER_KEY=generated-master-key-value\n');
  await writeFile(path.join(root, '.cache/search-db/initial-v1/transition.password'),
    'generated-transition-password-value');
  await writeFile(path.join(root, '.cache/search-security/ca.key'),
    `-----BEGIN PRIVATE KEY-----\n${'q'.repeat(80)}\n-----END PRIVATE KEY-----\n`);
  assert.equal(await scanCreatePrivateLog(root, log), true);
  for (const marker of ['generated-secret-password', 'generated-transition-password-value',
    'q'.repeat(32)]) {
    await writeFile(log, `safe setup\nsafe teardown\n${marker}\n`);
    await assert.rejects(scanCreatePrivateLog(root, log));
  }
  await writeFile(log, 'safe teardown\n');
  assert.equal(await scanCreatePrivateLog(root, log), true);
  const captured = await captureCreatePrivateMarkers(root);
  await writeFile(log, `safe setup\nsafe teardown\n${captured[0]}\n`);
  await rm(path.join(root, '.env'));
  await assert.rejects(scanCreatePrivateLog(root, log, captured));
  await writeFile(log, 'safe teardown\n');
  assert.equal(await scanCreatePrivateLog(root, log, captured), true);
  const markerFile = path.join(root, 'captured.json');
  await writeFile(markerFile, JSON.stringify(captured), { mode: 0o600 });
  const afterTeardown = () => spawnSync('bash', ['-c',
    'source tests/support/search-create-private-log-scan.sh; ' +
    'scan_create_private_log_after_teardown "$PWD" "$MARKER_FILE" "$PRIVATE_LOG" no'],
  { cwd: process.cwd(), env: { ...process.env, MARKER_FILE: markerFile,
    PRIVATE_LOG: log }, encoding: 'utf8' });
  await writeFile(log, `safe teardown\n${captured[0]}\n`);
  assert.notEqual(afterTeardown().status, 0);
  await writeFile(log, 'safe teardown\n');
  const scanned = afterTeardown();
  assert.equal(scanned.status, 0);
  assert.equal(scanned.stdout, 'Private create delivery log scan passed.\n');
});
