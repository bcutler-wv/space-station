import { databaseUrl, loadRuntimeConfig } from '@station/db';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { makeBoss, PROBE_QUEUE } from './queue.js';
import { hasLiveConsumer } from './readiness.js';

const boss = makeBoss(databaseUrl(loadRuntimeConfig(process.env)), false, false);
try {
  await boss.start();
  const instances = await boss.getInstances();
  if (!hasLiveConsumer(instances, hostname())) {
    process.exitCode = 1;
  } else {
    const nonce = randomUUID();
    const id = await boss.send(PROBE_QUEUE, { nonce });
    if (!id) throw new Error('Health probe was not queued');
    const deadline = Date.now() + 10_000;
    let completed = false;
    do {
      const [job] = await boss.findJobs(PROBE_QUEUE, { id });
      if (job?.state === 'completed') {
        completed = job.output !== null && typeof job.output === 'object' && 'received' in job.output && job.output.received === nonce;
        break;
      }
      if (job?.state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    if (!completed) process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
} finally {
  await boss.stop().catch(() => {});
}
