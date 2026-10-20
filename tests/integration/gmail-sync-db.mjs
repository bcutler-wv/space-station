import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { GmailReadError } from '../../packages/connectors/dist/index.js';
import { databaseUrl, loadRuntimeConfig, openDatabase, PrivateBlobStore, accounts, items, itemLabels, labels, oauthApps, orbits, readSyncEvents,
  settings, syncStates, users, evaluateStoredMailPrivacy, exclusionRules } from '../../packages/db/dist/index.js';
import { GmailSyncRunner } from '../../apps/worker/dist/gmail-sync.js';

const handle = openDatabase(databaseUrl(loadRuntimeConfig(process.env)));
const db = handle.db;
const store = new PrivateBlobStore(process.env.STATION_TEST_BLOB_ROOT ?? '/var/lib/station/blobs');
const origin = 'https://example.com';
const accountId = randomUUID();
let clockOffset = 0;
const now = () => new Date(Date.now() + clockOffset);
const day = new Date('2026-10-20T12:00:00Z').getTime();
const messages = new Map([
  ['a', { id: 'a', threadId: 'ta', historyId: '11', labelIds: ['INBOX', 'WORK'], internalDate: String(day), trustedSent: false, mime: Buffer.from('a') }],
  ['b', { id: 'b', threadId: 'tb', historyId: '12', labelIds: ['INBOX', 'WORK'], internalDate: String(day), trustedSent: false, mime: Buffer.from('b') }],
  ['c', { id: 'c', threadId: 'tc', historyId: '13', labelIds: ['INBOX'], internalDate: String(day), trustedSent: false, mime: Buffer.from('c') }],
]);
let mode = 'initial';
let failB = true;
let failReconcilePage = true;
let failHistoryTail = true;
let labelsNow = [{ id: 'INBOX', name: 'Inbox' }, { id: 'WORK', name: 'Work' }];
const calls = [];
const providerTimes = [];
const mark = () => { providerTimes.push(Date.now()); };
const assertPaced = () => {
  for (let index = 1; index < providerTimes.length; index++)
    assert.ok(providerTimes[index] - providerTimes[index - 1] >= 850, `provider calls ${index - 1} and ${index} were not paced`);
};
const reader = {
  async getProfile() { mark(); return { emailAddress: 'owner@example.com', historyId: mode === 'initial' ? '10' : '30' }; },
  async listLabels() { mark(); return { labels: labelsNow }; },
  async listMessageIds(_accountId, input) {
    mark();
    calls.push(['list', input.pageToken ?? null]);
    if (mode === 'initial') return { messages: [{ id: 'a', threadId: 'ta' }, { id: 'b', threadId: 'tb' }] };
    if (!input.pageToken) return { messages: [{ id: 'b', threadId: 'tb' }], nextPageToken: 'more' };
    if (failReconcilePage) { failReconcilePage = false; throw new GmailReadError('transient'); }
    return { messages: [] };
  },
  async getMessageRaw(_accountId, id) {
    mark();
    calls.push(['raw', id]);
    if (id === 'b' && failB) { failB = false; throw new GmailReadError('transient'); }
    const message = messages.get(id);
    if (!message) throw new GmailReadError('message_missing');
    return message;
  },
  async getMessageMinimal(_accountId, id) {
    mark();
    const value = messages.get(id);
    if (!value) throw new GmailReadError('message_missing');
    return value;
  },
  async listHistory(_accountId, input) {
    mark();
    calls.push(['history', input.startHistoryId, input.pageToken ?? null]);
    if (input.startHistoryId === '20') throw new GmailReadError('history_expired');
    if (input.startHistoryId === '30' || input.startHistoryId === '31') return { history: [], historyId: '31' };
    if (input.pageToken === 'tail') {
      if (failHistoryTail) { failHistoryTail = false; throw new GmailReadError('transient'); }
      return { history: [{ id: '19', labelsRemoved: [{ message: { id: 'a', threadId: 'ta' }, labelIds: ['INBOX'] }] }], historyId: '20' };
    }
    messages.get('a').labelIds = ['WORK'];
    return { history: [{ id: '15', messagesAdded: [{ message: { id: 'c', threadId: 'tc' } }] }], nextPageToken: 'tail', historyId: '20' };
  },
};
const parsed = (raw) => ({ ok: true, mail: { subject: `Subject ${Buffer.from(raw).toString()}`, messageId: null,
  inReplyTo: null, references: null, date: null, from: { name: 'Sender', address: 'sender@example.com' },
  senderIdentities: [{ name: 'Sender', address: 'sender@example.com' }], replyTo: [], to: [], cc: [], bcc: [],
  text: 'safe body', sanitizedHtml: null, attachments: [] } });
