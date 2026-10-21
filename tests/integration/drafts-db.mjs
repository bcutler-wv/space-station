import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { URL } from 'node:url';
import { generate } from 'otplib';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../../apps/server/dist/app.js';
import { authStore, digest } from '../../apps/server/dist/auth-store.js';
import { accounts, databaseUrl, drafts, identities, itemOrbits, itemRecipients, items, loadRuntimeConfig,
  oauthApps, openDatabase, orbits, people, threads } from '../../packages/db/dist/index.js';

const config = loadRuntimeConfig(process.env);
const first = openDatabase(databaseUrl(config));
const second = openDatabase(databaseUrl(config));
const db = first.db;
const origin = 'https://example.com';
const key = Buffer.from(config.STATION_MASTER_KEY, 'base64');
const store = authStore(db);
const app = buildApp(async () => {}, undefined, { db, origin, masterKey: key, store }, { trustedProxyIp: '127.0.0.1' });
let cookie = '';
const request = async (method, url, payload, csrf, headers = {}) => {
  const response = await app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}),
      ...(method === 'GET' ? {} : { origin, 'x-csrf-token': csrf }), ...headers } });
  const set = response.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set[0] : set).split(';')[0];
  return response;
};
const id = () => randomUUID();
const content = { to: [], cc: [], bcc: [], subject: '', bodyText: '', attachmentRefs: [] };
try {
  await app.ready();
  assert.equal((await request('GET', `/api/mail/drafts?accountId=${id()}`)).statusCode, 401);
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
  const orbitA = id(), orbitB = id(), accountA = id(), accountB = id(), appId = id(), threadA = id(), itemA = id();
  await db.insert(orbits).values([{ id: orbitA, name: 'Example A', slug: 'draft-a', colorSlot: 1, context: '', privacyDefaults: { index: 'deny', ai: 'deny' } },
    { id: orbitB, name: 'Example B', slug: 'draft-b', colorSlot: 2, context: '', privacyDefaults: { index: 'deny', ai: 'deny' } }]);
  await db.insert(oauthApps).values({ id: appId, provider: 'google', ownerId: 'owner', clientId: 'fixture', encryptedClientSecret: 'private-secret', redirectUri: `${origin}/api/google/callback` });
  await db.insert(accounts).values([{ id: accountA, provider: 'google', appId, orbitId: orbitA, email: 'owner@example.com', encryptedRefreshToken: 'x', encryptedAccessToken: 'x', grantedScopes: [] },
    { id: accountB, provider: 'google', appId, orbitId: orbitB, email: 'other@example.com', encryptedRefreshToken: 'x', encryptedAccessToken: 'x', grantedScopes: [] }]);
  await db.insert(threads).values({ id: threadA, accountId: accountA, collectionId: 'primary', externalId: 'provider-thread' });
  await db.insert(items).values({ id: itemA, accountId: accountA, collectionId: 'primary', threadId: threadA, externalId: 'provider-item', appliedSequence: 1,
    direction: 'in', directionProvenance: 'incoming', parseStatus: 'supported', flags: {}, subject: 'Café', messageId: '<original@example.com>', referencesHeader: '<earlier@example.com>',
    senderIdentitiesComplete: true, senderHeaderCount: 1, replyToIdentitiesComplete: true, replyToHeaderCount: 0 });
  await db.insert(itemOrbits).values({ itemId: itemA, orbitId: orbitA, reason: 'account' });
  const personId = id(), identityId = id();
  await db.insert(people).values({ id: personId, accountId: accountA, displayName: 'Example Sender' });
  await db.insert(identities).values({ id: identityId, accountId: accountA, personId, provider: 'google', kind: 'email', normalizedValue: 'sender@example.com' });
  await db.insert(itemRecipients).values({ itemId: itemA, accountId: accountA, identityId, role: 'sender' });
  const reply = await request('GET', `/api/mail/items/${itemA}/reply-context?accountId=${accountA}&orbitId=${orbitA}`);
  assert.equal(reply.statusCode, 200, reply.body);
  assert.equal(reply.json().messageId, '<original@example.com>');
  assert.equal(reply.json().references, '<earlier@example.com> <original@example.com>');
  assert.deepEqual(reply.json().to, [{ address: 'sender@example.com', name: '' }]);
  assert.equal((await request('GET', `/api/mail/items/${itemA}/reply-context?accountId=${accountB}`)).statusCode, 409);
  assert.equal((await request('GET', `/api/mail/items/${itemA}/reply-context?accountId=${accountA}&orbitId=${orbitB}`)).statusCode, 409);
  assert.equal((await request('GET', `/api/mail/items/${itemA}/reply-context?accountId=${accountA}`, undefined, undefined, { origin: 'https://other.example.com' })).statusCode, 403);
  const draftId = id(), creationKey = id();
  const body = { ...content, id: draftId, creationKey, accountId: accountA, orbitId: orbitA, parentItemId: itemA, subject: 'Re: Café', to: reply.json().to };
  assert.equal((await request('POST', '/api/mail/drafts', body, '')).statusCode, 403);
  assert.equal((await request('POST', '/api/mail/drafts', body, csrf, { origin: 'https://other.example.com' })).statusCode, 403);
  assert.equal((await request('POST', '/api/mail/drafts', { ...body, accountId: accountB }, csrf)).statusCode, 409);
  assert.equal((await request('POST', '/api/mail/drafts', { ...body, orbitId: orbitB }, csrf)).statusCode, 409);
  const created = await request('POST', '/api/mail/drafts', body, csrf);
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().revision, 1);
  assert.equal((await request('POST', '/api/mail/drafts', body, csrf)).statusCode, 200);
  assert.equal((await request('POST', '/api/mail/drafts', { ...body, subject: 'Changed' }, csrf)).statusCode, 409);
  assert.equal((await db.select().from(drafts)).length, 1);
  assert.equal((await request('GET', `/api/mail/drafts/${draftId}?accountId=${accountB}`)).statusCode, 404);
  assert.equal((await request('GET', `/api/mail/drafts?accountId=${accountA}&orbitId=${orbitB}`)).json().drafts.length, 0);
  assert.equal((await request('GET', `/api/mail/drafts?accountId=${accountA}`)).json().drafts.length, 1);
  assert.ok(!('bodyText' in (await request('GET', `/api/mail/drafts?accountId=${accountA}`)).json().drafts[0]));
  const extraIds = [id(), id()];
  for (const extraId of extraIds) assert.equal((await request('POST', '/api/mail/drafts', {
    ...content, id: extraId, creationKey: id(), accountId: accountA, subject: 'page' }, csrf)).statusCode, 201);
  await db.execute(sql`update drafts set updated_at = '2026-10-20 20:00:00.123456+00' where id in (${draftId}, ${extraIds[0]}, ${extraIds[1]})`);
  const seen = [];
  let next = null;
  do {
    const page = (await request('GET', `/api/mail/drafts?accountId=${accountA}&limit=1${next ? `&cursor=${encodeURIComponent(next)}` : ''}`)).json();
    assert.equal(page.drafts.length, 1);
    seen.push(page.drafts[0].id);
    next = page.nextCursor;
  } while (next);
  assert.deepEqual(seen.sort(), [draftId, ...extraIds].sort());
  assert.equal((await request('POST', '/api/mail/drafts', { ...content, id: id(), creationKey: id(), accountId: accountA,
    to: [{ address: 'bad\r\nBcc: x@example.com', name: '' }] }, csrf)).statusCode, 400);
  assert.equal((await request('POST', '/api/mail/drafts', { ...content, id: id(), creationKey: id(), accountId: accountA,
    bodyText: 'x'.repeat(4_194_305) }, csrf)).statusCode, 400);
  assert.equal((await request('POST', '/api/mail/drafts', { ...content, id: id(), creationKey: id(), accountId: accountA,
    attachmentRefs: ['b_fake'] }, csrf)).statusCode, 400);
  const update = { ...content, to: reply.json().to, subject: 'Re: Café', bodyText: 'Unicode 🛰️', revision: 1 };
  const [saveA, saveB] = await Promise.all([
    request('PUT', `/api/mail/drafts/${draftId}?accountId=${accountA}`, update, csrf),
    request('PUT', `/api/mail/drafts/${draftId}?accountId=${accountA}`, { ...update, bodyText: 'Other edit' }, csrf),
  ]);
  assert.deepEqual([saveA.statusCode, saveB.statusCode].sort(), [200, 409]);
  const persisted = (await second.db.select().from(drafts).where(eq(drafts.id, draftId)))[0];
  assert.equal(persisted.revision, 2);
  assert.ok(['Unicode 🛰️', 'Other edit'].includes(persisted.bodyText));
  const restarted = buildApp(async () => {}, undefined, { db: second.db, origin, masterKey: key,
    store: authStore(second.db) }, { trustedProxyIp: '127.0.0.1' });
  await restarted.ready();
  try {
    const reopened = await restarted.inject({ method: 'GET', url: `/api/mail/drafts/${draftId}?accountId=${accountA}`,
      remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': 'https', cookie } });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal(reopened.json().bodyText, persisted.bodyText);
  } finally { await restarted.close(); }
  assert.equal((await request('POST', `/api/mail/drafts/${draftId}/discard?accountId=${accountA}`, { revision: 2 }, csrf)).statusCode, 200);
  assert.equal((await request('POST', `/api/mail/drafts/${draftId}/discard?accountId=${accountA}`, { revision: 2 }, csrf)).statusCode, 200);
  assert.equal((await request('PUT', `/api/mail/drafts/${draftId}?accountId=${accountA}`, { ...update, revision: 3 }, csrf)).statusCode, 409);
  assert.equal((await request('GET', `/api/mail/drafts?accountId=${accountA}`)).json().drafts.length, 2);
  await db.insert(itemOrbits).values({ itemId: itemA, orbitId: orbitB, reason: 'rule' });
  assert.equal((await request('GET', `/api/mail/items/${itemA}/reply-context?accountId=${accountA}&orbitId=${orbitB}`)).statusCode, 200);
  assert.equal((await request('POST', '/api/mail/drafts', { ...content, id: id(), creationKey: id(),
    accountId: accountA, orbitId: orbitB, parentItemId: itemA, to: reply.json().to }, csrf)).statusCode, 201);
  await db.update(items).set({ senderIdentitiesComplete: false, senderHeaderCount: 2 }).where(eq(items.id, itemA));
  assert.equal((await request('GET', `/api/mail/items/${itemA}/reply-context?accountId=${accountA}`)).statusCode, 409);
  await db.update(items).set({ senderIdentitiesComplete: true, senderHeaderCount: 1,
    replyToIdentitiesComplete: false, replyToHeaderCount: 2 }).where(eq(items.id, itemA));
  assert.equal((await request('GET', `/api/mail/items/${itemA}/reply-context?accountId=${accountA}`)).statusCode, 409);
  await db.update(items).set({ replyToIdentitiesComplete: true, replyToHeaderCount: 0 }).where(eq(items.id, itemA));
  await db.update(items).set({ messageId: 'bad\r\nInjected: x' }).where(eq(items.id, itemA));
  assert.equal((await request('GET', `/api/mail/items/${itemA}/reply-context?accountId=${accountA}`)).statusCode, 409);
  console.log('draft PG HTTP fixture passed');
} finally { await app.close(); await first.close(); await second.close(); }
