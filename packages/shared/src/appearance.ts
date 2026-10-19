import { z } from 'zod';

export const appearanceModeSchema = z.enum(['system', 'light', 'dark']);
export const appearanceUpdateSchema = z.object({
  mode: appearanceModeSchema,
  showWallpaper: z.boolean(),
}).strict();
export const appearanceResponseSchema = appearanceUpdateSchema.extend({
  seed: z.number().int().nonnegative().max(4294967295),
  hasWallpaper: z.boolean(),
});
export type AppearanceUpdate = z.infer<typeof appearanceUpdateSchema>;
export type AppearanceResponse = z.infer<typeof appearanceResponseSchema>;
