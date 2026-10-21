import { and, eq, inArray, sql } from 'drizzle-orm';
import { blobIntents, draftAttachments, drafts, outboundOperations } from './schema.js';
import type { openDatabase } from './connection.js';
import { PrivateBlobStore } from './private-blob-store.js';

type Database = ReturnType<typeof openDatabase>['db'];

/** Draft intents are independent of sync pages. The row lock serializes with
 * publication; a worker can reclaim a crashed pending writer after its grace
 * period without borrowing a Gmail sync lease. */
export async function collectDraftAttachmentBlobs(db: Database, store: PrivateBlobStore,
  minimumAgeMs = 60_000, limit = 25): Promise<number> {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0 || minimumAgeMs > 7 * 24 * 60 * 60 * 1000 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid draft collector bounds');
  const candidates = await db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    return tx.select({ id: draftAttachments.id }).from(draftAttachments)
      .where(and(inArray(draftAttachments.state, ['pending', 'delete_pending']),
        sql`${draftAttachments.updatedAt} <= now() - (${minimumAgeMs} * interval '1 millisecond')`))
      .orderBy(draftAttachments.updatedAt).limit(limit);
  }, { accessMode: 'read only' });
  let count = 0;
  let failed = false;
  for (const candidate of candidates) {
    try {
      const removed = await db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '3000ms'`);
        await tx.execute(sql`set local lock_timeout = '750ms'`);
        const [intent] = await tx.select().from(draftAttachments)
          .where(and(eq(draftAttachments.id, candidate.id), inArray(draftAttachments.state, ['pending', 'delete_pending']),
            sql`${draftAttachments.updatedAt} <= now() - (${minimumAgeMs} * interval '1 millisecond')`))
          .limit(1).for('update', { skipLocked: true });
        if (!intent) return false;
        const [draft] = await tx.select({ id: drafts.id }).from(drafts)
          .where(and(eq(drafts.id, intent.draftId), sql`${drafts.attachmentRefs} @> ${JSON.stringify([intent.id])}::jsonb`)).limit(1);
        if (draft) {
          await tx.update(draftAttachments).set({ state: 'ready', updatedAt: new Date() }).where(eq(draftAttachments.id, intent.id));
          return false;
        }
        const [outbound] = await tx.select({ id: outboundOperations.id }).from(outboundOperations)
          .where(and(eq(outboundOperations.draftId, intent.draftId), eq(outboundOperations.accountId, intent.accountId),
            eq(outboundOperations.state, 'pending'), eq(outboundOperations.blobReady, false),
            sql`${outboundOperations.attachmentRefs} @> ${JSON.stringify([intent.id])}::jsonb`)).limit(1);
        if (outbound) return false;
        // Mail blobs own their own collector. A key collision or corrupt row
        // must never let this collector remove a sync-owned file.
        const [mailIntent] = await tx.select({ key: blobIntents.key }).from(blobIntents)
          .where(eq(blobIntents.key, intent.blobKey)).limit(1);
        if (mailIntent) return false;
        await store.delete(intent.blobKey);
        await store.deleteTemporary(intent.blobKey);
        await tx.delete(draftAttachments).where(eq(draftAttachments.id, intent.id));
        return true;
      });
      if (removed) count++;
    } catch {
      failed = true;
      // A corrupt or undeletable file must not permanently sit ahead of every
      // later candidate. Leave its intent for retry after the normal grace.
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '3000ms'`);
        await tx.execute(sql`set local lock_timeout = '750ms'`);
        await tx.update(draftAttachments).set({ updatedAt: new Date() })
          .where(and(eq(draftAttachments.id, candidate.id), inArray(draftAttachments.state, ['pending', 'delete_pending'])));
      }).catch(() => undefined);
    }
  }
  if (failed) throw new Error('Some draft blob cleanup candidates failed');
  return count;
}
