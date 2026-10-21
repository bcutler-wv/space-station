import { gmail } from '@googleapis/gmail';
import { OAuth2Client, type OAuth2ClientOptions } from 'google-auth-library';
import { z } from 'zod';
import { GoogleCredentialService } from './credentials.js';

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const sentResult = z.object({ id, threadId: id });
const searchResult = z.object({ messages: z.array(z.object({ id, threadId: id })).max(3).default([]),
  nextPageToken: z.string().optional() });
const sentMetadata = z.object({ id, threadId: id, labelIds: z.array(id).max(1000).default([]),
  payload: z.object({ headers: z.array(z.object({ name: z.string().max(64), value: z.string().max(8192) })).max(100) }) });

export type SentEvidence = z.infer<typeof sentMetadata>;
export class GmailSendError extends Error {
  constructor(readonly code: 'preflight' | 'unknown' | 'invalid_response') { super(code); }
}

function limitedFetch(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://gmail.googleapis.com' || !url.pathname.startsWith('/gmail/v1/users/me/messages'))
      throw new GmailSendError('invalid_response');
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
        if (size > 64 * 1024) throw new GmailSendError('invalid_response');
        chunks.push(part.value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** No rejected-token replay: a send failure after invocation has an unknown outcome. */
export class GmailSendAdapter {
  constructor(private readonly credentials: GoogleCredentialService, private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('Invalid Gmail send deadline');
  }

  async credential(accountId: string) { return this.credentials.get(accountId); }

  private async call(accessToken: string, write: boolean,
    deadline: number,
    request: (api: ReturnType<typeof gmail>, options: { timeout: number; retry: false; retryConfig: { retry: 0 }; signal: AbortSignal }) => Promise<{ data: unknown }>) {
    const controller = new AbortController();
    const timeout = Math.min(this.timeoutMs, Math.max(1, deadline - Date.now()));
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const transport = new OAuth2Client({ transporterOptions: {
        fetchImplementation: limitedFetch(this.fetchImpl, controller.signal),
      } }).transporter;
      const auth = new OAuth2Client({ transporter: transport } as OAuth2ClientOptions);
      auth.setCredentials({ access_token: accessToken, expiry_date: Date.now() + 3_600_000 });
      const api = gmail({ version: 'v1', auth });
      return await request(api, { timeout, retry: false, retryConfig: { retry: 0 }, signal: controller.signal });
    } catch (error) {
      if (write) throw new GmailSendError('unknown');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async send(accountId: string, accessToken: string, raw: Buffer, threadId?: string) {
    if (!accountId) throw new GmailSendError('preflight');
    const response = await this.call(accessToken, true, Date.now() + this.timeoutMs, (api, options) => api.users.messages.send({
      userId: 'me', requestBody: { raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) },
    }, options));
    const parsed = sentResult.safeParse(response.data);
    if (!parsed.success || (threadId && parsed.data.threadId !== threadId)) throw new GmailSendError('invalid_response');
    return parsed.data;
  }

  async findSent(accountId: string, messageId: string): Promise<{ evidence: SentEvidence[]; credentialGeneration: number }> {
    const credential = await this.credentials.get(accountId);
    const deadline = Date.now() + 30_000;
    const remaining = () => { if (Date.now() >= deadline) throw new GmailSendError('invalid_response'); };
    remaining();
    const list = await this.call(credential.accessToken, false, deadline, (api, options) => api.users.messages.list({
      userId: 'me', labelIds: ['SENT'], q: `rfc822msgid:${messageId}`, maxResults: 3,
    }, options));
    const matches = searchResult.safeParse(list.data);
    if (!matches.success || matches.data.nextPageToken) throw new GmailSendError('invalid_response');
    const result: SentEvidence[] = [];
    for (const match of matches.data.messages) {
      remaining();
      const message = await this.call(credential.accessToken, false, deadline, (api, options) => api.users.messages.get({
        userId: 'me', id: match.id, format: 'metadata', metadataHeaders: ['Message-ID', 'From', 'To', 'Cc', 'Bcc'],
      }, options));
      const parsed = sentMetadata.safeParse(message.data);
      if (!parsed.success || parsed.data.id !== match.id || parsed.data.threadId !== match.threadId)
        throw new GmailSendError('invalid_response');
      result.push(parsed.data);
    }
    return { evidence: result, credentialGeneration: credential.generation };
  }
}
