import { createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { SessionStore } from "@fastify/session";
import type { Session } from "fastify";
import {
  authChallenges,
  authCredentials,
  bootstrapTokens,
  recoveryCodes,
  sessions,
  users,
  type openDatabase,
} from "@station/db";

type Db = ReturnType<typeof openDatabase>["db"];
export const OWNER_ID = "owner";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const IDLE_MS = 30 * 60_000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60_000;

export function postgresSessionStore(db: Db): SessionStore {
  return {
    set(id, data, callback) {
      const now = new Date();
      const persisted = JSON.parse(JSON.stringify(data)) as Record<
        string,
        unknown
      >;
      delete persisted.sessionId;
      delete persisted.encryptedSessionId;
      void db
        .insert(sessions)
        .values({
          tokenHash: digest(id),
          data: persisted,
          createdAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: sessions.tokenHash,
          set: { data: persisted, lastSeenAt: now },
          setWhere: and(
            isNull(sessions.revokedAt),
            gt(sessions.lastSeenAt, new Date(now.getTime() - IDLE_MS)),
            gt(sessions.createdAt, new Date(now.getTime() - ABSOLUTE_MS)),
          )!,
        })
        .then(() => callback(), callback);
    },
    get(id, callback) {
      const now = new Date();
      void db
        .update(sessions)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(sessions.tokenHash, digest(id)),
            isNull(sessions.revokedAt),
            gt(sessions.lastSeenAt, new Date(now.getTime() - IDLE_MS)),
            gt(sessions.createdAt, new Date(now.getTime() - ABSOLUTE_MS)),
            sql`(${sessions.data}->>'authGeneration' IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = ${OWNER_ID} AND auth_generation = (${sessions.data}->>'authGeneration')::integer))`,
          ),
        )
        .returning({ data: sessions.data })
        .then(
          ([row]) => callback(null, row ? (row.data as Session) : null),
          callback,
        );
    },
    destroy(id, callback) {
      void db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.tokenHash, digest(id)))
        .then(() => callback(), callback);
    },
  };
}

