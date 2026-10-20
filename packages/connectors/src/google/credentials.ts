import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { accounts, oauthApps, type openDatabase } from '@station/db';
import { GMAIL_MODIFY_SCOPE, type GoogleTransport } from './index.js';
import { openSecret, sealSecret } from './secret-envelope.js';

type Database = ReturnType<typeof openDatabase>['db'];
type CredentialCode = 'not_found' | 'needs_reconnect' | 'busy' | 'transient';
export class GoogleCredentialError extends Error {
  constructor(readonly code: CredentialCode, readonly retryAfterMs?: number) { super(code); }
}

const context = (id: string, field: string) => `accounts/${id}/${field}`;
const appContext = (id: string) => `oauth_apps/${id}/client_secret`;
const eligible = (now: Date) => or(isNull(accounts.credentialLeaseUntil), lt(accounts.credentialLeaseUntil, now));

function classify(error: unknown): { permanent: boolean; retryAfterMs?: number } {
  if (!error || typeof error !== 'object') return { permanent: false };
  const response = 'response' in error ? error.response : undefined;
  const data = response && typeof response === 'object' && 'data' in response ? response.data : undefined;
  const reason = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
  const headers = response && typeof response === 'object' && 'headers' in response ? response.headers : undefined;
  const retry = headers && typeof headers === 'object'
    ? ('get' in headers && typeof headers.get === 'function' ? headers.get('retry-after')
      : 'retry-after' in headers ? headers['retry-after'] : undefined) : undefined;
  const seconds = typeof retry === 'string' ? Number(retry) : NaN;
  const dateDelay = typeof retry === 'string' ? Date.parse(retry) - Date.now() : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : dateDelay;
  return { permanent: reason === 'invalid_grant' || reason === 'invalid_scope' || reason === 'invalid_client',
    ...(Number.isSafeInteger(delay) && delay >= 0 ? { retryAfterMs: delay } : {}) };
}

async function within<T>(promise: Promise<T>, ms: number, abort: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { abort(); reject(new GoogleCredentialError('transient')); }, ms);
  })]); } finally { if (timer) clearTimeout(timer); }
}

interface RefreshInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
  transport?: GoogleTransport;
  /** Test seam; production uses eight seconds per request. */
  requestTimeoutMs?: number;
}

/** Uses the official SDK and real Gaxios retry path when given a Gaxios transport. */
export async function refreshGoogleGrant(input: RefreshInput): Promise<{
  accessToken: string; refreshToken: string; expiresAt: Date | null; scopes?: string[];
}> {
  const timeoutMs = input.requestTimeoutMs ?? 8000;
  const client = new OAuth2Client({ clientId: input.clientId, clientSecret: input.clientSecret,
    redirectUri: input.redirectUri, transporterOptions: { timeout: timeoutMs },
    ...(input.transport ? { transporter: input.transport } : {}) });
  // SDK token requests provide retryConfig with POST enabled. Gaxios defaults that
  // config to three retries even if the top-level retry flag is false.
  const originalTransport = client.transporter;
  let controller: AbortController | undefined;
  client.transporter = new Proxy(originalTransport, { get(target, property, receiver) {
    if (property === 'request') return (options: Parameters<typeof target.request>[0]) =>
      target.request({ ...options, retry: false, retryConfig: { retry: 0 }, signal: controller?.signal ?? null });
    return Reflect.get(target, property, receiver);
  } });
  client.setCredentials({ refresh_token: input.refreshToken });
  let emitted: Credentials | undefined;
  client.on('tokens', (tokens: Credentials) => { emitted = { ...tokens }; });
  let credentials: Credentials | undefined;
  const deadline = Date.now() + 25_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    controller = new AbortController();
    try {
      credentials = (await within(client.refreshAccessToken(), Math.min(timeoutMs, Math.max(1, deadline - Date.now())),
        () => controller?.abort())).credentials;
      break;
    } catch (error) {
      if (controller.signal.aborted) throw new GoogleCredentialError('transient');
      const { permanent, retryAfterMs } = classify(error);
      if (permanent) throw new GoogleCredentialError('needs_reconnect');
      if (attempt || Date.now() + (retryAfterMs ?? 500) >= deadline)
        throw new GoogleCredentialError('transient', retryAfterMs);
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs ?? 500));
    }
  }
  if (!credentials?.access_token) throw new GoogleCredentialError('transient');
  const scopes = emitted?.scope?.split(/\s+/).filter(Boolean);
  if (scopes && !scopes.includes(GMAIL_MODIFY_SCOPE)) throw new GoogleCredentialError('needs_reconnect');
  // refreshAccessToken overwrites the returned refresh_token after emitting tokens.
  return { accessToken: credentials.access_token, refreshToken: emitted?.refresh_token || input.refreshToken,
    expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
    ...(scopes ? { scopes } : {}) };
}

