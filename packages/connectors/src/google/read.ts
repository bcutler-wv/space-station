import { gmail } from '@googleapis/gmail';
import { OAuth2Client, type OAuth2ClientOptions } from 'google-auth-library';
import { z } from 'zod';
import { MAIL_LIMITS, id, historyId, token, profile, labelPage, messagePage, minimalMessage, rawMessage, historyPage,
  type GmailProfile, type GmailLabelPage, type GmailMessagePage, type GmailHistoryPage, type GmailMessageMetadata } from '@station/shared';
import { GoogleCredentialError, GoogleCredentialService } from './credentials.js';

export type { GmailProfile, GmailLabelPage, GmailMessagePage, GmailHistoryPage, GmailMessageMetadata } from '@station/shared';
export type GmailRawMessage = GmailMessageMetadata & { mime: Buffer };
export type GmailReadCode = 'not_found' | 'needs_reconnect' | 'permission_denied' | 'busy' | 'transient' | 'invalid_response' | 'too_large' | 'message_missing' | 'history_expired';
export class GmailReadError extends Error {
  constructor(readonly code: GmailReadCode, readonly retryAfterMs?: number) { super(code); }
}

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_RAW_BYTES = Math.ceil(MAIL_LIMITS.rawBytes / 3) * 4 + 64 * 1024;
const MAX_MIME_BYTES = MAIL_LIMITS.rawBytes;
const TIMEOUT_MS = 10_000;

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^[0-9]+$/.test(value)) return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER);
  const ms = Date.parse(value) - Date.now();
  return ms >= 0 ? Math.min(ms, Number.MAX_SAFE_INTEGER) : undefined;
}

function classify(error: unknown, operation: 'message' | 'history' | 'other'): GmailReadError {
  if (error instanceof GmailReadError) return error;
  if (error instanceof GoogleCredentialError) return new GmailReadError(error.code, error.retryAfterMs);
  if (error && typeof error === 'object' && 'cause' in error && error.cause instanceof GmailReadError) return error.cause;
  const response = error && typeof error === 'object' && 'response' in error ? error.response : undefined;
  const status = response && typeof response === 'object' && 'status' in response ? response.status : undefined;
  const headers = response && typeof response === 'object' && 'headers' in response ? response.headers : undefined;
  const retry = headers instanceof Headers ? headers.get('retry-after') : null;
  if (status === 404) return new GmailReadError(operation === 'history' ? 'history_expired' : operation === 'message' ? 'message_missing' : 'transient');
  if (status === 401) return new GmailReadError('needs_reconnect');
  if (status === 403) {
    const data = response && typeof response === 'object' && 'data' in response ? response.data : undefined;
    const body = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
    const details = body && typeof body === 'object' && 'errors' in body ? body.errors : undefined;
    const reason = Array.isArray(details) && details[0] && typeof details[0] === 'object' && 'reason' in details[0] ? details[0].reason : undefined;
    if (reason === 'insufficientPermissions' || reason === 'forbidden' || reason === 'accessNotConfigured')
      return new GmailReadError('permission_denied');
  }
  return new GmailReadError('transient', retryAfter(retry));
}

/** The actual fetch response is capped before Gaxios can parse successful or error JSON. */
function boundedFetch(limit: number, signal: AbortSignal, fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' || url.hostname !== 'gmail.googleapis.com' || url.port || !url.pathname.startsWith('/gmail/v1/users/me/'))
      throw new GmailReadError('invalid_response');
    const response = await fetchImpl(input, { ...init, signal, redirect: 'error' });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) { signal.removeEventListener('abort', abort); controller.close(); return; }
          bytes += part.value.byteLength;
          if (bytes > limit) { signal.removeEventListener('abort', abort); await reader.cancel();
            controller.error(response.ok ? new GmailReadError('too_large') : new GmailReadError('transient', retryAfter(response.headers.get('retry-after')))); return; }
          controller.enqueue(part.value);
        } catch (error) { controller.error(error); }
      },
      cancel() { signal.removeEventListener('abort', abort); return reader.cancel(); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function decodeRaw(encoded: string): Buffer {
  if (encoded.length > Math.ceil(MAX_MIME_BYTES / 3) * 4 + 2) throw new GmailReadError('too_large');
  const mime = Buffer.from(encoded, 'base64url');
  if (mime.length > MAX_MIME_BYTES) throw new GmailReadError('too_large');
  if (mime.toString('base64url') !== encoded.replace(/=+$/, '')) throw new GmailReadError('invalid_response');
  return mime;
}

function valid<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GmailReadError('invalid_response');
  return result.data;
}

