import { describe, expect, it } from 'vitest';
import { GmailChangeAdapter } from './change.js';

const service = { async get() { return { accessToken: 'fixture-access', generation: 3, expiresAt: null }; } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

describe('Gmail change adapter', () => {
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
