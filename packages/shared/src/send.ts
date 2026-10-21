import { z } from 'zod';

const uuid = z.string().uuid();
export const sendRequestSchema = z.object({ idempotencyKey: uuid, revision: z.number().int().min(1).max(2_147_483_646) }).strict();
export const sendScopeSchema = z.object({ accountId: uuid, orbitId: uuid.optional() }).strict();
export const sendOperationSchema = z.object({ id: uuid, draftId: uuid, accountId: uuid, orbitId: uuid.nullable(),
  state: z.enum(['pending', 'in_flight', 'succeeded', 'failed', 'outcome_unknown']),
  providerResultId: z.string().nullable(), updatedAt: z.iso.datetime(),
  message: z.string().max(500),
}).strict();
