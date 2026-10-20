import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { TextDecoder } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { setTimeout as schedule } from 'node:timers';
import { generate } from 'otplib';
const fetch = globalThis.fetch;
import { and, eq, isNull, sql } from 'drizzle-orm';
import { buildApp } from '../../apps/server/dist/app.js';
import { authStore, digest } from '../../apps/server/dist/auth-store.js';
import { accounts, appendSyncEvent, databaseUrl, loadRuntimeConfig, oauthApps, openDatabase, orbits,
  readSyncEvents, sessions, syncStates, users } from '../../packages/db/dist/index.js';

const config = loadRuntimeConfig(process.env);
const handle = openDatabase(databaseUrl(config));
const other = openDatabase(databaseUrl(config));
const db = handle.db;
const waitFor = async (check, message, timeoutMs = 3_000) => {
  const until = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    await sleep(50);
  } while (Date.now() < until);
  assert.fail(message);
};
const blockedBackend = async (table) => {
  const result = await other.db.execute(sql`select pid from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'
    and query ilike ${`%from "${table}"%`} limit 1`);
  return result.rows[0]?.pid;
};
const backendIdle = async (pid) => {
  const result = await other.db.execute(sql`select state, wait_event_type from pg_stat_activity where pid = ${pid}`);
  return !result.rows[0] || (result.rows[0].state === 'idle' && result.rows[0].wait_event_type !== 'Lock');
};
const origin = 'https://example.com';
const store = authStore(db);
const app = buildApp(async () => {}, undefined, { db, origin, masterKey: Buffer.from(config.STATION_MASTER_KEY, 'base64'), store },
  { trustedProxyIp: '127.0.0.1' });
