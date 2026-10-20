import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { eventClock, syncEvents } from './schema.js';
import type { openDatabase } from './connection.js';
import { syncChangeEventSchema } from '@station/shared';

type Database = ReturnType<typeof openDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type SyncEventKind = 'sync-progress' | 'mail-changed';
export const EVENT_REPLAY_LIMIT = 128;
export const EVENT_RETENTION = 512;

/** Limit database resources used by a passive SSE read, including lock waits.
 * SET LOCAL resets both settings when this transaction ends. */
export async function boundSyncStreamRead(tx: Transaction): Promise<void> {
  await tx.execute(sql`set local statement_timeout = '1250ms'`);
  await tx.execute(sql`set local lock_timeout = '1000ms'`);
}

/** Call only inside the transaction that changed progress or mail. The counter
 * update locks its singleton row until commit, so IDs follow commit order. */
export async function appendSyncEvent(tx: Transaction, kind: SyncEventKind, accountId: string): Promise<number> {
  syncChangeEventSchema.parse({ event: kind, id: '0', accountId });
  const [clock] = await tx.insert(eventClock).values({ id: 1, nextId: 0 }).onConflictDoUpdate({
    target: eventClock.id, set: { nextId: sql`${eventClock.nextId} + 1` },
  }).returning({ id: eventClock.nextId });
  // First insert initializes the clock at zero; increment it in the same lock.
  const id = clock!.id === 0 ? (await tx.update(eventClock).set({ nextId: 1 }).where(eq(eventClock.id, 1)).returning({ id: eventClock.nextId }))[0]!.id : clock!.id;
  await tx.insert(syncEvents).values({ id, kind, accountId });
  await tx.delete(syncEvents).where(lte(syncEvents.id, id - EVENT_RETENTION));
  return id;
}

export async function readSyncEvents(db: Database, cursor: number | null, afterBoundsRead?: () => Promise<void>) {
  return db.transaction(async (tx) => {
    await boundSyncStreamRead(tx);
    const [clock] = await tx.select({ head: eventClock.nextId }).from(eventClock).where(eq(eventClock.id, 1));
    const head = clock?.head ?? 0;
    const [oldest] = await tx.select({ id: syncEvents.id }).from(syncEvents).orderBy(asc(syncEvents.id)).limit(1);
    const gap = cursor !== null && (cursor > head || cursor < (oldest?.id ?? head + 1) - 1 || head - cursor > EVENT_REPLAY_LIMIT);
    // Diagnostic barrier exercises pruning while this read transaction is open.
    await afterBoundsRead?.();
    const rows = cursor === null || gap ? [] : await tx.select({ id: syncEvents.id, kind: syncEvents.kind, accountId: syncEvents.accountId })
      .from(syncEvents).where(and(gt(syncEvents.id, cursor), sql`${syncEvents.id} <= ${head}`))
      .orderBy(asc(syncEvents.id)).limit(EVENT_REPLAY_LIMIT);
    return { head, gap, rows };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
