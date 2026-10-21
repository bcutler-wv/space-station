import { z } from 'zod';

const uuid = z.uuid();
export const mailChangeScopeSchema = z.object({ accountId: uuid, orbitId: uuid.optional() }).strict();
export const mailChangeRequestSchema = z.object({
  idempotencyKey: uuid, action: z.enum(['archive', 'mark_read', 'mark_unread', 'add_label', 'remove_label']),
  labelId: uuid.optional(), itemSequence: z.number().int().nonnegative(), itemRevision: z.string().max(256).nullable(),
}).strict().refine((value) => (value.action === 'add_label' || value.action === 'remove_label') === Boolean(value.labelId));
export const mailChangeCurrentStatusQuerySchema = mailChangeScopeSchema.safeExtend({ idempotencyKey: uuid });
export const mailChangeOperationSchema = z.object({
  id: uuid, itemId: uuid, accountId: uuid, orbitId: uuid.nullable(), action: z.enum(['archive', 'mark_read', 'mark_unread', 'add_label', 'remove_label']),
  state: z.enum(['pending', 'in_flight', 'outcome_unknown', 'succeeded', 'failed']),
  confirmation: z.enum(['provider', 'observed']).nullable(), updatedAt: z.iso.datetime(), message: z.string().max(500),
}).strict();
export const mailChangeDiscoveryQuerySchema = mailChangeScopeSchema.safeExtend({
  cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(20).default(20),
});
export const mailChangeDiscoveryPageSchema = z.object({
  operations: z.array(mailChangeOperationSchema).max(20), nextCursor: z.string().nullable(),
}).strict();
