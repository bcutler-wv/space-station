import { z } from 'zod';

export const healthResponseSchema = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const readinessResponseSchema = z.object({ status: z.enum(['ready', 'unavailable']) });
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
