import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GoogleMailAuthorization } from '@station/connectors';
import { accounts, auditLog, oauthApps, oauthAttempts, orbits, sessions, settings, users } from '@station/db';
import { googleBackfillSchema, googleCallbackSchema, googleOkSchema, googleReconnectStartSchema, googleStartResponseSchema, googleStartSchema, googleStatusSchema } from '@station/shared';
import { digest, OWNER_ID } from './auth-store.js';
import type { AuthConfig } from './auth.js';
import type { SetupStore } from './setup-store.js';
import { openSecret, sealSecret } from './secret-envelope.js';

const TTL_MS = 10 * 60_000;
const callbackPath = '/api/google/callback';
const continuationPath = '/setup/google/continue';
const errorResponse = { error: 'Google connection failed. Start the connection again and approve mail access.' };
const sessionHash = (id: string) => digest(id);
const attemptContext = (id: string, field: string) => `oauth_attempts/${id}/${field}`;
const appContext = (id: string) => `oauth_apps/${id}/client_secret`;
const accountContext = (id: string, field: string) => `accounts/${id}/${field}`;

export function registerGoogle(app: FastifyInstance, auth: AuthConfig, setup: SetupStore) {
  const db = auth.db;
  const redirectUri = `${auth.origin}${callbackPath}`;
  const newProvider = (clientId: string, secret: string) => new GoogleMailAuthorization(clientId, secret, redirectUri, auth.googleTransport);
  const ready = async () => setup.isReady(auth.origin);
  const cleanup = async () => {
    await db.delete(oauthAttempts).where(lt(oauthAttempts.expiresAt, new Date()));
    await db.delete(oauthApps).where(sql`not exists (select 1 from oauth_attempts where oauth_attempts.app_id = ${oauthApps.id}) and not exists (select 1 from accounts where accounts.app_id = ${oauthApps.id})`);
  };
  const cleanupTimer = setInterval(() => { void cleanup().catch(() => {}); }, 60_000);
  cleanupTimer.unref();
  app.addHook('onClose', async () => clearInterval(cleanupTimer));

  app.get('/api/google/status', async (request, reply) => {
    if (!(await ready())) return reply.code(409).send({ error: 'Complete the first Orbit setup and confirm this address before connecting Google.' });
    const rows = await db.select().from(accounts).where(eq(accounts.provider, 'google'));
    const [pending] = await db.select({ id: oauthAttempts.id, reconnectAccountId: oauthAttempts.reconnectAccountId }).from(oauthAttempts).where(and(
      eq(oauthAttempts.provider, 'google'), eq(oauthAttempts.sessionHash, sessionHash(request.session.sessionId)),
      eq(oauthAttempts.authGeneration, request.session.authGeneration!), eq(oauthAttempts.status, 'returned'), gt(oauthAttempts.expiresAt, new Date()),
    )).orderBy(desc(oauthAttempts.createdAt)).limit(1);
    return googleStatusSchema.parse({ redirectUri, pendingConfirmation: Boolean(pending), pendingReconnectAccountId: pending?.reconnectAccountId ?? null, accounts: rows.map((row) => ({
      id: row.id, email: row.email, orbitId: row.orbitId, grantedScopes: row.grantedScopes,
      backfill: row.backfill, status: row.revokedAt ? 'needs_reconnect' : 'connected',
    })) });
  });

  const startConnection = async (request: FastifyRequest, reply: FastifyReply, reconnect: boolean) => {
    if (!(await ready())) return reply.code(409).send({ error: 'Complete the first Orbit setup and confirm this address before connecting Google.' });
    const parsed = reconnect ? googleReconnectStartSchema.safeParse(request.body) : googleStartSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the web client ID and client secret from Google Cloud.' });
    const reconnectAccountId = reconnect ? (parsed.data as unknown as { accountId: string }).accountId : null;
    if (reconnectAccountId) {
      const [target] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, reconnectAccountId), eq(accounts.provider, 'google')));
      if (!target) return reply.code(404).send({ error: 'This Google account is no longer connected.' });
    }
    await cleanup();
    const appId = randomUUID();
    const attemptId = randomUUID();
    const state = randomBytes(32).toString('base64url');
    const { url, codeVerifier } = await newProvider(parsed.data.clientId, parsed.data.clientSecret).authorization(state);
    const started = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(81923043)`);
      const [active] = await tx.select({ count: sql<number>`count(*)::integer` }).from(oauthAttempts).where(and(
        eq(oauthAttempts.sessionHash, sessionHash(request.session.sessionId)), gt(oauthAttempts.expiresAt, new Date()),
        sql`${oauthAttempts.status} in ('started', 'returned', 'claimed')`,
      ));
      if ((active?.count ?? 0) >= 3) return false;
      const [marker] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, 'first_orbit_setup_v1'));
      if ((marker?.value as { confirmedOrigin?: string } | undefined)?.confirmedOrigin !== auth.origin) return false;
      const [owner] = await tx.select({ generation: users.authGeneration }).from(users).where(eq(users.id, OWNER_ID)).for('update');
      const [liveSession] = await tx.select({ data: sessions.data }).from(sessions).where(and(
        eq(sessions.tokenHash, sessionHash(request.session.sessionId)), isNull(sessions.revokedAt),
        gt(sessions.lastSeenAt, new Date(Date.now() - 30 * 60_000)),
        gt(sessions.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60_000)),
      )).for('update');
      const principal = liveSession?.data as { userId?: string; authGeneration?: number; recoveryMode?: string } | undefined;
      if (owner?.generation !== request.session.authGeneration || principal?.userId !== OWNER_ID || principal.authGeneration !== owner?.generation || principal.recoveryMode) return false;
      if (reconnectAccountId) {
        const [target] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, reconnectAccountId), eq(accounts.provider, 'google')));
        if (!target) return false;
      }
      await tx.insert(oauthApps).values({ id: appId, provider: 'google', ownerId: OWNER_ID,
        clientId: parsed.data.clientId, encryptedClientSecret: sealSecret(parsed.data.clientSecret, auth.masterKey, appContext(appId)), redirectUri });
      await tx.insert(oauthAttempts).values({ id: attemptId, provider: 'google', appId, stateHash: digest(state),
        sessionHash: sessionHash(request.session.sessionId), authGeneration: request.session.authGeneration!,
        reconnectAccountId,
        encryptedVerifier: sealSecret(codeVerifier, auth.masterKey, attemptContext(attemptId, 'verifier')),
        expiresAt: new Date(Date.now() + TTL_MS) });
      return true;
    });
    if (!started) return reply.code(429).send({ error: 'Confirm the configured address or finish an earlier connection attempt.' });
    return googleStartResponseSchema.parse({ authorizationUrl: url });
  };
  app.post('/api/google/start', (request, reply) => startConnection(request, reply, false));
  app.post('/api/google/reconnect/start', (request, reply) => startConnection(request, reply, true));

  // This public callback is the only connection route that can run without a Strict session cookie.
  app.get(callbackPath, async (request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    const query = request.query as Record<string, unknown>;
    const parsed = googleCallbackSchema.safeParse({ state: query.state, code: query.code, error: query.error });
    if (parsed.success) {
      const [row] = await db.select({ id: oauthAttempts.id }).from(oauthAttempts).where(and(
        eq(oauthAttempts.stateHash, digest(parsed.data.state)), eq(oauthAttempts.provider, 'google'),
        eq(oauthAttempts.status, 'started'), gt(oauthAttempts.expiresAt, new Date()),
      )).limit(1);
      if (row) await db.update(oauthAttempts).set({ status: parsed.data.code ? 'returned' : 'failed',
        encryptedCode: parsed.data.code ? sealSecret(parsed.data.code, auth.masterKey, attemptContext(row.id, 'code')) : null,
        ...(parsed.data.error ? { encryptedVerifier: '' } : {}),
        updatedAt: new Date() }).where(and(eq(oauthAttempts.id, row.id), eq(oauthAttempts.status, 'started')));
    }
    return reply.redirect(continuationPath);
  });

  app.post('/api/google/confirm', async (request, reply) => {
    if (!(await ready())) return reply.code(409).send({ error: 'Confirm the configured HTTPS address again before connecting Google.' });
    const [attempt] = await db.select().from(oauthAttempts).where(and(
      eq(oauthAttempts.provider, 'google'), eq(oauthAttempts.sessionHash, sessionHash(request.session.sessionId)),
      eq(oauthAttempts.authGeneration, request.session.authGeneration!), eq(oauthAttempts.status, 'returned'),
      gt(oauthAttempts.expiresAt, new Date()),
    )).orderBy(desc(oauthAttempts.createdAt)).limit(1);
    if (!attempt?.encryptedCode) return reply.code(409).send({ error: 'No pending Google return was found. Start the connection again in this browser.' });
    const [claimed] = await db.update(oauthAttempts).set({ status: 'claimed', updatedAt: new Date() }).where(and(
      eq(oauthAttempts.id, attempt.id), eq(oauthAttempts.status, 'returned'), gt(oauthAttempts.expiresAt, new Date()),
    )).returning({ id: oauthAttempts.id });
    if (!claimed) return reply.code(409).send(errorResponse);
    const [providerApp] = await db.select().from(oauthApps).where(eq(oauthApps.id, attempt.appId));
    if (!providerApp || providerApp.redirectUri !== redirectUri) {
      await db.update(oauthAttempts).set({ status: 'failed', encryptedCode: null, encryptedVerifier: '' }).where(eq(oauthAttempts.id, attempt.id));
      return reply.code(409).send(errorResponse);
    }
    try {
      const result = await newProvider(providerApp.clientId, openSecret(providerApp.encryptedClientSecret, auth.masterKey, appContext(providerApp.id)))
        .exchange(openSecret(attempt.encryptedCode, auth.masterKey, attemptContext(attempt.id, 'code')),
          openSecret(attempt.encryptedVerifier, auth.masterKey, attemptContext(attempt.id, 'verifier')));
      const accountId = randomUUID();
      const linked = await db.transaction(async (tx) => {
        const [owner] = await tx.select({ generation: users.authGeneration }).from(users).where(eq(users.id, OWNER_ID)).for('update');
        const [liveSession] = await tx.select({ id: sessions.tokenHash, data: sessions.data }).from(sessions).where(and(
          eq(sessions.tokenHash, sessionHash(request.session.sessionId)), isNull(sessions.revokedAt),
          gt(sessions.lastSeenAt, new Date(Date.now() - 30 * 60_000)),
          gt(sessions.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60_000)),
        )).for('update');
        const [marker] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, 'first_orbit_setup_v1'));
        const stored = marker?.value as { orbitId?: string; confirmedOrigin?: string } | undefined;
        const [liveAttempt] = await tx.select({ status: oauthAttempts.status }).from(oauthAttempts).where(and(
          eq(oauthAttempts.id, attempt.id), gt(oauthAttempts.expiresAt, new Date()),
        )).for('update');
        const principal = liveSession?.data as { userId?: string; authGeneration?: number; recoveryMode?: string } | undefined;
        if (owner?.generation !== attempt.authGeneration || principal?.userId !== OWNER_ID || principal.authGeneration !== attempt.authGeneration || principal.recoveryMode || stored?.confirmedOrigin !== auth.origin || liveAttempt?.status !== 'claimed') return 'stale';
        const [orbit] = await tx.select({ id: orbits.id }).from(orbits).where(eq(orbits.id, stored.orbitId!));
        if (!orbit) return 'stale';
        if (attempt.reconnectAccountId) {
          const [target] = await tx.select().from(accounts).where(and(eq(accounts.id, attempt.reconnectAccountId), eq(accounts.provider, 'google'))).for('update');
          if (!target) return 'stale';
          if (target.email.toLowerCase() !== result.email) return 'wrong_account';
          await tx.update(accounts).set({ appId: providerApp.id,
            encryptedRefreshToken: sealSecret(result.refreshToken, auth.masterKey, accountContext(target.id, 'refresh')),
            encryptedAccessToken: sealSecret(result.accessToken, auth.masterKey, accountContext(target.id, 'access')),
            accessTokenExpiresAt: result.accessTokenExpiresAt, grantedScopes: result.scopes,
            credentialGeneration: target.credentialGeneration + 1, credentialLeaseUntil: null,
            revokedAt: null, updatedAt: new Date(),
          }).where(eq(accounts.id, target.id));
          await tx.insert(auditLog).values({ id: randomUUID(), actorId: OWNER_ID, action: 'reconnect_account', targetId: target.id });
          await tx.update(oauthAttempts).set({ status: 'completed', encryptedCode: null, encryptedVerifier: '', updatedAt: new Date() }).where(eq(oauthAttempts.id, attempt.id));
          return 'connected';
        }
        const [existing] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.provider, 'google'), sql`lower(${accounts.email}) = ${result.email}`));
        if (existing) return 'duplicate';
        await tx.insert(accounts).values({ id: accountId, provider: 'google', appId: providerApp.id, orbitId: orbit.id,
          email: result.email, encryptedRefreshToken: sealSecret(result.refreshToken, auth.masterKey, accountContext(accountId, 'refresh')),
          encryptedAccessToken: sealSecret(result.accessToken, auth.masterKey, accountContext(accountId, 'access')),
          accessTokenExpiresAt: result.accessTokenExpiresAt, grantedScopes: result.scopes });
        await tx.insert(auditLog).values({ id: randomUUID(), actorId: OWNER_ID, action: 'connect_account', targetId: accountId });
        await tx.update(oauthAttempts).set({ status: 'completed', encryptedCode: null, encryptedVerifier: '', updatedAt: new Date() }).where(eq(oauthAttempts.id, attempt.id));
        return 'connected';
      });
      if (linked !== 'connected') {
        await db.update(oauthAttempts).set({ status: 'failed', encryptedCode: null, encryptedVerifier: '' }).where(eq(oauthAttempts.id, attempt.id));
        if (linked === 'wrong_account') return reply.code(409).send({ error: 'Google returned a different mailbox. Choose the original mailbox and try reconnecting.' });
        return reply.code(409).send({ error: 'This account is already connected or the login changed. Sign in again and start a new connection.' });
      }
      await cleanup().catch(() => {});
      return googleOkSchema.parse({ ok: true });
    } catch (error) {
      await db.update(oauthAttempts).set({ status: 'failed', encryptedCode: null, encryptedVerifier: '', updatedAt: new Date() }).where(eq(oauthAttempts.id, attempt.id));
      if (error instanceof Error && error.message === 'GOOGLE_CONSENT_INCOMPLETE') return reply.code(403).send({ error: 'Google did not grant mail access and offline refresh. Start again and approve the requested permission.' });
      return reply.code(502).send(errorResponse);
    }
  });

  app.post('/api/google/backfill', async (request, reply) => {
    if (!(await ready())) return reply.code(409).send({ error: 'Confirm the configured HTTPS address again.' });
    const parsed = googleBackfillSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Choose 30 days, 1 year, or all mail.' });
    const [saved] = await db.update(accounts).set({ backfill: parsed.data.window, updatedAt: new Date() }).where(and(
      eq(accounts.id, parsed.data.accountId), eq(accounts.provider, 'google'), isNull(accounts.revokedAt), isNull(accounts.backfill),
    )).returning({ id: accounts.id });
    if (!saved) return reply.code(409).send({ error: 'This account already has a backfill choice or needs to reconnect.' });
    return googleOkSchema.parse({ ok: true });
  });
}
