import { describe, expect, it } from 'vitest';
import { GmailChangeAdapter } from './change.js';

const service = { async get() { return { accessToken: 'fixture-access', generation: 3, expiresAt: null }; } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

describe('Gmail change adapter', () => {
  it('reads exact message state and explicit label types through the SDK with one deadline', async () => {
    const calls: string[] = [];
    const adapter = new GmailChangeAdapter(service as never, async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith('/labels')) return json({ labels: [
        { id: 'Label_1', type: 'user' }, { id: 'INBOX', type: 'system' }, { id: 'Label_2' },
      ] });
      return json({ id: 'msg_1', labelIds: ['INBOX', 'UNREAD', 'Label_1'] });
    });
    expect(await adapter.inspectOptions('fixture-access', 'msg_1')).toEqual({
      labelIds: ['INBOX', 'UNREAD', 'Label_1'], labels: [
        { id: 'Label_1', type: 'user' }, { id: 'INBOX', type: 'system' }, { id: 'Label_2' },
      ],
    });
    expect(calls).toEqual(['/gmail/v1/users/me/messages/msg_1', '/gmail/v1/users/me/labels']);
  });

  it('rejects malformed, excessive and aborted options reads', async () => {
    for (const value of [{ labels: 'bad' }, { labels: [{ id: 'Label_1', type: 'user' }, { id: 'Label_1', type: 'system' }] },
      { labels: Array.from({ length: 501 }, (_, n) => ({ id: `Label_${n}`, type: 'user' })) }]) {
      const adapter = new GmailChangeAdapter(service as never, async (input) =>
        json(String(input).includes('/labels') ? value : { id: 'msg_1', labelIds: [] }));
      await expect(adapter.inspectOptions('fixture-access', 'msg_1')).rejects.toMatchObject({ code: 'invalid_response' });
    }
    const controller = new AbortController();
    const adapter = new GmailChangeAdapter(service as never, (_input, init) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) { reject(new Error('aborted')); return; }
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }), 100);
    const read = adapter.inspectOptions('fixture-access', 'msg_1', controller.signal);
    controller.abort();
    await expect(read).rejects.toBeInstanceOf(Error);
    let calls = 0;
    const timed = new GmailChangeAdapter(service as never, (_input, init) => new Promise((_resolve, reject) => {
      calls++;
      init?.signal?.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
    }), 25);
    await expect(timed.inspectOptions('fixture-access', 'msg_1')).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });
  it('uses exact users/me message and label reads, then one official SDK modify', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const adapter = new GmailChangeAdapter(service as never, async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({ url: request.url, method: request.method,
        body: request.method === 'POST' ? await request.json() : null });
      if (request.url.includes('/labels/')) return json({ id: 'Label_1', type: 'user' });
      if (request.method === 'POST') return json({ id: 'msg_1', labelIds: ['Label_1'] });
      return json({ id: 'msg_1', labelIds: ['INBOX'] });
    });
    expect((await adapter.inspectUserLabel('fixture-access', 'Label_1')).type).toBe('user');
    expect((await adapter.inspectMessage('fixture-access', 'msg_1')).labelIds).toEqual(['INBOX']);
    expect((await adapter.modify('fixture-access', 'msg_1', ['Label_1'], ['INBOX'])).labelIds).toEqual(['Label_1']);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST']);
    expect(calls[2]?.url).toContain('/gmail/v1/users/me/messages/msg_1/modify');
    expect(calls[2]?.body).toMatchObject({ addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] });
  });

  it('accepts omitted empty labelIds, but rejects malformed labels and IDs', async () => {
    const empty = new GmailChangeAdapter(service as never, async () => json({ id: 'msg_1' }));
    expect((await empty.modify('fixture-access', 'msg_1', [], ['INBOX'])).labelIds).toEqual([]);
    for (const result of [{ id: 'msg_1', labelIds: 'INBOX' }, { id: 'wrong', labelIds: [] }]) {
      const adapter = new GmailChangeAdapter(service as never, async () => json(result));
      await expect(adapter.modify('fixture-access', 'msg_1', [], ['INBOX']))
        .rejects.toMatchObject({ code: 'invalid_response' });
    }
    const system = new GmailChangeAdapter(service as never, async () => json({ id: 'Label_1', type: 'system' }));
    await expect(system.inspectUserLabel('fixture-access', 'Label_1'))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([401, 429, 503])('does not retry a modify after HTTP %i', async (status) => {
    let calls = 0;
    const adapter = new GmailChangeAdapter(service as never, async () => { calls++; return json({ error: 'fixture' }, status); });
    await expect(adapter.modify('fixture-access', 'msg_1', [], ['INBOX']))
      .rejects.toMatchObject({ code: 'provider_failed' });
    expect(calls).toBe(1);
  });

  it('does not retry timeout, redirect or oversized responses', async () => {
    for (const scenario of ['timeout', 'redirect', 'large']) {
      let calls = 0;
      const adapter = new GmailChangeAdapter(service as never, (_input, init) => {
        calls++;
        if (scenario === 'timeout') return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true });
        });
        if (scenario === 'redirect') return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://example.com' } }));
        return Promise.resolve(json({ id: 'msg_1', labelIds: Array.from({ length: 5000 }, () => 'Label_1') }));
      }, 25);
      await expect(adapter.modify('fixture-access', 'msg_1', [], ['INBOX'])).rejects.toBeInstanceOf(Error);
      expect(calls).toBe(1);
    }
  });
});
