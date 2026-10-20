import assert from "node:assert/strict";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  authStore,
  digest,
  postgresSessionStore,
} from "../../apps/server/dist/auth-store.js";
import {
  databaseUrl,
  loadRuntimeConfig,
  openDatabase,
  sessions,
  authChallenges,
  authCredentials,
} from "../../packages/db/dist/index.js";
import { eq } from "drizzle-orm";
import { buildApp } from "../../apps/server/dist/app.js";

const config = loadRuntimeConfig(process.env);
const database = openDatabase(databaseUrl(config));
const store = authStore(database.db);
const candidate = () => randomBytes(32).toString("base64url");
const token = candidate();
const codeHashes = Array.from({ length: 10 }, () => digest(candidate()));
try {
  const expired = candidate();
  await store.issueBootstrap(digest(expired), new Date(Date.now() - 1_000));
  assert.equal(
    await store.consumeBootstrap(
      digest(expired),
      "Example Owner",
      {
        kind: "password",
        passwordHash: "fixture-only",
        encryptedTotp: "fixture-only",
        lastTotpStep: 1,
      },
      codeHashes,
    ),
    false,
  );
  await store.issueBootstrap(digest(token), new Date(Date.now() + 60_000));
  const fixture = {
    kind: "password",
    passwordHash: "fixture-only",
    encryptedTotp: "fixture-only",
    lastTotpStep: 1,
  };
  const results = await Promise.all([
    store.consumeBootstrap(digest(token), "Example Owner", fixture, codeHashes),
    store.consumeBootstrap(digest(token), "Example Owner", fixture, codeHashes),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(
    await store.consumeBootstrap(
      digest(token),
      "Example Owner",
      fixture,
      codeHashes,
    ),
    false,
  );
  assert.equal(await store.consumeRecovery(codeHashes[0], 1), true);
  assert.equal(await store.consumeRecovery(codeHashes[0], 1), false);
  const sessionStore = postgresSessionStore(database.db);
  const id = candidate();
  const set = (data) =>
    new Promise((resolve, reject) =>
      sessionStore.set(id, data, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  const get = () =>
    new Promise((resolve, reject) =>
      sessionStore.get(id, (error, data) =>
        error ? reject(error) : resolve(data),
      ),
    );
  const destroy = () =>
    new Promise((resolve, reject) =>
      sessionStore.destroy(id, (error) => (error ? reject(error) : resolve())),
    );
  await set({
    userId: "owner",
    sessionId: id,
    encryptedSessionId: id,
    cookie: { originalMaxAge: 10000 },
  });
  const [row] = await database.db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, digest(id)));
  assert.ok(row);
  assert.equal(row.data.sessionId, undefined);
  assert.equal(row.data.encryptedSessionId, undefined);
  assert.equal(JSON.stringify(row).includes(id), false);
  assert.equal((await get()).userId, "owner");
  await destroy();
  assert.equal(await get(), null);
  await set({ userId: "owner", cookie: { originalMaxAge: 10000 } });
  assert.equal(await get(), null, "a stale save must not revive logout");
  const getBy = (tokenId) =>
    new Promise((resolve, reject) =>
      sessionStore.get(tokenId, (error, data) =>
        error ? reject(error) : resolve(data),
      ),
    );
  const idleId = candidate();
  await new Promise((resolve, reject) =>
    sessionStore.set(
      idleId,
      { userId: "owner", cookie: { originalMaxAge: 10000 } },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  await database.db
    .update(sessions)
    .set({ lastSeenAt: new Date(Date.now() - 31 * 60_000) })
    .where(eq(sessions.tokenHash, digest(idleId)));
  assert.equal(await getBy(idleId), null);
  await new Promise((resolve, reject) =>
    sessionStore.set(idleId, { userId: "owner", authGeneration: 1 }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  assert.equal(
    await getBy(idleId),
    null,
    "a stale save must not revive idle expiry",
  );
  const absoluteId = candidate();
  await new Promise((resolve, reject) =>
    sessionStore.set(
      absoluteId,
      { userId: "owner", cookie: { originalMaxAge: 10000 } },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  await database.db
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })
    .where(eq(sessions.tokenHash, digest(absoluteId)));
  assert.equal(await getBy(absoluteId), null);
  const replacement = candidate();
  assert.equal(await store.consumeTotp(2, 1), true);
  const verifiedGeneration = (await store.getCredential("totp")).authGeneration;
  assert.equal(verifiedGeneration, 1);
  assert.equal(
    await store.replaceTotp(1, "new-fixture-only", 3, [digest(replacement)]),
    2,
  );
  assert.equal(
    await store.consumeTotp(4, verifiedGeneration),
    false,
    "a pre-reset login cannot consume the replaced credential",
  );
  const lateSession = candidate();
  await new Promise((resolve, reject) =>
    sessionStore.set(
      lateSession,
      { userId: "owner", authGeneration: verifiedGeneration },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  assert.equal(await getBy(lateSession), null, "late login session must not load after credential replacement");
  assert.equal(await store.consumeRecovery(codeHashes[1], 1), false);
  assert.equal(await store.consumeRecovery(digest(replacement), 1), false);
  const competingCodes = [[digest(candidate())], [digest(candidate())]];
  const competing = await Promise.all([
    store.replaceTotp(2, "race-a", 4, competingCodes[0]),
    store.replaceTotp(2, "race-b", 4, competingCodes[1]),
  ]);
  assert.equal(
    competing.filter((generation) => generation === 3).length,
    1,
    "only one concurrent replacement wins",
  );
  assert.equal(competing.filter((generation) => generation === null).length, 1);
  const challengeId = candidate();
  const challenge = candidate();
  await store.issueChallenge(challengeId, challenge, "authentication");
  assert.equal(
    await store.consumeChallenge(challengeId, challenge, "authentication"),
    true,
  );
  assert.equal(
    await store.consumeChallenge(challengeId, challenge, "authentication"),
    false,
    "challenge replay rejected",
  );
  const expiredChallengeId = candidate();
  await store.issueChallenge(expiredChallengeId, challenge, "authentication");
  await database.db
    .update(authChallenges)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(authChallenges.id, expiredChallengeId));
  assert.equal(
    await store.consumeChallenge(
      expiredChallengeId,
      challenge,
      "authentication",
    ),
    false,
  );
  const staleChallengeId = candidate();
  await store.issueChallenge(staleChallengeId, challenge, "authentication");
  assert.equal(await store.consumeChallenge(staleChallengeId, challenge, "authentication", 2), false, "old credential generation cannot consume a challenge");
  await database.db
    .insert(authCredentials)
    .values({
      id: "fixture-passkey",
      userId: "owner",
      kind: "passkey",
      passkeyPublicKey: "fixture-only",
      passkeyCounter: 1,
      confirmed: true,
    });
  assert.equal(await store.bumpPasskey("fixture-passkey", 1, 2, 3), true);
  assert.equal(
    await store.bumpPasskey("fixture-passkey", 1, 2, 3),
    false,
    "stale counter rejected",
  );
  assert.equal(
    await store.bumpPasskey("fixture-passkey", 2, 3, 2),
    false,
    "stale generation rejected",
  );
  const currentCode = competingCodes[competing.indexOf(3)][0];
  assert.equal(await store.consumePasswordRecovery(currentCode, 5, 3), true);
  assert.equal(await store.consumePasswordRecovery(currentCode, 6, 3), false, "recovery code is one-time use");
  assert.equal(await store.replacePassword(3, "replacement-fixture-only", [digest(candidate())]), 4);
  assert.equal(await store.consumeRecovery(currentCode, 3), false, "old codes and generation are invalidated");
  const http = buildApp(undefined, undefined, {
    origin: config.APP_ORIGIN,
    masterKey: Buffer.from(config.STATION_MASTER_KEY, 'base64'),
    db: database.db,
    store,
  });
  try {
    for (let index = 0; index < 120; index++) {
      const response = await http.inject({ method: 'GET', url: '/api/auth/status' });
      assert.equal(response.statusCode, 200);
    }
    const limited = await http.inject({ method: 'GET', url: '/api/auth/status' });
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal(limited.json().error, 'Too many requests. Wait a minute and try again.');
  } finally {
    await http.close();
  }
  process.stdout.write(
    "Real PostgreSQL authentication transaction, session, and rate-limit checks passed.\n",
  );
} finally {
  await database.close();
}
