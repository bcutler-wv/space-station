import { PgBoss } from 'pg-boss';

export const PROBE_QUEUE = 'runtime.probe';
export const GMAIL_DISCOVER_QUEUE = 'gmail.discover';
export const GMAIL_SYNC_QUEUE = 'gmail.sync';
export const MAIL_BLOB_CLEANUP_QUEUE = 'mail.blob_cleanup';

export function makeBoss(connectionString: string, migrate = false, registerInstance = true): PgBoss {
  return new PgBoss({ connectionString, migrate, registerInstance, instanceName: 'worker', instanceHeartbeatSeconds: 5 });
}