const runner = new GmailSyncRunner(db, store, reader, origin, parsed, now);
const state = async () => (await db.select().from(syncStates).where(eq(syncStates.accountId, accountId)))[0];
const rows = async () => await db.select().from(items).where(eq(items.accountId, accountId));
try {
  const ownerId = randomUUID(); const orbitId = randomUUID(); const appId = randomUUID();
  await db.insert(users).values({ id: ownerId, displayName: 'Fixture owner' });
  await db.insert(orbits).values({ id: orbitId, name: 'Work', slug: 'fixture-work', colorSlot: 1, context: '', privacyDefaults: { index: 'allow', ai: 'allow' } });
  await db.insert(settings).values({ key: 'first_orbit_setup_v1', value: { version: 1, orbitId, confirmedOrigin: origin,
    globalDefaults: { index: 'allow', ai: 'allow' } } });
  await db.insert(oauthApps).values({ id: appId, provider: 'google', ownerId, clientId: 'fixture-client', encryptedClientSecret: 'fixture-ciphertext', redirectUri: `${origin}/callback` });
  await db.insert(accounts).values({ id: accountId, provider: 'google', appId, orbitId, email: 'owner@example.com',
    encryptedRefreshToken: 'fixture-ciphertext', encryptedAccessToken: 'fixture-ciphertext', grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
    backfill: 'all', credentialGeneration: 1 });
  const noBackfillId = randomUUID();
  await db.insert(accounts).values({ id: noBackfillId, provider: 'google', appId, orbitId, email: 'waiting@example.com',
    encryptedRefreshToken: 'fixture-ciphertext', encryptedAccessToken: 'fixture-ciphertext', grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
    backfill: null, credentialGeneration: 1 });
  const wrongOrigin = new GmailSyncRunner(db, store, reader, 'https://other.example.com', parsed, now);
  assert.deepEqual(await wrongOrigin.discover(), []);
  assert.deepEqual(await runner.discover(), [accountId]);
  const discovered = await readSyncEvents(db, 0);
  assert.deepEqual(discovered.rows.map(({ kind, accountId: id }) => [kind, id]), [['sync-progress', accountId]]);
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.accountId, noBackfillId))).length, 0);
  await runner.run(accountId);
  const runEvents = await readSyncEvents(db, discovered.head);
  assert.ok(runEvents.rows.some((event) => event.kind === 'mail-changed' && event.accountId === accountId));
  assert.ok(runEvents.rows.some((event) => event.kind === 'sync-progress' && event.accountId === accountId));
  assertPaced();
  assert.equal((await state()).lastError, 'transient');
  assert.equal((await state()).cursor.offset, 1);
  assert.deepEqual((await rows()).map((row) => row.externalId), ['a']);
  const interrupted = await state();
  assert.ok(interrupted.cursor.nextCallAt >= providerTimes.at(-1) + 850);
  await db.update(syncStates).set({ cursor: { ...interrupted.cursor, retryAt: 0 } }).where(eq(syncStates.id, interrupted.id));
  await runner.run(accountId);
  assertPaced(); // includes the first call after restart
  assert.equal((await state()).cursor.phase, 'history');
  assert.equal((await state()).cursor.historyStart, '10');
  assert.equal((await state()).cursor.historyToken, 'tail');
  clockOffset += 60_000;
  providerTimes.length = 0;
  await runner.run(accountId);
  assertPaced();
  assert.equal((await state()).cursor.phase, 'ready');
  assert.equal((await state()).cursor.anchor, '20');
  assert.deepEqual((await rows()).map((row) => row.externalId).sort(), ['a', 'b', 'c']);
  assert.deepEqual(calls.filter((call) => call[0] === 'history').map((call) => call.slice(1)), [['10', null], ['10', 'tail'], ['10', 'tail']]);
  const a = (await rows()).find((row) => row.externalId === 'a');
  assert.equal((await db.select().from(labels).where(eq(labels.accountId, accountId))).find((row) => row.providerRef === 'WORK').name, 'Work');
  assert.equal(a.direction, 'in');
  assert.equal((await db.select().from(items).where(eq(items.id, a.id)))[0].deletedAt, null);
  assert.equal((await db.select().from(itemLabels).where(eq(itemLabels.itemId, a.id))).length, 1);
  const c = (await rows()).find((row) => row.externalId === 'c');
  await db.update(items).set({ internalAt: null }).where(eq(items.id, c.id));
  mode = 'reconcile';
  await runner.run(accountId); // duplicate delivery, expired history, then failed reconciliation page
  assert.equal((await state()).cursor.phase, 'full');
  assert.equal((await rows()).filter((row) => row.deletedAt).length, 0);
  clockOffset += 60_000;
  await runner.run(accountId);
  assert.equal((await state()).cursor.phase, 'ready');
  assert.deepEqual((await rows()).filter((row) => row.deletedAt).map((row) => row.externalId).sort(), ['a', 'c']);
  assert.equal((await rows()).find((row) => row.externalId === 'b').deletedAt, null);
  labelsNow = [{ id: 'INBOX', name: 'Inbox' }, { id: 'WORK', name: 'Renamed' }];
  await db.insert(exclusionRules).values({ id: randomUUID(), orbitId: null, kind: 'label', value: 'renamed', effect: 'no_ai' });
  await runner.run(accountId);
  assert.equal((await db.select().from(labels).where(eq(labels.accountId, accountId))).find((row) => row.providerRef === 'WORK').name, 'Renamed');
  assert.equal((await evaluateStoredMailPrivacy(db, (await rows()).find((row) => row.externalId === 'b').id)).canUseAi, false);
  labelsNow = [{ id: 'INBOX', name: 'Inbox' }];
  await runner.run(accountId);
  assert.equal((await db.select().from(labels).where(eq(labels.accountId, accountId))).find((row) => row.providerRef === 'WORK').name, '');

  // A crash after the final item commit left this exact old durable cursor: the
  // pending terminal batch is exhausted, with no next page. Neither scan relists.
  let crashState = await state();
  const listCalls = () => calls.filter((call) => call[0] === 'list').length;
  const beforeInitialRelist = listCalls();
  await db.update(syncStates).set({ cursor: { ...crashState.cursor, phase: 'full', anchor: '31',
    pending: ['b'], offset: 1, listToken: null, scanStart: 0, retryAt: 0 } }).where(eq(syncStates.id, crashState.id));
  await runner.run(accountId);
  assert.equal(listCalls(), beforeInitialRelist);
  assert.equal((await state()).cursor.phase, 'ready');
  assert.equal((await rows()).find((row) => row.externalId === 'b').deletedAt, null);

  crashState = await state();
  const beforeReconcileRelist = listCalls();
  await db.update(syncStates).set({ cursor: { ...crashState.cursor, phase: 'full', anchor: '31',
    pending: ['b'], offset: 1, listToken: null, scanStart: crashState.sequence, retryAt: 0 } }).where(eq(syncStates.id, crashState.id));
  await runner.run(accountId);
  assert.equal(listCalls(), beforeReconcileRelist);
  assert.equal((await state()).cursor.phase, 'ready');
  assert.ok((await rows()).find((row) => row.externalId === 'b').deletedAt);

  // A second mailbox proves the exact cutoff, visible raw oversize metadata, and parser retry.
  const secondId = randomUUID();
  await db.insert(accounts).values({ id: secondId, provider: 'google', appId, orbitId, email: 'second@example.com',
    encryptedRefreshToken: 'fixture-ciphertext', encryptedAccessToken: 'fixture-ciphertext', grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
    backfill: '30_days', credentialGeneration: 1 });
  let cutoff;
  let parserUnavailable = true;
  let quotaNext = false;
  let permissionNext = false;
  let deletionNext = false;
  let secondReconcile = false;
  let secondHistoryExpired = false;
  const secondReader = {
    async getProfile() { return { emailAddress: 'second@example.com', historyId: secondReconcile ? '50' : '40' }; },
    async listLabels() { return { labels: [{ id: 'INBOX', name: 'Inbox' }] }; },
    async listMessageIds() { return { messages: (secondReconcile ? ['boundary', 'big', 'outage'] : ['old', 'boundary', 'big', 'malformed', 'outage'])
      .map((id) => ({ id, threadId: `t${id}` })) }; },
    async getMessageRaw(_id, id) {
      if (id === 'big') throw new GmailReadError('too_large');
      if (id === 'gone') throw new GmailReadError('message_missing');
      return { id, threadId: `t${id}`, historyId: '41', labelIds: ['INBOX'], trustedSent: false,
        internalDate: String(id === 'old' ? cutoff * 1000 - 1 : cutoff * 1000), mime: Buffer.from(id) };
    },
    async getMessageMinimal(_id, id) { return { id, threadId: `t${id}`, historyId: '41', labelIds: ['INBOX'], trustedSent: false,
      internalDate: String(cutoff * 1000) }; },
    async listHistory(_id, input) {
      if (secondHistoryExpired) { secondHistoryExpired = false; throw new GmailReadError('history_expired'); }
      if (quotaNext) { quotaNext = false; throw new GmailReadError('transient', 1_200_000); }
      if (permissionNext) { permissionNext = false; throw new GmailReadError('permission_denied'); }
      if (deletionNext) { deletionNext = false; return { history: [{ id: '43', messagesDeleted: [{ message: { id: 'gone', threadId: 'tgone' } }] }], historyId: '43' }; }
      return { history: [], historyId: input.startHistoryId === '40' ? '42' : input.startHistoryId };
    },
  };
  const secondParser = async (raw) => {
    if (Buffer.from(raw).toString() === 'malformed') return { ok: false, code: 'malformed' };
    if (Buffer.from(raw).toString() === 'outage' && parserUnavailable) {
      parserUnavailable = false;
      return { ok: false, code: 'service_unavailable' };
    }
    return parsed(raw);
  };
  const second = new GmailSyncRunner(db, store, secondReader, origin, secondParser, now);
  assert.ok((await second.discover()).includes(secondId));
  cutoff = (await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0].cursor.cutoff;
  await second.run(secondId);
  let secondRows = await db.select().from(items).where(eq(items.accountId, secondId));
  assert.deepEqual(secondRows.map((row) => row.externalId).sort(), ['big', 'boundary', 'malformed']);
  assert.equal(secondRows.find((row) => row.externalId === 'big').parseStatus, 'unsupported');
  assert.equal(secondRows.find((row) => row.externalId === 'malformed').parseStatus, 'unsupported');
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0].cursor.offset, 4);
  clockOffset += 60_000;
  await second.run(secondId);
  secondRows = await db.select().from(items).where(eq(items.accountId, secondId));
  assert.deepEqual(secondRows.map((row) => row.externalId).sort(), ['big', 'boundary', 'malformed', 'outage']);
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0].cursor.phase, 'ready');
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0].cursor.cutoff, cutoff);
  deletionNext = true;
  await second.run(secondId);
  assert.equal((await db.select().from(items).where(eq(items.accountId, secondId))).find((row) => row.externalId === 'gone').parseStatus, 'deleted');
  const olderRetained = (await db.select().from(items).where(eq(items.accountId, secondId))).find((row) => row.externalId === 'malformed');
  await db.update(items).set({ internalAt: new Date(cutoff * 1000 - 1) }).where(eq(items.id, olderRetained.id));
  secondReconcile = true;
  secondHistoryExpired = true;
  await second.run(secondId);
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0].cursor.phase, 'ready');
  assert.equal((await db.select().from(items).where(eq(items.id, olderRetained.id)))[0].deletedAt, null);

  // A newer owner takes over an expired lease; the old delivery cannot advance it.
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { entered = resolve; });
  const blockedReader = { ...secondReader, async listLabels() { entered(); await blocked; return { labels: [{ id: 'INBOX', name: 'Inbox' }] }; } };
  const staleRunner = new GmailSyncRunner(db, store, blockedReader, origin, secondParser, now);
  const stale = staleRunner.run(secondId);
  await began;
  const before = (await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0];
  await second.run(secondId); // overlap cannot claim the live lease
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0].generation, before.generation);
  await db.update(syncStates).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(syncStates.accountId, secondId));
  await second.run(secondId); // takeover after expiry
  const taken = (await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0];
  assert.ok(taken.generation > before.generation);
  release();
  await stale;
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0].generation, taken.generation);

  quotaNext = true;
  await second.run(secondId);
  const quotaState = (await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0];
  assert.equal(quotaState.lastError, 'transient');
  assert.ok(quotaState.cursor.retryAt >= now().getTime() + 1_199_000);

  // A reconnect during a fetched page must leave the old sequence and offset untouched.
  clockOffset += 1_260_000;
  const beforeReconnect = (await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0];
  await db.update(syncStates).set({ cursor: { ...beforeReconnect.cursor, phase: 'full', pending: ['boundary'], offset: 0,
    listToken: null, retryAt: 0 } }).where(eq(syncStates.id, beforeReconnect.id));
  const originalGet = secondReader.getMessageRaw;
  secondReader.getMessageRaw = async (...args) => {
    await db.update(accounts).set({ credentialGeneration: 2 }).where(eq(accounts.id, secondId));
    secondReader.getMessageRaw = originalGet;
    return originalGet(...args);
  };
  await second.run(secondId);
  const fenced = (await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0];
  assert.equal(fenced.sequence, beforeReconnect.sequence);
  assert.equal(fenced.cursor.offset, 0);
  assert.equal(fenced.lastError, 'stale_lease');
  clockOffset += 60_000;
  await second.run(secondId);
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0].cursor.phase, 'ready');
  permissionNext = true;
  await second.run(secondId);
  const blockedState = (await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0];
  assert.equal(blockedState.status, 'blocked');
  assert.equal(blockedState.lastError, 'permission_denied');
  assert.ok(!(await second.discover()).includes(secondId));
  await db.update(accounts).set({ credentialGeneration: 3 }).where(eq(accounts.id, secondId));
  assert.ok((await second.discover()).includes(secondId));

  const secondState = async () => (await db.select().from(syncStates).where(eq(syncStates.accountId, secondId)))[0];
  const resetPending = async () => {
    const before = await secondState();
    await db.update(syncStates).set({ status: 'idle', leaseUntil: null, cursor: { ...before.cursor, phase: 'full',
      pending: ['boundary'], offset: 0, listToken: null, anchor: '50', scanStart: 0,
      nextCallAt: 0, retryAt: 0, blockedGeneration: null } }).where(eq(syncStates.id, before.id));
    return secondState();
  };

  // Job cancellation during a provider call must fence the returned raw MIME,
  // leave the message offset and sequence intact, and permit the next delivery.
  let pending = await resetPending();
  let rawEntered;
  let rawRelease;
  const rawBegan = new Promise((resolve) => { rawEntered = resolve; });
  const rawBlocked = new Promise((resolve) => { rawRelease = resolve; });
  let parseCalls = 0;
  const rawReader = { ...secondReader, async getMessageRaw(...args) {
    rawEntered(); await rawBlocked; return secondReader.getMessageRaw(...args);
  } };
  const rawRunner = new GmailSyncRunner(db, store, rawReader, origin, async (raw) => { parseCalls++; return parsed(raw); }, now);
  const rawAbort = new globalThis.AbortController();
  const rawRun = rawRunner.run(secondId, rawAbort.signal);
  await rawBegan;
  rawAbort.abort(); rawRelease();
  await rawRun;
  assert.equal(parseCalls, 0);
  assert.equal((await secondState()).sequence, pending.sequence);
  assert.equal((await secondState()).cursor.offset, 0);
  assert.equal((await secondState()).leaseUntil, null);
  assert.equal((await secondState()).lastError, 'sync_interrupted');
  await second.run(secondId);
  assert.equal((await secondState()).cursor.phase, 'ready');

  // The same boundary applies when cancellation arrives while parsing MIME.
  pending = await resetPending();
  let parseEntered;
  let parseRelease;
  const parseBegan = new Promise((resolve) => { parseEntered = resolve; });
  const parseBlocked = new Promise((resolve) => { parseRelease = resolve; });
  const parsingRunner = new GmailSyncRunner(db, store, secondReader, origin, async (raw) => {
    parseEntered(); await parseBlocked; return parsed(raw);
  }, now);
  const parseAbort = new globalThis.AbortController();
  const parseRun = parsingRunner.run(secondId, parseAbort.signal);
  await parseBegan;
  parseAbort.abort(); parseRelease();
  await parseRun;
  assert.equal((await secondState()).sequence, pending.sequence);
  assert.equal((await secondState()).cursor.offset, 0);
  await second.run(secondId);
  assert.equal((await secondState()).cursor.phase, 'ready');

  // A persisted pacing wait is interruptible, and the elapsed budget also
  // cancels an in-flight read before its result can be committed.
  pending = await resetPending();
  await db.update(syncStates).set({ cursor: { ...pending.cursor, nextCallAt: now().getTime() + 60_000 } }).where(eq(syncStates.id, pending.id));
  let pacedCalls = 0;
  const pacingRunner = new GmailSyncRunner(db, store, { ...secondReader, async listLabels() { pacedCalls++; return secondReader.listLabels(); } }, origin, parsed, now);
  const paceAbort = new globalThis.AbortController();
  const paceRun = pacingRunner.run(secondId, paceAbort.signal);
  await delay(30);
  paceAbort.abort();
  await paceRun;
  assert.equal(pacedCalls, 0);
  assert.equal((await secondState()).cursor.offset, 0);
  assert.equal((await secondState()).leaseUntil, null);

  pending = await resetPending();
  let budgetEntered;
  let budgetRelease;
  const budgetBegan = new Promise((resolve) => { budgetEntered = resolve; });
  const budgetBlocked = new Promise((resolve) => { budgetRelease = resolve; });
  const budgetReader = { ...secondReader, async getMessageRaw(...args) {
    budgetEntered(); await budgetBlocked; return secondReader.getMessageRaw(...args);
  } };
  const budgetRunner = new GmailSyncRunner(db, store, budgetReader, origin, parsed, now, 2_500);
  const budgetRun = budgetRunner.run(secondId);
  await budgetBegan;
  await delay(2_600);
  budgetRelease();
  await budgetRun;
  assert.equal((await secondState()).sequence, pending.sequence);
  assert.equal((await secondState()).cursor.offset, 0);
  assert.equal((await secondState()).leaseUntil, null);
  await second.run(secondId);
  assert.equal((await secondState()).cursor.phase, 'ready');
  console.info('Gmail sync PostgreSQL fixture passed.');
} finally { await handle.close(); }
