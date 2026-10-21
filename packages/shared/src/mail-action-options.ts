import { z } from 'zod';
import { readerIdSchema } from './mail-reader.js';

export const mailActionOptionsQuerySchema = z.object({ accountId: readerIdSchema, orbitId: readerIdSchema.optional() }).strict();
export const mailActionOptionsSchema = z.object({
  itemId: readerIdSchema, accountId: readerIdSchema, orbitId: readerIdSchema.nullable(),
  itemSequence: z.number().int().nonnegative(), itemRevision: z.string().max(256).nullable(),
  unread: z.boolean(), inInbox: z.boolean(), blocked: z.boolean(),
  blockedReason: z.enum(['operation_pending', 'awaiting_sync', 'draft']).nullable(),
  blockingOperationId: readerIdSchema.nullable(),
  blockingOrbitId: readerIdSchema.nullable(),
  labelsIncomplete: z.boolean(),
  canArchive: z.boolean(), canMarkRead: z.boolean(), canMarkUnread: z.boolean(),
  labels: z.array(z.object({ id: readerIdSchema, name: z.string().max(1024), applied: z.boolean(),
    canAdd: z.boolean(), canRemove: z.boolean() }).strict()).max(500),
  message: z.string().max(500),
}).strict();