/** Explicit page calls leave cursor ownership and checkpointing with the durable runner. */
export class GmailReadAdapter {
  constructor(private readonly credentials: GoogleCredentialService, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(accountId: string, kind: 'message' | 'history' | 'other', limit: number,
    request: (api: ReturnType<typeof gmail>, options: { timeout: number; retry: false; retryConfig: { retry: 0 }; signal: AbortSignal }) => Promise<{ data: unknown }>,
    schema: z.ZodType<T>): Promise<T> {
    let credential: Awaited<ReturnType<GoogleCredentialService['get']>>;
    try { credential = await this.credentials.get(accountId); }
    catch (error) { throw classify(error, kind); }
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const transport = new OAuth2Client({ transporterOptions: { fetchImplementation: boundedFetch(limit, controller.signal, this.fetchImpl) } }).transporter;
        const auth = new OAuth2Client({ transporter: transport } as OAuth2ClientOptions);
        auth.setCredentials({ access_token: credential.accessToken, expiry_date: Date.now() + 3_600_000 });
        const api = gmail({ version: 'v1', auth });
        const response = await request(api, { timeout: TIMEOUT_MS, retry: false, retryConfig: { retry: 0 }, signal: controller.signal });
        const parsed = schema.safeParse(response.data);
        if (!parsed.success) throw new GmailReadError('invalid_response');
        return parsed.data;
      } catch (error) {
        const response = error && typeof error === 'object' && 'response' in error ? error.response : undefined;
        const status = response && typeof response === 'object' && 'status' in response ? response.status : undefined;
        if (status === 401 && attempt === 0) {
          try { credential = await this.credentials.get(accountId, credential); }
          catch (cause) { throw classify(cause, kind); }
          continue;
        }
        if (controller.signal.aborted) throw new GmailReadError('transient');
        throw classify(error, kind);
      } finally { clearTimeout(timer); }
    }
    throw new GmailReadError('transient');
  }

  getProfile(accountId: string): Promise<GmailProfile> {
    return this.call(accountId, 'other', MAX_METADATA_BYTES, (api, options) => api.users.getProfile({ userId: 'me' }, options), profile);
  }
  listLabels(accountId: string): Promise<GmailLabelPage> {
    return this.call(accountId, 'other', MAX_PAGE_BYTES, (api, options) => api.users.labels.list({ userId: 'me' }, options), labelPage);
  }
  listMessageIds(accountId: string, input: { cutoffEpochSeconds?: number; pageToken?: string; maxResults?: number; includeSpamTrash?: boolean } = {}): Promise<GmailMessagePage> {
    if (input.pageToken) valid(token, input.pageToken);
    const maxResults = input.maxResults ?? 100;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) throw new GmailReadError('invalid_response');
    if (input.cutoffEpochSeconds !== undefined && (!Number.isSafeInteger(input.cutoffEpochSeconds) || input.cutoffEpochSeconds < 0)) throw new GmailReadError('invalid_response');
    return this.call(accountId, 'other', MAX_PAGE_BYTES, (api, options) => api.users.messages.list({ userId: 'me', maxResults,
      includeSpamTrash: input.includeSpamTrash ?? true, ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      ...(input.cutoffEpochSeconds !== undefined ? { q: `after:${input.cutoffEpochSeconds}` } : {}) }, options), messagePage);
  }
  async getMessageRaw(accountId: string, messageId: string): Promise<GmailRawMessage> {
    valid(id, messageId);
    const result = await this.call(accountId, 'message', MAX_RAW_BYTES, (api, options) => api.users.messages.get({ userId: 'me', id: messageId, format: 'raw' }, options), rawMessage);
    const mime = decodeRaw(result.raw);
    return { id: result.id, threadId: result.threadId, historyId: result.historyId, labelIds: result.labelIds,
      internalDate: result.internalDate, sizeEstimate: result.sizeEstimate, trustedSent: result.labelIds.includes('SENT'), mime };
  }
  async getMessageMinimal(accountId: string, messageId: string): Promise<GmailMessageMetadata> {
    valid(id, messageId);
    const result = await this.call(accountId, 'message', MAX_METADATA_BYTES, (api, options) => api.users.messages.get({ userId: 'me', id: messageId, format: 'minimal' }, options), minimalMessage);
    return { ...result, trustedSent: result.labelIds.includes('SENT') };
  }
  listHistory(accountId: string, input: { startHistoryId: string; pageToken?: string }): Promise<GmailHistoryPage> {
    valid(historyId, input.startHistoryId);
    if (input.pageToken) valid(token, input.pageToken);
    return this.call(accountId, 'history', MAX_PAGE_BYTES, (api, options) => api.users.history.list({ userId: 'me', startHistoryId: input.startHistoryId,
      maxResults: 100, historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
      ...(input.pageToken ? { pageToken: input.pageToken } : {}) }, options), historyPage);
  }
}
