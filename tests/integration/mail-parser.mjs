import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { parseInChild, createMailParserServer } from '../../apps/worker/dist/mail-parser-service.js';
import { parseMail } from '../../apps/worker/dist/mail-parser-client.js';

const raw = Buffer.from([
  'From: =?UTF-8?B?Sm9yZGFu?= <jordan@example.com>',
  'Sender: relay@example.com',
  'To: alex@example.com',
  'Subject: =?UTF-8?B?Q2Fmw6k=?=',
  'Message-ID: <fixture@example.com>',
  'In-Reply-To: <earlier@example.com>',
  'References: <first@example.com> <earlier@example.com>',
  'Content-Type: multipart/mixed; boundary="outer"', '',
  '--outer', 'Content-Type: multipart/alternative; boundary="inner"', '',
  '--inner', 'Content-Type: text/plain; charset=iso-8859-1',
  'Content-Transfer-Encoding: quoted-printable', '', 'Caf=E9 reply',
  '--inner', 'Content-Type: text/html; charset=utf-8', '', '<b>Reply</b><script>bad()</script>',
  '--inner--', '--outer', 'Content-Type: image/png; name="../track.png"',
  'Content-ID: <inline@example.com>', 'Content-Disposition: inline; filename="../track.png"',
  'Content-Transfer-Encoding: base64', '', 'AQID', '--outer--', '',
].join('\r\n'));

const good = await parseInChild(raw);
assert.equal(good.ok, true, JSON.stringify(good));
assert.equal(good.mail.subject, 'Café');
assert.equal(good.mail.inReplyTo, '<earlier@example.com>');
assert.match(good.mail.text, /Café reply/);
assert.match(good.mail.untrustedHtml, /<script>/);
assert.deepEqual(good.mail.senderIdentities.map(({ address }) => address), ['jordan@example.com', 'relay@example.com']);
assert.equal(good.mail.attachments[0].filename, '../track.png');
assert.equal(good.mail.attachments[0].contentId, '<inline@example.com>');
assert.equal(good.mail.attachments[0].contentBase64, 'AQID');

const nested = Buffer.from('From: outer@example.com\r\nContent-Type: multipart/mixed; boundary="n"\r\n\r\n--n\r\nContent-Type: message/rfc822\r\n\r\nFrom: inner@example.com\r\nSubject: nested\r\n\r\ninner body\r\n--n--');
const nestedResult = await parseInChild(nested);
assert.equal(nestedResult.ok, true);
assert.match(nestedResult.mail.text, /inner body/);

const malformedName = Buffer.from('From: fixture@example.com\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="../../\\evil\u0000.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAQID');
const malformedResult = await parseInChild(malformedName);
assert.ok(malformedResult.ok || malformedResult.code === 'malformed');
if (malformedResult.ok) assert.equal(malformedResult.mail.attachments[0].contentBase64, 'AQID');

const tooManyParts = Buffer.from('Content-Type: multipart/mixed; boundary="x"\r\n\r\n' +
  Array.from({ length: 140 }, () => '--x\r\nContent-Type: text/plain\r\n\r\na\r\n').join('') + '--x--');
assert.deepEqual(await parseInChild(tooManyParts), { ok: false, code: 'limit_exceeded' });
const deep = Buffer.from('Content-Type: multipart/mixed; boundary="b0"\r\n\r\n' +
  Array.from({ length: 20 }, (_, level) => `--b${level}\r\nContent-Type: multipart/mixed; boundary="b${level + 1}"\r\n\r\n`).join('') +
  'deep\r\n' + Array.from({ length: 21 }, (_, level) => `--b${20 - level}--\r\n`).join(''));
assert.deepEqual(await parseInChild(deep), { ok: false, code: 'limit_exceeded' });
assert.deepEqual(await parseInChild(Buffer.from('Subject: ' + 'x'.repeat(70_000) + '\r\n\r\nx')), { ok: false, code: 'limit_exceeded' });
const aggregateHeaders = Buffer.from('Content-Type: multipart/mixed; boundary="h"\r\n\r\n' +
  Array.from({ length: 100 }, () => '--h\r\nX-Fixture: ' + 'a'.repeat(700) + '\r\n\r\na\r\n').join('') + '--h--');
assert.deepEqual(await parseInChild(aggregateHeaders), { ok: false, code: 'limit_exceeded' });
const manyRecipients = Buffer.from('From: source@example.com\r\nTo: ' +
  Array.from({ length: 110 }, (_, index) => `r${index}@example.com`).join(', ') + '\r\n\r\nbody');
assert.deepEqual(await parseInChild(manyRecipients), { ok: false, code: 'limit_exceeded' });
const attachmentPart = (content) => '--a\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="fixture.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + content + '\r\n';
const largeAttachment = Buffer.alloc(4_300_000, 7).toString('base64');
const aggregateAttachments = Buffer.from('From: fixture@example.com\r\nContent-Type: multipart/mixed; boundary="a"\r\n\r\n' +
  attachmentPart(largeAttachment) + attachmentPart(largeAttachment) + '--a--');
