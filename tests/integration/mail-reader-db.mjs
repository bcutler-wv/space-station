import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { Console } from 'node:console';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { generate } from 'otplib';
import { eq, isNull, sql } from 'drizzle-orm';
import { buildApp } from '../../apps/server/dist/app.js';
import { authStore, digest } from '../../apps/server/dist/auth-store.js';
import { accounts, attachments, blobIntents, databaseUrl, itemLabels, itemOrbits, items, labels,
  loadRuntimeConfig, oauthApps, openDatabase, orbits, PrivateBlobStore, sessions, syncStates, threads, people, identities,
  mailImageConsent } from '../../packages/db/dist/index.js';

const config = loadRuntimeConfig(process.env);
const handle = openDatabase(databaseUrl(config));
const other = openDatabase(databaseUrl(config));
const db = handle.db;
const fixtureParent = process.env.MAIL_READER_FIXTURE_DIR ?? path.join(process.cwd(), '.cache');
await mkdir(fixtureParent, { recursive: true });
const root = await mkdtemp(path.join(fixtureParent, 'station-mail-reader-'));
const blobs = new PrivateBlobStore(root);
const origin = 'https://example.com';
const store = authStore(db);
const app = buildApp(async () => {}, undefined,
  { db, origin, masterKey: Buffer.from(config.STATION_MASTER_KEY, 'base64'), store },
  { trustedProxyIp: '127.0.0.1' }, blobs, { signingKey: process.env.GOCAMO_HMAC, origin: 'http://go-camo:8080' });
