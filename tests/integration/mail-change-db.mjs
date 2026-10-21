import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { randomBytes, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { generate } from 'otplib';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../apps/server/dist/app.js';
import { authStore, digest } from '../../apps/server/dist/auth-store.js';
import { accounts, auditLog, databaseUrl, itemOrbits, items, labels, loadRuntimeConfig, PrivateBlobStore,
  mailChangeOperations, oauthApps, openDatabase, orbits, settings, threads } from '../../packages/db/dist/index.js';
import { GmailSyncRunner } from '../../apps/worker/dist/gmail-sync.js';

const config = loadRuntimeConfig(process.env);
const handle = openDatabase(databaseUrl(config));
const db = handle.db;
const origin = 'https://example.com';
const store = authStore(db);
const id = () => randomUUID();
let calls = 0;
let inspectReads = 0;
let mode = 'success';
let credentialGeneration = 0;
let onCredential = async () => {};
let onInspect = async () => {};
let onModify = async () => {};
let onOptions = async () => {};
let offerEmpty = false;
const provider = {
  async credential() { await onCredential(); return { accessToken: 'fixture', expiresAt: null, generation: credentialGeneration }; },
  async inspectUserLabel(_token, labelId) {
    if (mode === 'system_label') throw new Error('fixture system label');
    return { id: labelId, type: 'user' };
  },
  async inspectMessage(_token, messageId) { inspectReads++; await onInspect(); return { id: messageId,
    labelIds: mode === 'draft' ? ['DRAFT'] : mode === 'observed_read' ? ['INBOX'] : ['INBOX', 'UNREAD'] }; },
  async inspectOptions(_token, _messageId, signal) { inspectReads++; await onOptions(signal); return {
    labelIds: mode === 'draft' ? ['DRAFT'] : ['INBOX', 'UNREAD', 'Label_1'],
    labels: [{ id: 'Label_1', type: 'user', name: 'Renamed in Gmail' },
      ...(offerEmpty ? [{ id: 'Label_empty', type: 'user', name: 'Empty label' }] : []),
      { id: 'Label_system', type: 'system', name: 'Fake user label' },
      { id: 'Label_unknown', name: 'Unknown type' }],
  }; },
  async modify(_token, messageId, add, remove) {
    calls++;
    await onModify();
    if (mode === 'unknown') throw new Error('fixture lost response');
    return { id: messageId, labelIds: ['INBOX', 'UNREAD', ...add].filter((value) => !remove.includes(value)) };
  },
};
const makeApp = async () => {
  const app = buildApp(async () => {}, undefined, { db, origin,
    masterKey: Buffer.from(config.STATION_MASTER_KEY, 'base64'), store },
  { trustedProxyIp: '127.0.0.1' }, undefined, undefined, undefined, undefined, provider);
  await app.ready();
  return app;
};
let app = await makeApp();
let cookie = '';
const request = async (method, url, payload, csrf) => {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }),
    remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}),
      ...(method === 'GET' ? {} : { origin, 'x-csrf-token': csrf }) } });
  const set = response.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set[0] : set).split(';')[0];
  return response;
};

