import fastifyStatic from '@fastify/static';
import { databaseUrl, loadRuntimeConfig, openDatabase, settings } from '@station/db';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { databaseAppearanceStore } from './appearance-store.js';

const config = loadRuntimeConfig(process.env);
const database = openDatabase(databaseUrl(config));
const app = buildApp(async () => { await database.db.select().from(settings).limit(1); }, databaseAppearanceStore(database.db));
app.addHook('onClose', database.close);
await app.register(fastifyStatic, {
  root: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
});
try {
  await app.listen({ host: config.APP_HOST, port: config.APP_PORT });
} catch {
  console.error('API startup failed. Check database and runtime configuration.');
  process.exitCode = 1;
}
