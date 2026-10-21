import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { generate } from 'otplib';
import { databaseUrl, loadRuntimeConfig, openDatabase, PrivateBlobStore, orbits, settings, oauthApps,
  accounts, syncStates, items, labels, itemLabels, drafts, draftAttachments, outboundOperations } from '../../packages/db/dist/index.js';
import { sealSecret } from '../../packages/connectors/dist/index.js';
import { GMAIL_DISCOVER_QUEUE, GMAIL_SYNC_QUEUE } from '../../apps/worker/dist/queue.js';
import { authStore, digest } from '../../apps/server/dist/auth-store.js';

const fetch = globalThis.fetch;
const AbortSignal = globalThis.AbortSignal;
const config = loadRuntimeConfig(process.env);
const connection = openDatabase(databaseUrl(config));
const db = connection.db;
const key = Buffer.from(config.STATION_MASTER_KEY, 'base64');
const root = process.env.STATION_TEST_BLOB_ROOT ?? `${process.cwd()}/.cache/results/process-recovery-blobs`;
const artifacts = process.env.PROCESS_RECOVERY_ARTIFACT_ROOT ?? `${process.cwd()}/.cache/results/process-recovery`;
await mkdir(root, { recursive: true });
await mkdir(artifacts, { recursive: true });
const port = () => new Promise((resolve, reject) => {
  const socket = createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => resolve(value)); });
});
const ports = { provider: await port(), parser: await port(), app: await port() };
const env = { ...process.env, APP_ORIGIN: 'https://example.com', FIXTURE_PROVIDER_PORT: String(ports.provider),
  FIXTURE_PARSER_PORT: String(ports.parser), FIXTURE_APP_PORT: String(ports.app), STATION_TEST_BLOB_ROOT: root };
