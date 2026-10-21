import { describe, expect, it } from 'vitest';
import { GmailReadAdapter, GmailReadError } from './read.js';
import { GoogleCredentialService } from './credentials.js';
import { GoogleCredentialError } from './credentials.js';

const credential = (get: (accountId: string, rejected?: { accessToken: string; generation: number }) => Promise<{ accessToken: string; expiresAt: Date; generation: number }>) =>
  ({ get }) as GoogleCredentialService;
const access = { accessToken: 'fixture-token', expiresAt: new Date(Date.now() + 3600000), generation: 1 };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const fixture = (reply: (url: URL, request: RequestInit) => Response | Promise<Response>,
  get: (accountId: string, rejected?: { accessToken: string; generation: number }) => Promise<{ accessToken: string; expiresAt: Date; generation: number }> = async () => access) => {
  const calls: URL[] = [];
  const adapter = new GmailReadAdapter(credential(get), async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    expect(url.origin).toBe('https://gmail.googleapis.com');
    expect(input instanceof Request ? input.method : init?.method).toBe('GET');
    return reply(url, { ...init, ...(input instanceof Request ? { headers: input.headers } : {}) });
  });
  return { adapter, calls };
};

describe('Gmail read SDK transport', () => {
  it('reads only bounded reply metadata with the fixed header allowlist and one token refresh', async () => {
    const headers = [{ name: 'Message-ID', value: '<source@example.com>' }, { name: 'From', value: 'Sender <sender@example.com>' }];
    const observed: string[] = [];
    const { adapter, calls } = fixture((_url, request) => {
      expect(request.redirect).toBe('error');
      observed.push(new Headers(request.headers).get('authorization') ?? '');
      return observed.length === 1 ? json({ error: 'expired' }, 401) : json({ id: 'abc', threadId: 'thread1', historyId: '4', payload: { headers } });
    }, async (_id, rejected) => rejected ? { ...access, accessToken: 'fixture-fresh', generation: 2 } : access);
    const result = await adapter.getReplyHeaders('account', 'abc');
    expect(result).toMatchObject({ id: 'abc', credentialGeneration: 2, payload: { headers } });
    expect(observed).toEqual(['Bearer fixture-token', 'Bearer fixture-fresh']);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.searchParams.get('format')).toBe('metadata');
    expect(calls[0]?.searchParams.getAll('metadataHeaders')).toEqual(['Message-ID', 'In-Reply-To', 'References', 'Reply-To', 'From']);
    const huge = fixture(() => json({ id: 'abc', threadId: 'thread1', payload: { headers: [{ name: 'From', value: 'x'.repeat(9000) }] } }));
    await expect(huge.adapter.getReplyHeaders('account', 'abc')).rejects.toMatchObject({ code: 'invalid_response' });
    const missing = fixture(() => json({ error: 'gone' }, 404));
    await expect(missing.adapter.getReplyHeaders('account', 'abc')).rejects.toMatchObject({ code: 'message_missing' });
  });
  it('requests explicit bounded pages and preserves opaque history cursors', async () => {
    const { adapter, calls } = fixture((url) => {
      if (url.pathname.endsWith('/profile')) return json({ emailAddress: 'owner@example.com', historyId: '9007199254740999' });
      if (url.pathname.endsWith('/labels')) return json({ labels: [{ id: 'SENT', name: 'Sent', type: 'system' }] });
      if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'abc', threadId: 'thread1' }], nextPageToken: 'next_1' });
      if (url.pathname.endsWith('/history')) return json({ historyId: '9007199254741001', history: [{ id: '9007199254741000', messagesDeleted: [{ message: { id: 'gone', threadId: 'thread1' } }] }] });
      return json({ id: 'abc', threadId: 'thread1', historyId: '9007199254741000', internalDate: '1700000000000', labelIds: ['SENT'], raw: Buffer.from('From: owner@example.com\r\n').toString('base64url') });
    });
    expect((await adapter.getProfile('account')).historyId).toBe('9007199254740999');
    expect((await adapter.listLabels('account')).labels[0]?.name).toBe('Sent');
    expect((await adapter.listMessageIds('account', { cutoffEpochSeconds: 1700000000 })).nextPageToken).toBe('next_1');
    expect((await adapter.getMessageRaw('account', 'abc')).trustedSent).toBe(true);
    expect((await adapter.listHistory('account', { startHistoryId: '9007199254740999' })).historyId).toBe('9007199254741001');
    expect(calls[2]?.searchParams.get('q')).toBe('after:1700000000');
    expect(calls[3]?.searchParams.get('format')).toBe('raw');
  });

  it('caps streaming bytes before parsing, even without Content-Length', async () => {
    const { adapter } = fixture(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(600000)); controller.close(); } }),
      { headers: { 'content-type': 'application/json' } }));
    await expect(adapter.getProfile('account')).rejects.toMatchObject({ code: 'too_large' });
  });

  it('refreshes once after a rejected cached token and stops on a second 401', async () => {
    const rejected: { generation: number; accessToken: string }[] = [];
    const { adapter, calls } = fixture(() => json({ error: { message: 'secret provider detail' } }, 401), async (_id, generation) => {
      if (generation !== undefined) rejected.push(generation);
      return { ...access, accessToken: generation === undefined ? 'fixture-token' : 'fixture-new-token', generation: generation === undefined ? 1 : 2 };
    });
    await expect(adapter.getProfile('account')).rejects.toMatchObject({ code: 'needs_reconnect' });
    expect(rejected).toMatchObject([{ generation: 1, accessToken: 'fixture-token' }]);
    expect(calls).toHaveLength(2);
  });

  it('distinguishes missing messages from expired history', async () => {
    const { adapter } = fixture(() => json({ error: 'missing' }, 404));
    await expect(adapter.getMessageMinimal('account', 'missing')).rejects.toMatchObject({ code: 'message_missing' });
    await expect(adapter.listHistory('account', { startHistoryId: '1' })).rejects.toMatchObject({ code: 'history_expired' });
  });

  it('rejects malformed raw data and never treats message headers as Sent proof', async () => {
    const { adapter } = fixture(() => json({ id: 'abc', threadId: 'thread1', historyId: '4', internalDate: '1700000000000',
      labelIds: ['INBOX'], raw: Buffer.from('From: owner@example.com\r\n').toString('base64url') }));
    expect((await adapter.getMessageRaw('account', 'abc')).trustedSent).toBe(false);
    const malformed = fixture(() => json({ id: 'abc', threadId: 'thread1', historyId: '4', internalDate: '1700000000000', raw: '%%%' }));
    await expect(malformed.adapter.getMessageRaw('account', 'abc')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('returns bounded Retry-After without leaking provider body', async () => {
    const { adapter } = fixture(() => json({ error: 'secret provider diagnostic' }, 429, { 'retry-after': '120' }));
    const error = await adapter.getProfile('account').catch((cause: unknown) => cause) as GmailReadError;
    expect(error).toMatchObject({ code: 'transient', retryAfterMs: 120000 });
    expect(JSON.stringify(error)).not.toContain('secret provider diagnostic');
    const extreme = fixture(() => json({ error: 'quota' }, 429, { 'retry-after': '999999999999999999999999' }));
    await expect(extreme.adapter.getProfile('account')).rejects.toMatchObject({ retryAfterMs: Number.MAX_SAFE_INTEGER });
  });

  it('normalizes credential errors before and after a 401', async () => {
    const initial = fixture(() => json({}), async () => { throw new GoogleCredentialError('busy', 1000); });
    await expect(initial.adapter.getProfile('account')).rejects.toBeInstanceOf(GmailReadError);
    expect(initial.calls).toHaveLength(0);
    const rejected = fixture(() => json({ error: 'expired' }, 401), async (_id, observed) => {
      if (observed) throw new GoogleCredentialError('needs_reconnect');
      return access;
    });
    await expect(rejected.adapter.getProfile('account')).rejects.toMatchObject({ code: 'needs_reconnect' });
    expect(rejected.calls).toHaveLength(1);
  });

  it('replays a 401 once with a new bearer token and no SDK retry', async () => {
    const headers: string[] = [];
    let credentialsCalls = 0;
    const { adapter, calls } = fixture((_url, request) => {
      headers.push(new Headers(request.headers).get('authorization') ?? '');
      return calls.length === 1 ? json({ error: { message: 'rejected' } }, 401) : json({ emailAddress: 'owner@example.com', historyId: '77' });
    }, async (_id, rejected) => {
      credentialsCalls++;
      return rejected ? { ...access, generation: 2, accessToken: 'fixture-replacement' } : access;
    });
    expect((await adapter.getProfile('account')).historyId).toBe('77');
    expect(headers).toEqual(['Bearer fixture-token', 'Bearer fixture-replacement']);
    expect(credentialsCalls).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('classifies permission 403 separately from quota 403 and makes one transient call', async () => {
    const permission = fixture(() => json({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, 403));
    await expect(permission.adapter.getProfile('account')).rejects.toMatchObject({ code: 'permission_denied' });
    const quota = fixture(() => json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 403, { 'retry-after': '90' }));
    await expect(quota.adapter.getProfile('account')).rejects.toMatchObject({ code: 'transient', retryAfterMs: 90000 });
    expect(quota.calls).toHaveLength(1);
    const unavailable = fixture(() => json({ error: 'temporary' }, 503));
    await expect(unavailable.adapter.getProfile('account')).rejects.toMatchObject({ code: 'transient' });
    expect(unavailable.calls).toHaveLength(1);
  });

  it('caps a provider error body before JSON parsing', async () => {
    const { adapter } = fixture(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(600000)); controller.close(); } }),
      { status: 503, headers: { 'content-type': 'application/json' } }));
    await expect(adapter.getProfile('account')).rejects.toMatchObject({ code: 'transient' });
  });

  it('round trips opaque continuation tokens', async () => {
    const opaque = 'part=+/%2F?';
    const { adapter, calls } = fixture((url) => url.pathname.endsWith('/history')
      ? json({ historyId: '12', nextPageToken: opaque }) : json({ nextPageToken: opaque }));
    expect((await adapter.listMessageIds('account')).nextPageToken).toBe(opaque);
    expect((await adapter.listMessageIds('account', { pageToken: opaque })).nextPageToken).toBe(opaque);
    expect(calls[1]?.searchParams.get('pageToken')).toBe(opaque);
    expect((await adapter.listHistory('account', { startHistoryId: '1', pageToken: opaque })).nextPageToken).toBe(opaque);
    expect(calls[2]?.searchParams.get('pageToken')).toBe(opaque);
  });

  it('accepts a normal minimal message and rejects invalid provider metadata', async () => {
    const minimal = fixture(() => json({ id: 'abc', threadId: 'thread1', labelIds: ['SENT'] }));
    expect((await minimal.adapter.getMessageMinimal('account', 'abc')).trustedSent).toBe(true);
    for (const payload of [
      { id: 'abc', threadId: 'thread1', historyId: 123 },
      { id: 'abc', threadId: 'thread1', historyId: '3', internalDate: '9999999999999999', raw: 'QQ' },
      { id: 'bad/id', threadId: 'thread1', historyId: '3', internalDate: '1700000000000', raw: 'QQ' },
      { messages: Array.from({ length: 101 }, (_, i) => ({ id: `id${i}`, threadId: 'thread1' })) },
    ]) {
      const invalid = fixture(() => json(payload));
      const call = 'messages' in payload ? invalid.adapter.listMessageIds('account') : invalid.adapter.getMessageRaw('account', 'abc');
      await expect(call).rejects.toMatchObject({ code: 'invalid_response' });
    }
    const invalidHistory = fixture(() => json({ historyId: 123, history: [] }));
    await expect(invalidHistory.adapter.listHistory('account', { startHistoryId: '1' })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('honors the parser raw-byte boundary and rejects redirects', async () => {
    const raw = Buffer.alloc(12_582_912, 65).toString('base64url');
    const message = (body: string) => ({ id: 'abc', threadId: 'thread1', historyId: '4', internalDate: '1700000000000', raw: body });
    const withinLimit = fixture(() => json(message(raw)));
    expect((await withinLimit.adapter.getMessageRaw('account', 'abc')).mime.byteLength).toBe(12_582_912);
    const overLimit = fixture(() => json(message(Buffer.alloc(12_582_913, 65).toString('base64url'))));
    await expect(overLimit.adapter.getMessageRaw('account', 'abc')).rejects.toMatchObject({ code: 'too_large' });
    const redirect = fixture((_url, request) => {
      expect(request.redirect).toBe('error');
      return new Response(null, { status: 302, headers: { location: 'https://other.example.com/steal' } });
    });
    await expect(redirect.adapter.getProfile('account')).rejects.toMatchObject({ code: 'transient' });
    expect(redirect.calls).toHaveLength(1);
  });

  it('cancels a stalled response body at the deadline', async () => {
    let canceled = false;
    const { adapter } = fixture(() => new Response(new ReadableStream({ cancel() { canceled = true; } }),
      { headers: { 'content-type': 'application/json' } }));
    await expect(adapter.getProfile('account')).rejects.toMatchObject({ code: 'transient' });
    expect(canceled).toBe(true);
  }, 15_000);
});
