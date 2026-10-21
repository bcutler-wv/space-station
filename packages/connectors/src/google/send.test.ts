import { describe, expect, it } from 'vitest';
import { GmailSendAdapter, GmailSendError } from './send.js';

const credential = { accessToken: 'fixture-access', expiresAt: new Date(Date.now() + 3600_000), generation: 4 };
const service = { async get() { return credential; } };

describe('Gmail send adapter', () => {
  it('uses one official SDK POST without automatic retry and validates response', async () => {
    const calls: { url: string; method: string; authorization: string | null; body: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({ url: request.url, method: request.method,
        authorization: request.headers.get('authorization'), body: await request.json() });
      return new Response(JSON.stringify({ id: 'sent_1', threadId: 'thread_1' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const adapter = new GmailSendAdapter(service as never, fetcher);
    const sent = await adapter.send('account-1', credential.accessToken, Buffer.from('To: user@example.com\r\n\r\nhello'), 'thread_1');
    expect(sent.id).toBe('sent_1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.authorization).toBe('Bearer fixture-access');
    expect(calls[0]?.url).toContain('/gmail/v1/users/me/messages/send');
    expect(calls[0]?.body).toMatchObject({ threadId: 'thread_1' });
  });

  it.each([401, 429, 503])('does not replay a Gmail POST after HTTP %i', async (status) => {
    let calls = 0;
    const adapter = new GmailSendAdapter(service as never, async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'fixture' } }), {
        status, headers: { 'content-type': 'application/json' },
      });
    });
    await expect(adapter.send('account-1', credential.accessToken, Buffer.from('example')))
      .rejects.toMatchObject({ code: 'unknown' });
    expect(calls).toBe(1);
  });

  it('aborts an unanswered POST without replay', async () => {
    let calls = 0;
    const adapter = new GmailSendAdapter(service as never, (_input, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true });
      });
    }, 25);
    await expect(adapter.send('account-1', credential.accessToken, Buffer.from('example')))
      .rejects.toMatchObject({ code: 'unknown' });
    expect(calls).toBe(1);
  });

  it('rejects oversized provider JSON after one POST', async () => {
    let calls = 0;
    let canceled = false;
    const adapter = new GmailSendAdapter(service as never, async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(65 * 1024)); },
        cancel() { canceled = true; },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await expect(adapter.send('account-1', credential.accessToken, Buffer.from('example')))
      .rejects.toMatchObject({ code: 'unknown' });
    expect(calls).toBe(1);
    expect(canceled).toBe(true);
  });

  it('keeps a rejected, timed-out, or invalid successful response ambiguous', async () => {
    let calls = 0;
    const adapter = new GmailSendAdapter(service as never, async () => {
      calls++;
      return new Response(JSON.stringify({ id: 'sent_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await expect(adapter.send('account-1', credential.accessToken, Buffer.from('example')))
      .rejects.toMatchObject({ code: 'invalid_response' } satisfies Partial<GmailSendError>);
    expect(calls).toBe(1);
  });

  it('checks only bounded Sent candidates and exact returned IDs', async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      calls.push(request.url);
      if (request.url.includes('/messages?')) return new Response(JSON.stringify({ messages: [{ id: 'sent_1', threadId: 'thread_1' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ id: 'sent_1', threadId: 'thread_1', labelIds: ['SENT'],
        payload: { headers: [{ name: 'Message-ID', value: '<example@station.local>' }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const adapter = new GmailSendAdapter(service as never, fetcher);
    const result = await adapter.findSent('account-1', '<example@station.local>');
    expect(result.credentialGeneration).toBe(4);
    expect(result.evidence).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('does not accept a changed Sent candidate or truncated search page', async () => {
    const changed = new GmailSendAdapter(service as never, async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      return new Response(JSON.stringify(request.url.includes('/messages?') ?
        { messages: [{ id: 'sent_1', threadId: 'thread_1' }] } :
        { id: 'other', threadId: 'thread_1', labelIds: ['SENT'], payload: { headers: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await expect(changed.findSent('account-1', '<example@station.local>'))
      .rejects.toMatchObject({ code: 'invalid_response' });
    const paged = new GmailSendAdapter(service as never, async () => new Response(JSON.stringify({
      messages: [{ id: 'sent_1', threadId: 'thread_1' }], nextPageToken: 'more',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(paged.findSent('account-1', '<example@station.local>'))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
});
