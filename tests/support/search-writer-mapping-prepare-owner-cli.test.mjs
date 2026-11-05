import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const script = path.resolve('scripts/search-writer-mapping-prepare-owner.mjs');
const line = 'Private writer mapping preparation owner failed.\n';
const validShape = ['a'.repeat(64), 'b'.repeat(64),
  '11111111-1111-4111-8111-111111111111',
  'station-search-indexer-11111111111141118111111111111111',
  'station-search-query-11111111111141118111111111111111',
  'c'.repeat(64), 'd'.repeat(64)];
const invoke = (args, env = {}) => spawnSync(process.execPath, [script, ...args], {
  env: { ...process.env, APP_UID: String(process.getuid()),
    APP_GID: String(process.getgid()), ...env }, encoding: 'utf8', timeout: 5000 });

test('fixed CLI refuses count, malformed approval and wrong host identity before I/O', () => {
  for (const args of [[], validShape.slice(0, 6), [...validShape, 'extra'],
    ['not-a-sha', ...validShape.slice(1)]]) {
    const result = invoke(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, line);
  }
  const wrong = invoke(validShape, { APP_UID: String(process.getuid() + 1) });
  assert.equal(wrong.status, 1);
  assert.equal(wrong.stdout, '');
  assert.equal(wrong.stderr, line);
});