let cookie = '';
const get = async (url, opts = {}) => {
  const response = await app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1', headers: {
  'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}), ...opts,
  } });
  const value = response.headers['set-cookie'];
  if (value) cookie = (Array.isArray(value) ? value[0] : value).split(';')[0];
  return response;
};
const post = async (url, payload, csrf) => {
  const response = await app.inject({ method: 'POST', url, payload, remoteAddress: '127.0.0.1', headers: {
    'x-forwarded-proto': 'https', origin, 'x-csrf-token': csrf, ...(cookie ? { cookie } : {}),
  } });
  const value = response.headers['set-cookie'];
  if (value) cookie = (Array.isArray(value) ? value[0] : value).split(';')[0];
  return response;
};
const id = () => randomUUID();
const output = new Console(process.stdout);
let firstItem;
try {
  await app.ready();
  assert.equal((await get('/api/mail/conversations?accountId=' + id())).statusCode, 401);
  assert.equal((await get(`/api/mail/items/${id()}/images/consent?accountId=${id()}`)).statusCode, 401);
  const bootstrap = randomBytes(32).toString('base64url');
  await store.issueBootstrap(digest(bootstrap), new Date(Date.now() + 60_000));
  let csrf = (await get('/api/auth/status')).json().csrfToken;
  const enrolled = await post('/api/auth/bootstrap/password', { bootstrapToken: bootstrap,
    displayName: 'Example Owner', password: 'Example-only-password-123!' }, csrf);
  assert.equal(enrolled.statusCode, 200, enrolled.body);
  csrf = (await get('/api/auth/status')).json().csrfToken;
  const secret = new URL(enrolled.json().totpUri).searchParams.get('secret');
  assert.equal((await post('/api/auth/bootstrap/totp', { code: await generate({ secret }) }, csrf)).statusCode, 200);

  const orbitA = id(), orbitB = id(), accountA = id(), accountB = id(), appId = id();
  await db.insert(orbits).values([
    { id: orbitA, name: 'Example A', slug: 'example-a', colorSlot: 1, context: '', privacyDefaults: { index: 'deny', ai: 'deny' } },
    { id: orbitB, name: 'Example B', slug: 'example-b', colorSlot: 2, context: '', privacyDefaults: { index: 'allow', ai: 'allow' } },
  ]);
  await db.insert(oauthApps).values({ id: appId, provider: 'google', ownerId: 'owner', clientId: 'fixture',
    encryptedClientSecret: 'private-secret', redirectUri: `${origin}/api/google/callback` });
  await db.insert(accounts).values([
    { id: accountA, provider: 'google', appId, orbitId: orbitA, email: 'a@example.com', encryptedRefreshToken: 'private-refresh-a', encryptedAccessToken: 'private-access-a', grantedScopes: [] },
    { id: accountB, provider: 'google', appId, orbitId: orbitB, email: 'b@example.com', encryptedRefreshToken: 'private-refresh-b', encryptedAccessToken: 'private-access-b', grantedScopes: [] },
  ]);
  const state = id();
  await db.insert(syncStates).values({ id: state, accountId: accountA, resource: 'mail', collectionId: 'primary', cursor: {} });
  const threadA = id(), threadB = id(), deletedThread = id();
  await db.insert(threads).values([
    { id: threadA, accountId: accountA, collectionId: 'primary', externalId: 'same-provider-id', subject: 'stale private subject', lastActivityAt: new Date('2026-01-01T00:00:00Z') },
    { id: threadB, accountId: accountB, collectionId: 'primary', externalId: 'same-provider-id', subject: 'other account', lastActivityAt: new Date('2026-01-01T00:00:00Z') },
    { id: deletedThread, accountId: accountA, collectionId: 'primary', externalId: 'deleted-thread', subject: 'deleted thread' },
  ]);
  const secondItem = id(), otherItem = id(), tombstone = id();
  firstItem = id();
  const sameTime = new Date('2026-01-01T00:00:00Z');
  await db.insert(items).values([
    { id: firstItem, accountId: accountA, collectionId: 'primary', threadId: threadA, externalId: 'same-provider-item', appliedSequence: 1,
      direction: 'in', directionProvenance: 'incoming', internalAt: sameTime, subject: '100% _literal', snippet: 'visible one',
      bodyText: 'Hello from a@example.com', flags: {}, parseStatus: 'supported' },
    { id: secondItem, accountId: accountA, collectionId: 'primary', threadId: threadA, externalId: 'second', appliedSequence: 1,
      direction: 'out', directionProvenance: 'provider_sent_account', internalAt: null, subject: 'Null date', snippet: 'visible two',
      bodyText: 'Second', flags: {}, parseStatus: 'supported' },
    { id: otherItem, accountId: accountB, collectionId: 'primary', threadId: threadB, externalId: 'same-provider-item', appliedSequence: 1,
      direction: 'in', directionProvenance: 'incoming', internalAt: sameTime, subject: 'Other account', snippet: 'private other',
      bodyText: 'secret other account', flags: {}, parseStatus: 'supported' },
    { id: tombstone, accountId: accountA, collectionId: 'primary', threadId: deletedThread, externalId: 'gone', appliedSequence: 1,
      direction: 'in', directionProvenance: 'incoming', internalAt: sameTime, subject: 'Deleted', flags: {},
      parseStatus: 'deleted', deletedAt: new Date() },
  ]);
  await db.insert(itemOrbits).values([
    { itemId: firstItem, orbitId: orbitA, reason: 'account' }, { itemId: secondItem, orbitId: orbitA, reason: 'account' },
    { itemId: otherItem, orbitId: orbitB, reason: 'account' }, { itemId: tombstone, orbitId: orbitA, reason: 'account' },
  ]);
  const label = id();
  await db.insert(labels).values({ id: label, accountId: accountA, providerRef: 'literal', name: 'Literal' });
  await db.insert(itemLabels).values({ itemId: firstItem, accountId: accountA, labelId: label, source: 'provider' });
  const url = (suffix = '') => `/api/mail/conversations?accountId=${accountA}${suffix}`;
  const list = await get(url());
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().conversations.length, 1);
  assert.equal(list.json().conversations[0].subject, '100% _literal');
  assert.equal(list.json().conversations[0].messageCount, 2);
  assert.equal((await get(url('&subject=%25'))).json().conversations.length, 1);
  assert.equal((await get(url('&subject=_literal'))).json().conversations.length, 1);
  assert.equal((await get(url('&subject=other'))).json().conversations.length, 0);
  assert.equal((await get(url('&labelId=' + label))).json().conversations[0].messageCount, 1);
  assert.equal((await get(`/api/mail/conversations?orbitId=${orbitB}`)).json().conversations[0].accountId, accountB);
  const routedLabel = id();
  await db.insert(labels).values({ id: routedLabel, accountId: accountB, providerRef: 'routed', name: 'Routed' });
  await db.insert(itemLabels).values({ itemId: otherItem, accountId: accountB, labelId: routedLabel, source: 'provider' });
  await db.insert(itemOrbits).values({ itemId: otherItem, orbitId: orbitA, reason: 'rule' });
  assert.ok((await get(`/api/mail/labels?orbitId=${orbitA}`)).json().labels.some((row) => row.id === routedLabel));
  const tiedThreads = [id(), id(), id()];
  const tiedItems = [id(), id(), id()];
  await db.insert(threads).values(tiedThreads.map((threadId, index) => ({ id: threadId, accountId: accountA,
    collectionId: 'primary', externalId: `tied-${index}` })));
  await db.insert(items).values(tiedItems.map((itemId, index) => ({ id: itemId, accountId: accountA,
    collectionId: 'primary', threadId: tiedThreads[index], externalId: `tied-item-${index}`, appliedSequence: 1,
    direction: 'in', directionProvenance: 'incoming', internalAt: index === 2 ? null : sameTime,
    subject: 'Tie', flags: {}, parseStatus: 'supported' })));
  await db.insert(itemOrbits).values(tiedItems.map((itemId) => ({ itemId, orbitId: orbitA, reason: 'account' })));
  await db.execute(sql`update items set internal_at = '2026-01-01 00:00:00.000900+00' where id in (${tiedItems[0]}, ${tiedItems[1]})`);
  const seen = [];
  let listCursor = null;
  do {
    const result = await get(url(`&limit=1${listCursor ? `&cursor=${encodeURIComponent(listCursor)}` : ''}`));
    assert.equal(result.statusCode, 200, result.body);
    seen.push(result.json().conversations[0].threadId);
    listCursor = result.json().nextCursor;
  } while (listCursor);
  assert.deepEqual(seen, [...tiedThreads.slice(0, 2).sort().reverse(), threadA, tiedThreads[2]]);
  assert.equal((await get(`/api/mail/conversations?orbitId=${orbitA}&cursor=${encodeURIComponent((await get(url('&limit=1'))).json().nextCursor)}`)).statusCode, 400);
  assert.equal((await get(`/api/mail/threads/${threadB}/messages?accountId=${accountA}`)).statusCode, 404);
  assert.equal((await get(`/api/mail/threads/${deletedThread}/messages?accountId=${accountA}`)).statusCode, 404);
  const page1 = await get(`/api/mail/threads/${threadA}/messages?accountId=${accountA}&limit=1`);
  assert.equal(page1.statusCode, 200, page1.body);
  assert.equal(page1.json().messages.length, 1);
  const cursor = page1.json().nextCursor;
  assert.ok(cursor);
  const page2 = await get(`/api/mail/threads/${threadA}/messages?accountId=${accountA}&limit=1&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(page2.statusCode, 200, page2.body);
  assert.notEqual(page1.json().messages[0].id, page2.json().messages[0].id);
  assert.equal((await get(`/api/mail/threads/${threadA}/messages?accountId=${accountA}&orbitId=${orbitB}&cursor=${encodeURIComponent(cursor)}`)).statusCode, 400);
  const largestSupportedText = 'x'.repeat(4_194_304);
  await db.update(items).set({ bodyText: largestSupportedText }).where(eq(items.id, secondItem));
  const fullBody = await get(`/api/mail/items/${secondItem}/body?accountId=${accountA}`);
  assert.equal(fullBody.statusCode, 200, fullBody.body.slice(0, 200));
  assert.equal(fullBody.json().text.length, largestSupportedText.length);
  await db.update(items).set({ bodyText: 'Second' }).where(eq(items.id, secondItem));
  assert.equal((await get(`/api/mail/items/${firstItem}/body?accountId=${accountA}`)).json().text, 'Hello from a@example.com');
  const htmlKey = await blobs.write(Buffer.from('<p>Hello</p><img data-station-image-ref="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">'));
  await db.insert(blobIntents).values({ key: htmlKey, accountId: accountA, stateId: state, pageId: 'fixture', leaseGeneration: 0,
    credentialGeneration: 0, expectedSequence: 0, state: 'referenced' });
  await db.update(items).set({ bodyHtmlPath: htmlKey, htmlPolicyVersion: 1,
    imageMetadata: [{ refId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'remote', source: 'https://remote.example.com/image' }] }).where(eq(items.id, firstItem));
  const body = await get(`/api/mail/items/${firstItem}/body?accountId=${accountA}`);
  assert.equal(body.statusCode, 200, body.body);
  assert.deepEqual(body.json().imageRefs, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  assert.ok(!body.body.includes('https://remote.example.com/image'));
  csrf = (await get('/api/auth/status')).json().csrfToken;
  const imageBase = `/api/mail/items/${firstItem}/images`;
  const imageRequest = { accountId: accountA, refId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const refContract = (await get(`${imageBase}/consent?accountId=${accountA}`)).json();
  assert.equal(refContract.messageEnabled, false);
  assert.deepEqual(refContract.refs, [{ refId: imageRequest.refId, kind: 'remote' }],
    'The authenticated consent response proves ref kind without exposing its source URL');
  assert.ok(!JSON.stringify(refContract).includes('remote.example.com'));
  assert.equal((await post(`${imageBase}/fetch`, imageRequest, csrf)).statusCode, 403, 'Remote images are blocked by default');
  assert.equal((await post(`${imageBase}/consent`, { accountId: accountB, enabled: true }, csrf)).statusCode, 404);
  assert.equal((await post(`${imageBase}/consent`, { accountId: accountA, orbitId: orbitB, enabled: true }, csrf)).statusCode, 404);
  assert.equal((await post(`/api/mail/items/${tombstone}/images/consent`, { accountId: accountA, enabled: true }, csrf)).statusCode, 404);
  assert.equal((await post(`${imageBase}/consent`, { accountId: accountA, enabled: true }, 'bad-token')).statusCode, 403);
  const wrongOrigin = await app.inject({ method: 'POST', url: `${imageBase}/fetch`, payload: imageRequest,
    headers: { origin: 'https://other.example.com', 'x-csrf-token': csrf, cookie } });
  assert.equal(wrongOrigin.statusCode, 403);
  assert.equal((await post(`${imageBase}/consent`, { accountId: accountA, enabled: true }, csrf)).statusCode, 200);
  assert.equal((await get(`${imageBase}/consent?accountId=${accountA}`)).json().messageEnabled, true);
  await db.update(items).set({ providerRevision: 'new-message-revision' }).where(eq(items.id, firstItem));
  assert.equal((await get(`${imageBase}/consent?accountId=${accountA}`)).json().messageEnabled, false,
    'A changed provider revision invalidates one-message consent');
  assert.equal((await post(`${imageBase}/consent`, { accountId: accountA, enabled: true }, csrf)).statusCode, 200);
  assert.equal((await post(`${imageBase}/fetch`, { ...imageRequest, refId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, csrf)).statusCode, 404);
  assert.equal((await post(`${imageBase}/fetch`, { ...imageRequest, accountId: accountB }, csrf)).statusCode, 404);
  assert.equal((await post(`${imageBase}/fetch`, { ...imageRequest, orbitId: orbitB }, csrf)).statusCode, 404);
  assert.equal((await post(`${imageBase}/sender-preference`, { accountId: accountA, enabled: true }, csrf)).statusCode, 409,
    'A message without a single claimed From identity cannot create a sender preference');
  const personA = id();
  const personB = id();
  await db.insert(people).values({ id: personA, accountId: accountA, displayName: 'Example sender' });
  await db.insert(people).values({ id: personB, accountId: accountB, displayName: 'Example sender' });
  await db.insert(identities).values([
    { id: id(), accountId: accountA, personId: personA, provider: 'google', kind: 'email', normalizedValue: 'sender@example.com' },
    { id: id(), accountId: accountB, personId: personB, provider: 'google', kind: 'email', normalizedValue: 'sender@example.com' },
  ]);
  await db.update(items).set({ fromPersonId: personA, senderIdentitiesComplete: true }).where(eq(items.id, firstItem));
  const stateB = id();
  await db.insert(syncStates).values({ id: stateB, accountId: accountB, resource: 'mail', collectionId: 'primary', cursor: {} });
  const otherHtmlKey = await blobs.write(Buffer.from('<span data-station-image-ref="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">[Image blocked]</span>'));
  await db.insert(blobIntents).values({ key: otherHtmlKey, accountId: accountB, stateId: stateB, pageId: 'sender-fixture',
    leaseGeneration: 0, credentialGeneration: 0, expectedSequence: 0, state: 'referenced' });
  const senderSource = process.env.CAMO_FIXTURE_URL ?? 'http://127.0.0.1/private';
  await db.update(items).set({ imageMetadata: [{ refId: imageRequest.refId, kind: 'remote', source: senderSource }] }).where(eq(items.id, firstItem));
  await db.update(items).set({ fromPersonId: personB, senderIdentitiesComplete: true, bodyHtmlPath: otherHtmlKey,
    htmlPolicyVersion: 1, imageMetadata: [{ refId: imageRequest.refId, kind: 'remote', source: senderSource }] }).where(eq(items.id, otherItem));
  assert.equal((await post(`${imageBase}/consent`, { accountId: accountA, enabled: false }, csrf)).statusCode, 200);
  assert.equal((await post(`${imageBase}/sender-preference`, { accountId: accountA, enabled: true }, csrf)).statusCode, 200);
  assert.equal((await get(`${imageBase}/consent?accountId=${accountA}`)).json().senderEnabled, true);
  const blockedOverride = (await get(`${imageBase}/consent?accountId=${accountA}`)).json();
  assert.equal(blockedOverride.messageChoice, false);
  assert.equal(blockedOverride.effectiveRemoteEnabled, false);
  assert.equal((await post(`${imageBase}/fetch`, imageRequest, csrf)).statusCode, 403,
    'Explicit message block overrides the claimed sender preference');
  assert.equal((await get(`/api/mail/items/${otherItem}/images/consent?accountId=${accountB}`)).json().senderEnabled, false);
  await db.update(items).set({ fromPersonId: personA, senderIdentitiesComplete: true, bodyHtmlPath: htmlKey,
    htmlPolicyVersion: 1, imageMetadata: [{ refId: imageRequest.refId, kind: 'remote', source: senderSource }] }).where(eq(items.id, secondItem));
  assert.equal((await get(`/api/mail/items/${secondItem}/images/consent?accountId=${accountA}`)).json().effectiveRemoteEnabled, true,
    'A block on the first message does not suppress another message from the same claimed sender');
  await db.update(items).set({ providerRevision: 'new-image-source-revision' }).where(eq(items.id, firstItem));
  assert.equal((await get(`${imageBase}/consent?accountId=${accountA}`)).json().effectiveRemoteEnabled, true,
    'A stale message override no longer blocks the sender preference after a source change');
  const senderFetchA = await post(`${imageBase}/fetch`, imageRequest, csrf);
  assert.equal(senderFetchA.statusCode, process.env.CAMO_FIXTURE_URL ? 200 : 503,
    'A preference authorizes a fetch independently of item consent');
  assert.equal((await post(`/api/mail/items/${otherItem}/images/fetch`, { accountId: accountB, refId: imageRequest.refId }, csrf)).statusCode, 403,
    'An identical claimed sender in another account remains blocked');
  assert.equal((await post(`${imageBase}/sender-preference`, { accountId: accountA, enabled: false }, csrf)).statusCode, 200);
  assert.equal((await post(`${imageBase}/fetch`, imageRequest, csrf)).statusCode, 403,
    'Revoking the sender preference blocks the original account again');
  await db.update(items).set({ imageMetadata: [{ refId: imageRequest.refId, kind: 'remote', source: 'https://remote.example.com/image' }] }).where(eq(items.id, firstItem));
  const probeHostileImage = async (source) => {
    const hostileItem = id();
    await db.insert(items).values({ id: hostileItem, accountId: accountA, collectionId: 'primary', threadId: threadA,
      externalId: `hostile-${hostileItem}`, appliedSequence: 1, direction: 'in', directionProvenance: 'incoming',
      flags: {}, parseStatus: 'supported', bodyHtmlPath: htmlKey, htmlPolicyVersion: 1,
      imageMetadata: [{ refId: imageRequest.refId, kind: 'remote', source }] });
    await db.insert(itemOrbits).values({ itemId: hostileItem, orbitId: orbitA, reason: 'account' });
    const endpoint = `/api/mail/items/${hostileItem}/images`;
    try {
      assert.equal((await post(`${endpoint}/consent`, { accountId: accountA, enabled: true }, csrf)).statusCode, 200);
      return await post(`${endpoint}/fetch`, imageRequest, csrf);
    } finally {
      await db.update(items).set({ deletedAt: new Date(), parseStatus: 'deleted' }).where(eq(items.id, hostileItem));
    }
  };
  await db.update(items).set({ imageMetadata: [{ refId: imageRequest.refId, kind: 'remote', source: 'http://127.0.0.1/private' }] }).where(eq(items.id, firstItem));
  assert.equal((await get(`${imageBase}/consent?accountId=${accountA}`)).json().messageEnabled, false, 'Updated source revokes item consent');
  assert.equal((await post(`${imageBase}/fetch`, imageRequest, csrf)).statusCode, 403);
  assert.equal((await probeHostileImage('http://127.0.0.1/private')).statusCode, 503, 'Private IPs are not signed');
  assert.equal((await probeHostileImage('https://remote.example.com:8443/image')).statusCode, 503, 'Nonstandard ports are not signed');
  await db.update(items).set({ imageMetadata: [{ refId: imageRequest.refId, kind: 'remote', source: 'https://remote.example.com/image' }] }).where(eq(items.id, firstItem));
  if (process.env.CAMO_FIXTURE_URL) {
    await db.update(items).set({ imageMetadata: [{ refId: imageRequest.refId, kind: 'remote', source: process.env.CAMO_FIXTURE_URL }] }).where(eq(items.id, firstItem));
    assert.equal((await post(`${imageBase}/fetch`, imageRequest, csrf)).statusCode, 403, 'Changing image source requires fresh consent');
    assert.equal((await post(`${imageBase}/consent`, { accountId: accountA, enabled: true }, csrf)).statusCode, 200);
    const proxied = await post(`${imageBase}/fetch`, imageRequest, csrf);
    assert.equal(proxied.statusCode, 200, proxied.body.slice(0, 200));
    assert.equal(proxied.headers['content-type'], 'image/png');
    assert.equal(proxied.headers['x-content-type-options'], 'nosniff');
    assert.equal(proxied.headers['cache-control'], 'private, no-store');
    assert.equal(proxied.rawPayload.subarray(1, 4).toString('ascii'), 'PNG');
    await db.update(items).set({ imageMetadata: [{ refId: imageRequest.refId, kind: 'remote',
      source: new URL('/avif', process.env.CAMO_FIXTURE_URL).href }] }).where(eq(items.id, firstItem));
    assert.equal((await post(`${imageBase}/consent`, { accountId: accountA, enabled: true }, csrf)).statusCode, 200);
    const avif = await post(`${imageBase}/fetch`, imageRequest, csrf);
    assert.equal(avif.statusCode, 200, avif.body.slice(0, 120));
    assert.equal(avif.headers['content-type'], 'image/png');
    assert.equal((await post(`${imageBase}/consent`, { accountId: accountA, enabled: false }, csrf)).statusCode, 200);
    assert.equal((await post(`${imageBase}/fetch`, imageRequest, csrf)).statusCode, 403, 'Revocation applies before another fetch');
    for (const path of ['/bad', '/bomb', '/large', '/slow']) {
      const failed = await probeHostileImage(new URL(path, process.env.CAMO_FIXTURE_URL).href);
      assert.equal(failed.statusCode, 503, `${path}: ${failed.body.slice(0, 120)}`);
      assert.ok(!failed.body.includes('raster.example.com'));
    }
    await db.update(items).set({ imageMetadata: [{ refId: imageRequest.refId, kind: 'remote', source: 'https://remote.example.com/image' }] }).where(eq(items.id, firstItem));
  }
  const blockedImageRequest = async (holdLock, requestAction) => {
    let release;
    let enteredResolve;
    let enteredReject;
    const entered = new Promise((resolve, reject) => { enteredResolve = resolve; enteredReject = reject; });
    const holder = other.db.transaction(async (tx) => {
      await holdLock(tx);
      enteredResolve();
      await new Promise((resolve) => { release = resolve; });
    });
    void holder.catch(enteredReject);
    await entered;
    try {
      const response = await Promise.race([
        requestAction(),
        delay(2_500).then(() => { throw new Error('Image database request outlived its lock deadline'); }),
      ]);
      assert.equal(response.statusCode, 500, response.body);
      const activity = await db.execute(sql`select
        count(*) filter (where wait_event_type = 'Lock')::integer waiting,
        count(*) filter (where state = 'idle in transaction')::integer open_transactions
        from pg_stat_activity where datname = current_database()`);
      assert.equal(activity.rows[0].waiting, 0, 'Timed-out image request released its database client');
      assert.equal(activity.rows[0].open_transactions, 1, 'Only the deliberate lock holder retains a transaction');
    } finally { release(); await holder; }
  };
  await blockedImageRequest((tx) => tx.execute(sql`lock table items in access exclusive mode`),
    () => get(`${imageBase}/consent?accountId=${accountA}`));
  await blockedImageRequest((tx) => tx.select().from(mailImageConsent).where(eq(mailImageConsent.itemId, firstItem)).for('update'),
    () => post(`${imageBase}/consent`, { accountId: accountA, enabled: false }, csrf));
  const cidRef = 'cccccccccccccccccccccccccccccccc';
  const cidHtml = await blobs.write(Buffer.from(`<span data-station-image-ref="${cidRef}">[Image blocked]</span>`));
  const cidPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgZGL+DwABFAEG9O6t0QAAAABJRU5ErkJggg==', 'base64');
  const cidKey = await blobs.write(cidPng);
  await db.insert(blobIntents).values([cidHtml, cidKey].map((storageKey) => ({ key: storageKey, accountId: accountA,
    stateId: state, pageId: 'cid-fixture', leaseGeneration: 0, credentialGeneration: 0, expectedSequence: 0, state: 'referenced' })));
  await db.update(items).set({ bodyHtmlPath: cidHtml, htmlPolicyVersion: 1,
    imageMetadata: [{ refId: cidRef, kind: 'cid', source: 'inline@example.com' }] }).where(eq(items.id, secondItem));
  const cidAttachment = id();
  await db.insert(attachments).values({ id: cidAttachment, itemId: secondItem, accountId: accountA, ordinal: 0,
    filename: 'inline.png', mimeType: 'image/png', contentId: '<inline@example.com>', related: true,
    size: cidPng.length, storagePath: cidKey });
  const cidFetch = { accountId: accountA, refId: cidRef };
  const cidEndpoint = `/api/mail/items/${secondItem}/images/fetch`;
  const inline = await post(cidEndpoint, cidFetch, csrf);
  assert.equal(inline.statusCode, 200, inline.body.slice(0, 120));
  assert.equal(inline.headers['content-type'], 'image/png');
  assert.equal((await post(cidEndpoint, { ...cidFetch, accountId: accountB }, csrf)).statusCode, 404);
  await db.update(attachments).set({ contentId: '<different@example.com>' }).where(eq(attachments.id, cidAttachment));
  assert.equal((await post(cidEndpoint, cidFetch, csrf)).statusCode, 404, 'CID must match a related same-item attachment');
  await db.update(attachments).set({ contentId: '<inline@example.com>' }).where(eq(attachments.id, cidAttachment));
  await db.update(items).set({ htmlPolicyVersion: 2 }).where(eq(items.id, firstItem));
  assert.equal((await get(`/api/mail/items/${firstItem}/body?accountId=${accountA}`)).json().status, 'unavailable');
  await db.update(items).set({ htmlPolicyVersion: 1 }).where(eq(items.id, firstItem));
  await blobs.delete(htmlKey);
  assert.equal((await get(`/api/mail/items/${firstItem}/body?accountId=${accountA}`)).json().status, 'unavailable');
  await symlink('/etc/passwd', path.join(root, htmlKey));
  assert.equal((await get(`/api/mail/items/${firstItem}/body?accountId=${accountA}`)).json().status, 'unavailable');
  assert.equal((await get(`/api/mail/items/${otherItem}/body?accountId=${accountA}`)).statusCode, 404);
  assert.equal((await get(`/api/mail/items/${tombstone}/body?accountId=${accountA}`)).statusCode, 404);
  const key = await blobs.write(Buffer.from('fixture attachment'));
  await db.insert(blobIntents).values({ key, accountId: accountA, stateId: state, pageId: 'fixture', leaseGeneration: 0,
    credentialGeneration: 0, expectedSequence: 0, state: 'referenced' });
  const attachmentId = id();
  await db.insert(attachments).values({ id: attachmentId, itemId: firstItem, accountId: accountA, ordinal: 0,
    filename: '../../evil\r\nX-Custom: yes.html', mimeType: 'text/html', size: 18, storagePath: key });
  const download = await get(`/api/mail/items/${firstItem}/attachments/${attachmentId}/download?accountId=${accountA}`);
  assert.equal(download.statusCode, 200, download.body);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.match(download.headers['content-disposition'], /^attachment; filename=/);
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.ok(!download.headers['content-disposition'].includes('\r'));
  await db.update(attachments).set({ filename: `${'a'.repeat(179)}😀.txt` }).where(eq(attachments.id, attachmentId));
  const unicode = await get(`/api/mail/items/${firstItem}/attachments/${attachmentId}/download?accountId=${accountA}`);
  assert.equal(unicode.statusCode, 200, unicode.body);
  assert.match(unicode.headers['content-disposition'], /%F0%9F%98%80/);
  await db.update(attachments).set({ filename: 'broken\ud800.txt' }).where(eq(attachments.id, attachmentId));
  const malformed = await get(`/api/mail/items/${firstItem}/attachments/${attachmentId}/download?accountId=${accountA}`);
  assert.equal(malformed.statusCode, 200, malformed.body);
  assert.match(malformed.headers['content-disposition'], /%EF%BF%BD/);
  assert.equal((await get(`/api/mail/items/${firstItem}/attachments/${attachmentId}/download?accountId=${accountB}`)).statusCode, 404);
  await blobs.delete(key);
  assert.equal((await get(`/api/mail/items/${firstItem}/attachments/${attachmentId}/download?accountId=${accountA}`)).statusCode, 503);
  await symlink('/etc/passwd', path.join(root, key));
  assert.equal((await get(`/api/mail/items/${firstItem}/attachments/${attachmentId}/download?accountId=${accountA}`)).statusCode, 503);
  const combined = [list.body, page1.body, download.headers['content-disposition']].join(' ');
  for (const secretValue of ['private-secret', 'private-refresh-a', 'private-access-a', root, key, 'https://remote.example.com/image'])
    assert.ok(!combined.includes(secretValue), secretValue);
  const whileItemsLocked = async (requestUrl) => {
    let unlock;
    let enteredResolve;
    let enteredReject;
    const entered = new Promise((resolve, reject) => { enteredResolve = resolve; enteredReject = reject; });
    const holder = other.db.transaction(async (tx) => {
      await tx.execute(sql`lock table items in access exclusive mode`);
      enteredResolve();
      await new Promise((resolve) => { unlock = resolve; });
    });
    void holder.catch(enteredReject);
    await entered;
    try {
      const start = Date.now();
      const response = await Promise.race([
        get(requestUrl),
        delay(2_500).then(() => { throw new Error('Reader query waited beyond its lock deadline'); }),
      ]);
      assert.equal(response.statusCode, 500, response.body);
      assert.ok(Date.now() - start < 2_500);
      const activity = await db.execute(sql`select
        count(*) filter (where wait_event_type = 'Lock' and query ilike '%items%')::integer waiting,
        count(*) filter (where state = 'idle in transaction')::integer open_transactions
        from pg_stat_activity where datname = current_database()`);
      assert.equal(activity.rows[0].waiting, 0);
      assert.equal(activity.rows[0].open_transactions, 1, 'Only the deliberate lock holder keeps a transaction open');
    } finally { unlock(); await holder; }
  };
  await whileItemsLocked(`/api/mail/threads/${threadA}/messages?accountId=${accountA}`);
  assert.equal((await get(`/api/mail/threads/${threadA}/messages?accountId=${accountA}`)).statusCode, 200);
  await whileItemsLocked(`/api/mail/labels?orbitId=${orbitA}`);
  assert.equal((await get(`/api/mail/labels?orbitId=${orbitA}`)).statusCode, 200);
  await db.update(items).set({ deletedAt: new Date(), parseStatus: 'deleted' }).where(eq(items.id, firstItem));
  assert.equal((await get(`/api/mail/items/${firstItem}/body?accountId=${accountA}`)).statusCode, 404);
  assert.equal((await get(`/api/mail/items/${firstItem}/attachments/${attachmentId}/download?accountId=${accountA}`)).statusCode, 404);
  assert.equal((await get(url('&labelId=' + label))).json().conversations.length, 0);
  await db.update(items).set({ deletedAt: new Date(), parseStatus: 'deleted' }).where(eq(items.id, secondItem));
  await db.update(items).set({ deletedAt: new Date(), parseStatus: 'deleted' }).where(sql`${items.id} in (${tiedItems[0]}, ${tiedItems[1]}, ${tiedItems[2]})`);
  assert.equal((await get(url())).json().conversations.length, 0);
  assert.equal((await get(`/api/mail/threads/${threadA}/messages?accountId=${accountA}`)).statusCode, 404);
  assert.equal((await get(url(), { origin: 'https://other.example.com' })).statusCode, 403);
  const [liveSession] = await db.select().from(sessions).where(isNull(sessions.revokedAt)).limit(1);
  await db.update(sessions).set({ data: { ...liveSession.data, recoveryMode: 'totp' } }).where(eq(sessions.tokenHash, liveSession.tokenHash));
  assert.equal((await get(url())).statusCode, 401);
  await db.update(sessions).set({ data: liveSession.data, revokedAt: new Date() }).where(eq(sessions.tokenHash, liveSession.tokenHash));
  assert.equal((await get(url())).statusCode, 401);
  output.log('Mail reader database and HTTP fixture passed.');
} finally {
  await app.close();
  await other.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
}