assert.deepEqual(await parseInChild(aggregateAttachments), { ok: false, code: 'limit_exceeded' });
const bodyOverflow = Buffer.from('From: fixture@example.com\r\nContent-Type: multipart/alternative; boundary="t"\r\n\r\n' +
  '--t\r\nContent-Type: text/plain\r\n\r\n' + 'a'.repeat(2_200_000) + '\r\n' +
  '--t\r\nContent-Type: text/html\r\n\r\n' + 'b'.repeat(2_200_000) + '\r\n--t--');
assert.deepEqual(await parseInChild(bodyOverflow), { ok: false, code: 'limit_exceeded' });
const badEncoding = Buffer.from('From: fixture@example.com\r\nContent-Transfer-Encoding: base64\r\n\r\n!!!!not-base64!!!!');
const encodingResult = await parseInChild(badEncoding);
assert.ok(encodingResult.ok || encodingResult.code === 'malformed');
assert.deepEqual(await parseInChild(raw, 1), { ok: false, code: 'timeout' });
assert.equal((await parseInChild(raw)).ok, true);

const server = createMailParserServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
try {
  const result = await fetch(`http://127.0.0.1:${port}/parse`, {
    method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: raw,
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).ok, true);
  const oversized = await fetch(`http://127.0.0.1:${port}/parse`, {
    method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: Buffer.alloc(12_582_913),
  }).catch(() => null);
  if (oversized) assert.equal(oversized.status, 413);
  const slow = request({ host: '127.0.0.1', port, path: '/parse', method: 'POST', headers: { 'Content-Type': 'message/rfc822' } });
  const slowStart = Date.now();
  const timeout = new Promise((resolve) => { slow.on('response', resolve); slow.on('error', resolve); });
  slow.write('Subject: slow\r\n');
  const timed = await timeout;
  assert.ok(Date.now() - slowStart >= 3_000 && Date.now() - slowStart < 5_000);
  if ('statusCode' in timed) assert.equal(timed.statusCode, 408);
  const afterTimeout = await fetch(`http://127.0.0.1:${port}/parse`, {
    method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: raw,
  });
  assert.equal((await afterTimeout.json()).ok, true);
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

const fixtureChildPath = new URL('../fixtures/mail-child.mjs', import.meta.url);
const makeFixtureChild = () => spawn(process.execPath, [fixtureChildPath.pathname], { stdio: ['pipe', 'pipe', 'ignore'] });
assert.deepEqual(await parseInChild(Buffer.from('bad'), 3_000, undefined, makeFixtureChild), { ok: false, code: 'malformed' });
let overflowClosed = false;
assert.deepEqual(await parseInChild(Buffer.from('overflow'), 3_000, undefined, () => {
  const child = makeFixtureChild();
  child.on('close', () => { overflowClosed = true; });
  return child;
}), { ok: false, code: 'limit_exceeded' });
assert.equal(overflowClosed, true);

let started = 0;
let closed = 0;
const runner = (input, timeoutMs, signal) => {
  if (input.toString() !== 'hang') return parseInChild(input, timeoutMs, signal);
  return parseInChild(input, timeoutMs, signal, () => {
    const child = makeFixtureChild();
    started++;
    child.on('close', () => closed++);
    return child;
  });
};
const lifecycleServer = createMailParserServer(runner);
await new Promise((resolve) => lifecycleServer.listen(0, '127.0.0.1', resolve));
const lifecyclePort = lifecycleServer.address().port;
const endpoint = `http://127.0.0.1:${lifecyclePort}/parse`;
const post = (body, signal) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body, signal });
const waitUntil = async (test) => {
  const deadline = Date.now() + 2_000;
  while (!test()) {
    assert.ok(Date.now() < deadline, 'lifecycle event did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
try {
  const first = new AbortController();
  const second = new AbortController();
  const hangingOne = post('hang', first.signal).catch(() => null);
  const hangingTwo = post('hang', second.signal).catch(() => null);
  await waitUntil(() => started === 2);
  const busy = await post(raw);
  assert.equal(busy.status, 429);
  assert.deepEqual(await busy.json(), { ok: false, code: 'busy' });
  first.abort();
  await hangingOne;
  await waitUntil(() => closed === 1);
  const recovered = await post(raw);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).ok, true);
  second.abort();
  await hangingTwo;
  await waitUntil(() => closed === 2);
  assert.equal((await (await post(raw)).json()).ok, true);
} finally { lifecycleServer.closeAllConnections(); await new Promise((resolve) => lifecycleServer.close(resolve)); }

const fakeFetch = (response, observed) => async (url) => {
  observed.push(url);
  return response;
};
const observed = [];
let cancelled = false;
const overHeader = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': '16777217' } });
assert.deepEqual(await parseMail(raw, fakeFetch(overHeader, observed)), { ok: false, code: 'limit_exceeded' });
assert.equal(cancelled, true);
let streamCancelled = false;
const overStream = new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(16_777_217)); },
  cancel() { streamCancelled = true; },
}));
assert.deepEqual(await parseMail(raw, fakeFetch(overStream, observed)), { ok: false, code: 'limit_exceeded' });
assert.equal(streamCancelled, true);
assert.deepEqual(await parseMail(raw, fakeFetch(new Response('{'), observed)), { ok: false, code: 'malformed' });
assert.deepEqual(await parseMail(raw, async () => { throw new Error('offline'); }), { ok: false, code: 'service_unavailable' });
assert.ok(observed.every((url) => url === 'http://mime-parser:8090/parse'));
console.log('Mail parser fixtures passed.');
