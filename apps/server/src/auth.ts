import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import csrf from "@fastify/csrf-protection";
import rateLimit from "@fastify/rate-limit";
import { hash, verify as verifyPassword, Algorithm } from "@node-rs/argon2";
import { generateSecret, generateURI, verify as verifyTotp } from "otplib";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PRODUCT_NAME,
  bootstrapPasswordSchema,
  bootstrapTotpSchema,
  loginPasswordSchema,
  loginRecoverySchema,
  loginPasswordRecoverySchema,
  resetPasswordSchema,
  bootstrapPasskeyOptionsSchema,
  bootstrapPasskeyVerifySchema,
  passkeyVerifySchema,
  passkeyRecoveryOptionsSchema,
} from "@station/shared";
import {
  digest,
  OWNER_ID,
  postgresSessionStore,
  type AuthStore,
} from "./auth-store.js";
import type { openDatabase } from "@station/db";
import type { GoogleTransport } from '@station/connectors';

const passwordParams = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};
const safe = (value: unknown, schema: z.ZodType) => schema.safeParse(value);
const unauthorized = {
  error: "Authentication failed. Check your credentials and try again.",
};
const newCodes = () =>
  Array.from({ length: 10 }, () => randomBytes(12).toString("base64url"));
const publicAuthRoutes = new Set([
  '/api/google/callback',
  '/api/auth/status', '/api/auth/logout', '/api/auth/bootstrap/restart',
  '/api/auth/bootstrap/password', '/api/auth/bootstrap/totp',
  '/api/auth/bootstrap/passkey/options', '/api/auth/bootstrap/passkey/verify',
  '/api/auth/login/password', '/api/auth/login/recovery',
  '/api/auth/login/passkey/options', '/api/auth/login/passkey/verify',
  '/api/auth/recovery/password', '/api/auth/recovery/passkey/options',
  '/api/auth/recovery/passkey/verify', '/api/auth/reset/password',
  '/api/auth/reset/totp/options', '/api/auth/reset/totp/confirm',
]);

