import fastifyStatic from "../../apps/server/node_modules/@fastify/static/index.js";
import { fileURLToPath, URL } from "node:url";
import { buildApp } from "../../apps/server/dist/app.js";
import {
  defaultAppearance,
  registerAppearance,
} from "../../apps/server/dist/appearance.js";

// Browser-test process only. Production always uses PostgreSQL through main.js.
let appearance = { ...defaultAppearance };
const store = {
  get: async () => appearance,
  patch: async (value) => {
    appearance = { ...appearance, ...value };
    return appearance;
  },
};
const app = buildApp();
app.get("/api/auth/status", async () => ({
  ownerExists: true,
  authenticated: true,
  recoveryAuthenticated: false,
  recoveryMode: null,
  pendingTotpUri: null,
  csrfToken: "fixture-token",
}));
registerAppearance(app, store);
await app.register(fastifyStatic, {
  root: fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)),
});
app.setNotFoundHandler((request, reply) => {
  const pathname = new URL(request.url, 'http://127.0.0.1:4173').pathname;
  if (pathname.startsWith('/api/')) return reply.code(404).send({ error: 'API route not found.' });
  if (request.method === 'GET' && (pathname === '/' || pathname === '/setup' || /^\/demo\/orbits\/[a-z0-9-]+$/.test(pathname))) return reply.sendFile('index.html');
  return reply.code(404).send({ error: 'Page not found.' });
});
await app.listen({ host: "127.0.0.1", port: 4173 });