export function authStore(db: Db) {
  return {
    async hasOwner() {
      return (
        (await db.select({ id: users.id }).from(users).limit(1)).length > 0
      );
    },
    async getOwnerGeneration() {
      const [row] = await db
        .select({ generation: users.authGeneration })
        .from(users)
        .where(eq(users.id, OWNER_ID));
      return row?.generation ?? null;
    },
    async hasValidBootstrap(hash: string) {
      return (
        (
          await db
            .select({ hash: bootstrapTokens.tokenHash })
            .from(bootstrapTokens)
            .where(
              and(
                eq(bootstrapTokens.tokenHash, hash),
                isNull(bootstrapTokens.consumedAt),
                gt(bootstrapTokens.expiresAt, new Date()),
              ),
            )
            .limit(1)
        ).length > 0
      );
    },
    async issueBootstrap(hash: string, expiresAt: Date) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(739183)`);
        if ((await tx.select({ id: users.id }).from(users).limit(1)).length)
          throw new Error("OWNER_EXISTS");
        await tx.delete(bootstrapTokens);
        await tx.insert(bootstrapTokens).values({ tokenHash: hash, expiresAt });
      });
    },
    async consumeBootstrap(
      hash: string,
      displayName: string,
      credential:
        | {
            kind: "password";
            passwordHash: string;
            encryptedTotp: string;
            lastTotpStep: number;
          }
        | {
            kind: "passkey";
            id: string;
            publicKey: string;
            counter: number;
            transports: string[];
          },
      codeHashes: string[],
    ) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(739183)`);
        if ((await tx.select({ id: users.id }).from(users).limit(1)).length)
          return false;
        const [token] = await tx
          .update(bootstrapTokens)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(bootstrapTokens.tokenHash, hash),
              isNull(bootstrapTokens.consumedAt),
              gt(bootstrapTokens.expiresAt, new Date()),
            ),
          )
          .returning({ hash: bootstrapTokens.tokenHash });
        if (!token) return false;
        await tx.insert(users).values({ id: OWNER_ID, displayName });
        if (credential.kind === "password") {
          await tx.insert(authCredentials).values({
            id: "password",
            userId: OWNER_ID,
            kind: "password",
            passwordHash: credential.passwordHash,
            confirmed: true,
          });
          await tx.insert(authCredentials).values({
            id: "totp",
            userId: OWNER_ID,
            kind: "totp",
            encryptedSecret: credential.encryptedTotp,
            lastTotpStep: credential.lastTotpStep,
            confirmed: true,
          });
        } else {
          await tx.insert(authCredentials).values({
            id: credential.id,
            userId: OWNER_ID,
            kind: "passkey",
            passkeyPublicKey: credential.publicKey,
            passkeyCounter: credential.counter,
            passkeyTransports: credential.transports,
            confirmed: true,
          });
        }
        await tx
          .insert(recoveryCodes)
          .values(
            codeHashes.map((codeHash) => ({ codeHash, userId: OWNER_ID })),
          );
        return true;
      });
    },
    async getCredential(kind: string) {
      const [row] = await db
        .select({
          credential: authCredentials,
          authGeneration: users.authGeneration,
        })
        .from(authCredentials)
        .innerJoin(users, eq(authCredentials.userId, users.id))
        .where(and(eq(authCredentials.kind, kind), eq(users.id, OWNER_ID)))
        .limit(1);
      return row
        ? { ...row.credential, authGeneration: row.authGeneration }
        : undefined;
    },
    async consumeTotp(step: number, expectedGeneration: number) {
      const [row] = await db
        .update(authCredentials)
        .set({ lastTotpStep: step })
        .where(
          and(
            eq(authCredentials.id, "totp"),
            eq(authCredentials.confirmed, true),
            sql`(${authCredentials.lastTotpStep} IS NULL OR ${authCredentials.lastTotpStep} < ${step})`,
            sql`EXISTS (SELECT 1 FROM users WHERE id = ${OWNER_ID} AND auth_generation = ${expectedGeneration})`,
          ),
        )
        .returning({ id: authCredentials.id });
      return Boolean(row);
    },
    async bumpPasskey(
      id: string,
      oldCounter: number,
      nextCounter: number,
      expectedGeneration: number,
    ) {
      const [row] = await db
        .update(authCredentials)
        .set({ passkeyCounter: nextCounter })
        .where(
          and(
            eq(authCredentials.id, id),
            eq(authCredentials.passkeyCounter, oldCounter),
            sql`EXISTS (SELECT 1 FROM users WHERE id = ${OWNER_ID} AND auth_generation = ${expectedGeneration})`,
          ),
        )
        .returning({ id: authCredentials.id });
      return Boolean(row);
    },
    async replacePasskey(
      expectedGeneration: number,
      id: string,
      publicKey: string,
      counter: number,
      transports: string[],
      codeHashes: string[],
    ) {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .update(users)
          .set({ authGeneration: expectedGeneration + 1 })
          .where(
            and(
              eq(users.id, OWNER_ID),
              eq(users.authGeneration, expectedGeneration),
            ),
          )
          .returning({ generation: users.authGeneration });
        if (!owner) return null;
        await tx
          .update(authCredentials)
          .set({
            id,
            passkeyPublicKey: publicKey,
            passkeyCounter: counter,
            passkeyTransports: transports,
            confirmed: true,
          })
          .where(eq(authCredentials.kind, "passkey"));
        await tx
          .delete(recoveryCodes)
          .where(eq(recoveryCodes.userId, OWNER_ID));
        await tx
          .insert(recoveryCodes)
          .values(
            codeHashes.map((codeHash) => ({ codeHash, userId: OWNER_ID })),
          );
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(isNull(sessions.revokedAt));
        return owner.generation;
      });
    },
    async replaceTotp(
      expectedGeneration: number,
      encryptedSecret: string,
      step: number,
      codeHashes: string[],
    ) {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .update(users)
          .set({ authGeneration: expectedGeneration + 1 })
          .where(
            and(
              eq(users.id, OWNER_ID),
              eq(users.authGeneration, expectedGeneration),
            ),
          )
          .returning({ generation: users.authGeneration });
        if (!owner) return null;
        await tx
          .update(authCredentials)
          .set({ encryptedSecret, lastTotpStep: step, confirmed: true })
          .where(eq(authCredentials.id, "totp"));
        await tx
          .delete(recoveryCodes)
          .where(eq(recoveryCodes.userId, OWNER_ID));
        await tx
          .insert(recoveryCodes)
          .values(
            codeHashes.map((codeHash) => ({ codeHash, userId: OWNER_ID })),
          );
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(isNull(sessions.revokedAt));
        return owner.generation;
      });
    },
    async replacePassword(
      expectedGeneration: number,
      passwordHash: string,
      codeHashes: string[],
    ) {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .update(users)
          .set({ authGeneration: expectedGeneration + 1 })
          .where(
            and(
              eq(users.id, OWNER_ID),
              eq(users.authGeneration, expectedGeneration),
            ),
          )
          .returning({ generation: users.authGeneration });
        if (!owner) return null;
        await tx
          .update(authCredentials)
          .set({ passwordHash })
          .where(eq(authCredentials.id, "password"));
        await tx
          .delete(recoveryCodes)
          .where(eq(recoveryCodes.userId, OWNER_ID));
        await tx
          .insert(recoveryCodes)
          .values(
            codeHashes.map((codeHash) => ({ codeHash, userId: OWNER_ID })),
          );
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(isNull(sessions.revokedAt));
        return owner.generation;
      });
    },
    async setRecoveryCodes(hashes: string[]) {
      await db.transaction(async (tx) => {
        await tx
          .delete(recoveryCodes)
          .where(eq(recoveryCodes.userId, OWNER_ID));
        await tx
          .insert(recoveryCodes)
          .values(hashes.map((codeHash) => ({ codeHash, userId: OWNER_ID })));
      });
    },
    async consumeRecovery(hash: string, expectedGeneration: number) {
      const [row] = await db
        .update(recoveryCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(recoveryCodes.codeHash, hash),
            isNull(recoveryCodes.usedAt),
            sql`EXISTS (SELECT 1 FROM users WHERE id = ${OWNER_ID} AND auth_generation = ${expectedGeneration})`,
          ),
        )
        .returning({ codeHash: recoveryCodes.codeHash });
      return Boolean(row);
    },
    async consumePasswordRecovery(
      hash: string,
      step: number,
      expectedGeneration: number,
    ) {
      return db
        .transaction(async (tx) => {
          const [owner] = await tx
            .select({ generation: users.authGeneration })
            .from(users)
            .where(eq(users.id, OWNER_ID))
            .for("update");
          if (owner?.generation !== expectedGeneration) return false;
          const [code] = await tx
            .update(recoveryCodes)
            .set({ usedAt: new Date() })
            .where(
              and(
                eq(recoveryCodes.codeHash, hash),
                isNull(recoveryCodes.usedAt),
              ),
            )
            .returning({ codeHash: recoveryCodes.codeHash });
          if (!code) return false;
          const [totp] = await tx
            .update(authCredentials)
            .set({ lastTotpStep: step })
            .where(
              and(
                eq(authCredentials.id, "totp"),
                sql`(${authCredentials.lastTotpStep} IS NULL OR ${authCredentials.lastTotpStep} < ${step})`,
              ),
            )
            .returning({ id: authCredentials.id });
          if (!totp) throw new Error("TOTP_REPLAY");
          return true;
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === "TOTP_REPLAY")
            return false;
          throw error;
        });
    },
    async issueChallenge(id: string, challenge: string, kind: string) {
      await db.insert(authChallenges).values({
        id,
        challengeHash: digest(challenge),
        kind,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      });
    },
    async consumeChallenge(
      id: string,
      challenge: string,
      kind: string,
      expectedGeneration?: number,
    ) {
      const [row] = await db
        .update(authChallenges)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(authChallenges.id, id),
            eq(authChallenges.challengeHash, digest(challenge)),
            eq(authChallenges.kind, kind),
            isNull(authChallenges.consumedAt),
            gt(authChallenges.expiresAt, new Date()),
            expectedGeneration === undefined
              ? undefined
              : sql`EXISTS (SELECT 1 FROM users WHERE id = ${OWNER_ID} AND auth_generation = ${expectedGeneration})`,
          ),
        )
        .returning({ id: authChallenges.id });
      return Boolean(row);
    },
  };
}
export type AuthStore = ReturnType<typeof authStore>;
