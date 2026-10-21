import { Buffer } from 'node:buffer';
import console from 'node:console';
import { URL } from 'node:url';
import process from 'node:process';
import { databaseUrl, loadRuntimeConfig, openDatabase, PrivateBlobStore, settings } from '../../packages/db/dist/index.js';
import { GmailReadAdapter, GmailSendAdapter, GoogleCredentialService } from '../../packages/connectors/dist/index.js';
import { GmailSyncRunner } from '../../apps/worker/dist/gmail-sync.js';
import { makeBoss, GMAIL_DISCOVER_QUEUE, GMAIL_SYNC_QUEUE } from '../../apps/worker/dist/queue.js';
import { parseMail } from '../../apps/worker/dist/mail-parser-client.js';
import { createMailParserServer } from '../../apps/worker/dist/mail-parser-service.js';
import { buildApp } from '../../apps/server/dist/app.js';
import { authStore } from '../../apps/server/dist/auth-store.js';

const fetch = globalThis.fetch;
const Request = globalThis.Request;
const role = process.argv[2];
const config = loadRuntimeConfig(process.env);
const providerPort = Number(process.env.FIXTURE_PROVIDER_PORT);
const parserPort = Number(process.env.FIXTURE_PARSER_PORT);
const blobRoot = process.env.STATION_TEST_BLOB_ROOT;
if (!providerPort || !parserPort || !blobRoot) throw new Error('Missing process fixture configuration');
const dbHandle = role === 'provider' || role === 'parser' ? null : openDatabase(databaseUrl(config));
const blobs = new PrivateBlobStore(blobRoot);
const relay = async (input, init) => {
  const original = input instanceof Request ? input : new Request(input, init);
  const url = new URL(original.url);
  if (url.origin !== 'https://gmail.googleapis.com') throw new Error('Unexpected provider origin');
  const target = `http://127.0.0.1:${providerPort}${url.pathname}${url.search}`;
  return fetch(target, { method: original.method, headers: original.headers,
    ...(original.method === 'GET' || original.method === 'HEAD' ? {} : { body: await original.arrayBuffer() }),
    signal: init?.signal ?? original.signal, redirect: 'error' });
};
const credentials = dbHandle && new GoogleCredentialService(dbHandle.db, Buffer.from(config.STATION_MASTER_KEY, 'base64'));
const stop = async (server, boss) => {
  try { if (server) await new Promise((resolve) => server.close(resolve)); } catch { /* fixture teardown */ }
  try { if (boss) await boss.stop({ timeout: 10_000 }); } catch { /* fixture teardown */ }
  await dbHandle?.close();
};
if (role === 'parser') {
  const server = createMailParserServer();
  server.listen(parserPort, '127.0.0.1', () => console.log('parser ready'));
  process.on('SIGTERM', () => { void stop(server); });
} else if (role === 'worker' || role === 'lease-probe') {
  const reader = new GmailReadAdapter(credentials, relay);
  const parserFetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href !== 'http://mime-parser:8090/parse') throw new Error('Unexpected parser endpoint');
    return fetch(`http://127.0.0.1:${parserPort}/parse`, init);
  };
  const sync = new GmailSyncRunner(dbHandle.db, blobs, reader, config.APP_ORIGIN,
    (raw, signal) => parseMail(raw, parserFetch, signal));
  if (role === 'lease-probe') {
    await sync.run(process.argv[3]);
    console.log('lease probe finished');
    await dbHandle.close();
    process.exit(0);
  }
  const boss = makeBoss(databaseUrl(config), false, false);
  await boss.start();
  await boss.work(GMAIL_DISCOVER_QUEUE, { pollingIntervalSeconds: 0.5 }, async () => {
    for (const accountId of await sync.discover())
      await boss.send(GMAIL_SYNC_QUEUE, { accountId }, { singletonKey: accountId });
  });
  await boss.work(GMAIL_SYNC_QUEUE, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
    if (!job || typeof job.data.accountId !== 'string') throw new Error('Invalid Gmail sync payload');
    await sync.run(job.data.accountId, job.signal);
  });
  await boss.send(GMAIL_DISCOVER_QUEUE, {}, { singletonKey: 'discovery' });
  console.log('worker ready');
  process.on('SIGTERM', () => { void stop(null, boss); });
} else if (role === 'app') {
  const provider = new GmailSendAdapter(credentials, relay);
  const app = buildApp(async () => { await dbHandle.db.select().from(settings).limit(1); }, undefined,
    { db: dbHandle.db, origin: config.APP_ORIGIN, masterKey: Buffer.from(config.STATION_MASTER_KEY, 'base64'), store: authStore(dbHandle.db) },
    { trustedProxyIp: '127.0.0.1' }, blobs, undefined, undefined, provider);
  await app.listen({ host: '127.0.0.1', port: Number(process.env.FIXTURE_APP_PORT) });
  console.log('app ready');
  process.on('SIGTERM', () => { void app.close().then(() => dbHandle.close()); });
} else throw new Error('Unknown fixture process role');
