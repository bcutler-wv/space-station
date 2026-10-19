import Fastify from 'fastify';
import { healthResponseSchema, readinessResponseSchema } from '@station/shared';

export function buildApp(checkDatabase: () => Promise<void> = async () => {}) {
  const app = Fastify();
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