/** Server-only credential service; never serialize its return value into an API response. */
export class GoogleCredentialService {
  constructor(private readonly db: Database, private readonly masterKey: Buffer, private readonly transport?: GoogleTransport) {}

  async get(accountId: string, rejected?: { generation: number; accessToken: string }): Promise<{ accessToken: string; expiresAt: Date | null; generation: number }> {
    const [account] = await this.db.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.provider, 'google')));
    if (!account) throw new GoogleCredentialError('not_found');
    if (account.revokedAt) throw new GoogleCredentialError('needs_reconnect');
    if (rejected && account.credentialGeneration < rejected.generation)
      throw new GoogleCredentialError('busy', 1000);
    if (account.accessTokenExpiresAt && account.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
      const accessToken = await this.readAccess(account.encryptedAccessToken, accountId, account.credentialGeneration);
      if (!rejected || accessToken !== rejected.accessToken)
        return { accessToken, expiresAt: account.accessTokenExpiresAt, generation: account.credentialGeneration };
    }

    // A reconnect increments the generation and clears this finite lease. No provider
    // request holds a database transaction, and an older response cannot persist.
    const [lease] = await this.db.update(accounts).set({ credentialGeneration: sql`${accounts.credentialGeneration} + 1`,
      credentialLeaseUntil: new Date(Date.now() + 45_000) }).where(and(eq(accounts.id, accountId),
      eq(accounts.credentialGeneration, account.credentialGeneration), isNull(accounts.revokedAt), eligible(new Date())))
      .returning({ generation: accounts.credentialGeneration });
    if (!lease) {
      const [current] = await this.db.select().from(accounts).where(eq(accounts.id, accountId));
      if (current?.revokedAt) throw new GoogleCredentialError('needs_reconnect');
      if (current && current.accessTokenExpiresAt && current.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
        const accessToken = await this.readAccess(current.encryptedAccessToken, accountId, current.credentialGeneration);
        if (!rejected || accessToken !== rejected.accessToken)
          return { accessToken, expiresAt: current.accessTokenExpiresAt, generation: current.credentialGeneration };
      }
      throw new GoogleCredentialError('busy', 1000);
    }
    try {
      const [app] = await this.db.select().from(oauthApps).where(eq(oauthApps.id, account.appId));
      if (!app) throw new GoogleCredentialError('needs_reconnect');
      let refreshToken: string;
      let clientSecret: string;
      try {
        refreshToken = openSecret(account.encryptedRefreshToken, this.masterKey, context(accountId, 'refresh'));
        clientSecret = openSecret(app.encryptedClientSecret, this.masterKey, appContext(app.id));
      } catch { throw new GoogleCredentialError('needs_reconnect'); }
      const fresh = await refreshGoogleGrant({ clientId: app.clientId, clientSecret, redirectUri: app.redirectUri,
        refreshToken, ...(this.transport ? { transport: this.transport } : {}) });
      const [saved] = await this.db.update(accounts).set({
        encryptedAccessToken: sealSecret(fresh.accessToken, this.masterKey, context(accountId, 'access')),
        encryptedRefreshToken: sealSecret(fresh.refreshToken, this.masterKey, context(accountId, 'refresh')),
        accessTokenExpiresAt: fresh.expiresAt, grantedScopes: fresh.scopes ?? account.grantedScopes,
        credentialLeaseUntil: null, updatedAt: new Date(),
      }).where(and(eq(accounts.id, accountId), eq(accounts.credentialGeneration, lease.generation), isNull(accounts.revokedAt)))
        .returning({ id: accounts.id });
      if (!saved) throw new GoogleCredentialError('busy', 1000);
      return { accessToken: fresh.accessToken, expiresAt: fresh.expiresAt, generation: lease.generation };
    } catch (error) {
      if (error instanceof GoogleCredentialError && error.code === 'needs_reconnect')
        return this.markNeedsReconnect(accountId, lease.generation);
      await this.db.update(accounts).set({ credentialLeaseUntil: null }).where(and(eq(accounts.id, accountId),
        eq(accounts.credentialGeneration, lease.generation)));
      if (error instanceof GoogleCredentialError) throw error;
      throw new GoogleCredentialError('transient');
    }
  }

  private async markNeedsReconnect(accountId: string, generation: number): Promise<never> {
    const [marked] = await this.db.update(accounts).set({ revokedAt: new Date(), credentialLeaseUntil: null, updatedAt: new Date() })
      .where(and(eq(accounts.id, accountId), eq(accounts.credentialGeneration, generation), isNull(accounts.revokedAt)))
      .returning({ id: accounts.id });
    throw new GoogleCredentialError(marked ? 'needs_reconnect' : 'busy', marked ? undefined : 1000);
  }

  private async readAccess(ciphertext: string, accountId: string, generation: number): Promise<string> {
    try { return openSecret(ciphertext, this.masterKey, context(accountId, 'access')); }
    catch { return this.markNeedsReconnect(accountId, generation); }
  }
}
