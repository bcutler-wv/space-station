import type { PgBoss } from 'pg-boss';
import { PROBE_QUEUE } from './queue.js';

type Instance = Awaited<ReturnType<PgBoss['getInstances']>>[number];
type ConsumerInstance = Pick<Instance, 'name' | 'host' | 'live' | 'stoppedOn'> & { workers: Array<{ queue: string }> };

export function hasLiveConsumer(instances: ConsumerInstance[], host: string): boolean {
  return instances.some((instance) =>
    instance.name === 'worker' &&
    instance.host === host &&
    instance.live &&
    instance.stoppedOn === null &&
    instance.workers.some((worker) => worker.queue === PROBE_QUEUE),
  );
}
