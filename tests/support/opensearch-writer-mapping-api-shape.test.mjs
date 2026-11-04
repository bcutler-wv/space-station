import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writerMappingShapeLine, writerMappingExpectedShape,
  writerMappingAmbiguousLine } from
  './opensearch-writer-mapping-api-shape.mjs';

const target = `station_indexer_${'1'.repeat(32)}`;
const counts = { producer: 1, connection: 1 };
const envelope = (phase, body = { status: phase === 'first' ? 'CREATED' : 'OK',
  message: `'${target}' ${phase === 'first' ? 'created' : 'updated'}.` }) =>
  ({ body, statusCode: phase === 'first' ? 201 : 200, bytes: 60 });

test('finite first and replacement shape classes remain distinct from approval', () => {
  const first = writerMappingShapeLine('first', envelope('first'), target, counts);
  const replacement = writerMappingShapeLine('replacement', envelope('replacement'), target,
    counts);
  assert.equal(writerMappingExpectedShape('first', first), true);
  assert.equal(writerMappingExpectedShape('replacement', replacement), true);
  assert.equal(writerMappingExpectedShape('ambiguous-first',
    writerMappingShapeLine('ambiguous-first', envelope('first'), target, counts)), true);
  for (const line of [first, replacement]) assert.equal(line.includes(target), false);
  assert.equal(writerMappingAmbiguousLine(counts, true),
    'Writer mapping API shape phase=ambiguous original-return-lost observed-mapping=true producer=1 connection=1');
});

test('response oddities classify finitely or fail without touching accessors', () => {
  let touched = 0;
  const other = writerMappingShapeLine('first', envelope('first',
    { status: 'private-secret', message: 'private-secret' }), target, counts);
  assert.match(other, /status=other message=other/);
  assert.equal(other.includes('private-secret'), false);
  for (const body of [
    { status: 'CREATED', message: `'${target}' created.`, secret: 'private-secret' },
    { status: 'CREATED', message: `'${target}' created.`, nested: {} },
    ['CREATED'],
  ]) {
    const line = writerMappingShapeLine('first', envelope('first', body), target, counts);
    assert.equal(writerMappingExpectedShape('first', line), false);
    assert.equal(line.includes('private-secret'), false);
  }
  const hidden = { status: 'CREATED', message: `'${target}' created.` };
  Object.defineProperty(hidden, 'secret', { enumerable: false,
    value: 'private-secret' });
  const hiddenLine = writerMappingShapeLine('first', envelope('first', hidden),
    target, counts);
  assert.match(hiddenLine, /schema=accessor keys=3 status=other message=other/);
  assert.equal(writerMappingExpectedShape('first', hiddenLine), false);
  const getter = { status: 'CREATED' };
  Object.defineProperty(getter, 'message', { enumerable: true,
    get() { touched++; return 'private-secret'; } });
  const getterLine = writerMappingShapeLine('first', envelope('first', getter),
    target, counts);
  assert.match(getterLine, /schema=accessor keys=2 status=other message=other/);
  assert.equal(writerMappingExpectedShape('first', getterLine), false);
  const envelopeGetter = {};
  Object.defineProperty(envelopeGetter, 'body', { enumerable: true,
    get() { touched++; return 'private-secret'; } });
  assert.throws(() => writerMappingShapeLine('first', envelopeGetter, target, counts));
  assert.equal(touched, 0);
  const unknownHttp = writerMappingShapeLine('first',
    { ...envelope('first'), statusCode: 202 }, target, counts);
  assert.match(unknownHttp, /http=other schema=status-message/);
  assert.equal(writerMappingExpectedShape('first', unknownHttp), false);
  const unknownStatus = writerMappingShapeLine('first',
    envelope('first', { status: 'PRIVATE', message: `'${target}' created.` }),
    target, counts);
  assert.match(unknownStatus, /status=other message=quoted-target-created/);
  assert.equal(writerMappingExpectedShape('first', unknownStatus), false);
  assert.throws(() => writerMappingShapeLine('first', { ...envelope('first'),
    extra: 'private-secret' }, target, counts));
  assert.throws(() => writerMappingShapeLine('first', { ...envelope('first'),
    bytes: 32_769 }, target, counts));
  const malformed = writerMappingShapeLine('first', { ...envelope('first'),
    body: 'malformed' }, target, counts);
  assert.match(malformed, /schema=malformed keys=na status=other message=other/);
  assert.equal(writerMappingExpectedShape('first', malformed), false);
  assert.throws(() => writerMappingShapeLine('first', envelope('first'), target,
    { producer: 2, connection: 1 }));
  assert.throws(() => writerMappingAmbiguousLine(counts, false));
});
