import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { generate } from 'otplib';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../../apps/server/dist/app.js';
import { authStore, digest } from '../../apps/server/dist/auth-store.js';
import { GoogleCredentialService } from '../../packages/connectors/dist/index.js';
import { accounts, auditLog, collectOutboundOperations, databaseUrl, draftAttachments, drafts,
  identities, itemOrbits, itemRecipients, items, loadRuntimeConfig, oauthApps, openDatabase, orbits,
  outboundOperations, people, PrivateBlobStore, threads } from '../../packages/db/dist/index.js';

const config = loadRuntimeConfig(process.env);
const connection = openDatabase(databaseUrl(config));
const db = connection.db;
const origin = 'https://example.com';
const key = Buffer.from(config.STATION_MASTER_KEY, 'base64');
const auth = authStore(db);
const fixtureRoot = process.env.SEND_TEST_BLOB_ROOT;
const dir = fixtureRoot ?? await (async () => {
  const base = path.join(process.cwd(), '.cache', 'test-results');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'send-'));
})();
if (fixtureRoot) await mkdir(dir, { recursive: true });
const blobs = new PrivateBlobStore(dir);
const id = () => randomUUID();
const scope = (draftId, accountId) => `/api/mail/drafts/${draftId}/send?accountId=${accountId}`;
const operation = (operationId, accountId) => `/api/mail/sends/${operationId}?accountId=${accountId}`;
let mode = 'success';
let sends = 0;
let rawSent;
let found = [];
let onSend = async () => {};
let onFind = async () => {};
let onCredential = async () => {};
let lastThreadId;
const provider = {
  async credential() { await onCredential(); return { accessToken: 'fixture-access', generation: 0, expiresAt: new Date(Date.now() + 3600_000) }; },
  async send(_accountId, _token, raw, threadId) {
    sends++;
    rawSent = raw;
    lastThreadId = threadId;
    await onSend();
    if (mode === 'unknown') throw new Error('fixture response lost');
    return { id: `sent_${sends}`, threadId: threadId ?? 'thread_1' };
  },
  async findSent() { await onFind(); return { evidence: found, credentialGeneration: 0 }; },
};
const createApp = async () => {
  const app = buildApp(async () => {}, undefined, { db, origin, masterKey: key, store: auth },
    { trustedProxyIp: '127.0.0.1' }, blobs, undefined, undefined, provider);
  await app.ready();
  return app;
};
let app = await createApp();
let cookie = '';
const call = async (method, url, payload, csrf, extra = {}) => {
  const response = await app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}),
      ...(method === 'GET' ? {} : { origin, 'x-csrf-token': csrf }), ...extra } });
  const set = response.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set[0] : set).split(';')[0];
  return response;
};
const draftInput = (draftId, accountId) => ({ id: draftId, creationKey: id(), accountId,
  to: [{ address: 'recipient@example.com', name: 'Example Recipient' }], cc: [],
  bcc: [{ address: 'blind@example.com', name: '' }], subject: 'Example subject', bodyText: 'Example body', attachmentRefs: [] });
