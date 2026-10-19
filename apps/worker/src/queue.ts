import { PgBoss } from 'pg-boss';

export const PROBE_QUEUE = 'runtime.probe';

export function makeBoss(connectionString: string, migrate = false, registerInstance = true): PgBoss {
  return new PgBoss({ connectionString, migrate, registerInstance, instanceName: 'worker', instanceHeartbeatSeconds: 5 });
}
