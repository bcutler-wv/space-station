import { databaseUrl, loadRuntimeConfig, migrateDatabase } from '@station/db';
import { makeBoss, PROBE_QUEUE, GMAIL_DISCOVER_QUEUE, GMAIL_SYNC_QUEUE, MAIL_BLOB_CLEANUP_QUEUE, DRAFT_BLOB_CLEANUP_QUEUE } from './queue.js';

const connectionString = databaseUrl(loadRuntimeConfig(process.env));
await migrateDatabase(connectionString, async () => {
  const boss = makeBoss(connectionString, true, false);
  try {
    await boss.start();
    await boss.createQueue(PROBE_QUEUE, { deleteAfterSeconds: 3600, retentionSeconds: 3600, retryLimit: 0 });
    await boss.createQueue(GMAIL_DISCOVER_QUEUE, { policy: 'stately', deleteAfterSeconds: 3600, retentionSeconds: 3600, retryLimit: 2, retryDelay: 30 });
    await boss.createQueue(GMAIL_SYNC_QUEUE, { policy: 'stately', deleteAfterSeconds: 3600, retentionSeconds: 3600, retryLimit: 0, expireInSeconds: 900 });
    await boss.createQueue(MAIL_BLOB_CLEANUP_QUEUE, { policy: 'stately', deleteAfterSeconds: 3600, retentionSeconds: 3600, retryLimit: 2, retryDelay: 30 });
    await boss.createQueue(DRAFT_BLOB_CLEANUP_QUEUE, { policy: 'stately', deleteAfterSeconds: 3600, retentionSeconds: 3600, retryLimit: 2, retryDelay: 30 });
  } finally {
    await boss.stop();
  }
});
console.info('Database and queue migrations complete.');
