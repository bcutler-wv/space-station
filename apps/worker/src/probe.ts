import { databaseUrl, loadRuntimeConfig } from '@station/db';
import { randomUUID } from 'node:crypto';
import { makeBoss, PROBE_QUEUE } from './queue.js';

const [command, id] = process.argv.slice(2);
const boss = makeBoss(databaseUrl(loadRuntimeConfig(process.env)), false, false);
await boss.start();
try {
  if (command === 'send') {
    const jobId = await boss.send(PROBE_QUEUE, { nonce: randomUUID() });
    if (!jobId) throw new Error('Probe job was not queued');
    console.log(jobId);
  } else if ((command === 'status' || command === 'wait') && id) {
    const deadline = Date.now() + (command === 'wait' ? 30_000 : 0);
    let state = 'missing';
    do {
      const jobs = await boss.findJobs(PROBE_QUEUE, { id });
      state = jobs[0]?.state ?? 'missing';
      if (state === 'completed') break;
      if (command === 'status' || state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    console.log(state);
    if (command === 'wait' && state !== 'completed') process.exitCode = 1;
  } else {
    throw new Error('Usage: probe send | status <id> | wait <id>');
  }
} finally {
  await boss.stop();
}
