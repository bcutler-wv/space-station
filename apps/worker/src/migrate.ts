import { databaseUrl, loadRuntimeConfig, migrateDatabase } from '@station/db';
import { makeBoss, PROBE_QUEUE } from './queue.js';

const connectionString = databaseUrl(loadRuntimeConfig(process.env));
await migrateDatabase(connectionString, async () => {
  const boss = makeBoss(connectionString, true, false);
  try {
    await boss.start();
    await boss.createQueue(PROBE_QUEUE, { deleteAfterSeconds: 3600, retentionSeconds: 3600, retryLimit: 0 });
  } finally {
    await boss.stop();
  }
});
console.info('Database and queue migrations complete.');
