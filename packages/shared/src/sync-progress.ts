import { z } from 'zod';

export const syncPhaseSchema = z.enum(['waiting', 'backfill', 'catchup', 'current', 'retry', 'repair']);
export const syncRepairCodeSchema = z.enum(['needs_reconnect', 'permission_denied', 'sync_cursor_invalid']);
export const syncProgressAccountSchema = z.object({
  accountId: z.uuid(), orbitId: z.uuid(), phase: syncPhaseSchema,
  repairCode: syncRepairCodeSchema.nullable(),
  retryAt: z.iso.datetime().nullable(),
  processedPages: z.number().int().nonnegative(),
  supportedItems: z.number().int().nonnegative(),
  unsupportedItems: z.number().int().nonnegative(),
  lastSuccessAt: z.iso.datetime().nullable(),
}).strict();
export const syncProgressResponseSchema = z.object({ accounts: z.array(syncProgressAccountSchema) }).strict();
export type SyncProgressResponse = z.infer<typeof syncProgressResponseSchema>;

export const SYNC_EVENT_NAMES = {
  progress: 'sync-progress', mail: 'mail-changed', reset: 'sync-reset', heartbeat: 'heartbeat',
} as const;
export const syncEventIdSchema = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).refine((value) => Number.isSafeInteger(Number(value)));
export const syncChangeEventSchema = z.object({
  event: z.enum([SYNC_EVENT_NAMES.progress, SYNC_EVENT_NAMES.mail]),
  id: syncEventIdSchema,
  accountId: z.uuid(),
}).strict();
export const syncResetEventSchema = z.object({ event: z.literal(SYNC_EVENT_NAMES.reset), id: syncEventIdSchema }).strict();
