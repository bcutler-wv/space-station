import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URLSearchParams } from 'node:url';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { buildApp } from '../../apps/server/dist/app.js';
import { registerWebStatic } from '../../apps/server/dist/web-static.js';
import { accounts, appendSyncEvent, databaseUrl, loadRuntimeConfig, openDatabase, sessions, settings, syncStates } from '../../packages/db/dist/index.js';
import { databaseAppearanceStore } from '../../apps/server/dist/appearance-store.js';
import { authStore } from '../../apps/server/dist/auth-store.js';

// Separate CI-only process. The production entrypoint never imports this transport or observer.
const config = loadRuntimeConfig(process.env);
if (!config.APP_TLS_KEY_PATH || !config.APP_TLS_CERT_PATH) throw new Error('HTTPS certificate required for Google browser fixture.');
const database = openDatabase(databaseUrl(config));
const callbackCookies = [];
let providerCalls = 0;
let profileEmail = 'owner@example.com';
let streamOpens = 0;
let activeStreams = 0;
let progressReads = 0;
const transport = { interceptors: { request: { add() {} }, response: { add() {} } }, async request(options) {
  providerCalls++;
  if (options.url?.includes('/token')) {
    const code = new URLSearchParams(options.data).get('code');
    profileEmail = code === 'fixture-wrong-code' ? 'other@example.com' : 'owner@example.com';
    return { data: { access_token: `fixture-access-${code}`, refresh_token: `fixture-refresh-${code}`, scope: 'https://www.googleapis.com/auth/gmail.modify', token_type: 'Bearer', expires_in: 3600 } };
  }
  if (options.url?.includes('/profile')) return { data: { emailAddress: profileEmail } };
  throw new Error('Unexpected provider request.');
} };
const app = buildApp(async () => { await database.db.select().from(settings).limit(1); }, databaseAppearanceStore(database.db), {
  origin: config.APP_ORIGIN, masterKey: Buffer.from(config.STATION_MASTER_KEY, 'base64'), db: database.db,
  store: authStore(database.db), googleTransport: transport,
}, { key: readFileSync(config.APP_TLS_KEY_PATH), cert: readFileSync(config.APP_TLS_CERT_PATH) });
app.addHook('onRequest', async (request) => {
  if (request.url.startsWith('/api/google/callback')) callbackCookies.push(Boolean(request.headers.cookie));
  if (request.url === '/api/sync/progress') progressReads++;
  if (request.url === '/api/sync/events') {
    streamOpens++; activeStreams++;
    request.raw.once('close', () => { activeStreams--; });
  }
});
app.get('/fixture/observations', async () => {
  const [session] = await database.db.select({ lastSeenAt: sessions.lastSeenAt }).from(sessions).orderBy(desc(sessions.createdAt)).limit(1);
  return { callbackCookies, providerCalls, streamOpens, activeStreams, progressReads, lastSeenAt: session?.lastSeenAt?.toISOString() ?? null };
});
// Test-server-only state writer. It uses the production transaction and journal.
app.post('/fixture/progress', async (request) => {
  const { phase, lastError = null, retryAt = 0 } = request.body;
  if (!['full', 'history', 'ready'].includes(phase)) throw new Error('Invalid fixture phase');
  const [account] = await database.db.select().from(accounts).where(eq(accounts.email, 'owner@example.com'));
  if (!account) throw new Error('Fixture account missing');
  await database.db.transaction(async (tx) => {
    const [state] = await tx.select().from(syncStates).where(eq(syncStates.accountId, account.id));
    const values = { cursor: { phase, retryAt }, lastError, status: lastError ? 'blocked' : 'idle', lastSuccessAt: new Date(), sequence: (state?.sequence ?? 0) + 1 };
    if (state) await tx.update(syncStates).set(values).where(eq(syncStates.id, state.id));
    else await tx.insert(syncStates).values({ id: randomUUID(), accountId: account.id, resource: 'mail', collectionId: 'primary', ...values });
    await appendSyncEvent(tx, 'sync-progress', account.id);
  });
  return { ok: true };
});
app.addHook('onClose', database.close);
await registerWebStatic(app, config.APP_ORIGIN);
await app.listen({ host: config.APP_HOST, port: config.APP_PORT });