try {
  assert.equal((await request('GET', `/api/mail/changes/${id()}?accountId=${id()}`)).statusCode, 401);
  const bootstrap = randomBytes(32).toString('base64url');
  await store.issueBootstrap(digest(bootstrap), new Date(Date.now() + 60_000));
  let csrf = (await request('GET', '/api/auth/status')).json().csrfToken;
  const enrolled = await request('POST', '/api/auth/bootstrap/password', { bootstrapToken: bootstrap,
    displayName: 'Example Owner', password: 'Example-only-password-123!' }, csrf);
  assert.equal(enrolled.statusCode, 200, enrolled.body);
  csrf = (await request('GET', '/api/auth/status')).json().csrfToken;
  const secret = new URL(enrolled.json().totpUri).searchParams.get('secret');
  assert.equal((await request('POST', '/api/auth/bootstrap/totp', { code: await generate({ secret }) }, csrf)).statusCode, 200);
  csrf = (await request('GET', '/api/auth/status')).json().csrfToken;

  const orbitA = id(), orbitB = id(), accountA = id(), accountB = id(), appId = id();
  await db.insert(orbits).values([{ id: orbitA, name: 'Example A', slug: 'change-a', colorSlot: 1, context: '', privacyDefaults: { index: 'deny', ai: 'deny' } },
    { id: orbitB, name: 'Example B', slug: 'change-b', colorSlot: 2, context: '', privacyDefaults: { index: 'deny', ai: 'deny' } }]);
  await db.insert(oauthApps).values({ id: appId, provider: 'google', ownerId: 'owner', clientId: 'fixture',
    encryptedClientSecret: 'fixture', redirectUri: `${origin}/api/google/callback` });
  await db.insert(accounts).values([{ id: accountA, provider: 'google', appId, orbitId: orbitA, email: 'a@example.com',
    encryptedRefreshToken: 'fixture', encryptedAccessToken: 'fixture', grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  { id: accountB, provider: 'google', appId, orbitId: orbitB, email: 'b@example.com',
    encryptedRefreshToken: 'fixture', encryptedAccessToken: 'fixture', grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'] }]);
  const threadA = id(), itemA = id(), itemB = id(), tombstone = id(), labelA = id();
  const capItems = [id(), id(), id()];
  await db.insert(threads).values({ id: threadA, accountId: accountA, collectionId: 'primary', externalId: 'thread_1' });
  await db.insert(items).values([itemA, itemB, tombstone, ...capItems].map((itemId) => ({ id: itemId, accountId: accountA,
    collectionId: 'primary', threadId: threadA, externalId: `message_${itemId.replaceAll('-', '')}`,
    providerRevision: '7', appliedSequence: 1, direction: 'in', directionProvenance: 'incoming',
    subject: itemId === itemB ? 'Example recovery subject '.repeat(30) : 'Example message',
    parseStatus: 'supported', flags: {}, ...(itemId === tombstone ? { deletedAt: new Date() } : {}) })));
  await db.insert(itemOrbits).values([itemA, itemB, ...capItems].map((itemId) => ({ itemId, orbitId: orbitA, reason: 'account' })));
  await db.insert(labels).values([{ id: labelA, accountId: accountA, providerRef: 'Label_1', name: 'Example label' },
    { id: id(), accountId: accountA, providerRef: 'Label_system', name: 'Stored system' },
    { id: id(), accountId: accountA, providerRef: 'Label_unknown', name: 'Stored unknown' }]);
  const options = (itemId, accountId = accountA, orbitId = orbitA) =>
    `/api/mail/items/${itemId}/action-options?accountId=${accountId}&orbitId=${orbitId}`;
  assert.equal((await request('GET', options(itemA, accountB))).statusCode, 404);
  assert.equal((await request('GET', options(itemA, accountA, orbitB))).statusCode, 404);
  assert.equal((await request('GET', options(tombstone))).statusCode, 404);
  const beforeOptions = await request('GET', options(itemA));
  assert.equal(beforeOptions.statusCode, 200, beforeOptions.body);
  assert.equal(beforeOptions.json().itemSequence, 1);
  assert.equal(beforeOptions.json().itemRevision, '7');
  assert.equal(beforeOptions.json().labels[0].name, 'Renamed in Gmail');
  assert.equal(beforeOptions.json().labels[0].canRemove, true);
  assert.equal(beforeOptions.json().labels.length, 1);
  assert.equal(beforeOptions.json().labelsIncomplete, true);
  await db.delete(labels).where(eq(labels.providerRef, 'Label_unknown'));
  const syncedOptions = await request('GET', options(itemA));
  assert.equal(syncedOptions.statusCode, 200, syncedOptions.body);
  assert.equal(syncedOptions.json().labelsIncomplete, false);
  assert.equal(syncedOptions.json().labels.length, 1);
  await db.insert(settings).values({ key: 'first_orbit_setup_v1', value: { version: 1, orbitId: orbitA,
    confirmedOrigin: origin, globalDefaults: { index: 'exclude', ai: 'exclude' } } });
  await db.update(accounts).set({ backfill: 'all' }).where(eq(accounts.id, accountA));
  const catalogReader = {
    async listLabels() { return { labels: [{ id: 'Label_1', name: 'Renamed in Gmail' },
      { id: 'Label_system', name: 'Stored system' }, { id: 'Label_empty', name: 'Empty label' }] }; },
    async getProfile() { return { emailAddress: 'a@example.com', historyId: '1' }; },
    async listMessageIds() { return { messages: [] }; },
    async listHistory() { return { history: [], historyId: '1' }; },
  };
  const catalogRunner = new GmailSyncRunner(db, new PrivateBlobStore(process.env.STATION_TEST_BLOB_ROOT ?? '/var/lib/station/blobs'),
    catalogReader, origin);
  assert.ok((await catalogRunner.discover()).includes(accountA));
  await catalogRunner.run(accountA);
  const mappedEmpty = (await db.select().from(labels).where(eq(labels.accountId, accountA))).find((label) => label.providerRef === 'Label_empty');
  assert.ok(mappedEmpty);
  offerEmpty = true;
  const emptyOptions = await request('GET', options(itemA));
  assert.equal(emptyOptions.statusCode, 200, emptyOptions.body);
  assert.equal(emptyOptions.json().labels.find((label) => label.id === mappedEmpty.id)?.canAdd, true);
  assert.equal(emptyOptions.json().labelsIncomplete, false);
  assert.equal(beforeOptions.json().canMarkRead, true);
  assert.equal(beforeOptions.json().canArchive, true);
  onOptions = (signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(new Error('fixture deadline')); return; }
    signal.addEventListener('abort', () => reject(new Error('fixture deadline')), { once: true });
  });
  const timedOptions = await request('GET', options(itemA));
  assert.equal(timedOptions.statusCode, 503, timedOptions.body);
  onOptions = async () => {};
  assert.equal((await request('GET', options(itemA))).statusCode, 200);
  mode = 'draft';
  assert.equal((await request('GET', options(itemA))).json().blockedReason, 'draft');
  mode = 'success';
  onOptions = async () => { await db.update(accounts).set({ credentialGeneration: 4 }).where(eq(accounts.id, accountA)); };
  assert.equal((await request('GET', options(itemA))).statusCode, 409);
  onOptions = async () => {};
  credentialGeneration = 4;
  onOptions = async () => { await db.delete(itemOrbits).where(eq(itemOrbits.itemId, itemA)); };
  assert.equal((await request('GET', options(itemA))).statusCode, 409);
  await db.insert(itemOrbits).values({ itemId: itemA, orbitId: orbitA, reason: 'account' });
  onOptions = async () => {};
  onOptions = async () => { await db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, itemA)); };
  assert.equal((await request('GET', options(itemA))).statusCode, 409);
  await db.update(items).set({ deletedAt: null }).where(eq(items.id, itemA));
  onOptions = async () => {};
  await db.update(accounts).set({ credentialGeneration: 0 }).where(eq(accounts.id, accountA));
  credentialGeneration = 0;
  const endpoint = (itemId, accountId = accountA, orbitId = orbitA) =>
    `/api/mail/items/${itemId}/change?accountId=${accountId}&orbitId=${orbitId}`;
  const body = (action, key = id(), extra = {}) => ({ idempotencyKey: key, action,
    itemSequence: 1, itemRevision: '7', ...extra });
  assert.equal((await request('POST', endpoint(itemA, accountB), body('archive'), csrf)).statusCode, 404);
  assert.equal((await request('POST', endpoint(itemA, accountA, orbitB), body('archive'), csrf)).statusCode, 404);
  assert.equal((await request('POST', endpoint(tombstone), body('archive'), csrf)).statusCode, 404);
  assert.equal((await request('POST', endpoint(itemA), body('add_label', id(), { labelId: id() }), csrf)).statusCode, 404);
  mode = 'draft';
  assert.equal((await request('POST', endpoint(itemA), body('archive'), csrf)).statusCode, 409);
  mode = 'system_label';
  assert.equal((await request('POST', endpoint(itemA), body('add_label', id(), { labelId: labelA }), csrf)).statusCode, 409);
  assert.equal(calls, 0);
  mode = 'success';
  const key = id();
  const [first, concurrent] = await Promise.all([
    request('POST', endpoint(itemA), body('archive', key), csrf),
    request('POST', endpoint(itemA), body('archive', key), csrf),
  ]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(concurrent.statusCode, 200, concurrent.body);
  assert.equal(first.json().id, concurrent.json().id);
  assert.equal(calls, 1);
  const actionEpoch = async (itemId) => (await db.select({ epoch: items.actionEpoch }).from(items).where(eq(items.id, itemId)))[0].epoch;
  assert.equal(await actionEpoch(itemA), 1, 'one confirmed action advances the epoch once, including idempotent replay');
  const blockedOptions = await request('GET', options(itemA));
  assert.equal(blockedOptions.statusCode, 200, blockedOptions.body);
  assert.equal(blockedOptions.json().blockedReason, 'awaiting_sync');
  assert.equal(blockedOptions.json().canArchive, false);
  await db.insert(itemOrbits).values({ itemId: itemA, orbitId: orbitB, reason: 'account' });
  const crossOrbitOptions = await request('GET', options(itemA, accountA, orbitB));
  assert.equal(crossOrbitOptions.statusCode, 200, crossOrbitOptions.body);
  assert.equal(crossOrbitOptions.json().blockingOperationId, first.json().id);
  assert.equal(crossOrbitOptions.json().blockingOrbitId, orbitA);
  await db.delete(itemOrbits).where(eq(itemOrbits.orbitId, orbitB));
  const keyed = (itemId, accountId, orbitId, idempotencyKey) =>
    `/api/mail/items/${itemId}/change?accountId=${accountId}&orbitId=${orbitId}&idempotencyKey=${idempotencyKey}`;
  assert.equal((await request('GET', keyed(itemA, accountA, orbitA, key))).json().id, first.json().id);
  assert.equal((await request('GET', keyed(itemB, accountA, orbitA, key))).statusCode, 404);
  assert.equal((await request('GET', keyed(itemA, accountB, orbitA, key))).statusCode, 404);
  assert.equal((await request('GET', keyed(itemA, accountA, orbitB, key))).statusCode, 404);
  assert.equal((await request('GET', keyed(itemA, accountA, orbitA, id()))).statusCode, 404);
  assert.equal((await request('POST', endpoint(itemA), body('mark_read'), csrf)).statusCode, 409);
  assert.equal((await request('POST', endpoint(itemA), body('archive', key, { itemRevision: '8' }), csrf)).statusCode, 409);
  assert.equal((await request('GET', `/api/mail/changes/${first.json().id}?accountId=${accountA}&orbitId=${orbitB}`)).statusCode, 404);
  assert.equal((await db.select().from(items).where(eq(items.id, itemA)))[0].providerRevision, '7');
  assert.deepEqual((await db.select().from(items).where(eq(items.id, itemA)))[0].flags, {});
  assert.equal((await db.select().from(auditLog).where(eq(auditLog.targetId, first.json().id))).length, 2);

  mode = 'unknown';
  const unknown = await request('POST', endpoint(itemB), body('mark_read'), csrf);
  assert.equal(unknown.statusCode, 202, unknown.body);
  assert.equal(unknown.json().state, 'outcome_unknown');
  assert.equal(await actionEpoch(itemB), 0, 'uncertain provider outcomes do not advance the epoch');
  await app.close();
  app = await makeApp();
  assert.equal((await request('GET', `/api/mail/changes/${unknown.json().id}?accountId=${accountA}&orbitId=${orbitA}`)).json().state,
    'outcome_unknown');
  assert.equal((await request('POST', endpoint(itemB), body('mark_unread'), csrf)).statusCode, 409);
  const unresolved = await request('GET', `/api/mail/changes/unresolved?accountId=${accountA}`);
  assert.equal(unresolved.statusCode, 200, unresolved.body);
  assert.equal(unresolved.json().operations[0].id, unknown.json().id);
  assert.equal(unresolved.json().operations[0].context.threadId, threadA);
  assert.equal(unresolved.json().operations[0].context.subject.length, 120);
  assert.equal((await request('GET', `/api/mail/changes/unresolved?accountId=${accountB}`)).json().operations.length, 0);
  assert.equal((await request('GET', `/api/mail/changes/unresolved?accountId=${accountA}&orbitId=${orbitB}`)).json().operations.length, 0);
  await db.update(mailChangeOperations).set({ updatedAt: new Date(Date.now() - 31_000) }).where(eq(mailChangeOperations.id, unknown.json().id));
  await db.update(accounts).set({ credentialGeneration: 1 }).where(eq(accounts.id, accountA));
  credentialGeneration = 1;
  mode = 'observed_read';
  const reconcile = await request('POST', `/api/mail/changes/${unknown.json().id}/reconcile?accountId=${accountA}&orbitId=${orbitA}`, {}, csrf);
  assert.equal(reconcile.statusCode, 200, reconcile.body);
  assert.equal(reconcile.json().state, 'succeeded');
  assert.equal(reconcile.json().confirmation, 'observed');
  assert.equal(await actionEpoch(itemB), 1, 'observed reconciliation advances the epoch');
  assert.equal(calls, 2);
  assert.equal((await db.select().from(items).where(eq(items.id, itemB)))[0].providerRevision, '7');

  await db.update(items).set({ appliedSequence: 2, providerRevision: '8',
    updatedAt: new Date(Date.now() + 1_000) }).where(eq(items.id, itemB));
  mode = 'unknown';
  const unknownAfterSync = await request('POST', endpoint(itemB), body('add_label', id(), { labelId: labelA,
    itemSequence: 2, itemRevision: '8' }), csrf);
  assert.equal(unknownAfterSync.statusCode, 202, unknownAfterSync.body);
  await db.update(mailChangeOperations).set({ updatedAt: new Date(Date.now() - 31_000) }).where(eq(mailChangeOperations.id, unknownAfterSync.json().id));
  onInspect = async () => { await db.update(accounts).set({ credentialGeneration: 2 }).where(eq(accounts.id, accountA)); };
  const racedReconcile = await request('POST', `/api/mail/changes/${unknownAfterSync.json().id}/reconcile?accountId=${accountA}&orbitId=${orbitA}`, {}, csrf);
  assert.equal(racedReconcile.statusCode, 404, racedReconcile.body);
  assert.equal((await db.select().from(mailChangeOperations).where(eq(mailChangeOperations.id, unknownAfterSync.json().id)))[0].state, 'outcome_unknown');
  assert.equal(await actionEpoch(itemB), 1, 'a fenced reconciliation does not advance the epoch');
  credentialGeneration = 2;
  onInspect = async () => { await db.update(accounts).set({ credentialGeneration: 3 }).where(eq(accounts.id, accountA)); };
  const fence = await request('POST', endpoint(capItems[0]), body('add_label', id(), { labelId: labelA,
    itemSequence: 1, itemRevision: '7' }), csrf);
  assert.equal(fence.statusCode, 409, fence.body);
  assert.equal(calls, 3);
  assert.equal((await db.select().from(mailChangeOperations).where(eq(mailChangeOperations.id, fence.json().id)))[0].state, 'failed');
  await db.update(items).set({ appliedSequence: 2, providerRevision: '8',
    updatedAt: new Date(Date.now() + 1_000) }).where(eq(items.id, itemA));
  mode = 'success';
  onInspect = async () => {};
  credentialGeneration = 3;
  const noOp = await request('POST', endpoint(itemA), body('mark_unread', id(), {
    itemSequence: 2, itemRevision: '8' }), csrf);
  assert.equal(noOp.statusCode, 200, noOp.body);
  assert.equal(noOp.json().confirmation, 'observed');
  assert.equal(await actionEpoch(itemA), 2, 'a zero-write observed no-op still requires a later provider read');
  assert.equal((await db.select().from(mailChangeOperations).where(eq(mailChangeOperations.id, noOp.json().id)))[0].attemptCount, 0);
  assert.equal(calls, 3);
  onCredential = async () => {
    credentialGeneration = 4;
    await db.update(accounts).set({ credentialGeneration: 4 }).where(eq(accounts.id, accountA));
  };
  const refreshed = await request('POST', endpoint(itemA), body('archive', id(), {
    itemSequence: 2, itemRevision: '8' }), csrf);
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal(refreshed.json().confirmation, 'provider');
  assert.equal(await actionEpoch(itemA), 3);
  onCredential = async () => {};
  let inspectStarted = 0;
  let releaseInspect;
  let reachedTwo;
  const held = new Promise((resolve) => { releaseInspect = resolve; });
  const twoReads = new Promise((resolve) => { reachedTwo = resolve; });
  onInspect = async () => { inspectStarted++; if (inspectStarted === 2) reachedTwo(); await held; };
  const capRequests = capItems.slice(0, 2).map((itemId) => request('POST', endpoint(itemId), body('archive'), csrf));
  await twoReads;
  assert.equal((await request('POST', endpoint(capItems[2]), body('archive'), csrf)).statusCode, 503);
  releaseInspect();
  assert.deepEqual((await Promise.all(capRequests)).map((response) => response.statusCode), [200, 200]);
  assert.equal(inspectStarted, 2);
  onInspect = async () => {};
  let releaseModify;
  let reachedModify;
  const heldModify = new Promise((resolve) => { releaseModify = resolve; });
  const modifyStarted = new Promise((resolve) => { reachedModify = resolve; });
  onModify = async () => { reachedModify(); await heldModify; };
  const racingItem = capItems[2];
  const firstModify = request('POST', endpoint(racingItem), body('archive'), csrf);
  await modifyStarted;
  await db.update(items).set({ appliedSequence: 2, providerRevision: '8', updatedAt: new Date() }).where(eq(items.id, racingItem));
  assert.equal((await request('POST', endpoint(racingItem), body('mark_read', id(), {
    itemSequence: 2, itemRevision: '8' }), csrf)).statusCode, 409);
  releaseModify();
  assert.equal((await firstModify).statusCode, 200);
  onModify = async () => {};
  assert.equal((await request('POST', endpoint(racingItem), body('mark_read', id(), {
    itemSequence: 2, itemRevision: '8' }), csrf)).statusCode, 409);
  await db.update(items).set({ appliedSequence: 3, providerRevision: '9',
    updatedAt: new Date(Date.now() + 1_000) }).where(eq(items.id, racingItem));
  assert.equal((await request('POST', endpoint(racingItem), body('mark_read', id(), {
    itemSequence: 3, itemRevision: '9' }), csrf)).statusCode, 200);
  await db.update(items).set({ appliedSequence: 2, providerRevision: '8' }).where(eq(items.id, capItems[0]));
  await db.update(items).set({ appliedSequence: 2, providerRevision: '8' }).where(eq(items.id, capItems[1]));
  const staleAt = new Date(Date.now() - 31_000);
  const pendingId = id(), flightId = id();
  await db.insert(mailChangeOperations).values([
    { id: pendingId, ownerId: 'owner', accountId: accountA, orbitId: orbitA, itemId: capItems[0],
      externalId: `message_${capItems[0].replaceAll('-', '')}`, idempotencyKey: id(), requestDigest: 'fixture-pending',
      action: 'archive', removeLabels: ['INBOX'], itemRevision: '8', itemSequence: 2, updatedAt: staleAt },
    { id: flightId, ownerId: 'owner', accountId: accountA, orbitId: orbitA, itemId: capItems[1],
      externalId: `message_${capItems[1].replaceAll('-', '')}`, idempotencyKey: id(), requestDigest: 'fixture-flight',
      action: 'mark_read', removeLabels: ['UNREAD'], itemRevision: '8', itemSequence: 2,
      state: 'in_flight', attemptCount: 1, credentialGeneration: 4, updatedAt: staleAt },
  ]);
  const reconciliation = (operationId) => `/api/mail/changes/${operationId}/reconcile?accountId=${accountA}&orbitId=${orbitA}`;
  assert.equal((await request('POST', reconciliation(pendingId), {}, csrf)).json().state, 'failed');
  const nonmatch = await request('POST', reconciliation(flightId), {}, csrf);
  assert.equal(nonmatch.statusCode, 200, nonmatch.body);
  assert.equal(nonmatch.json().state, 'outcome_unknown');
  assert.equal(nonmatch.json().confirmation, null);
  mode = 'observed_read';
  await db.update(mailChangeOperations).set({ updatedAt: staleAt }).where(eq(mailChangeOperations.id, flightId));
  const matched = await request('POST', reconciliation(flightId), {}, csrf);
  assert.equal(matched.statusCode, 200, matched.body);
  assert.equal(matched.json().confirmation, 'observed');
  const tombstoneOperation = id(), orbitOperation = id(), afterReadOperation = id();
  await db.insert(mailChangeOperations).values([
    { id: tombstoneOperation, ownerId: 'owner', accountId: accountA, orbitId: orbitA, itemId: capItems[0],
      externalId: `message_${capItems[0].replaceAll('-', '')}`, idempotencyKey: id(), requestDigest: 'fixture-tombstone',
      action: 'mark_read', removeLabels: ['UNREAD'], itemRevision: '8', itemSequence: 2,
      state: 'outcome_unknown', attemptCount: 1, credentialGeneration: 4, updatedAt: staleAt },
    { id: orbitOperation, ownerId: 'owner', accountId: accountA, orbitId: orbitA, itemId: capItems[1],
      externalId: `message_${capItems[1].replaceAll('-', '')}`, idempotencyKey: id(), requestDigest: 'fixture-orbit',
      action: 'mark_read', removeLabels: ['UNREAD'], itemRevision: '8', itemSequence: 2,
      state: 'outcome_unknown', attemptCount: 1, credentialGeneration: 4, updatedAt: staleAt },
    { id: afterReadOperation, ownerId: 'owner', accountId: accountA, orbitId: orbitA, itemId: capItems[2],
      externalId: `message_${capItems[2].replaceAll('-', '')}`, idempotencyKey: id(), requestDigest: 'fixture-after-read',
      action: 'mark_read', removeLabels: ['UNREAD'], itemRevision: '9', itemSequence: 3,
      state: 'outcome_unknown', attemptCount: 1, credentialGeneration: 4, updatedAt: staleAt },
  ]);
  await db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, capItems[0]));
  await db.delete(itemOrbits).where(eq(itemOrbits.itemId, capItems[1]));
  const readsBefore = inspectReads;
  assert.equal((await request('POST', reconciliation(tombstoneOperation), {}, csrf)).statusCode, 404);
  assert.equal((await request('POST', reconciliation(orbitOperation), {}, csrf)).statusCode, 404);
  assert.equal(inspectReads, readsBefore);
  onInspect = async () => { await db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, capItems[2])); };
  assert.equal((await request('POST', reconciliation(afterReadOperation), {}, csrf)).statusCode, 404);
  assert.equal(inspectReads, readsBefore + 1);
  assert.equal((await db.select().from(mailChangeOperations).where(eq(mailChangeOperations.id, afterReadOperation)))[0].state,
    'outcome_unknown');
  onInspect = async () => {};
  await db.insert(mailChangeOperations).values(Array.from({ length: 22 }, () => ({ id: id(), ownerId: 'owner',
    itemId: itemA, externalId: 'fixture', accountId: accountA, orbitId: orbitA, idempotencyKey: id(),
    requestDigest: 'fixture', action: 'archive', addLabels: [], removeLabels: ['INBOX'],
    itemRevision: '8', itemSequence: 2, credentialGeneration: 4, state: 'outcome_unknown', attemptCount: 1 })));
  const page1 = await request('GET', `/api/mail/changes/unresolved?accountId=${accountA}&orbitId=${orbitA}&limit=20`);
  assert.equal(page1.statusCode, 200, page1.body);
  assert.equal(page1.json().operations.length, 20);
  assert.ok(Buffer.byteLength(page1.body) <= 64 * 1024);
  assert.ok(page1.json().nextCursor);
  assert.ok(page1.json().operations.every((entry) => entry.context?.threadId === threadA || entry.context === null));
  const removedRows = [...page1.json().operations];
  let contextCursor = page1.json().nextCursor;
  while (contextCursor) {
    const next = await request('GET', `/api/mail/changes/unresolved?accountId=${accountA}&orbitId=${orbitA}&limit=20&cursor=${encodeURIComponent(contextCursor)}`);
    removedRows.push(...next.json().operations); contextCursor = next.json().nextCursor;
  }
  assert.equal(removedRows.find((entry) => entry.id === tombstoneOperation)?.context, null);
  assert.equal(removedRows.find((entry) => entry.id === orbitOperation)?.context, null);
  assert.ok(removedRows.some((entry) => entry.context?.subject === 'Example message' && entry.context.threadId === threadA));
  const page2 = await request('GET', `/api/mail/changes/unresolved?accountId=${accountA}&orbitId=${orbitA}&limit=20&cursor=${encodeURIComponent(page1.json().nextCursor)}`);
  assert.equal(page2.statusCode, 200, page2.body);
  assert.ok(page2.json().operations.length >= 3);
  assert.equal((await request('GET', `/api/mail/changes/unresolved?accountId=${accountB}&cursor=${encodeURIComponent(page1.json().nextCursor)}`)).statusCode, 400);
  console.log('mail-change-db: scope, key recovery, provider cap, stale recovery, no-op, pagination, restart and reconnect fences passed');
} finally {
  await app.close();
  await handle.close();
}
