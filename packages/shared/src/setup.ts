import { z } from 'zod';

export const privacyChoiceSchema = z.enum(['allow', 'exclude']);
export const privacyDefaultsSchema = z.object({
  index: privacyChoiceSchema,
  ai: privacyChoiceSchema,
}).strict();
export const exclusionRuleSchema = z.object({
  scope: z.enum(['global', 'orbit']),
  kind: z.enum(['account', 'sender', 'label']),
  value: z.string().trim().min(1).max(254),
  effect: z.enum(['no_ai', 'no_index', 'no_ai_and_no_index']),
}).strict();
export const setupSubmitSchema = z.object({
  version: z.literal(1),
  confirmedOrigin: z.string().url(),
  orbit: z.object({
    name: z.string().trim().min(1).max(80),
    colorSlot: z.number().int().min(1).max(4),
    context: z.string().trim().min(1).max(500),
  }).strict(),
  globalDefaults: privacyDefaultsSchema,
  orbitDefaults: privacyDefaultsSchema,
  exclusions: z.array(exclusionRuleSchema).max(50),
}).strict();
export const setupStatusSchema = z.object({
  version: z.literal(1),
  configuredOrigin: z.string().url(),
  confirmedOrigin: z.string().url().nullable(),
  completed: z.boolean(),
  orbit: setupSubmitSchema.shape.orbit.extend({ id: z.string() }).nullable(),
  globalDefaults: privacyDefaultsSchema.nullable(),
  orbitDefaults: privacyDefaultsSchema.nullable(),
  exclusions: z.array(exclusionRuleSchema),
});
export const setupOriginSchema = z.object({ confirmedOrigin: z.string().url() }).strict();
export type SetupSubmit = z.infer<typeof setupSubmitSchema>;
export type SetupStatus = z.infer<typeof setupStatusSchema>;
export type ExclusionRule = z.infer<typeof exclusionRuleSchema>;
export type PrivacyDefaults = z.infer<typeof privacyDefaultsSchema>;
