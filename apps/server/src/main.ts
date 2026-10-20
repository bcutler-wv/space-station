import { databaseUrl, loadRuntimeConfig, openDatabase, PrivateBlobStore, settings } from '@station/db';
import { readFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { registerWebStatic } from './web-static.js';
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
}, new PrivateBlobStore(process.env.PRIVATE_BLOB_DIR ?? '/var/lib/station/blobs'));
app.addHook('onClose', database.close);
await registerWebStatic(app, config.APP_ORIGIN);
try {
  await app.listen({ host: config.APP_HOST, port: config.APP_PORT });
} catch {
  console.error('API startup failed. Check database and runtime configuration.');
  process.exitCode = 1;
}
