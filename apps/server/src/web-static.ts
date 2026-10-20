import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';

export async function registerWebStatic(app: FastifyInstance, origin: string) {
  await app.register(fastifyStatic, { root: fileURLToPath(new URL('../../web/dist/', import.meta.url)) });
  app.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, origin).pathname;
    if (pathname.startsWith('/api/')) return reply.code(404).send({ error: 'API route not found.' });
    if (request.method === 'GET' && (pathname === '/' || pathname === '/setup' || pathname === '/setup/google' || pathname === '/setup/google/continue' || /^\/demo\/orbits\/[a-z0-9-]+$/.test(pathname))) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Page not found.' });
  });
}