app.addHook('onRequest', (request, reply, done) => {
  if (request.url === '/api/sync/events' && request.headers['x-fixture-slow'] === '1')
    reply.raw.write = () => false; // The plugin's drain promise will never settle.
  if (request.url === '/api/sync/events' && request.headers['x-fixture-slow'] === 'paced') {
    const original = reply.raw.write.bind(reply.raw);
    reply.raw.write = (...args) => {
      original(...args);
      schedule(() => reply.raw.emit('drain'), 1_600);
      return false;
    };
  }
  done();
});
let cookie = '';
const send = async (method, url, payload, csrf) => {
  const response = await app.inject({ method, url, remoteAddress: '127.0.0.1', headers: {
    'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}),
    ...(method === 'POST' ? { origin, 'x-csrf-token': csrf } : {}),
  }, ...(payload === undefined ? {} : { payload }) });
  const setCookie = response.headers['set-cookie'];
  if (setCookie) cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  return response;
};
const status = async () => (await send('GET', '/api/auth/status')).json();
const accountId = randomUUID();
let address;
try {
  await app.ready();
  assert.equal((await send('GET', '/api/sync/progress')).statusCode, 401);
  const bootstrap = randomBytes(32).toString('base64url');
  await store.issueBootstrap(digest(bootstrap), new Date(Date.now() + 60_000));
  let csrf = (await status()).csrfToken;
  const enrolled = await send('POST', '/api/auth/bootstrap/password', { bootstrapToken: bootstrap,
    displayName: 'Example Owner', password: 'Example-only-password-123!' }, csrf);
  assert.equal(enrolled.statusCode, 200, enrolled.body);
  csrf = (await status()).csrfToken;
  const secret = new URL(enrolled.json().totpUri).searchParams.get('secret');
  assert.equal((await send('POST', '/api/auth/bootstrap/totp', { code: await generate({ secret }) }, csrf)).statusCode, 200);

  const orbitId = randomUUID();
  const appId = randomUUID();
  await db.insert(orbits).values({ id: orbitId, name: 'Example', slug: 'example', colorSlot: 1, context: '',
    privacyDefaults: { index: 'allow', ai: 'allow' } });
  await db.insert(oauthApps).values({ id: appId, provider: 'google', ownerId: 'owner', clientId: 'fixture',
    encryptedClientSecret: 'fixture', redirectUri: `${origin}/api/google/callback` });
  await db.insert(accounts).values({ id: accountId, provider: 'google', appId, orbitId, email: 'owner@example.com',
    encryptedRefreshToken: 'fixture', encryptedAccessToken: 'fixture', grantedScopes: [], backfill: 'all' });
  const progress = await send('GET', '/api/sync/progress');
  assert.equal(progress.statusCode, 200, progress.body);
  assert.deepEqual(progress.json().accounts[0], { accountId, orbitId, phase: 'waiting', repairCode: null, retryAt: null,
    processedPages: 0, supportedItems: 0, unsupportedItems: 0, lastSuccessAt: null });
  assert.equal((await app.inject({ method: 'GET', url: '/api/sync/progress', headers: { cookie, origin: 'https://other.example.com' } })).statusCode, 403);
  const stateId = randomUUID();
  const cursor = { phase: 'full', retryAt: 0 };
  await db.insert(syncStates).values({ id: stateId, accountId, resource: 'mail', collectionId: 'primary', cursor });
  assert.equal((await send('GET', '/api/sync/progress')).json().accounts[0].phase, 'backfill');
  await db.update(syncStates).set({ cursor: { phase: 'history', retryAt: 0 } }).where(eq(syncStates.id, stateId));
  assert.equal((await send('GET', '/api/sync/progress')).json().accounts[0].phase, 'catchup');
  await db.update(syncStates).set({ cursor: { phase: 'ready', retryAt: 0 } }).where(eq(syncStates.id, stateId));
  assert.equal((await send('GET', '/api/sync/progress')).json().accounts[0].phase, 'current');
  await db.update(syncStates).set({ cursor: { phase: 'ready', retryAt: 8_639_999_999_999_999 }, lastError: 'transient' }).where(eq(syncStates.id, stateId));
  const extreme = (await send('GET', '/api/sync/progress')).json().accounts[0];
  assert.equal(extreme.phase, 'retry');
  assert.equal(extreme.retryAt, null);
  await db.update(syncStates).set({ status: 'blocked', lastError: 'permission_denied' }).where(eq(syncStates.id, stateId));
  assert.deepEqual(((await send('GET', '/api/sync/progress')).json().accounts[0].repairCode), 'permission_denied');

  const head0 = (await readSyncEvents(db, null)).head;
  await assert.rejects(db.transaction(async (tx) => { await appendSyncEvent(tx, 'sync-progress', accountId); throw new Error('rollback'); }));
  assert.equal((await readSyncEvents(db, null)).head, head0);
  let release;
  let entered;
  const firstReady = new Promise((resolve) => { entered = resolve; });
  const first = db.transaction(async (tx) => {
    await appendSyncEvent(tx, 'sync-progress', accountId);
    entered();
    await new Promise((resolve) => { release = resolve; });
  });
  await firstReady;
  let secondDone = false;
  const second = other.db.transaction(async (tx) => { await appendSyncEvent(tx, 'mail-changed', accountId); secondDone = true; });
  await sleep(100);
  assert.equal(secondDone, false, 'later append cannot commit past an open earlier append');
  assert.equal((await readSyncEvents(other.db, head0)).rows.length, 0, 'uncommitted event is invisible');
  release(); await Promise.all([first, second]);
  const replay = await readSyncEvents(other.db, head0);
  assert.deepEqual(replay.rows.map((row) => row.kind), ['sync-progress', 'mail-changed']);
  assert.deepEqual(replay.rows.map((row) => row.id), [head0 + 1, head0 + 2]);
  assert.equal((await readSyncEvents(db, head0 + 999)).gap, true, 'ahead cursor resets');
  assert.equal((await readSyncEvents(db, head0)).gap, false);

  const [session] = await db.select().from(sessions).where(and(isNull(sessions.revokedAt),
    sql`(${sessions.data}->>'userId') = 'owner'`, sql`(${sessions.data}->>'authGeneration') = '1'`));
  assert.ok(session, 'active owner session exists');
  await db.update(sessions).set({ data: { ...session.data, recoveryMode: 'totp' } }).where(eq(sessions.tokenHash, session.tokenHash));
  assert.equal((await send('GET', '/api/sync/progress')).statusCode, 401, 'recovery session cannot see progress');
  await db.update(sessions).set({ data: session.data }).where(eq(sessions.tokenHash, session.tokenHash));
  const before = new Date(Date.now() - 29 * 60_000);
  await db.update(sessions).set({ lastSeenAt: before }).where(eq(sessions.tokenHash, session.tokenHash));
  assert.equal((await send('GET', '/api/sync/progress')).statusCode, 200);
  const [passive] = await db.select().from(sessions).where(eq(sessions.tokenHash, session.tokenHash));
  assert.equal(passive.lastSeenAt.getTime(), before.getTime(), 'passive progress must not touch idle clock');
  assert.equal((await send('GET', '/api/auth/status')).statusCode, 200);
  const [active] = await db.select().from(sessions).where(eq(sessions.tokenHash, session.tokenHash));
  assert.ok(active.lastSeenAt > before, 'ordinary session requests preserve activity refresh');
  await db.update(sessions).set({ lastSeenAt: before }).where(eq(sessions.tokenHash, session.tokenHash));

  address = await app.listen({ host: '127.0.0.1', port: 0 });
  const stream = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https', accept: 'text/event-stream' } });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('cache-control'), 'no-store');
  const reader = stream.body.getReader();
  const firstChunk = await reader.read();
  assert.match(new TextDecoder().decode(firstChunk.value), /event: sync-reset/);
  await reader.cancel();
  const replayStream = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https',
    accept: 'text/event-stream', 'last-event-id': String(head0) } });
  assert.equal(replayStream.status, 200);
  const replayReader = replayStream.body.getReader();
  assert.match(new TextDecoder().decode((await replayReader.read()).value), /event: sync-progress/);
  await replayReader.cancel();
  const gapStream = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https',
    accept: 'text/event-stream', 'last-event-id': String(head0 + 999) } });
  assert.equal(gapStream.status, 200);
  const gapReader = gapStream.body.getReader();
  assert.match(new TextDecoder().decode((await gapReader.read()).value), /event: sync-reset/);
  await gapReader.cancel();
  const wrongOrigin = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https',
    accept: 'text/event-stream', origin: 'https://other.example.com' } });
  assert.equal(wrongOrigin.status, 403);
  const invalid = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https',
    accept: 'text/event-stream', 'last-event-id': 'nan' } });
  assert.equal(invalid.status, 400);
  const blockedStream = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https', accept: 'text/event-stream' } });
  const blockedReader = blockedStream.body.getReader();
  await blockedReader.read();
  let releaseSessionLock;
  let sessionLockHeld;
  const locked = new Promise((resolve) => { sessionLockHeld = resolve; });
  const heldLock = other.db.transaction(async (tx) => {
    await tx.execute(sql`lock table sessions in access exclusive mode`);
    sessionLockHeld();
    await new Promise((resolve) => { releaseSessionLock = resolve; });
  });
  await locked;
  const lockStarted = Date.now();
  try {
    const blockedPid = await waitFor(() => blockedBackend('sessions'), 'session query did not wait on fixture lock');
    const closedOnTimeout = await Promise.race([blockedReader.read().then((value) => value.done).catch(() => true), sleep(5_500).then(() => false)]);
    assert.equal(closedOnTimeout, true, 'stalled session check closes the stream');
    assert.ok(Date.now() - lockStarted < 5_000, 'session check has a bounded deadline');
    await waitFor(() => backendIdle(blockedPid), 'session query retained its pool client after timeout');
  } finally { releaseSessionLock(); await heldLock; }
  const slowReplayStart = (await readSyncEvents(db, null)).head;
  for (let index = 0; index < 8; index++)
    await other.db.transaction((tx) => appendSyncEvent(tx, 'sync-progress', accountId));
  const pacedStream = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https',
    accept: 'text/event-stream', 'last-event-id': String(slowReplayStart), 'x-fixture-slow': 'paced' } });
  assert.equal(pacedStream.status, 200);
  const pacedReader = pacedStream.body.getReader();
  let pacedEvents = 0;
  const firstPaced = await pacedReader.read();
  pacedEvents += (new TextDecoder().decode(firstPaced.value).match(/event: sync-progress/g) ?? []).length;
  const revokedAt = Date.now();
  await other.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, session.tokenHash));
  const pacedClosed = await Promise.race([(async () => {
    while (true) {
      try {
        const chunk = await pacedReader.read();
        if (chunk.done) return true;
        pacedEvents += (new TextDecoder().decode(chunk.value).match(/event: sync-progress/g) ?? []).length;
      } catch { return true; }
    }
  })(), sleep(5_500).then(() => false)]);
  assert.equal(pacedClosed, true, 'revocation closes a replay that drains slowly but before the send deadline');
  assert.ok(Date.now() - revokedAt < 5_000, 'replay authorization is checked on an elapsed-time cadence');
  assert.ok(pacedEvents < 8, 'revoked replay does not deliver the remaining account events');
  await db.update(sessions).set({ revokedAt: null }).where(eq(sessions.tokenHash, session.tokenHash));
  const slowStarted = Date.now();
  const slowStream = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https',
    accept: 'text/event-stream', 'x-fixture-slow': '1' } });
  const slowReader = slowStream.body.getReader();
  const slowClosed = await Promise.race([slowReader.read().then((value) => value.done).catch(() => true), sleep(4_500).then(() => false)]);
  assert.equal(slowClosed, true, 'a backpressured stream closes without waiting for a drain that never comes');
  assert.ok(Date.now() - slowStarted >= 1_500 && Date.now() - slowStarted < 5_000, 'backpressured send obeys its deadline');
  const capped = [];
  for (let index = 0; index < 8; index++) {
    const response = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https', accept: 'text/event-stream' } });
    assert.equal(response.status, 200);
    capped.push(response.body.getReader());
  }
  const extra = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https', accept: 'text/event-stream' } });
  assert.equal(extra.status, 429, 'per-process stream cap');
  await Promise.all(capped.map((open) => open.cancel()));
  await sleep(100);
  const afterCancel = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https', accept: 'text/event-stream' } });
  assert.equal(afterCancel.status, 200, 'cancelled streams release their slots');
  await afterCancel.body.cancel();
  const [stillPassive] = await db.select().from(sessions).where(eq(sessions.tokenHash, session.tokenHash));
  assert.equal(stillPassive.lastSeenAt.getTime(), before.getTime(), 'stream handshake must not touch idle clock');
  const idleStream = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https', accept: 'text/event-stream' } });
  const idleReader = idleStream.body.getReader();
  await idleReader.read();
  await db.update(sessions).set({ lastSeenAt: new Date(Date.now() - 31 * 60_000) }).where(eq(sessions.tokenHash, session.tokenHash));
  assert.equal(await Promise.race([idleReader.read().then((value) => value.done), sleep(6_000).then(() => false)]), true,
    'idle expiry closes an established stream');
  const activeCookie = cookie;
  assert.equal((await send('GET', '/api/sync/progress')).statusCode, 401, 'passive progress cannot revive an expired session');
  cookie = activeCookie;
  await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.tokenHash, session.tokenHash));
  const generationStream = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https', accept: 'text/event-stream' } });
  const generationReader = generationStream.body.getReader();
  await generationReader.read();
  await db.update(users).set({ authGeneration: 2 }).where(eq(users.id, 'owner'));
  assert.equal(await Promise.race([generationReader.read().then((value) => value.done), sleep(6_000).then(() => false)]), true,
    'auth generation reset closes established stream');
  assert.equal((await send('GET', '/api/sync/progress')).statusCode, 401);
  cookie = activeCookie;
  await db.update(users).set({ authGeneration: 1 }).where(eq(users.id, 'owner'));
  const revocationStream = await fetch(`${address}/api/sync/events`, { headers: { cookie, 'x-forwarded-proto': 'https', accept: 'text/event-stream' } });
  assert.equal(revocationStream.status, 200);
  const liveReader = revocationStream.body.getReader();
  await liveReader.read();
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, session.tokenHash));
  const closed = await Promise.race([liveReader.read().then((value) => value.done), sleep(6_000).then(() => false)]);
  assert.equal(closed, true, 'revocation must close cross-process stream promptly');
  assert.equal((await send('GET', '/api/sync/progress')).statusCode, 401);
  for (let index = 0; index < 513; index++)
    await other.db.transaction((tx) => appendSyncEvent(tx, 'sync-progress', accountId));
  assert.equal((await readSyncEvents(db, head0)).gap, true, 'pruned replay cursor resets');
  const retained = await db.execute(sql`select count(*)::integer as total from sync_events`);
  assert.equal(retained.rows[0].total, 512, 'journal retention is bounded');
  const capturedHead = (await readSyncEvents(db, null)).head;
  const captured = await readSyncEvents(db, capturedHead - 2, async () => {
    // Append and prune beyond the captured cursor after the reader has seen
    // its bounds but before it fetches rows. A READ COMMITTED reader skipped
    // the pruned IDs here; REPEATABLE READ must return its original snapshot.
    for (let index = 0; index < 513; index++)
      await other.db.transaction((tx) => appendSyncEvent(tx, 'mail-changed', accountId));
  });
  assert.equal(captured.gap, false);
  assert.equal(captured.head, capturedHead);
  assert.deepEqual(captured.rows.map((row) => row.id), [capturedHead - 1, capturedHead]);
  let releaseClockLock;
  let clockLockHeld;
  const clockLocked = new Promise((resolve) => { clockLockHeld = resolve; });
  const heldClockLock = other.db.transaction(async (tx) => {
    await tx.execute(sql`lock table event_clock in access exclusive mode`);
    clockLockHeld();
    await new Promise((resolve) => { releaseClockLock = resolve; });
  });
  await clockLocked;
  try {
    const replayRead = readSyncEvents(db, capturedHead);
    const blockedPid = await waitFor(() => blockedBackend('event_clock'), 'replay query did not wait on fixture lock');
    const started = Date.now();
    await assert.rejects(replayRead, (error) => error.cause?.code === '55P03' || error.code === '55P03');
    assert.ok(Date.now() - started < 2_000, 'replay lock wait ends before unlock');
    await waitFor(() => backendIdle(blockedPid), 'replay query retained its pool client after timeout');
  } finally { releaseClockLock(); await heldClockLock; }
  process.stdout.write('Sync journal commit ordering, rollback, replay, private progress, passive idle, and SSE revocation passed.\n');
} finally {
  await app.close();
  await handle.close();
  await other.close();
}
