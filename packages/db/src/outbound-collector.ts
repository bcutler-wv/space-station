import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, drafts, outboundOperations } from './schema.js';
import type { openDatabase } from './connection.js';
import { PrivateBlobStore } from './private-blob-store.js';

type Database = ReturnType<typeof openDatabase>['db'];

/** Recovery never calls Gmail. A claimed call becomes unknown; abandoned
 * preparation can be safely failed because no send claim was committed. */
export async function collectOutboundOperations(db: Database, store: PrivateBlobStore, limit = 25): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid outbound collector limit');
  const candidates = await db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    return tx.select({ id: outboundOperations.id }).from(outboundOperations)
      .where(sql`(${outboundOperations.state} = 'pending' and ${outboundOperations.updatedAt} < now() - interval '5 minutes')
        or (${outboundOperations.state} = 'in_flight' and ${outboundOperations.updatedAt} < now() - interval '30 seconds')
        or (${outboundOperations.state} = 'failed' and ${outboundOperations.blobCollectedAt} is null and ${outboundOperations.updatedAt} < now() - interval '1 minute')
        or (${outboundOperations.state} = 'succeeded' and ${outboundOperations.blobCollectedAt} is null
          and ${outboundOperations.completedAt} < now() - interval '30 days'
          and ${outboundOperations.updatedAt} < now() - interval '1 minute')`)
      .orderBy(outboundOperations.updatedAt).limit(limit);
  }, { accessMode: 'read only' });
  let count = 0;
  let failed = false;
  for (const candidate of candidates) {
    try { await db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '3000ms'`);
      await tx.execute(sql`set local lock_timeout = '750ms'`);
      const [row] = await tx.select().from(outboundOperations).where(eq(outboundOperations.id, candidate.id))
        .for('update', { skipLocked: true });
      if (!row) return;
      const age = Date.now() - row.updatedAt.getTime();
      if (row.state === 'pending' && age >= 5 * 60_000) {
        await tx.update(outboundOperations).set({ state: 'failed', lastError: 'preparation_interrupted',
          completedAt: new Date(), updatedAt: new Date() }).where(eq(outboundOperations.id, row.id));
        await tx.update(drafts).set({ state: 'editing', updatedAt: new Date() })
          .where(and(eq(drafts.id, row.draftId), eq(drafts.state, 'sending')));
        await tx.insert(auditLog).values({ id: randomUUID(), actorId: row.ownerId, action: 'send_failed', targetId: row.id });
        count++;
      } else if (row.state === 'in_flight' && age >= 30_000) {
        await tx.update(outboundOperations).set({ state: 'outcome_unknown', lastError: 'confirmation_interrupted',
          updatedAt: new Date() }).where(eq(outboundOperations.id, row.id));
        await tx.insert(auditLog).values({ id: randomUUID(), actorId: row.ownerId, action: 'send_unknown', targetId: row.id });
        count++;
      } else if (!row.blobCollectedAt && ((row.state === 'failed' && age >= 60_000) ||
        (row.state === 'succeeded' && row.completedAt && Date.now() - row.completedAt.getTime() >= 30 * 24 * 60 * 60_000))) {
        await store.delete(row.blobKey);
        await store.deleteTemporary(row.blobKey);
        await tx.update(outboundOperations).set({ blobReady: false, blobCollectedAt: new Date(), updatedAt: new Date() })
          .where(eq(outboundOperations.id, row.id));
        count++;
      }
    }); } catch {
      failed = true;
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '3000ms'`);
        await tx.execute(sql`set local lock_timeout = '750ms'`);
        await tx.update(outboundOperations).set({ updatedAt: new Date() })
          .where(eq(outboundOperations.id, candidate.id));
      }).catch(() => undefined);
    }
  }
  if (failed) throw new Error('Some outbound recovery candidates failed');
  return count;
}