try {
  assert.equal((await call('GET', operation(id(), id()))).statusCode, 401);
  const bootstrap = randomBytes(32).toString('base64url');
  await auth.issueBootstrap(digest(bootstrap), new Date(Date.now() + 60_000));
  let csrf = (await call('GET', '/api/auth/status')).json().csrfToken;
  const enrolled = await call('POST', '/api/auth/bootstrap/password', { bootstrapToken: bootstrap,
    displayName: 'Example Owner', password: 'Example-only-password-123!' }, csrf);
  assert.equal(enrolled.statusCode, 200, enrolled.body);
  csrf = (await call('GET', '/api/auth/status')).json().csrfToken;
  const secret = new URL(enrolled.json().totpUri).searchParams.get('secret');
  assert.equal((await call('POST', '/api/auth/bootstrap/totp', { code: await generate({ secret }) }, csrf)).statusCode, 200);
  csrf = (await call('GET', '/api/auth/status')).json().csrfToken;
  const orbitId = id(), accountId = id(), appId = id(), draftId = id();
  await db.insert(orbits).values({ id: orbitId, name: 'Example Orbit', slug: 'send-example', colorSlot: 1,
    context: '', privacyDefaults: { index: 'deny', ai: 'deny' } });
  await db.insert(oauthApps).values({ id: appId, provider: 'google', ownerId: 'owner', clientId: 'fixture',
    encryptedClientSecret: 'fixture-secret', redirectUri: `${origin}/api/google/callback` });
  await db.insert(accounts).values({ id: accountId, provider: 'google', appId, orbitId,
    email: 'owner@example.com', encryptedRefreshToken: 'fixture', encryptedAccessToken: 'fixture',
    grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'] });
  const senderPersonId = id(), senderIdentityId = id();
  await db.insert(people).values({ id: senderPersonId, accountId, displayName: 'Example Sender' });
  await db.insert(identities).values({ id: senderIdentityId, accountId, personId: senderPersonId, provider: 'google',
    kind: 'email', normalizedValue: 'sender@example.com' });
  const makeReply = async (legacy = false) => {
    const threadId = id(), parentId = id(), replyDraftId = id();
    await db.insert(threads).values({ id: threadId, accountId, collectionId: 'primary', externalId: `provider_${threadId}` });
    await db.insert(items).values({ id: parentId, accountId, collectionId: 'primary', threadId,
      externalId: `item_${parentId}`, appliedSequence: 1, direction: 'in', directionProvenance: 'incoming',
      parseStatus: 'supported', flags: {}, subject: 'Example reply',
      messageId: legacy ? null : '<parent@example.com>',
      referencesHeader: legacy ? null : '<older@example.com>',
      replyMetadata: legacy ? { messageId: '<legacy@example.com>', references: '<older@example.com>', to: 'sender@example.com' } : null,
      senderIdentitiesComplete: true, senderHeaderCount: 1, replyToIdentitiesComplete: true, replyToHeaderCount: 0 });
    await db.insert(itemOrbits).values({ itemId: parentId, orbitId, reason: 'account' });
    await db.insert(itemRecipients).values({ itemId: parentId, accountId, identityId: senderIdentityId, role: 'sender' });
    const replyBody = { ...draftInput(replyDraftId, accountId), orbitId, parentItemId: parentId,
      subject: 'Re: Example reply', to: [{ address: 'sender@example.com', name: '' }], bcc: [] };
    const created = await call('POST', '/api/mail/drafts', replyBody, csrf);
    assert.equal(created.statusCode, 201, created.body);
    return { replyDraftId, parentId, threadId, providerThreadId: `provider_${threadId}` };
  };
  assert.equal((await call('POST', '/api/mail/drafts', draftInput(draftId, accountId), csrf)).statusCode, 201);
  const bytes = Buffer.from('fixture attachment');
  const blobKey = PrivateBlobStore.generateKey();
  await blobs.writeReserved(blobKey, bytes);
  const attachmentId = id();
  await db.insert(draftAttachments).values({ id: attachmentId, draftId, accountId, blobKey, uploadKey: id(),
    digest: createHash('sha256').update(bytes).digest('hex'), filename: 'example.txt', byteSize: bytes.length, state: 'ready' });
  await db.update(drafts).set({ attachmentRefs: [attachmentId], revision: 2 }).where(eq(drafts.id, draftId));
  const key1 = id();
  assert.equal((await call('POST', scope(draftId, accountId), { idempotencyKey: key1, revision: 2 }, '', {})).statusCode, 403);
  assert.equal((await call('POST', scope(draftId, accountId), { idempotencyKey: key1, revision: 2 }, csrf,
    { origin: 'https://evil.example.com' })).statusCode, 403);
  const sent = await call('POST', scope(draftId, accountId), { idempotencyKey: key1, revision: 2 }, csrf);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().state, 'succeeded');
  assert.equal((await db.select().from(drafts).where(eq(drafts.id, draftId)))[0].state, 'sent');
  assert.deepEqual((await db.select().from(drafts).where(eq(drafts.id, draftId)))[0].attachmentRefs, []);
  assert.equal((await db.select().from(draftAttachments).where(eq(draftAttachments.id, attachmentId)))[0].state, 'delete_pending');
  assert.equal(sends, 1);
  assert.match(rawSent.toString(), /Bcc: blind@example\.com/i);
  assert.match(rawSent.toString(), /example\.txt/);
  assert.equal((await call('POST', scope(draftId, accountId), { idempotencyKey: key1, revision: 2 }, csrf)).json().id, sent.json().id);
  assert.equal(sends, 1);
  assert.equal((await call('POST', scope(draftId, accountId), { idempotencyKey: key1, revision: 1 }, csrf)).statusCode, 409);
  assert.equal((await call('GET', scope(draftId, accountId))).json().id, sent.json().id);
  assert.equal((await call('PUT', `/api/mail/drafts/${draftId}?accountId=${accountId}`, {
    to: [{ address: 'recipient@example.com', name: 'Example Recipient' }], cc: [],
    bcc: [{ address: 'blind@example.com', name: '' }], subject: 'Example subject', bodyText: 'Example body',
    revision: 2, attachmentRefs: [attachmentId] }, csrf)).statusCode, 409);
  assert.equal((await call('GET', operation(sent.json().id, id()))).statusCode, 404);
  assert.equal((await call('GET', scope(draftId, accountId), undefined, undefined,
    { origin: 'https://evil.example.com' })).statusCode, 403);
  const doubleId = id(), doubleKey = id();
  assert.equal((await call('POST', '/api/mail/drafts', draftInput(doubleId, accountId), csrf)).statusCode, 201);
  let sendEntered;
  const entered = new Promise((resolve) => { sendEntered = resolve; });
  let releaseSend;
  onSend = async () => { sendEntered(); await new Promise((resolve) => { releaseSend = resolve; }); };
  const firstClick = call('POST', scope(doubleId, accountId), { idempotencyKey: doubleKey, revision: 1 }, csrf);
  await entered;
  const secondClick = await call('POST', scope(doubleId, accountId), { idempotencyKey: doubleKey, revision: 1 }, csrf);
  assert.equal(secondClick.statusCode, 200, secondClick.body);
  assert.equal(secondClick.json().state, 'in_flight');
  assert.equal(sends, 2);
  releaseSend();
  assert.equal((await firstClick).json().id, secondClick.json().id);
  onSend = async () => {};
  const lockDraft = id();
  assert.equal((await call('POST', '/api/mail/drafts', draftInput(lockDraft, accountId), csrf)).statusCode, 201);
  let unlockAccount, lockedAccount;
  const accountGate = new Promise((resolve) => { unlockAccount = resolve; });
  const accountLocked = new Promise((resolve) => { lockedAccount = resolve; });
  const blocker = db.transaction(async (tx) => {
    await tx.execute(sql`select id from accounts where id = ${accountId} for no key update`);
    lockedAccount();
    await accountGate;
  });
  await accountLocked;
  const credentialService = new GoogleCredentialService(db, key);
  const lockStarted = Date.now();
  await assert.rejects(credentialService.get(accountId), (error) => error.code === 'busy');
  assert.ok(Date.now() - lockStarted < 2500, 'credential row lock settles within its database deadline');
  let credentialCalls = 0;
  onCredential = () => { credentialCalls++; return credentialService.get(accountId); };
  const callsBeforeLockedSend = sends;
  const sendStarted = Date.now();
  const blockedSend = await call('POST', scope(lockDraft, accountId), { idempotencyKey: id(), revision: 1 }, csrf);
  assert.equal(blockedSend.statusCode, 503, blockedSend.body);
  assert.ok(Date.now() - sendStarted < 3500, 'locked credential row cannot occupy a send slot indefinitely');
  assert.equal(credentialCalls, 1);
  assert.equal(sends, callsBeforeLockedSend);
  assert.equal((await db.select().from(drafts).where(eq(drafts.id, lockDraft)))[0].state, 'editing');
  const [failedPreflight] = await db.select().from(outboundOperations).where(eq(outboundOperations.draftId, lockDraft));
  assert.equal(failedPreflight.state, 'failed');
  assert.equal(failedPreflight.lastError, 'credential_preflight');
  assert.equal(failedPreflight.blobReady, true);
  assert.deepEqual((await db.select({ action: auditLog.action }).from(auditLog)
    .where(eq(auditLog.targetId, failedPreflight.id))).map((row) => row.action).sort(), ['send_failed', 'send_requested']);
  onCredential = async () => {};
  unlockAccount();
  await blocker;
  const second = id();
  assert.equal((await call('POST', '/api/mail/drafts', draftInput(second, accountId), csrf)).statusCode, 201);
  mode = 'unknown';
  const unknown = await call('POST', scope(second, accountId), { idempotencyKey: id(), revision: 1 }, csrf);
  assert.equal(unknown.statusCode, 202, unknown.body);
  assert.equal(unknown.json().state, 'outcome_unknown');
  assert.equal(sends, 3);
  await app.close();
  app = await createApp();
  assert.equal((await call('GET', operation(unknown.json().id, accountId))).json().state, 'outcome_unknown');
  assert.equal(sends, 3);
  assert.equal((await call('POST', `${operation(unknown.json().id, accountId).replace('?', '/reconcile?')}`, {}, csrf)).json().state, 'outcome_unknown');
  found = [{ id: 'sent_recovered', threadId: 'thread_1', labelIds: ['SENT'], payload: { headers: [
    { name: 'Message-ID', value: (await db.select().from(outboundOperations).where(eq(outboundOperations.id, unknown.json().id)))[0].messageId },
    { name: 'From', value: 'owner@example.com' }, { name: 'To', value: 'Example Recipient <recipient@example.com>' },
    { name: 'Bcc', value: 'blind@example.com' },
  ] } }];
  onFind = async () => { await db.update(accounts).set({ credentialGeneration: 1 }).where(eq(accounts.id, accountId)); };
  assert.equal((await call('POST', operation(unknown.json().id, accountId).replace('?', '/reconcile?'), {}, csrf)).statusCode, 404);
  assert.equal((await call('GET', operation(unknown.json().id, accountId))).json().state, 'outcome_unknown');
  await db.update(accounts).set({ credentialGeneration: 0 }).where(eq(accounts.id, accountId));
  onFind = async () => {};
  const recovered = await call('POST', operation(unknown.json().id, accountId).replace('?', '/reconcile?'), {}, csrf);
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().state, 'succeeded');
  assert.equal((await db.select().from(drafts).where(eq(drafts.id, second)))[0].state, 'sent');
  assert.equal(sends, 3);
  mode = 'success';
  for (const legacy of [false, true]) {
    const replyCase = await makeReply(legacy);
    const result = await call('POST', `${scope(replyCase.replyDraftId, accountId)}&orbitId=${orbitId}`,
      { idempotencyKey: id(), revision: 1 }, csrf);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(lastThreadId, replyCase.providerThreadId);
    assert.match(rawSent.toString(), /In-Reply-To: <(parent|legacy)@example\.com>/i);
    assert.match(rawSent.toString(), /References: <older@example\.com> <(parent|legacy)@example\.com>/i);
    assert.match(rawSent.toString(), /To: sender@example\.com/i);
    assert.match(rawSent.toString(), /Subject: Re: Example reply/i);
  }
  const beforeMutation = sends;
  for (const change of ['tombstone', 'revision', 'orbit']) {
    const replyCase = await makeReply();
    onCredential = async () => {
      if (change === 'tombstone') await db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, replyCase.parentId));
      if (change === 'revision') await db.update(items).set({ appliedSequence: 2 }).where(eq(items.id, replyCase.parentId));
      if (change === 'orbit') await db.delete(itemOrbits).where(eq(itemOrbits.itemId, replyCase.parentId));
    };
    const rejected = await call('POST', `${scope(replyCase.replyDraftId, accountId)}&orbitId=${orbitId}`,
      { idempotencyKey: id(), revision: 1 }, csrf);
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal((await db.select().from(drafts).where(eq(drafts.id, replyCase.replyDraftId)))[0].state, 'editing');
    onCredential = async () => {};
  }
  assert.equal(sends, beforeMutation);
  const largeId = id();
  assert.equal((await call('POST', '/api/mail/drafts', draftInput(largeId, accountId), csrf)).statusCode, 201);
  const largeBytes = randomBytes(8 * 1024 * 1024);
  const largeKey = PrivateBlobStore.generateKey(), largeAttachment = id();
  await blobs.writeReserved(largeKey, largeBytes);
  await db.insert(draftAttachments).values({ id: largeAttachment, draftId: largeId, accountId, blobKey: largeKey,
    uploadKey: id(), digest: createHash('sha256').update(largeBytes).digest('hex'),
    filename: 'large.bin', byteSize: largeBytes.length, state: 'ready' });
  await db.update(drafts).set({ attachmentRefs: [largeAttachment], bodyText: 'x'.repeat(4 * 1024 * 1024), revision: 2 })
    .where(eq(drafts.id, largeId));
  const tooLarge = await call('POST', scope(largeId, accountId), { idempotencyKey: id(), revision: 2 }, csrf);
  assert.equal(tooLarge.statusCode, 422, tooLarge.body);
  assert.equal(sends, beforeMutation);
  assert.equal((await db.select().from(drafts).where(eq(drafts.id, largeId)))[0].state, 'editing');
  const crashDraft = id(), crashOp = id(), crashMessageId = `<${id()}@example.com>`;
  assert.equal((await call('POST', '/api/mail/drafts', draftInput(crashDraft, accountId), csrf)).statusCode, 201);
  const crashKey = PrivateBlobStore.generateKey();
  const crashMime = Buffer.from(`From: owner@example.com\r\nTo: recipient@example.com\r\nBcc: blind@example.com\r\nMessage-ID: ${crashMessageId}\r\n\r\nExample`);
  await blobs.writeReserved(crashKey, crashMime);
  const sentBeforeCrash = await provider.send(accountId, 'fixture-access', crashMime);
  const afterProvider = sends;
  // Simulate a process dying after Gmail returned success but before local confirmation.
  await db.insert(outboundOperations).values({ id: crashOp, ownerId: 'owner', draftId: crashDraft, accountId,
    idempotencyKey: id(), requestDigest: 'fixture', draftRevision: 1, blobKey: crashKey, blobReady: true,
    mimeDigest: createHash('sha256').update(crashMime).digest('hex'), mimeBytes: crashMime.length,
    messageId: crashMessageId, fromAddress: 'owner@example.com', attemptCount: 1, state: 'in_flight',
    recipientAddresses: { to: ['recipient@example.com'], cc: [], bcc: ['blind@example.com'] },
    updatedAt: new Date(Date.now() - 60_000) });
  await db.update(drafts).set({ state: 'sending' }).where(eq(drafts.id, crashDraft));
  await app.close();
  app = await createApp();
  assert.equal((await call('GET', operation(crashOp, accountId))).json().state, 'outcome_unknown');
  assert.ok(await collectOutboundOperations(db, blobs));
  assert.equal((await db.select().from(outboundOperations).where(eq(outboundOperations.id, crashOp)))[0].state, 'outcome_unknown');
  assert.equal(sends, afterProvider);
  found = [{ id: sentBeforeCrash.id, threadId: sentBeforeCrash.threadId, labelIds: ['SENT'], payload: { headers: [
    { name: 'Message-ID', value: crashMessageId }, { name: 'From', value: 'owner@example.com' },
    { name: 'To', value: 'recipient@example.com' }, { name: 'Bcc', value: 'blind@example.com' },
  ] } }];
  assert.equal((await call('POST', operation(crashOp, accountId).replace('?', '/reconcile?'), {}, csrf)).json().state, 'succeeded');
  assert.equal(sends, afterProvider);
  const third = id();
  assert.equal((await call('POST', '/api/mail/drafts', draftInput(third, accountId), csrf)).statusCode, 201);
  const abandoned = id(), abandonedBlob = PrivateBlobStore.generateKey();
  await db.insert(outboundOperations).values({ id: abandoned, ownerId: 'owner', draftId: third, accountId,
    idempotencyKey: id(), requestDigest: 'fixture', draftRevision: 1, blobKey: abandonedBlob,
    messageId: `<${id()}@station.local>`, fromAddress: 'owner@example.com',
    recipientAddresses: { to: ['recipient@example.com'], cc: [], bcc: [] },
    updatedAt: new Date(Date.now() - 6 * 60_000) });
  await blobs.writeReserved(abandonedBlob, Buffer.from('orphan MIME'));
  await db.update(drafts).set({ state: 'sending' }).where(eq(drafts.id, third));
  assert.ok(await collectOutboundOperations(db, blobs));
  assert.equal((await db.select().from(outboundOperations).where(eq(outboundOperations.id, abandoned)))[0].state, 'failed');
  assert.equal((await db.select().from(drafts).where(eq(drafts.id, third)))[0].state, 'editing');
  await db.execute(sql`update outbound_operations set updated_at = now() - interval '2 minutes' where id = ${abandoned}`);
  assert.ok(await collectOutboundOperations(db, blobs));
  assert.equal((await db.select().from(outboundOperations).where(eq(outboundOperations.id, abandoned)))[0].blobCollectedAt instanceof Date, true);
  await assert.rejects(blobs.read(abandonedBlob, 1024));
  assert.equal((await db.select().from(auditLog).where(eq(auditLog.targetId, sent.json().id))).length, 2);
  console.log('send PostgreSQL HTTP/provider/filesystem fixture passed');
} finally {
  await app.close();
  await connection.close();
  await rm(dir, { recursive: true, force: true });
}
