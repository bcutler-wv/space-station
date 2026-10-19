import { z } from "zod";

const name = z.string().min(1).max(128);
const password = z.string().min(12).max(1024);
const code = z.string().regex(/^\d{6}$/);
const setupToken = z.string().min(32).max(200);
const recoveryCode = z.string().min(16).max(100);
const webauthnResponse = z.record(z.string(), z.unknown());

export const bootstrapPasswordSchema = z
  .object({ bootstrapToken: setupToken, displayName: name, password })
  .strict();
export const bootstrapTotpSchema = z.object({ code }).strict();
export const loginPasswordSchema = z.object({ password, code }).strict();
export const loginRecoverySchema = z
  .object({ password, recoveryCode })
  .strict();
export const loginPasswordRecoverySchema = z
  .object({ recoveryCode, code })
  .strict();
export const resetPasswordSchema = z
  .object({ password, confirmPassword: password })
  .strict()
  .refine((value) => value.password === value.confirmPassword);
export const bootstrapPasskeyOptionsSchema = z
  .object({ bootstrapToken: setupToken, displayName: name })
  .strict();
export const bootstrapPasskeyVerifySchema = z
  .object({ response: webauthnResponse, displayName: name })
  .strict();
export const passkeyVerifySchema = z
  .object({ response: webauthnResponse })
  .strict();
export const passkeyRecoveryOptionsSchema = z.object({ recoveryCode }).strict();
export const authStatusSchema = z.object({
  ownerExists: z.boolean(),
  authenticated: z.boolean(),
  recoveryAuthenticated: z.boolean(),
  recoveryMode: z.enum(["totp", "password"]).nullable(),
  pendingTotpUri: z.string().nullable(),
  csrfToken: z.string(),
});
export const recoveryCodesResponseSchema = z.object({
  recoveryCodes: z.array(recoveryCode).length(10),
});
export const totpUriResponseSchema = z.object({ totpUri: z.string().url() });
export const authOkSchema = z.object({ ok: z.literal(true) });
