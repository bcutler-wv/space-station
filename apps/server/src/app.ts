import Fastify from 'fastify';
import { healthResponseSchema, readinessResponseSchema } from '@station/shared';
import { registerAppearance, type AppearanceStore } from './appearance.js';
import { registerAuth, type AuthConfig } from './auth.js';
import { registerSetup } from './setup.js';
import { databaseSetupStore } from './setup-store.js';
import { registerGoogle } from './google.js';
import { registerSync } from './sync.js';
import { registerMailReader } from './mail-reader.js';
import { registerDrafts } from './drafts.js';
import { registerDraftAttachments } from './draft-attachments.js';
import { registerSend } from './send.js';
import { registerMailChange } from './mail-change.js';
import { registerMailActionOptions } from './mail-action-options.js';
import type { GmailReadAdapter, GmailSendAdapter, GmailChangeAdapter } from '@station/connectors';
import { registerMailImages, type MailImageProxyConfig } from './mail-images.js';
import type { PrivateBlobStore } from '@station/db';

export function buildApp(checkDatabase: () => Promise<void> = async () => {}, appearanceStore?: AppearanceStore, auth?: AuthConfig, transport?: { key?: Buffer; cert?: Buffer; trustedProxyIp?: string }, mailBlobStore?: PrivateBlobStore, mailImageProxy?: MailImageProxyConfig,
  replyReader?: Pick<GmailReadAdapter, 'getReplyHeaders'>,
  sendProvider?: Pick<GmailSendAdapter, 'credential' | 'send' | 'findSent'>,
  changeProvider?: Pick<GmailChangeAdapter, 'credential' | 'inspectMessage' | 'inspectUserLabel' | 'modify' | 'inspectOptions'>) {
  const app = Fastify({
    ...(transport?.key && transport.cert ? { https: { key: transport.key, cert: transport.cert } } : {}),
    ...(transport?.trustedProxyIp ? { trustProxy: (address: string) => address === transport.trustedProxyIp } : {}),
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(status).send({ error: status === 413 ? 'Upload a file under 4 MB.' : status === 429 ? 'Too many requests. Wait a minute and try again.' : 'The request could not be completed.' });
  });
  if (appearanceStore && !auth) throw new Error('Authentication is required before registering private routes.');
  if (auth) void app.register(async (instance) => {
    await registerAuth(instance, auth);
    if (appearanceStore) registerAppearance(instance, appearanceStore);
    registerSetup(instance, databaseSetupStore(auth.db), auth.origin);
    registerGoogle(instance, auth, databaseSetupStore(auth.db));
    await registerSync(instance, auth);
    registerMailReader(instance, auth, mailBlobStore);
    registerDrafts(instance, auth, replyReader);
    if (mailBlobStore) registerDraftAttachments(instance, auth, mailBlobStore);
    if (mailBlobStore) registerSend(instance, auth, mailBlobStore, sendProvider);
    registerMailChange(instance, auth, changeProvider);
    registerMailActionOptions(instance, auth, changeProvider);
    if (mailBlobStore && mailImageProxy) registerMailImages(instance, auth, mailBlobStore, mailImageProxy);
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
