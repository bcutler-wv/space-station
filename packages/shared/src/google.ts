import { z } from 'zod';

export const googleStartSchema = z.object({
  clientId: z.string().trim().regex(/^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/).max(512),
  clientSecret: z.string().min(8).max(2048),
}).strict();
export const googleReconnectStartSchema = googleStartSchema.extend({ accountId: z.uuid() });
export const googleCallbackSchema = z.object({
  state: z.string().min(30).max(200),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(128).optional(),
}).refine((value) => Boolean(value.code) !== Boolean(value.error));
export const googleBackfillSchema = z.object({
  accountId: z.uuid(),
  window: z.enum(['30_days', '1_year', 'all']),
}).strict();
export const googleAccountSchema = z.object({
  id: z.uuid(), email: z.email(), orbitId: z.uuid(),
  grantedScopes: z.array(z.string()),
  backfill: z.enum(['30_days', '1_year', 'all']).nullable(),
  status: z.enum(['connected', 'needs_reconnect']),
});
export const googleStatusSchema = z.object({
  redirectUri: z.url(), pendingConfirmation: z.boolean(),
  accounts: z.array(googleAccountSchema),
});
export const googleStartResponseSchema = z.object({ authorizationUrl: z.url() });
export const googleOkSchema = z.object({ ok: z.literal(true) });
