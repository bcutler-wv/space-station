import fastifyStatic from '@fastify/static';
import { databaseUrl, loadRuntimeConfig, openDatabase, settings } from '@station/db';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { databaseAppearanceStore } from './appearance-store.js';
import { authStore } from './auth-store.js';

const config = loadRuntimeConfig(process.env);
const database = openDatabase(databaseUrl(config));
if (Boolean(config.APP_TLS_KEY_PATH) !== Boolean(config.APP_TLS_CERT_PATH)) throw new Error('Set both APP_TLS_KEY_PATH and APP_TLS_CERT_PATH.');
if (!config.APP_TLS_KEY_PATH && !config.APP_TRUSTED_PROXY_IP) throw new Error('Configure direct TLS or an exact trusted HTTPS reverse proxy IP.');
const app = buildApp(async () => { await database.db.select().from(settings).limit(1); }, databaseAppearanceStore(database.db), {
  origin: config.APP_ORIGIN,
  masterKey: Buffer.from(config.STATION_MASTER_KEY, 'base64'),
  db: database.db,
  store: authStore(database.db),
}, {
  ...(config.APP_TLS_KEY_PATH ? { key: readFileSync(config.APP_TLS_KEY_PATH), cert: readFileSync(config.APP_TLS_CERT_PATH) } : {}),
  ...(config.APP_TRUSTED_PROXY_IP ? { trustedProxyIp: config.APP_TRUSTED_PROXY_IP } : {}),
});
app.addHook('onClose', database.close);
await app.register(fastifyStatic, {
  root: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
});
app.setNotFoundHandler((request, reply) => {
  const pathname = new URL(request.url, config.APP_ORIGIN).pathname;
  if (pathname.startsWith('/api/')) return reply.code(404).send({ error: 'API route not found.' });
  if (request.method === 'GET' && (pathname === '/' || pathname === '/setup' || /^\/demo\/orbits\/[a-z0-9-]+$/.test(pathname))) return reply.sendFile('index.html');
  return reply.code(404).send({ error: 'Page not found.' });
});
try {
  await app.listen({ host: config.APP_HOST, port: config.APP_PORT });
} catch {
  console.error('API startup failed. Check database and runtime configuration.');
  process.exitCode = 1;
}
