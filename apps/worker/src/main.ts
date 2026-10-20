import { databaseUrl, loadRuntimeConfig, openDatabase, PrivateBlobStore } from '@station/db';
import { GmailReadAdapter, GoogleCredentialService } from '@station/connectors';
import { GmailSyncRunner } from './gmail-sync.js';
import { makeBoss, PROBE_QUEUE, GMAIL_DISCOVER_QUEUE, GMAIL_SYNC_QUEUE, MAIL_BLOB_CLEANUP_QUEUE } from './queue.js';

const config = loadRuntimeConfig(process.env);
const connectionString = databaseUrl(config);
const database = openDatabase(connectionString);
const reader = new GmailReadAdapter(new GoogleCredentialService(database.db, Buffer.from(config.STATION_MASTER_KEY, 'base64')));
const sync = new GmailSyncRunner(database.db, new PrivateBlobStore('/var/lib/station/blobs'), reader, config.APP_ORIGIN);
const boss = makeBoss(connectionString);
const shutdown = new AbortController();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    // pg-boss waits for handlers before stopping; the runner checks this signal after
    // every bounded read/parse and releases its fenced lease before the DB is closed.
    void boss.stop({ timeout: 90_000 }).then(() => database.close()).then(() => { process.exitCode = 0; })
      .catch(() => { process.exitCode = 1; });
  });
}
boss.on('error', () => console.error('Queue connection error.'));
await boss.start();
await boss.work<{ nonce: string }, { received: string }>(PROBE_QUEUE, async ([job]) => {
  if (!job || typeof job.data.nonce !== 'string') throw new Error('Invalid probe payload');
  return { received: job.data.nonce };
});
await boss.work(GMAIL_DISCOVER_QUEUE, async () => {
  try {
    for (const accountId of await sync.discover()) await boss.send(GMAIL_SYNC_QUEUE, { accountId }, { singletonKey: accountId });
  } catch { throw new Error('Gmail discovery failed'); }
});
await boss.work<{ accountId: string }>(GMAIL_SYNC_QUEUE, async ([job]) => {
  if (!job || typeof job.data.accountId !== 'string') throw new Error('Invalid Gmail sync payload');
  try { await sync.run(job.data.accountId, AbortSignal.any([job.signal, shutdown.signal])); }
  catch { throw new Error('Gmail sync could not start'); }
});
await boss.work(MAIL_BLOB_CLEANUP_QUEUE, async () => {
  try { await sync.collect(); }
  catch { throw new Error('Mail blob cleanup failed'); }
});
await boss.schedule(GMAIL_DISCOVER_QUEUE, '* * * * *', {}, { singletonKey: 'discovery' });
await boss.schedule(MAIL_BLOB_CLEANUP_QUEUE, '*/5 * * * *', {}, { singletonKey: 'cleanup' });
await boss.send(GMAIL_DISCOVER_QUEUE, {}, { singletonKey: 'discovery' });
console.info('Runtime probe worker ready.');
