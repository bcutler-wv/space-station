import Fastify from 'fastify';
import { healthResponseSchema, readinessResponseSchema } from '@station/shared';
import { registerAppearance, type AppearanceStore } from './appearance.js';
import { registerAuth, type AuthConfig } from './auth.js';
import { registerSetup } from './setup.js';
import { databaseSetupStore } from './setup-store.js';

export function buildApp(checkDatabase: () => Promise<void> = async () => {}, appearanceStore?: AppearanceStore, auth?: AuthConfig, transport?: { key?: Buffer; cert?: Buffer; trustedProxyIp?: string }) {
  const app = Fastify({
    ...(transport?.key && transport.cert ? { https: { key: transport.key, cert: transport.cert } } : {}),
    ...(transport?.trustedProxyIp ? { trustProxy: (address: string) => address === transport.trustedProxyIp } : {}),
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(status).send({ error: status === 413 ? 'Upload a file under 4 MB.' : 'The request could not be completed.' });
  });
  if (appearanceStore && !auth) throw new Error('Authentication is required before registering private routes.');
  if (auth) void app.register(async (instance) => {
    await registerAuth(instance, auth);
    if (appearanceStore) registerAppearance(instance, appearanceStore);
    registerSetup(instance, databaseSetupStore(auth.db), auth.origin);
  });
  app.get('/health', async () => healthResponseSchema.parse({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await checkDatabase();
      return readinessResponseSchema.parse({ status: 'ready' });
    } catch {
      reply.code(503);
      return readinessResponseSchema.parse({ status: 'unavailable' });
    }
  });
  return app;
}
