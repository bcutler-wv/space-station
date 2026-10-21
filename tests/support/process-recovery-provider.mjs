import { createServer } from 'node:http';
import console from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const PostalMime = require('postal-mime');

const messages = new Map([
  ['a', { threadId: 'ta', labels: ['INBOX', 'WORK'], historyId: '11' }],
  ['b', { threadId: 'tb', labels: ['INBOX'], historyId: '12' }],
  ['c', { threadId: 'tc', labels: ['INBOX'], historyId: '15' }],
]);
const observations = { calls: [], sent: [], holds: [] };
let hold = null;
let historyEnabled = false;
const send = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};
const body = async (request) => {
  const parts = [];
  for await (const part of request) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/fixture/state') return send(response, 200, { ...observations, historyEnabled });
    if (url.pathname === '/fixture/hold' && request.method === 'POST') {
      hold = await body(request);
      return send(response, 200, { ok: true });
    }
    if (url.pathname === '/fixture/history' && request.method === 'POST') {
      historyEnabled = true;
      return send(response, 200, { ok: true });
    }
    if (url.pathname === '/fixture/release' && request.method === 'POST') {
      const pending = hold;
      hold = null;
      pending?.release?.();
      return send(response, 200, { ok: true });
    }
    const path = url.pathname;
    observations.calls.push({ path, query: url.search, at: Date.now(), method: request.method });
    if (path === '/gmail/v1/users/me/profile') return send(response, 200, { emailAddress: 'owner@example.com', historyId: '10' });
    if (path === '/gmail/v1/users/me/labels' && hold?.path === path) {
      observations.holds.push({ path, at: Date.now() });
      await new Promise((resolve) => { hold.release = resolve; });
    }
    if (path === '/gmail/v1/users/me/labels') return send(response, 200, { labels: [
      { id: 'INBOX', name: 'Inbox', type: 'system' }, { id: 'SENT', name: 'Sent', type: 'system' },
      { id: 'WORK', name: 'Work', type: 'user' }, { id: 'EMPTY', name: 'Empty', type: 'user' },
    ] });
    if (path === '/gmail/v1/users/me/messages' && request.method === 'GET') {
      if (url.searchParams.get('labelIds') === 'SENT') return send(response, 200, { messages: observations.sent.map((sent) => ({ id: sent.id, threadId: sent.threadId })) });
      return send(response, 200, { messages: [{ id: 'a', threadId: 'ta' }, { id: 'b', threadId: 'tb' }] });
    }
    if (path === '/gmail/v1/users/me/history') {
      if (!historyEnabled) return send(response, 200, { history: [], historyId: '10' });
      if (!url.searchParams.has('pageToken')) return send(response, 200, { history: [{ id: '15', messagesAdded: [{ message: { id: 'c', threadId: 'tc' } }] }], nextPageToken: 'tail', historyId: '20' });
      return send(response, 200, { history: [{ id: '19', labelsRemoved: [{ message: { id: 'a', threadId: 'ta' }, labelIds: ['INBOX'] }] }], historyId: '20' });
    }
    const get = /^\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]+)$/.exec(path);
    if (get && request.method === 'GET') {
      const sent = observations.sent.find((entry) => entry.id === get[1]);
      if (sent) return send(response, 200, { id: sent.id, threadId: sent.threadId, labelIds: ['SENT'], payload: { headers: sent.headers } });
      const message = messages.get(get[1]);
      if (!message) return send(response, 404, { error: { code: 404 } });
      if (hold?.path === path && hold?.format === url.searchParams.get('format')) {
        observations.holds.push({ path, format: hold.format, at: Date.now() });
        await new Promise((resolve) => { hold.release = resolve; });
      }
      const labels = get[1] === 'a' && historyEnabled ? ['WORK'] : message.labels;
      const base = { id: get[1], threadId: message.threadId, historyId: message.historyId,
        labelIds: labels, internalDate: String(Date.now() - 60_000) };
      if (url.searchParams.get('format') === 'raw') {
        const raw = `From: Example Sender <sender@example.com>\r\nTo: owner@example.com\r\nSubject: Example ${get[1]}\r\nMessage-ID: <${get[1]}@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nExample ${get[1]}`;
        return send(response, 200, { ...base, raw: Buffer.from(raw).toString('base64url') });
      }
      return send(response, 200, base);
    }
    if (path === '/gmail/v1/users/me/messages/send' && request.method === 'POST') {
      const payload = await body(request);
      const mime = Buffer.from(payload.raw, 'base64url');
      const parsed = await new PostalMime().parse(mime);
      const messageId = parsed.messageId;
      const headers = [
        { name: 'Message-ID', value: messageId }, { name: 'From', value: parsed.from?.address ?? '' },
        { name: 'To', value: parsed.to?.map((entry) => entry.address).join(', ') ?? '' },
        { name: 'Cc', value: parsed.cc?.map((entry) => entry.address).join(', ') ?? '' },
        { name: 'Bcc', value: parsed.bcc?.map((entry) => entry.address).join(', ') ?? '' },
      ];
      const sent = { id: `sent_${observations.sent.length + 1}`, threadId: 'tsent', messageId, headers,
        bytes: mime.length };
      observations.sent.push(sent);
      if (hold?.path === path) {
        observations.holds.push({ path, at: Date.now() });
        await new Promise((resolve) => { hold.release = resolve; });
      }
      return send(response, 200, { id: sent.id, threadId: sent.threadId });
    }
    return send(response, 404, { error: { code: 404 } });
  } catch (error) {
    console.error('Provider fixture request failed', error);
    send(response, 500, { error: { code: 500 } });
  }
});
server.listen(Number(process.env.FIXTURE_PROVIDER_PORT), '127.0.0.1', () => console.log('provider ready'));
