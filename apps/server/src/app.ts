import Fastify from 'fastify';
import { healthResponseSchema, readinessResponseSchema } from '@station/shared';
import { registerAppearance, type AppearanceStore } from './appearance.js';

export function buildApp(checkDatabase: () => Promise<void> = async () => {}, appearanceStore?: AppearanceStore) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(status).send({ error: status === 413 ? 'Upload a file under 4 MB.' : 'The request could not be completed.' });
  });
  if (appearanceStore) registerAppearance(app, appearanceStore);
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