const children = new Set();
let childNumber = 0;
const launch = (label, file, args = []) => {
  const child = spawn(process.execPath, [file, ...args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const stream = createWriteStream(`${artifacts}/${++childNumber}-${label}.log`);
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  child.once('exit', (code, signal) => { stream.end(`\nexit ${code ?? signal}\n`); });
  return child;
};
const kill = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGKILL');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000).then(() => { throw new Error('Child did not exit'); })]);
};
const waitFor = async (label, probe, timeout = 30_000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await probe(); if (result) return result; }
    catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`${label} timed out: ${last?.message ?? 'condition absent'}`);
};
const providerBase = `http://127.0.0.1:${ports.provider}`;
const appBase = `http://127.0.0.1:${ports.app}`;
const control = async (path, value) => {
  const response = await fetch(`${providerBase}/fixture/${path}`, { signal: AbortSignal.timeout(3_000), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal(response.status, 200);
};
const observation = () => fetch(`${providerBase}/fixture/state`, { signal: AbortSignal.timeout(3_000) }).then((response) => response.json());
const requireWorker = createRequire(new URL('../../apps/worker/package.json', import.meta.url));
const { PgBoss } = requireWorker('pg-boss');
const queue = new PgBoss({ connectionString: databaseUrl(config), migrate: false, registerInstance: false,
  supervise: false, monitorIntervalSeconds: 1, superviseIntervalSeconds: 1 });
const accountId = randomUUID();
const origin = 'https://example.com';
const state = async () => (await db.select().from(syncStates).where(eq(syncStates.accountId, accountId)))[0];
const rows = async () => db.select().from(items).where(eq(items.accountId, accountId));
const jobRecord = async (id) => (await db.execute(sql`select state, retry_count, singleton_key from pgboss.job where id = ${id}`)).rows[0];
const syncJobs = async () => (await db.execute(sql`select id, state, retry_count, singleton_key from pgboss.job where name = ${GMAIL_SYNC_QUEUE} order by created_on, id`)).rows;
const jobState = async (id) => (await jobRecord(id))?.state;
const request = async (method, path, payload, csrf, cookie = '') => {
  const response = await fetch(`${appBase}${path}`, { signal: AbortSignal.timeout(30_000), method, headers: { 'x-forwarded-proto': 'https',
    ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
};
let worker, contender, app;
try {
  launch('provider', 'tests/support/process-recovery-provider.mjs');
  launch('parser', 'tests/support/process-recovery-runtime.mjs', ['parser']);
  await waitFor('provider health', () => observation());
  await waitFor('parser health', async () => (await fetch(`http://127.0.0.1:${ports.parser}/health`, { signal: AbortSignal.timeout(3_000) })).ok);
  app = launch('app-send', 'tests/support/process-recovery-runtime.mjs', ['app']);
  await waitFor('app ready', async () => (await fetch(`${appBase}/ready`, { signal: AbortSignal.timeout(3_000) })).ok);
  const auth = authStore(db);
  const bootstrap = randomBytes(32).toString('base64url');
  await auth.issueBootstrap(digest(bootstrap), new Date(Date.now() + 60_000));
  let response = await request('GET', '/api/auth/status');
  let cookie = response.cookie, csrf = response.data.csrfToken;
  response = await request('POST', '/api/auth/bootstrap/password', { bootstrapToken: bootstrap,
    displayName: 'Example owner', password: 'Example-only-password-123!' }, csrf, cookie);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const totpUri = response.data.totpUri;
  cookie = response.cookie ?? cookie;
  response = await request('GET', '/api/auth/status', undefined, undefined, cookie);
  csrf = response.data.csrfToken;
  const secret = new URL(totpUri).searchParams.get('secret');
  assert.ok(secret);
  const enrolled = await request('POST', '/api/auth/bootstrap/totp', { code: await generate({ secret }) }, csrf, cookie);
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.data));
  cookie = enrolled.cookie ?? cookie;
  csrf = (await request('GET', '/api/auth/status', undefined, undefined, cookie)).data.csrfToken;
  const ownerId = 'owner', orbitId = randomUUID(), appId = randomUUID();
  await db.insert(orbits).values({ id: orbitId, name: 'Example Orbit', slug: 'process-example', colorSlot: 1,
    context: '', privacyDefaults: { index: 'allow', ai: 'allow' } });
  await db.insert(settings).values({ key: 'first_orbit_setup_v1', value: { version: 1, orbitId, confirmedOrigin: origin,
    globalDefaults: { index: 'allow', ai: 'allow' } } });
  await db.insert(oauthApps).values({ id: appId, provider: 'google', ownerId, clientId: 'fixture-client',
    encryptedClientSecret: sealSecret('fixture-secret', key, `oauth_apps/${appId}/client_secret`), redirectUri: `${origin}/callback` });
  await db.insert(accounts).values({ id: accountId, provider: 'google', appId, orbitId, email: 'owner@example.com',
    encryptedRefreshToken: sealSecret('fixture-refresh', key, `accounts/${accountId}/refresh`),
    encryptedAccessToken: sealSecret('fixture-access', key, `accounts/${accountId}/access`),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000), backfill: 'all',
    grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'] });
  await queue.start();
  // Only the disposable queue expiry is shortened; zero retries and stately policy stay intact.
  await queue.updateQueue(GMAIL_SYNC_QUEUE, { expireInSeconds: 15 });
  const [queuePolicy] = (await db.execute(sql`select policy, retry_limit, expire_seconds from pgboss.queue where name = ${GMAIL_SYNC_QUEUE}`)).rows;
  assert.equal(queuePolicy.policy, 'stately');
  assert.equal(queuePolicy.retry_limit, 0);
  assert.equal(queuePolicy.expire_seconds, 15);
  await control('hold', { path: '/gmail/v1/users/me/messages/b', format: 'raw' });
  worker = launch('worker-initial', 'tests/support/process-recovery-runtime.mjs', ['worker']);
  const firstJob = (await waitFor('initial discovery job', async () => (await syncJobs())[0]))?.id;
  assert.ok(firstJob);
  assert.equal((await jobRecord(firstJob)).singleton_key, accountId);
  await waitFor('initial durable item and held provider read', async () => {
    const value = await observation();
    return value.holds.some((entry) => entry.path.endsWith('/b')) && (await rows()).some((row) => row.externalId === 'a');
  }, 45_000);
  assert.equal((await state()).cursor.offset, 1);
  const initialCursor = (await state()).cursor;
  await kill(worker);
  assert.equal((await rows()).length, 1);
  assert.equal(await jobState(firstJob), 'active');
  // The provider process remains alive while pg-boss expires this killed delivery.
  await waitFor('initial job failed after expiry', async () => {
    await queue.supervise(GMAIL_SYNC_QUEUE);
    return (await jobState(firstJob)) === 'failed';
  }, 30_000);
  assert.equal((await jobRecord(firstJob)).retry_count, 0);
  await db.update(syncStates).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(syncStates.accountId, accountId));
  assert.equal(await jobState(firstJob), 'failed');
  await control('release', {});
  worker = launch('worker-resume', 'tests/support/process-recovery-runtime.mjs', ['worker']);
  const initialSuccessor = (await waitFor('initial discovery successor', async () =>
    (await syncJobs()).find((job) => job.id !== firstJob)))?.id;
  assert.ok(initialSuccessor && initialSuccessor !== firstJob);
  assert.equal((await jobRecord(initialSuccessor)).singleton_key, accountId);
  await waitFor('initial successor completed', async () => (await jobState(initialSuccessor)) === 'completed', 60_000);
  await waitFor('initial complete', async () => (await state()).cursor.phase === 'ready', 30_000);
  assert.equal((await jobRecord(firstJob)).state, 'failed');
  assert.equal((await jobRecord(initialSuccessor)).retry_count, 0);
  assert.deepEqual((await rows()).map((row) => row.externalId).sort(), ['a', 'b']);
  assert.equal((await rows()).length, 2);
  assert.equal((await state()).cursor.anchor, '10');
  assert.equal((await observation()).calls.filter((entry) => entry.path === '/gmail/v1/users/me/messages' && !entry.query.includes('labelIds=SENT')).length, 1);
  assert.ok(initialCursor.nextCallAt > 0);
  await control('history', {});
  await control('hold', { path: '/gmail/v1/users/me/messages/a', format: 'raw' });
  const beforeHistoryJobs = new Set((await syncJobs()).map((job) => job.id));
  assert.ok(await queue.send(GMAIL_DISCOVER_QUEUE, {}, { singletonKey: 'discovery' }));
  const historyJob = (await waitFor('history discovery job', async () =>
    (await syncJobs()).find((job) => !beforeHistoryJobs.has(job.id))))?.id;
  assert.ok(historyJob);
  assert.equal((await jobRecord(historyJob)).singleton_key, accountId);
  await waitFor('history page held', async () => (await observation()).holds.some((entry) => entry.path.endsWith('/a')), 45_000);
  assert.equal((await state()).cursor.phase, 'history');
  assert.equal((await state()).cursor.historyToken, 'tail');
  assert.equal((await state()).cursor.historyOffset, 0);
  assert.ok((await rows()).some((row) => row.externalId === 'c'));
  const cRawBefore = (await observation()).calls.filter((entry) => entry.path.endsWith('/c') && entry.query.includes('format=raw')).length;
  await kill(worker);
  const historyBefore = await state();
  await waitFor('history job failed after expiry', async () => {
    await queue.supervise(GMAIL_SYNC_QUEUE);
    return (await jobState(historyJob)) === 'failed';
  }, 30_000);
  assert.equal((await jobRecord(historyJob)).retry_count, 0);
  await db.update(syncStates).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(syncStates.accountId, accountId));
  await control('release', {});
  worker = launch('worker-history-resume', 'tests/support/process-recovery-runtime.mjs', ['worker']);
  const historySuccessor = (await waitFor('history discovery successor', async () =>
    (await syncJobs()).find((job) => job.id !== historyJob && !beforeHistoryJobs.has(job.id))))?.id;
  assert.ok(historySuccessor && historySuccessor !== historyJob);
  assert.equal((await jobRecord(historySuccessor)).singleton_key, accountId);
  await waitFor('history successor completed', async () => (await jobState(historySuccessor)) === 'completed', 60_000);
  await waitFor('history cursor complete', async () => (await state()).cursor.anchor === '20', 30_000);
  assert.equal((await jobRecord(historyJob)).state, 'failed');
  assert.equal((await jobRecord(historySuccessor)).retry_count, 0);
  assert.equal((await observation()).calls.filter((entry) => entry.path.endsWith('/c') && entry.query.includes('format=raw')).length, cRawBefore);
  assert.deepEqual((await rows()).map((row) => row.externalId).sort(), ['a', 'b', 'c']);
  assert.equal((await state()).cursor.phase, 'ready');
  assert.equal((await db.select().from(itemLabels).where(eq(itemLabels.itemId, (await rows()).find((row) => row.externalId === 'a').id))).length, 1);
  assert.ok((await state()).sequence > historyBefore.sequence);
  const providerCalls = (await observation()).calls.filter((entry) => entry.path.startsWith('/gmail/'));
  for (let i = 1; i < providerCalls.length; i++) {
    const previous = providerCalls[i - 1], next = providerCalls[i];
    const wallDelta = next.at - previous.at;
    if (wallDelta < 850) {
      const pacingState = await state();
      const safe = (call) => ({ method: call.method, path: call.path.slice(0, 120),
        at: call.at, elapsedMs: call.elapsedMs });
      assert.fail(`provider pacing ${JSON.stringify({ previous: safe(previous), next: safe(next),
        wallDelta, elapsedDelta: next.elapsedMs - previous.elapsedMs,
        generation: pacingState.generation, sequence: pacingState.sequence,
        nextCallAt: pacingState.cursor?.nextCallAt })}`);
    }
  }
  const empty = (await db.select().from(labels).where(eq(labels.accountId, accountId))).find((row) => row.providerRef === 'EMPTY');
  assert.ok(empty);
  assert.equal((await db.select().from(itemLabels).where(eq(itemLabels.labelId, empty.id))).length, 0);

  // An independent runner must not take a live lease. The fixture then advances
  // only the lease timestamp, retaining the generation fence for the old worker.
  await control('hold', { path: '/gmail/v1/users/me/labels' });
  const beforeLeaseJobs = new Set((await syncJobs()).map((job) => job.id));
  assert.ok(await queue.send(GMAIL_DISCOVER_QUEUE, {}, { singletonKey: 'discovery' }));
  const leaseJob = (await waitFor('lease discovery job', async () =>
    (await syncJobs()).find((job) => !beforeLeaseJobs.has(job.id))))?.id;
  assert.ok(leaseJob);
  assert.equal((await jobRecord(leaseJob)).singleton_key, accountId);
  await waitFor('lease read held', async () => (await observation()).holds.some((entry) => entry.path.endsWith('/labels')), 30_000);
  const leased = await state();
  contender = launch('worker-lease-denied', 'tests/support/process-recovery-runtime.mjs', ['lease-probe', accountId]);
  await waitFor('live lease denied to second process', () => contender.exitCode !== null, 5_000);
  assert.equal(contender.exitCode, 0);
  assert.equal((await state()).generation, leased.generation);
  assert.equal((await state()).status, 'running');
  assert.ok((await state()).leaseUntil > new Date());
  await db.update(syncStates).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(syncStates.id, leased.id));
  contender = launch('worker-lease-takeover', 'tests/support/process-recovery-runtime.mjs', ['lease-probe', accountId]);
  await waitFor('expired lease claimed by second process', async () => (await state()).generation > leased.generation, 5_000);
  await kill(worker);
  await kill(contender);
  await queue.cancel(GMAIL_SYNC_QUEUE, leaseJob);
  await control('release', {});

  const draftId = randomUUID();
  response = await request('POST', '/api/mail/drafts', { id: draftId, creationKey: randomUUID(), accountId,
    to: [{ address: 'recipient@example.com', name: 'Example Recipient' }], cc: [], bcc: [],
    subject: 'Example process send', bodyText: 'Example body', attachmentRefs: [] }, csrf, cookie);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const bytes = Buffer.from('Example attachment');
  const blobKey = PrivateBlobStore.generateKey();
  const blobs = new PrivateBlobStore(root);
  await blobs.writeReserved(blobKey, bytes);
  const attachmentId = randomUUID();
  await db.insert(draftAttachments).values({ id: attachmentId, draftId, accountId, blobKey, uploadKey: randomUUID(),
    digest: createHash('sha256').update(bytes).digest('hex'), filename: 'example.txt', byteSize: bytes.length, state: 'ready' });
  await db.update(drafts).set({ attachmentRefs: [attachmentId], revision: 2 }).where(eq(drafts.id, draftId));
  await control('hold', { path: '/gmail/v1/users/me/messages/send' });
  const sendPromise = request('POST', `/api/mail/drafts/${draftId}/send?accountId=${accountId}`,
    { idempotencyKey: randomUUID(), revision: 2 }, csrf, cookie).catch(() => null);
  await waitFor('provider accepted send', async () => (await observation()).sent.length === 1, 30_000);
  const [operation] = await db.select().from(outboundOperations).where(eq(outboundOperations.draftId, draftId));
  assert.equal(operation.state, 'in_flight');
  assert.equal(operation.blobReady, true);
  assert.equal(operation.attemptCount, 1);
  assert.equal(createHash('sha256').update(await blobs.read(operation.blobKey, 12 * 1024 * 1024)).digest('hex'), operation.mimeDigest);
  await kill(app);
  // Advance only the operation's stale-status clock; the provider and frozen MIME are untouched.
  await db.update(outboundOperations).set({ updatedAt: new Date(Date.now() - 31_000) }).where(eq(outboundOperations.id, operation.id));
  await sendPromise;
  await control('release', {});
  app = launch('app-restarted', 'tests/support/process-recovery-runtime.mjs', ['app']);
  await waitFor('restarted app ready', async () => (await fetch(`${appBase}/ready`, { signal: AbortSignal.timeout(3_000) })).ok);
  response = await request('GET', `/api/mail/sends/unresolved?accountId=${accountId}`, undefined, undefined, cookie);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.ok(response.data.operations.some((entry) => entry.id === operation.id));
  response = await request('GET', `/api/mail/sends/${operation.id}?accountId=${accountId}`, undefined, undefined, cookie);
  assert.equal(response.data.state, 'outcome_unknown');
  assert.equal((await observation()).sent.length, 1);
  response = await request('POST', `/api/mail/sends/${operation.id}/reconcile?accountId=${accountId}`, {}, csrf, cookie);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.state, 'succeeded');
  assert.equal((await observation()).sent.length, 1);
  assert.equal((await db.select().from(drafts).where(eq(drafts.id, draftId)))[0].state, 'sent');
  assert.equal((await db.select().from(draftAttachments).where(eq(draftAttachments.id, attachmentId)))[0].state, 'delete_pending');
  assert.ok((await blobs.read(operation.blobKey, 12 * 1024 * 1024)).length > 0);
  console.log('process recovery fixture passed');
} finally {
  for (const child of [...children]) await kill(child).catch(() => {});
  await queue.stop({ timeout: 5_000 }).catch(() => {});
  await connection.close();
  if (!process.env.STATION_TEST_BLOB_ROOT) await rm(root, { recursive: true, force: true });
}
