import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writerRoleShapeLine, writerRoleAmbiguousLine } from './opensearch-writer-role-api-shape.mjs';

const target = `station_indexer_${'1'.repeat(32)}`;
const counts = { producer: 1, connection: 1 };
const envelope = (phase, body = { status: phase === 'first' ? 'CREATED' : 'OK',
  message: `'${target}' ${phase === 'first' ? 'created' : 'updated'}.` }) =>
  ({ body, statusCode: phase === 'first' ? 201 : 200, bytes: 55 });

test('retained lines have only finite phase, HTTP, schema, status, shape and counts', () => {
  for (const phase of ['first', 'update']) {
    const line = writerRoleShapeLine(phase, envelope(phase), target, counts);
    assert.match(line, new RegExp(`^Writer role API shape phase=${phase} ` +
      `http=${phase === 'first' ? 201 : 200} `));
    assert.ok(!line.includes(target));
    assert.equal(line.includes('schema=status-message'), true);
  }
  assert.equal(writerRoleAmbiguousLine(counts, true),
    'Writer role API shape phase=ambiguous original-return-lost observed-role=true producer=1 connection=1');
});

test('hostile or dynamic response fields never reach retained output', () => {
  let accessed = 0;
  const hostile = { status: 'CREATED', message: `'${target}' created.`,
    secret: 'private-secret-do-not-print' };
  assert.throws(() => writerRoleShapeLine('first', envelope('first', hostile), target, counts));
  const hidden = { status: 'CREATED', message: `'${target}' created.` };
  Object.defineProperty(hidden, 'secret', { enumerable: false,
    value: 'private-secret-do-not-print' });
  assert.throws(() => writerRoleShapeLine('first', envelope('first', hidden), target, counts));
  for (const body of [
    { status: 'CREATED', message: 'private-secret-do-not-print' },
    { status: 'OK', message: `'${target}' created.` },
    { status: 'CREATED', message: `'${target}' created. private-secret-do-not-print` },
  ]) assert.throws(() => writerRoleShapeLine('first', envelope('first', body), target, counts));
  for (const status of ['UPDATED', 'CREATED']) {
    assert.throws(() => writerRoleShapeLine('update',
      envelope('update', { status, message: `'${target}' updated.` }), target, counts));
  }
  const getter = { status: 'CREATED' };
  Object.defineProperty(getter, 'message', { enumerable: true,
    get: () => { accessed++; return 'private-secret-do-not-print'; } });
  assert.throws(() => writerRoleShapeLine('first', envelope('first', getter), target, counts));
  assert.equal(accessed, 0);
  const hiddenGetter = { status: 'CREATED', message: `'${target}' created.` };
  Object.defineProperty(hiddenGetter, 'secret', { enumerable: false,
    get: () => { accessed++; return 'private-secret-do-not-print'; } });
  assert.throws(() => writerRoleShapeLine('first', envelope('first', hiddenGetter), target, counts));
  assert.equal(accessed, 0);
  const envelopeGetter = {};
  Object.defineProperty(envelopeGetter, 'body', { enumerable: true,
    get: () => { accessed++; return hostile; } });
  assert.throws(() => writerRoleShapeLine('first', envelopeGetter, target, counts));
  assert.equal(accessed, 0);
  assert.throws(() => writerRoleShapeLine('first', envelope('first'), target,
    { producer: 2, connection: 1 }));
  assert.throws(() => writerRoleShapeLine('update',
    { ...envelope('update'), statusCode: 201 }, target, counts));
  assert.throws(() => writerRoleShapeLine('first',
    { ...envelope('first'), statusCode: 200 }, target, counts));
  assert.throws(() => writerRoleAmbiguousLine(counts, false));
});