function encrypt(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}
function decrypt(value: string, key: Buffer) {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

export interface AuthConfig {
  origin: string;
  masterKey: Buffer;
  db: ReturnType<typeof openDatabase>["db"];
  store: AuthStore;
  googleTransport?: GoogleTransport;
}

declare module "fastify" {
  interface Session {
    userId?: string;
    authGeneration?: number;
    recoveryMode?: "totp" | "password";
    pendingRecovery?: boolean;
    pendingPasswordHash?: string;
    pendingName?: string;
    pendingTotpSecret?: string;
    pendingPasskey?: string;
    challenge?: string | undefined;
    challengeId?: string;
    pendingBootstrap?: string;
  }
}

export async function registerAuth(app: FastifyInstance, config: AuthConfig) {
  const origin = new URL(config.origin);
  if (origin.origin !== config.origin || origin.protocol !== "https:")
    throw new Error("APP_ORIGIN must be an exact HTTPS origin");
  const rpID = origin.hostname;
  const store = config.store;
  await app.register(cookie);
  await app.register(session, {
    secret: config.masterKey.toString("hex"),
    cookieName: "__Host-station",
    store: postgresSessionStore(config.db),
    saveUninitialized: false,
    rolling: false,
    cookie: {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60_000,
    },
  });
  await app.register(csrf, {
    sessionPlugin: "@fastify/session",
    getToken: (request) =>
      request.headers["x-csrf-token"] as string | undefined,
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      error: "Too many requests. Wait a minute and try again.",
    }),
  });
  const strictRate = {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 minute",
        keyGenerator: () => "owner",
      },
    },
  };
  const currentPrincipal = async (request: {
    session: { authGeneration?: number };
  }) =>
    request.session.authGeneration !== undefined &&
    request.session.authGeneration === (await store.getOwnerGeneration());

  app.addHook("onRequest", (request, reply, done) => {
    if (request.url.startsWith("/api/"))
      reply.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.headers.origin !== config.origin) {
        reply.code(403).send({
          error:
            "Open this page at the configured HTTPS address and try again.",
        });
        return;
      }
      app.csrfProtection(request, reply, done);
      return;
    }
    done();
  });
  app.addHook("preHandler", async (request, reply) => {
    if (
      request.url.startsWith('/api/') &&
      !publicAuthRoutes.has(request.url.split('?')[0] ?? '') &&
      (request.session.userId !== OWNER_ID ||
        request.session.recoveryMode ||
        !(await currentPrincipal(request)))
    )
      return reply
        .code(401)
        .send({ error: "Sign in to access your settings." });
  });

  app.get("/api/auth/status", async (request, reply) => {
    const valid = await currentPrincipal(request);
    return {
      ownerExists: await store.hasOwner(),
      authenticated:
        valid &&
        request.session.userId === OWNER_ID &&
        !request.session.recoveryMode,
      recoveryAuthenticated: valid && Boolean(request.session.recoveryMode),
      recoveryMode: valid ? (request.session.recoveryMode ?? null) : null,
      pendingTotpUri:
        request.session.pendingTotpSecret && request.session.pendingName
          ? generateURI({
              issuer: PRODUCT_NAME,
              label: request.session.pendingName,
              secret: decrypt(
                request.session.pendingTotpSecret,
                config.masterKey,
              ),
            })
          : null,
      csrfToken: await reply.generateCsrf(),
    };
  });
  app.post("/api/auth/logout", async (request) => {
    await request.session.destroy();
    return { ok: true };
  });
  app.post("/api/auth/bootstrap/restart", async (request) => {
    await request.session.regenerate();
    return { ok: true };
  });

  app.post(
    "/api/auth/bootstrap/password",
    strictRate,
    async (request, reply) => {
      const parsed = safe(request.body, bootstrapPasswordSchema);
      if (!parsed.success)
        return reply.code(400).send({
          error:
            "Enter a name, a password of at least 12 characters, and the setup token.",
        });
      const data = parsed.data as {
        bootstrapToken: string;
        displayName: string;
        password: string;
      };
      if (!(await store.hasValidBootstrap(digest(data.bootstrapToken))))
        return reply.code(403).send({
          error:
            "The setup token expired or was used. Start setup again with a new local token.",
        });
      const passwordHash = await hash(data.password, passwordParams);
      if (await store.hasOwner())
        return reply
          .code(403)
          .send({ error: "The owner login already exists." });
      const secret = generateSecret();
      await request.session.regenerate();
      request.session.pendingBootstrap = digest(data.bootstrapToken);
      request.session.pendingPasswordHash = passwordHash;
      request.session.pendingName = data.displayName;
      request.session.pendingTotpSecret = encrypt(secret, config.masterKey);
      return {
        totpUri: generateURI({
          issuer: PRODUCT_NAME,
          label: data.displayName,
          secret,
        }),
      };
    },
  );
  app.post("/api/auth/bootstrap/totp", strictRate, async (request, reply) => {
    if (
      !request.session.pendingPasswordHash ||
      !request.session.pendingTotpSecret ||
      !request.session.pendingName ||
      !request.session.pendingBootstrap
    )
      return reply.code(401).send(unauthorized);
    const parsed = safe(request.body, bootstrapTotpSchema);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Enter the six-digit code from your authenticator." });
    const result = await verifyTotp({
      secret: decrypt(request.session.pendingTotpSecret, config.masterKey),
      token: (parsed.data as { code: string }).code,
    });
    if (!result.valid || !("timeStep" in result))
      return reply.code(401).send(unauthorized);
    const codes = newCodes();
    if (
      !(await store.consumeBootstrap(
        request.session.pendingBootstrap,
        request.session.pendingName,
        {
          kind: "password",
          passwordHash: request.session.pendingPasswordHash,
          encryptedTotp: request.session.pendingTotpSecret,
          lastTotpStep: result.timeStep,
        },
        codes.map(digest),
      ))
    )
      return reply.code(403).send({
        error:
          "The setup token expired or was used. Start setup again with a new local token.",
      });
    await request.session.regenerate();
    request.session.userId = OWNER_ID;
    request.session.authGeneration = 1;
    return { recoveryCodes: codes };
  });
  app.post("/api/auth/login/password", strictRate, async (request, reply) => {
    const parsed = safe(request.body, loginPasswordSchema);
    if (!parsed.success)
      return reply.code(400).send({
        error: "Enter your password and six-digit authenticator code.",
      });
    const data = parsed.data as { password: string; code: string };
    const pw = await store.getCredential("password");
    const totp = await store.getCredential("totp");
    if (
      !pw?.passwordHash ||
      !totp?.confirmed ||
      !totp.encryptedSecret ||
      pw.authGeneration !== totp.authGeneration ||
      !(await verifyPassword(pw.passwordHash, data.password))
    )
      return reply.code(401).send(unauthorized);
    const result = await verifyTotp({
      secret: decrypt(totp.encryptedSecret, config.masterKey),
      token: data.code,
      ...(totp.lastTotpStep === null
        ? {}
        : { afterTimeStep: totp.lastTotpStep }),
    });
    if (
      !result.valid ||
      !("timeStep" in result) ||
      !(await store.consumeTotp(result.timeStep, totp.authGeneration))
    )
      return reply.code(401).send(unauthorized);
    await request.session.regenerate();
    request.session.userId = OWNER_ID;
    request.session.authGeneration = totp.authGeneration;
    return { ok: true };
  });
  app.post("/api/auth/login/recovery", strictRate, async (request, reply) => {
    const parsed = safe(request.body, loginRecoverySchema);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Enter your password and a recovery code." });
    const data = parsed.data as { password: string; recoveryCode: string };
    const pw = await store.getCredential("password");
    if (
      !pw?.passwordHash ||
      !(await verifyPassword(pw.passwordHash, data.password)) ||
      !(await store.consumeRecovery(
        digest(data.recoveryCode),
        pw.authGeneration,
      ))
    )
      return reply.code(401).send(unauthorized);
    await request.session.regenerate();
    request.session.authGeneration = pw.authGeneration;
    request.session.recoveryMode = "totp";
    return { ok: true };
  });
  app.post(
    "/api/auth/recovery/password",
    strictRate,
    async (request, reply) => {
      const parsed = safe(request.body, loginPasswordRecoverySchema);
      if (!parsed.success)
        return reply.code(400).send({
          error:
            "Enter an unused recovery code and current authenticator code.",
        });
      const data = parsed.data as { recoveryCode: string; code: string };
      const totp = await store.getCredential("totp");
      if (!totp?.confirmed || !totp.encryptedSecret)
        return reply.code(401).send(unauthorized);
      const result = await verifyTotp({
        secret: decrypt(totp.encryptedSecret, config.masterKey),
        token: data.code,
        ...(totp.lastTotpStep === null
          ? {}
          : { afterTimeStep: totp.lastTotpStep }),
      });
      if (
        !result.valid ||
        !("timeStep" in result) ||
        !(await store.consumePasswordRecovery(
          digest(data.recoveryCode),
          result.timeStep,
          totp.authGeneration,
        ))
      )
        return reply.code(401).send(unauthorized);
      await request.session.regenerate();
      request.session.authGeneration = totp.authGeneration;
      request.session.recoveryMode = "password";
      return { ok: true };
    },
  );
  app.post("/api/auth/reset/password", strictRate, async (request, reply) => {
    if (
      request.session.recoveryMode !== "password" ||
      !(await currentPrincipal(request))
    )
      return reply.code(403).send(unauthorized);
    const parsed = safe(request.body, resetPasswordSchema);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Enter matching passwords of at least 12 characters." });
    const passwordHash = await hash(
      (parsed.data as { password: string }).password,
      passwordParams,
    );
    const codes = newCodes();
    const generation = await store.replacePassword(
      request.session.authGeneration!,
      passwordHash,
      codes.map(digest),
    );
    if (!generation) return reply.code(403).send(unauthorized);
    await request.session.regenerate();
    request.session.userId = OWNER_ID;
    request.session.authGeneration = generation;
    return { recoveryCodes: codes };
  });
  app.post(
    "/api/auth/reset/totp/options",
    strictRate,
    async (request, reply) => {
      if (
        request.session.recoveryMode !== "totp" ||
        !(await currentPrincipal(request))
      )
        return reply.code(403).send({
          error:
            "Sign in with a recovery code before resetting your authenticator.",
        });
      const secret = generateSecret();
      request.session.pendingTotpSecret = encrypt(secret, config.masterKey);
      return {
        totpUri: generateURI({ issuer: PRODUCT_NAME, label: "Owner", secret }),
      };
    },
  );
  app.post(
    "/api/auth/reset/totp/confirm",
    strictRate,
    async (request, reply) => {
      if (
        request.session.recoveryMode !== "totp" ||
        !request.session.pendingTotpSecret ||
        !(await currentPrincipal(request))
      )
        return reply.code(403).send(unauthorized);
      const parsed = safe(request.body, bootstrapTotpSchema);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Enter the six-digit code from your new authenticator.",
        });
      const result = await verifyTotp({
        secret: decrypt(request.session.pendingTotpSecret, config.masterKey),
        token: (parsed.data as { code: string }).code,
      });
      if (!result.valid || !("timeStep" in result))
        return reply.code(401).send(unauthorized);
      const codes = newCodes();
      const generation = await store.replaceTotp(
        request.session.authGeneration!,
        request.session.pendingTotpSecret,
        result.timeStep,
        codes.map(digest),
      );
      if (!generation) return reply.code(403).send(unauthorized);
      await request.session.regenerate();
      request.session.userId = OWNER_ID;
      request.session.authGeneration = generation;
      return { recoveryCodes: codes };
    },
  );
  app.post(
    "/api/auth/recovery/passkey/options",
    strictRate,
    async (request, reply) => {
      const parsed = safe(request.body, passkeyRecoveryOptionsSchema);
      const credential = await store.getCredential("passkey");
      if (
        !parsed.success ||
        !credential?.confirmed ||
        !(await store.consumeRecovery(
          digest((parsed.data as { recoveryCode: string }).recoveryCode),
          credential.authGeneration,
        ))
      )
        return reply.code(401).send(unauthorized);
      const options = await generateRegistrationOptions({
        rpName: PRODUCT_NAME,
        rpID,
        userName: "Owner",
        authenticatorSelection: {
          userVerification: "required",
          residentKey: "required",
        },
      });
      await request.session.regenerate();
      const challengeId = randomBytes(16).toString("hex");
      await store.issueChallenge(challengeId, options.challenge, "recovery");
      request.session.challenge = options.challenge;
      request.session.challengeId = challengeId;
      request.session.pendingRecovery = true;
      request.session.authGeneration = credential.authGeneration;
      return options;
    },
  );
  app.post(
    "/api/auth/recovery/passkey/verify",
    strictRate,
    async (request, reply) => {
      const parsed = safe(request.body, passkeyVerifySchema);
      if (
        !parsed.success ||
        !request.session.pendingRecovery ||
        !request.session.challenge ||
        !request.session.challengeId ||
        !(await currentPrincipal(request))
      )
        return reply.code(401).send(unauthorized);
      const challenge = request.session.challenge;
      request.session.challenge = undefined;
      let verified;
      try {
        verified = await verifyRegistrationResponse({
          response: (parsed.data as { response: RegistrationResponseJSON })
            .response,
          expectedChallenge: challenge,
          expectedOrigin: config.origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch {
        return reply.code(401).send(unauthorized);
      }
      if (
        !verified.verified ||
        !(await store.consumeChallenge(
          request.session.challengeId,
          challenge,
          "recovery",
          request.session.authGeneration,
        ))
      )
        return reply.code(401).send(unauthorized);
      const credential = verified.registrationInfo.credential;
      const codes = newCodes();
      const generation = await store.replacePasskey(
        request.session.authGeneration!,
        credential.id,
        Buffer.from(credential.publicKey).toString("base64"),
        credential.counter,
        credential.transports ?? [],
        codes.map(digest),
      );
      if (!generation) return reply.code(403).send(unauthorized);
      await request.session.regenerate();
      request.session.userId = OWNER_ID;
      request.session.authGeneration = generation;
      return { recoveryCodes: codes };
    },
  );
  app.post(
    "/api/auth/bootstrap/passkey/options",
    strictRate,
    async (request, reply) => {
      const parsed = safe(request.body, bootstrapPasskeyOptionsSchema);
      if (
        !parsed.success ||
        (await store.hasOwner()) ||
        !(await store.hasValidBootstrap(
          digest((parsed.data as { bootstrapToken: string }).bootstrapToken),
        ))
      )
        return reply.code(403).send(unauthorized);
      const data = parsed.data as {
        bootstrapToken: string;
        displayName: string;
      };
      const options = await generateRegistrationOptions({
        rpName: PRODUCT_NAME,
        rpID,
        userName: data.displayName,
        userDisplayName: data.displayName,
        authenticatorSelection: {
          userVerification: "required",
          residentKey: "required",
        },
      });
      await request.session.regenerate();
      const challengeId = randomBytes(16).toString("hex");
      await store.issueChallenge(
        challengeId,
        options.challenge,
        "registration",
      );
      request.session.challenge = options.challenge;
      request.session.challengeId = challengeId;
      request.session.pendingBootstrap = digest(data.bootstrapToken);
      return options;
    },
  );
  app.post(
    "/api/auth/bootstrap/passkey/verify",
    strictRate,
    async (request, reply) => {
      const parsed = safe(request.body, bootstrapPasskeyVerifySchema);
      if (
        !parsed.success ||
        !request.session.challenge ||
        !request.session.challengeId ||
        !request.session.pendingBootstrap
      )
        return reply.code(401).send(unauthorized);
      const data = parsed.data as {
        response: RegistrationResponseJSON;
        displayName: string;
      };
      const challenge = request.session.challenge;
      request.session.challenge = undefined;
      let verified;
      try {
        verified = await verifyRegistrationResponse({
          response: data.response,
          expectedChallenge: challenge,
          expectedOrigin: config.origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch {
        return reply.code(401).send(unauthorized);
      }
      if (
        !verified.verified ||
        !(await store.consumeChallenge(
          request.session.challengeId,
          challenge,
          "registration",
        ))
      )
        return reply.code(401).send(unauthorized);
      const credential = verified.registrationInfo.credential;
      const codes = newCodes();
      if (
        !(await store.consumeBootstrap(
          request.session.pendingBootstrap,
          data.displayName,
          {
            kind: "passkey",
            id: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString("base64"),
            counter: credential.counter,
            transports: credential.transports ?? [],
          },
          codes.map(digest),
        ))
      )
        return reply.code(403).send({
          error:
            "The setup token expired or was used. Start setup again with a new local token.",
        });
      await request.session.regenerate();
      request.session.userId = OWNER_ID;
      request.session.authGeneration = 1;
      return { recoveryCodes: codes };
    },
  );
  app.post(
    "/api/auth/login/passkey/options",
    strictRate,
    async (request, reply) => {
      const credential = await store.getCredential("passkey");
      if (!credential?.confirmed) return reply.code(401).send(unauthorized);
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: "required",
        allowCredentials: [
          {
            id: credential.id,
            transports: (credential.passkeyTransports as string[]) ?? [],
          },
        ],
      });
      await request.session.regenerate();
      request.session.challenge = options.challenge;
      request.session.authGeneration = credential.authGeneration;
      const challengeId = randomBytes(16).toString("hex");
      await store.issueChallenge(
        challengeId,
        options.challenge,
        "authentication",
      );
      request.session.challengeId = challengeId;
      return options;
    },
  );
  app.post(
    "/api/auth/login/passkey/verify",
    strictRate,
    async (request, reply) => {
      const parsed = safe(request.body, passkeyVerifySchema);
      const credential = await store.getCredential("passkey");
      if (
        !parsed.success ||
        !request.session.challenge ||
        !request.session.challengeId ||
        !credential?.passkeyPublicKey ||
        credential.passkeyCounter === null ||
        credential.authGeneration !== request.session.authGeneration ||
        !(await currentPrincipal(request))
      )
        return reply.code(401).send(unauthorized);
      const challenge = request.session.challenge;
      request.session.challenge = undefined;
      let verified;
      try {
        verified = await verifyAuthenticationResponse({
          response: (parsed.data as { response: AuthenticationResponseJSON })
            .response,
          expectedChallenge: challenge,
          expectedOrigin: config.origin,
          expectedRPID: rpID,
          credential: {
            id: credential.id,
            publicKey: new Uint8Array(
              Buffer.from(credential.passkeyPublicKey, "base64"),
            ),
            counter: credential.passkeyCounter,
            transports: (credential.passkeyTransports as string[]) ?? [],
          },
          requireUserVerification: true,
        });
      } catch {
        return reply.code(401).send(unauthorized);
      }
      if (
        !verified.verified ||
        !(await store.consumeChallenge(
          request.session.challengeId,
          challenge,
          "authentication",
          credential.authGeneration,
        )) ||
        !(await store.bumpPasskey(
          credential.id,
          credential.passkeyCounter,
          verified.authenticationInfo.newCounter,
          credential.authGeneration,
        ))
      )
        return reply.code(401).send(unauthorized);
      await request.session.regenerate();
      request.session.userId = OWNER_ID;
      request.session.authGeneration = credential.authGeneration;
      return { ok: true };
    },
  );
}
