import { z } from 'zod';

const uuid = z.string().uuid();
export const sendRequestSchema = z.object({ idempotencyKey: uuid, revision: z.number().int().min(1).max(2_147_483_646) }).strict();
export const sendScopeSchema = z.object({ accountId: uuid, orbitId: uuid.optional() }).strict();
export const sendDraftStatusQuerySchema = sendScopeSchema.safeExtend({ idempotencyKey: uuid.optional() });
export const sendOperationSchema = z.object({ id: uuid, draftId: uuid, accountId: uuid, orbitId: uuid.nullable(),
  state: z.enum(['pending', 'in_flight', 'succeeded', 'failed', 'outcome_unknown']),
  providerResultId: z.string().nullable(), updatedAt: z.iso.datetime(),
  message: z.string().max(500),
}).strict();
export const sendDiscoveryQuerySchema = z.object({ accountId: uuid, orbitId: uuid.optional(),
  cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(20).default(20) }).strict();
export const sendDiscoveryPageSchema = z.object({ operations: z.array(sendOperationSchema).max(20), nextCursor: z.string().nullable() }).strict();
