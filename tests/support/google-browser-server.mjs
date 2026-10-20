import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URLSearchParams } from 'node:url';
import { buildApp } from '../../apps/server/dist/app.js';
import { registerWebStatic } from '../../apps/server/dist/web-static.js';
import { databaseUrl, loadRuntimeConfig, openDatabase, settings } from '../../packages/db/dist/index.js';
import { databaseAppearanceStore } from '../../apps/server/dist/appearance-store.js';
import { authStore } from '../../apps/server/dist/auth-store.js';

// Separate CI-only process. The production entrypoint never imports this transport or observer.
const config = loadRuntimeConfig(process.env);
if (!config.APP_TLS_KEY_PATH || !config.APP_TLS_CERT_PATH) throw new Error('HTTPS certificate required for Google browser fixture.');
const database = openDatabase(databaseUrl(config));
const callbackCookies = [];
let providerCalls = 0;
let profileEmail = 'owner@example.com';
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
});
app.get('/fixture/observations', async () => ({ callbackCookies, providerCalls }));
app.addHook('onClose', database.close);
await registerWebStatic(app, config.APP_ORIGIN);
await app.listen({ host: config.APP_HOST, port: config.APP_PORT });
