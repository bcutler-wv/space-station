import assert from 'node:assert/strict';
import test from 'node:test';
import { writerDeliveryCreateOutput, isWriterDeliveryCreateOutputLine } from
  './search-writer-role-create-output-diagnostic.mjs';
import { filteredCreateBoundaryDiagnostics } from
  './search-create-boundary-delivery-diagnostic-filter.mjs';

const name = 'fixed-project-search-writer-role-apply-transfer';
const reply = stderr => ({ code: 0, signal: null, stdout: '', stderr });
const format = (stderr, extra = {}) => writerDeliveryCreateOutput({
  caseName: 'lost-return', phase: 'transfer', response: reply(stderr),
  expectedName: name, ...extra });

test('finite source-derived two-space progress and exact line forwarding', () => {
  const line = format(` Container ${name}  Creating\n Container ${name}  Created\n`);
  assert.match(line, /kinds=cr,ed lead=one gap=two tail=zero/);
  assert.match(line, /eol=lf blank=zero/);
  assert.ok(isWriterDeliveryCreateOutputLine(line));
  const apply = format(` Container ${name}  Created\n`, { phase: 'apply' });
  assert.deepEqual(filteredCreateBoundaryDiagnostics(
    `private-sentinel\n${line}\n${line}\n${apply}\n${apply}\n` +
    `${line} private-sentinel\n`), [line, apply]);
  assert.match(format(''), /stderrbytes=zero lines=zero.*blank=zero kinds=none/);
});

test('whitespace, CR, ANSI, wrong names and warning remain finite and distinguishable', () => {
  const examples = [
    [` Container ${name} Created\n`, 'gap=one'],
    [` Container ${name}   Created\n`, 'gap=many'],
    [` Container ${name} Created \n`, 'tail=one'],
    [` Container ${name} Created\r\n`, 'eol=crlf'],
    [` Container ${name} Created\r`, 'eol=cr-only'],
    [`\u001b[31mContainer ${name} Created\n`, 'kinds=an'],
    [' Container other-name Created\n', 'kinds=wn'],
    ['WARN[0000] Found orphan containers ([private]) for this project.\n', 'kinds=or'],
    ['WARN[0000] unknown private warning\n', 'kinds=wa'],
  ];
  for (const [raw, expected] of examples) {
    const line = format(raw);
    assert.ok(line.includes(expected), expected);
    assert.ok(isWriterDeliveryCreateOutputLine(line));
    assert.equal(line.includes('private'), false);
    assert.equal(line.includes(name), false);
  }
});

test('longest bounded line, missing name, hostile fields and malformed forwarder are safe', () => {
  const longest = format(Array.from({ length: 4 },
    () => ` Container ${name}    Other\n`).join(''));
  assert.ok(longest.length <= 240);
  assert.ok(isWriterDeliveryCreateOutputLine(longest));
  const maxFields = 'Writer delivery create-output case=held-timeout phase=transfer ' +
    'expected=missing envelope=invalid stdout=nonempty stderrbytes=medium ' +
    'lines=many eol=no-final-lf blank=many kinds=co,co,co,co ' +
    'lead=mixed gap=mixed tail=mixed.';
  assert.ok(maxFields.length <= 240);
  assert.ok(isWriterDeliveryCreateOutputLine(maxFields));
  assert.deepEqual(filteredCreateBoundaryDiagnostics(`${maxFields}\n${maxFields}\n`),
    [maxFields]);
  const missing = format(` Container ${name}  Created\n`, { expectedName: null });
  assert.match(missing, /expected=missing.*kinds=wn/);
  assert.ok(isWriterDeliveryCreateOutputLine(missing));
  let accessed = false;
  const hostile = reply('x');
  Object.defineProperty(hostile, 'stderr', { get() { accessed = true; return 'secret'; } });
  assert.throws(() => format('x', { response: hostile }));
  assert.equal(accessed, false);
  assert.throws(() => format('x', { response: { ...reply('x'), extra: 'secret' } }));
  assert.deepEqual(filteredCreateBoundaryDiagnostics(
    `${longest}\n${longest} leaked-value\n\u001b[31m${longest}\n`), [longest]);
});
