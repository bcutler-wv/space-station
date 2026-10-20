import { buildApp } from "../../apps/server/dist/app.js";
import { registerWebStatic } from "../../apps/server/dist/web-static.js";
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
// A real, browser-native stream for UI fixtures. This process has fake auth and
// no database; production never imports it.
const streams = new Set();
let syncId = 0;
app.get('/api/sync/events', async (_request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  reply.raw.write('event: sync-reset\nid: 0\ndata: ""\n\n');
  streams.add(reply.raw);
  reply.raw.once('close', () => streams.delete(reply.raw));
});
app.post('/fixture/sync-event', async () => {
  syncId++;
  for (const stream of streams) stream.write(`event: sync-progress\nid: ${syncId}\ndata: "11111111-1111-4111-8111-111111111111"\n\n`);
  return { streams: streams.size };
});
await registerWebStatic(app, 'http://127.0.0.1:4173');
await app.listen({ host: "127.0.0.1", port: 4173 });
