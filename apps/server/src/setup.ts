import type { FastifyInstance } from 'fastify';
import { setupOriginSchema, setupSubmitSchema } from '@station/shared';
import type { SetupStore } from './setup-store.js';

export function registerSetup(app: FastifyInstance, store: SetupStore, origin: string) {
  app.get('/api/setup', async () => store.get(origin));
  app.post('/api/setup', async (request, reply) => {
    const parsed = setupSubmitSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Check the Orbit and privacy choices, then try again.' });
    if (parsed.data.confirmedOrigin !== origin) return reply.code(400).send({ error: 'Open the configured HTTPS address and confirm it before continuing.' });
    if (parsed.data.exclusions.some((rule) => ['account', 'sender'].includes(rule.kind) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rule.value))) return reply.code(400).send({ error: 'Use a full email address for account and sender rules.' });
    const keys = parsed.data.exclusions.map((rule) => `${rule.scope}|${rule.kind}|${rule.value.trim().toLowerCase()}|${rule.effect}`);
    if (new Set(keys).size !== keys.length) return reply.code(400).send({ error: 'Remove duplicate exclusions and try again.' });
    const result = await store.complete(parsed.data, origin);
    if (!result) return reply.code(409).send({ error: 'First Orbit setup is already complete. Reload to continue.' });
    return reply.code(201).send(result);
  });
  app.put('/api/setup/origin', async (request, reply) => {
    const parsed = setupOriginSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.confirmedOrigin !== origin) return reply.code(400).send({ error: 'Open the configured HTTPS address and confirm it before continuing.' });
    const result = await store.reconfirmOrigin(origin);
    return result ?? reply.code(409).send({ error: 'Create the first Orbit before confirming this address.' });
  });
}
