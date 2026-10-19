import { databaseUrl, loadRuntimeConfig } from '@station/db';
import { makeBoss, PROBE_QUEUE } from './queue.js';

const boss = makeBoss(databaseUrl(loadRuntimeConfig(process.env)));
boss.on('error', () => console.error('Queue connection error.'));
await boss.start();
await boss.work<{ nonce: string }, { received: string }>(PROBE_QUEUE, async ([job]) => {
  if (!job || typeof job.data.nonce !== 'string') throw new Error('Invalid probe payload');
  return { received: job.data.nonce };
});
console.info('Runtime probe worker ready.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void boss.stop().then(() => { process.exitCode = 0; }); });
}
