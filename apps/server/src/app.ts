import Fastify from 'fastify';
import { healthResponseSchema } from '@station/shared';

export function buildApp() {
  const app = Fastify();
  app.get('/health', async () => healthResponseSchema.parse({ status: 'ok' }));
  return app;
}
