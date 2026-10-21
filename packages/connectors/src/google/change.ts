import { gmail } from '@googleapis/gmail';
import { OAuth2Client, type OAuth2ClientOptions } from 'google-auth-library';
import { z } from 'zod';
import { GoogleCredentialService } from './credentials.js';

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
// Gmail omits an empty repeated labelIds field; malformed present values fail.
const message = z.object({ id, labelIds: z.array(id).max(1000).default([]) });
const label = z.object({ id, type: z.literal('user') });

export class GmailChangeError extends Error {
  constructor(readonly code: 'invalid_response' | 'provider_failed') { super(code); }
}

function boundedFetch(fetchImpl: typeof fetch, signal: AbortSignal, limit = 64 * 1024): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://gmail.googleapis.com' ||
      !/^\/gmail\/v1\/users\/me\/(?:messages\/[^/]+(?:\/modify)?|labels(?:\/[^/]+)?)$/.test(url.pathname)) throw new GmailChangeError('invalid_response');
    const response = await fetchImpl(input, { ...init, signal, redirect: 'error' });
    const reader = response.body?.getReader();
    if (!reader) return response;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new GmailChangeError('invalid_response');
        chunks.push(part.value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** Callers claim a durable operation before modify; this adapter never replays a write. */
export class GmailChangeAdapter {
  constructor(private readonly credentials: GoogleCredentialService, private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('Invalid Gmail change deadline');
  }

  async credential(accountId: string) { return this.credentials.get(accountId); }

  private async call(accessToken: string, request: (api: ReturnType<typeof gmail>,
    options: { timeout: number; retry: false; retryConfig: { retry: 0 }; signal: AbortSignal }) => Promise<{ data: unknown }>) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const transport = new OAuth2Client({ transporterOptions: {
        fetchImplementation: boundedFetch(this.fetchImpl, controller.signal),
      } }).transporter;
      const auth = new OAuth2Client({ transporter: transport } as OAuth2ClientOptions);
      auth.setCredentials({ access_token: accessToken, expiry_date: Date.now() + 3_600_000 });
      return await request(gmail({ version: 'v1', auth }), {
        timeout: this.timeoutMs, retry: false, retryConfig: { retry: 0 }, signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
  }

  async inspectMessage(accessToken: string, messageId: string) {
    const response = await this.call(accessToken, (api, options) => api.users.messages.get({
      userId: 'me', id: messageId, format: 'minimal', fields: 'id,labelIds',
    }, options));
    const parsed = message.safeParse(response.data);
    if (!parsed.success || parsed.data.id !== messageId) throw new GmailChangeError('invalid_response');
    return parsed.data;
  }

  async inspectUserLabel(accessToken: string, labelId: string) {
    const response = await this.call(accessToken, (api, options) => api.users.labels.get({
      userId: 'me', id: labelId, fields: 'id,type',
    }, options));
    const parsed = label.safeParse(response.data);
    if (!parsed.success || parsed.data.id !== labelId) throw new GmailChangeError('invalid_response');
    return parsed.data;
  }

  /** One credential and one deadline cover both presentation reads. */
  async inspectOptions(accessToken: string, messageId: string, signal?: AbortSignal) {
    if (!id.safeParse(messageId).success) throw new GmailChangeError('invalid_response');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const transport = new OAuth2Client({ transporterOptions: {
        fetchImplementation: boundedFetch(this.fetchImpl, controller.signal, 512 * 1024),
      } }).transporter;
      const auth = new OAuth2Client({ transporter: transport } as OAuth2ClientOptions);
      auth.setCredentials({ access_token: accessToken, expiry_date: Date.now() + 3_600_000 });
      const api = gmail({ version: 'v1', auth });
      const options = { timeout: this.timeoutMs, retry: false as const, retryConfig: { retry: 0 }, signal: controller.signal };
      if (controller.signal.aborted) throw new GmailChangeError('provider_failed');
      const messageResult = await api.users.messages.get({ userId: 'me', id: messageId, format: 'minimal', fields: 'id,labelIds' }, options);
      const parsedMessage = message.safeParse(messageResult.data);
      if (!parsedMessage.success || parsedMessage.data.id !== messageId) throw new GmailChangeError('invalid_response');
      if (controller.signal.aborted) throw new GmailChangeError('provider_failed');
      const labelResult = await api.users.labels.list({ userId: 'me', fields: 'labels(id,type,name)' }, options);
      const parsedLabels = z.object({ labels: z.array(z.object({ id, type: z.enum(['user', 'system']).optional(),
        name: z.string().min(1).max(1024).optional() })).max(500).refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length).default([]) }).safeParse(labelResult.data);
      if (!parsedLabels.success) throw new GmailChangeError('invalid_response');
      return { labelIds: parsedMessage.data.labelIds, labels: parsedLabels.data.labels };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  async modify(accessToken: string, messageId: string, addLabels: string[], removeLabels: string[]) {
    let response: { data: unknown };
    try {
      response = await this.call(accessToken, (api, options) => api.users.messages.modify({
        userId: 'me', id: messageId,
        requestBody: { addLabelIds: addLabels, removeLabelIds: removeLabels },
        fields: 'id,labelIds',
      }, options));
    } catch { throw new GmailChangeError('provider_failed'); }
    const parsed = message.safeParse(response.data);
    if (!parsed.success || parsed.data.id !== messageId) throw new GmailChangeError('invalid_response');
    return parsed.data;
  }
}
