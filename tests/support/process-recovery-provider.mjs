import { createServer } from 'node:http';
import console from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { URLSearchParams } from 'node:url';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const PostalMime = require('postal-mime');

const messages = new Map([
  ['a', { threadId: 'ta', labels: ['INBOX', 'WORK'], historyId: '11' }],
  ['b', { threadId: 'tb', labels: ['INBOX'], historyId: '12' }],
  ['c', { threadId: 'tc', labels: ['INBOX'], historyId: '15' }],
]);
const observations = { calls: [], sent: [], holds: [], modifications: [], oauth: [] };
let hold = null;
let historyEnabled = false;
let latestHistory = 20;
const actionHistory = [];
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
    if (url.pathname === '/fixture/oauth' && request.method === 'POST') {
      const input = await body(request);
      const target = new URL(input.url);
      if (target.pathname === '/token') {
        const code = new URLSearchParams(input.data).get('code');
        observations.oauth.push({ kind: 'token' });
        return send(response, 200, { access_token: `fixture-access-${code}`, refresh_token: `fixture-refresh-${code}`,
          scope: 'https://www.googleapis.com/auth/gmail.modify', token_type: 'Bearer', expires_in: 3600 });
      }
      if (target.pathname === '/gmail/v1/users/me/profile') {
        observations.oauth.push({ kind: 'profile' });
        return send(response, 200, { emailAddress: 'owner@example.com' });
      }
      return send(response, 404, { error: 'Unknown OAuth fixture request' });
    }
    if (url.pathname === '/fixture/hold' && request.method === 'POST') {
      hold = await body(request);
      return send(response, 200, { ok: true });
    }
    if (url.pathname === '/fixture/history' && request.method === 'POST') {
      historyEnabled = true;
      messages.get('a').labels = process.env.FIXTURE_BROWSER_DATA === '1' ? ['WORK', 'UNREAD'] : ['WORK'];
      return send(response, 200, { ok: true });
    }
    if (url.pathname === '/fixture/release' && request.method === 'POST') {
      const pending = hold;
      hold = null;
      pending?.release?.();
      return send(response, 200, { ok: true });
    }
    const path = url.pathname;
    observations.calls.push({ path, query: url.search, at: Date.now(), elapsedMs: Math.round(performance.now()), method: request.method });
    if (path === '/gmail/v1/users/me/profile') return send(response, 200, { emailAddress: 'owner@example.com', historyId: '10' });
    if (path === '/gmail/v1/users/me/labels' && hold?.path === path) {
      observations.holds.push({ path, at: Date.now() });
      await new Promise((resolve) => { hold.release = resolve; });
    }
    if (path === '/gmail/v1/users/me/labels') return send(response, 200, { labels: [
      { id: 'INBOX', name: 'Inbox', type: 'system' }, { id: 'SENT', name: 'Sent', type: 'system' },
      { id: 'UNREAD', name: 'Unread', type: 'system' }, { id: 'DRAFT', name: 'Draft', type: 'system' },
      { id: 'WORK', name: 'Work', type: 'user' }, { id: 'EMPTY', name: 'Empty', type: 'user' },
    ] });
    const getLabel = /^\/gmail\/v1\/users\/me\/labels\/([A-Za-z0-9_-]+)$/.exec(path);
    if (getLabel && request.method === 'GET') {
      if (getLabel[1] === 'WORK' || getLabel[1] === 'EMPTY') return send(response, 200, { id: getLabel[1], type: 'user' });
      return send(response, 404, { error: { code: 404 } });
    }
    if (path === '/gmail/v1/users/me/messages' && request.method === 'GET') {
      if (url.searchParams.get('labelIds') === 'SENT') return send(response, 200, { messages: observations.sent.map((sent) => ({ id: sent.id, threadId: sent.threadId })) });
      return send(response, 200, { messages: [{ id: 'a', threadId: 'ta' }, { id: 'b', threadId: 'tb' }] });
    }
    if (path === '/gmail/v1/users/me/history') {
      if (!historyEnabled) return send(response, 200, { history: [], historyId: '10' });
      const start = Number(url.searchParams.get('startHistoryId'));
      if (start >= 20) return send(response, 200, {
        history: actionHistory.filter((entry) => Number(entry.id) > start), historyId: String(latestHistory),
      });
      if (!url.searchParams.has('pageToken')) return send(response, 200, { history: [{ id: '15', messagesAdded: [{ message: { id: 'c', threadId: 'tc' } }] }], nextPageToken: 'tail', historyId: '20' });
      return send(response, 200, { history: [{ id: '19', labelsRemoved: [{ message: { id: 'a', threadId: 'ta' }, labelIds: ['INBOX'] }] }], historyId: String(latestHistory) });
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
      const labels = message.labels;
      const base = { id: get[1], threadId: message.threadId, historyId: message.historyId,
        labelIds: labels, internalDate: String(Date.now() - 60_000) };
      if (url.searchParams.get('format') === 'metadata') return send(response, 200, { ...base,
        payload: { headers: [
          { name: 'Message-ID', value: `<${get[1]}@example.com>` },
          { name: 'From', value: 'Example Sender <sender@example.com>' },
        ] },
      });
      if (url.searchParams.get('format') === 'raw') {
        const raw = get[1] === 'a' && process.env.FIXTURE_BROWSER_DATA === '1'
          ? `From: Example Sender <sender@example.com>\r\nTo: owner@example.com\r\nSubject: Example a\r\nMessage-ID: <a@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: multipart/alternative; boundary="inner"\r\n\r\n--inner\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSafe plain example.\r\n--inner\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Safe example</p><script>window.__mailAttack = true</script><img src="https://images.example.com/track.png" alt="Remote image">\r\n--inner--\r\n--outer\r\nContent-Type: text/plain; name="example.txt"\r\nContent-Disposition: attachment; filename="example.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nRXhhbXBsZSBhdHRhY2htZW50\r\n--outer--\r\n`
          : `From: Example Sender <sender@example.com>\r\nTo: owner@example.com\r\nSubject: Example ${get[1]}\r\n${get[1] === 'c' && process.env.FIXTURE_BROWSER_DATA === '1' ? '' : `Message-ID: <${get[1]}@example.com>\r\n`}Content-Type: text/plain; charset=utf-8\r\n\r\nExample ${get[1]}`;
        return send(response, 200, { ...base, raw: Buffer.from(raw).toString('base64url') });
      }
      return send(response, 200, base);
    }
    const modify = /^\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]+)\/modify$/.exec(path);
    if (modify && request.method === 'POST') {
      const message = messages.get(modify[1]);
      if (!message) return send(response, 404, { error: { code: 404 } });
      const input = await body(request);
      const labels = new Set(message.labels);
      for (const id of input.addLabelIds ?? []) labels.add(id);
      for (const id of input.removeLabelIds ?? []) labels.delete(id);
      message.labels = [...labels];
      message.changed = true;
      observations.modifications.push({ id: modify[1], add: input.addLabelIds ?? [], remove: input.removeLabelIds ?? [] });
      const history = { id: String(++latestHistory) };
      message.historyId = history.id;
      if ((input.addLabelIds ?? []).length) history.labelsAdded = [{ message: { id: modify[1], threadId: message.threadId }, labelIds: input.addLabelIds }];
      if ((input.removeLabelIds ?? []).length) history.labelsRemoved = [{ message: { id: modify[1], threadId: message.threadId }, labelIds: input.removeLabelIds }];
      actionHistory.push(history);
      if (hold?.path === path) {
        observations.holds.push({ path, at: Date.now() });
        await new Promise((resolve) => { hold.release = resolve; });
      }
      return send(response, 200, { id: modify[1], labelIds: message.labels });
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
      const sent = { id: `sent_${observations.sent.length + 1}`, threadId: payload.threadId ?? 'tsent', messageId, headers,
        inReplyTo: parsed.inReplyTo ?? null, references: parsed.references ?? null,
        attachments: parsed.attachments.map((entry) => ({ filename: entry.filename, mimeType: entry.mimeType,
          digest: createHash('sha256').update(Buffer.from(entry.content)).digest('hex') })),
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
