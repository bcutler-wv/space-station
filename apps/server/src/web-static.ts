import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';

export async function registerWebStatic(app: FastifyInstance, origin: string) {
  app.addHook('onSend', (_request, reply, payload, done) => {
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'self'; form-action 'self'");
    done(null, payload);
  });
  await app.register(fastifyStatic, { root: fileURLToPath(new URL('../../web/dist/', import.meta.url)) });
  app.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, origin).pathname;
    if (pathname.startsWith('/api/')) return reply.code(404).send({ error: 'API route not found.' });
    if (request.method === 'GET' && (pathname === '/' || pathname === '/mail' || /^\/mail\/thread\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(pathname) || /^\/mail\/draft\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(pathname) || pathname === '/setup' || pathname === '/setup/google' || pathname === '/setup/google/continue' || /^\/demo\/orbits\/[a-z0-9-]+$/.test(pathname) || /^\/mail\/body\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(pathname))) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Page not found.' });
  });
}
