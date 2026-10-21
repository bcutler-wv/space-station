import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { eq } from 'drizzle-orm';
import { sanitizeMailHtml } from '../../apps/worker/dist/mail-html-sanitize.js';
import { databaseUrl, loadRuntimeConfig, openDatabase, PrivateBlobStore, applyMailPage, collectOrphanBlobs, readSyncEvents,
  evaluateStoredMailPrivacy, MailPageFenceError, accounts, attachments,
  itemRecipients, itemLabels, items, identities, blobIntents, syncPages, labels, oauthApps, orbits, settings, syncStates, users, exclusionRules } from '../../packages/db/dist/index.js';

const dbHandle = openDatabase(databaseUrl(loadRuntimeConfig(process.env)));
const db = dbHandle.db;
const blobRoot = process.env.STATION_TEST_BLOB_ROOT ?? '/var/lib/station/blobs';
const store = new PrivateBlobStore(blobRoot);
const origin = 'https://example.com';
const scope = 'https://www.googleapis.com/auth/gmail.modify';
const ownerId = randomUUID();
const orbitId = randomUUID();
const secondOrbitId = randomUUID();
const accountsByName = {};
const statesByName = {};
const allow = { index: 'allow', ai: 'allow' };
const fake = (name) => `${name}@example.com`;
const isForeignKeyViolation = (error) => error?.cause?.code === '23503';
async function awaitBarrier(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000); })]); }
  finally { clearTimeout(timer); }
}
async function createAccount(name) {
  const appId = randomUUID(); const accountId = randomUUID(); const stateId = randomUUID();
  await db.insert(oauthApps).values({ id: appId, provider: 'google', ownerId, clientId: `${name}-client`, encryptedClientSecret: 'fixture-ciphertext', redirectUri: `${origin}/callback` });
  await db.insert(accounts).values({ id: accountId, provider: 'google', appId, orbitId, email: fake(name), encryptedRefreshToken: 'fixture-ciphertext', encryptedAccessToken: 'fixture-ciphertext', grantedScopes: [scope], backfill: 'all', credentialGeneration: 1 });
  await db.insert(syncStates).values({ id: stateId, accountId, resource: 'mail', collectionId: 'primary', generation: 1, leaseUntil: new Date(Date.now() + 600_000), status: 'running' });
  accountsByName[name] = accountId; statesByName[name] = stateId;
}
function parsed(from = fake('sender'), opts = {}) {
  return { ok: true, mail: { subject: 'Fixture subject', messageId: '<fixture@example.com>', inReplyTo: null, references: null,
    date: 'Tue, 20 Oct 2026 12:00:00 GMT', from: { name: 'Sender', address: from },
    senderIdentities: opts.senders ?? [{ name: 'Other', address: fake('blocked') }], senderHeaderFieldCount: 1,
    replyTo: [], replyToHeaderFieldCount: 0, to: [{ name: 'Owner', address: fake('one') }], cc: [], bcc: [],
    text: 'fixture body', sanitizedHtml: opts.html ? { policyVersion: 1, html: '<p>fixture</p>', images: [] } : null,
    attachments: opts.attachment ? [{ filename: '../evil\\name\u0000.txt', mimeType: 'application/octet-stream', disposition: 'inline', contentId: '<cid@example.com>', related: true, contentBase64: Buffer.from('fixture bytes').toString('base64') }] : [] } };
}
function page(name, sequence, changes, suffix = String(sequence)) {
  return { accountId: accountsByName[name], stateId: statesByName[name], collectionId: 'primary', pageId: `${name}-${suffix}`,
    configuredOrigin: origin, expectedLeaseGeneration: 1, expectedCredentialGeneration: 1, expectedSequence: sequence,
    cursorAfter: { historyId: String(sequence + 1) }, changes };
}
function change(id, options = {}) {
  return { externalId: id, threadExternalId: options.thread ?? 'thread-1', providerRevision: options.revision ?? '900719925474099312345',
    internalAt: new Date('2026-10-20T12:00:00Z'), receivedAt: new Date('2026-10-20T12:01:00Z'), snippet: 'safe snippet', flags: { read: false },
    labelRefs: options.labels ?? [{ ref: 'INBOX', name: 'Inbox' }], providerSent: options.providerSent ?? false,
    deleted: options.deleted ?? false, parsed: options.deleted ? null : options.parsed ?? parsed(), routedOrbitIds: options.orbits ?? [] };
}
async function item(name, id) { return (await db.select().from(items).where(eq(items.accountId, accountsByName[name]))).find((row) => row.externalId === id); }
try {
  await db.insert(users).values({ id: ownerId, displayName: 'Fixture owner' });
  await db.insert(orbits).values([{ id: orbitId, name: 'Work', slug: 'fixture-work', colorSlot: 1, context: '', privacyDefaults: allow },
    { id: secondOrbitId, name: 'Restricted', slug: 'fixture-restricted', colorSlot: 2, context: '', privacyDefaults: { index: 'exclude', ai: 'allow' } }]);
  await db.insert(settings).values({ key: 'first_orbit_setup_v1', value: { version: 1, orbitId, globalDefaults: allow, confirmedOrigin: origin } });
  await createAccount('one'); await createAccount('two');
  const first = page('one', 0, [change('same', { parsed: parsed(fake('one'), { html: true, attachment: true }), providerSent: true,
    labels: [{ ref: 'SENT', name: 'Sent' }], orbits: [secondOrbitId] })]);
  assert.equal(await applyMailPage(db, store, first), 'applied');
  const firstEvent = await readSyncEvents(db, 0);
  assert.deepEqual(firstEvent.rows.map(({ kind, accountId }) => [kind, accountId]), [['mail-changed', accountsByName.one]]);
  assert.equal((await item('one', 'same')).direction, 'out');
  assert.equal((await item('one', 'same')).directionProvenance, 'provider_sent_account');
  assert.equal((await item('one', 'same')).providerRevision, '900719925474099312345');
  assert.equal((await item('one', 'same')).messageId, '<fixture@example.com>');
  assert.equal((await item('one', 'same')).inReplyTo, null);
  assert.equal((await item('one', 'same')).referencesHeader, null);
  assert.equal((await db.select().from(attachments))[0].filename, '.._evil_name_.txt');
  assert.equal((await db.select().from(attachments))[0].contentId, '<cid@example.com>');
  assert.equal((await db.select().from(attachments))[0].disposition, 'inline');
  assert.equal((await db.select().from(attachments))[0].related, true);
  assert.equal((await store.read((await db.select().from(attachments))[0].storagePath)).toString(), 'fixture bytes');
  assert.equal((await evaluateStoredMailPrivacy(db, (await item('one', 'same')).id)).canIndex, false);
  assert.equal(await applyMailPage(db, store, first), 'replayed');
  const changedHeader = { ...first, changes: first.changes.map((entry) => ({ ...entry,
    parsed: { ...entry.parsed, mail: { ...entry.parsed.mail, messageId: '<changed@example.com>' } } })) };
  await assert.rejects(() => applyMailPage(db, store, changedHeader), /changed content or sequence/);
  assert.equal((await readSyncEvents(db, 0)).head, firstEvent.head, 'page replay emits no duplicate event');
  await assert.rejects(applyMailPage(db, store, { ...first, cursorAfter: { historyId: 'different' } }), /changed content/);
  assert.equal((await db.select().from(items)).length, 1);
  assert.equal((await db.select().from(attachments)).length, 1);
  assert.equal((await db.select().from(itemRecipients)).length, 3);
  const ambiguous = parsed(fake('sender'), { senders: [
    { name: 'Valid', address: fake('sender') }, { name: 'Broken', address: 'bad@@' },
  ] });
  ambiguous.mail.replyTo = [{ name: 'Valid', address: fake('reply') }, { name: 'Broken', address: 'bad@@' }];
  await applyMailPage(db, store, page('two', 0, [change('same', { parsed: ambiguous })]));
  assert.equal((await db.select().from(items)).length, 2);
  assert.notEqual((await item('one', 'same')).id, (await item('two', 'same')).id);
  assert.equal((await item('two', 'same')).senderIdentitiesComplete, false);
  assert.equal((await item('two', 'same')).senderHeaderCount, 2);
  assert.equal((await item('two', 'same')).replyToIdentitiesComplete, false);
  assert.equal((await item('two', 'same')).replyToHeaderCount, 2);
  const [oneLabel] = await db.select().from(labels).where(eq(labels.accountId, accountsByName.one));
  await assert.rejects(db.insert(itemLabels).values({ itemId: (await item('two', 'same')).id, accountId: accountsByName.two, labelId: oneLabel.id, source: 'provider' }), isForeignKeyViolation);
  const [oneIdentity] = await db.select().from(identities).where(eq(identities.accountId, accountsByName.one));
  await assert.rejects(db.insert(itemRecipients).values({ itemId: (await item('two', 'same')).id, accountId: accountsByName.two, identityId: oneIdentity.id, role: 'to' }), isForeignKeyViolation);
  await db.insert(exclusionRules).values({ id: randomUUID(), orbitId: null, kind: 'label', value: 'inbox', effect: 'no_index' });
  assert.equal((await evaluateStoredMailPrivacy(db, (await item('two', 'same')).id)).canIndex, false);
  await applyMailPage(db, store, page('two', 1, [change('same', { parsed: parsed(fake('sender'), { senders: [{ name: 'Sender', address: fake('sender') }] }), labels: [{ ref: 'INBOX', name: 'Inbox' }] })]));
  assert.equal((await evaluateStoredMailPrivacy(db, (await item('two', 'same')).id)).canUseAi, true);
  await applyMailPage(db, store, page('two', 2, [change('same', { parsed: parsed(fake('sender'), { senders: [{ name: 'Sender', address: fake('sender') }] }), labels: [{ ref: 'INBOX', name: null }] })]));
  assert.equal((await evaluateStoredMailPrivacy(db, (await item('two', 'same')).id)).canUseAi, false);
  await db.insert(exclusionRules).values({ id: randomUUID(), orbitId: null, kind: 'sender', value: fake('blocked'), effect: 'no_ai' });
  assert.equal((await evaluateStoredMailPrivacy(db, (await item('one', 'same')).id)).canUseAi, false);
  const beforeRollbackEvent = (await readSyncEvents(db, null)).head;
  await assert.rejects(applyMailPage(db, store, page('one', 1, [change('rollback', { orbits: [randomUUID()], parsed: parsed(fake('sender'), { html: true }) })])), isForeignKeyViolation);
  assert.equal((await readSyncEvents(db, null)).head, beforeRollbackEvent, 'failed page emits no event');
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.id, statesByName.one)))[0].sequence, 1);
  assert.deepEqual((await db.select().from(syncStates).where(eq(syncStates.id, statesByName.one)))[0].cursor, { historyId: '1' });
  assert.equal(await item('one', 'rollback'), undefined);
  await db.update(syncStates).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(syncStates.id, statesByName.one));
  await assert.rejects(applyMailPage(db, store, page('one', 1, [change('expired')])), MailPageFenceError);
  assert.equal(await collectOrphanBlobs(db, store, 0), 1);
  await db.update(syncStates).set({ leaseUntil: new Date(Date.now() + 60_000), generation: 2 }).where(eq(syncStates.id, statesByName.one));
  await assert.rejects(applyMailPage(db, store, page('one', 1, [change('stale')])), MailPageFenceError);
  await db.update(syncStates).set({ generation: 1 }).where(eq(syncStates.id, statesByName.one));
  await db.update(accounts).set({ credentialGeneration: 2 }).where(eq(accounts.id, accountsByName.one));
  await assert.rejects(applyMailPage(db, store, page('one', 1, [change('reconnected')])), MailPageFenceError);
  await db.update(accounts).set({ credentialGeneration: 1, revokedAt: new Date() }).where(eq(accounts.id, accountsByName.one));
  await assert.rejects(applyMailPage(db, store, page('one', 1, [change('revoked')])), MailPageFenceError);
  await db.update(accounts).set({ revokedAt: null }).where(eq(accounts.id, accountsByName.one));
  await applyMailPage(db, store, page('one', 1, [change('same', { deleted: true })]));
  assert.ok((await item('one', 'same')).deletedAt);
  assert.equal((await db.select().from(attachments)).length, 0);
  assert.equal((await evaluateStoredMailPrivacy(db, (await item('one', 'same')).id)).canUseAi, false);
  assert.equal(await collectOrphanBlobs(db, store, 0), 2);
  await applyMailPage(db, store, page('one', 2, [change('unsupported', { parsed: { ok: false, code: 'limit_exceeded' }, labels: [{ ref: 'UNKNOWN', name: null }] })]));
  assert.equal((await item('one', 'unsupported')).parseStatus, 'unsupported');
  assert.equal((await item('one', 'unsupported')).bodyHtmlPath, null);
  assert.equal((await evaluateStoredMailPrivacy(db, (await item('one', 'unsupported')).id)).canIndex, false);
  await assert.rejects(applyMailPage(db, store, page('one', 3, [change('outage', { parsed: { ok: false, code: 'timeout' } })])), /Transient parser failure/);
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.id, statesByName.one)))[0].sequence, 3);
  await applyMailPage(db, store, page('one', 3, [{ ...change('unknown-deleted', { deleted: true }), threadExternalId: null }]));
  assert.equal((await item('one', 'unknown-deleted')).parseStatus, 'deleted');
  await applyMailPage(db, store, page('one', 4, [change('spoofed', { parsed: parsed(fake('one')), providerSent: true })]));
  assert.equal((await item('one', 'spoofed')).direction, 'in');

  let entered = 0; let signalEntered; let release;
  const bothEntered = new Promise((resolve) => { signalEntered = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  class PausedStore extends PrivateBlobStore {
    async writeReserved(key, bytes, signal) {
      if (++entered === 2) signalEntered();
      await released;
      return super.writeReserved(key, bytes, signal);
    }
  }
  const duplicatePage = page('one', 5, [change('concurrent', { parsed: parsed(fake('sender'), { html: true }) })]);
  const paused = new PausedStore(blobRoot);
  const concurrent = [applyMailPage(db, paused, duplicatePage), applyMailPage(db, paused, duplicatePage)];
  try {
    await awaitBarrier(bothEntered, 'Concurrent staging');
    assert.equal(await collectOrphanBlobs(db, store, 0), 0, 'active writer intents must survive cleanup');
  } finally { release(); }
  assert.deepEqual((await Promise.all(concurrent)).sort(), ['applied', 'replayed']);
  assert.equal((await db.select().from(items).where(eq(items.externalId, 'concurrent'))).length, 1);
  assert.equal((await db.select().from(syncPages).where(eq(syncPages.stateId, statesByName.one))).length, 6);
  assert.equal((await db.select().from(blobIntents).where(eq(blobIntents.state, 'pending'))).length, 1);
  assert.equal(await collectOrphanBlobs(db, store, 0), 1, 'losing duplicate publication is reclaimed');
  const surviving = await item('one', 'concurrent');
  assert.equal((await store.read(surviving.bodyHtmlPath)).toString(), '<p>fixture</p>');

  const activeTemp = PrivateBlobStore.generateKey();
  await db.insert(blobIntents).values({ key: activeTemp, accountId: accountsByName.one, stateId: statesByName.one, pageId: 'active-temp',
    leaseGeneration: 1, credentialGeneration: 1, expectedSequence: 6 });
  const activeTempPath = path.join(blobRoot, `.tmp-${activeTemp}`);
  await writeFile(activeTempPath, 'interrupted temporary bytes');
  assert.equal(await readFile(activeTempPath, 'utf8'), 'interrupted temporary bytes');
  assert.equal(await collectOrphanBlobs(db, store, 0), 0, 'active page temporary file is protected');
  assert.equal(await readFile(activeTempPath, 'utf8'), 'interrupted temporary bytes');
  await db.update(syncStates).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(syncStates.id, statesByName.one));
  assert.equal(await collectOrphanBlobs(db, store, 0), 1, 'expired owner temporary file is removed');
  await assert.rejects(readFile(activeTempPath), { code: 'ENOENT' });
  await db.update(syncStates).set({ leaseUntil: new Date(Date.now() + 600_000) }).where(eq(syncStates.id, statesByName.one));
  const crashKey = PrivateBlobStore.generateKey();
  await db.insert(blobIntents).values({ key: crashKey, accountId: accountsByName.one, stateId: statesByName.one, pageId: 'crash-after-publish',
    leaseGeneration: 1, credentialGeneration: 1, expectedSequence: 5 });
  await store.writeReserved(crashKey, Buffer.from('published without page commit'));
  assert.equal((await store.read(crashKey)).toString(), 'published without page commit');
  assert.equal(await collectOrphanBlobs(db, store, 0), 1, 'published orphan is reclaimed after restart');
  await assert.rejects(store.read(crashKey), { code: 'ENOENT' });
  assert.equal((await store.read(surviving.bodyHtmlPath)).toString(), '<p>fixture</p>', 'live publication survives cleanup');

  const imageMarkup = '<img src="https://example.com/photo.png"><img src="cid:cid@example.com">';
  const imageMail = () => { const result = parsed(fake('sender'), { attachment: true }); result.mail.sanitizedHtml = sanitizeMailHtml(imageMarkup); return result; };
  const imageFirst = page('one', 6, [change('image-replay', { parsed: imageMail() })]);
  const imageSecond = page('one', 6, [change('image-replay', { parsed: imageMail() })]);
  imageSecond.changes[0].receivedAt = new Date('2026-10-20T13:00:00Z');
  assert.notEqual(imageFirst.changes[0].parsed.mail.sanitizedHtml.html, imageSecond.changes[0].parsed.mail.sanitizedHtml.html);
  assert.equal(await applyMailPage(db, store, imageFirst), 'applied');
  assert.equal(await applyMailPage(db, store, imageSecond), 'replayed');
  const changedImage = page('one', 6, [change('image-replay', { parsed: imageMail() })]);
  changedImage.changes[0].parsed.mail.sanitizedHtml = sanitizeMailHtml('<img src="https://example.com/other.png"><img src="cid:cid@example.com">');
  await assert.rejects(applyMailPage(db, store, changedImage), /changed content/);
  const changedBytes = page('one', 6, [change('image-replay', { parsed: imageMail() })]);
  changedBytes.changes[0].parsed.mail.attachments[0].contentBase64 = Buffer.from('changed bytes').toString('base64');
  await assert.rejects(applyMailPage(db, store, changedBytes), /changed content/);
  assert.equal((await store.read((await item('one', 'image-replay')).bodyHtmlPath)).toString(), imageFirst.changes[0].parsed.mail.sanitizedHtml.html);

  // A credential replacement during the publication gap must fence the page.
  let stagedResolve; let continueWrite;
  const stagedPromise = new Promise((resolve) => { stagedResolve = resolve; });
  const continuePromise = new Promise((resolve) => { continueWrite = resolve; });
  class OnePauseStore extends PrivateBlobStore {
    async writeReserved(key, bytes, signal) { stagedResolve(); await continuePromise; return super.writeReserved(key, bytes, signal); }
  }
  const fenced = applyMailPage(db, new OnePauseStore(blobRoot), page('one', 7, [change('fenced-stage', { parsed: parsed(fake('sender'), { html: true }) })]));
  await awaitBarrier(stagedPromise, 'Fence staging');
  await db.update(accounts).set({ credentialGeneration: 2 }).where(eq(accounts.id, accountsByName.one));
  assert.equal(await collectOrphanBlobs(db, store, 0), 0, 'collector skips the locked in-flight publication');
  continueWrite();
  await assert.rejects(fenced, MailPageFenceError);
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.id, statesByName.one)))[0].sequence, 7);
  assert.equal(await collectOrphanBlobs(db, store, 0), 1);
  await db.update(accounts).set({ credentialGeneration: 1 }).where(eq(accounts.id, accountsByName.one));

  // Missing setup, origin confirmation, scope and backfill each fail before publication.
  const blockedPage = page('one', 7, [change('blocked-config')]);
  await db.delete(settings).where(eq(settings.key, 'first_orbit_setup_v1'));
  await assert.rejects(applyMailPage(db, store, blockedPage), MailPageFenceError);
  await db.insert(settings).values({ key: 'first_orbit_setup_v1', value: { version: 1, orbitId, globalDefaults: allow, confirmedOrigin: origin } });
  await db.update(settings).set({ value: { version: 1, orbitId, globalDefaults: allow, confirmedOrigin: 'https://other.example.com' } }).where(eq(settings.key, 'first_orbit_setup_v1'));
  await assert.rejects(applyMailPage(db, store, blockedPage), MailPageFenceError);
  await db.update(settings).set({ value: { version: 1, orbitId, globalDefaults: allow, confirmedOrigin: origin } }).where(eq(settings.key, 'first_orbit_setup_v1'));
  await db.update(accounts).set({ grantedScopes: [] }).where(eq(accounts.id, accountsByName.one));
  await assert.rejects(applyMailPage(db, store, blockedPage), MailPageFenceError);
  await db.update(accounts).set({ grantedScopes: [scope], backfill: null }).where(eq(accounts.id, accountsByName.one));
  await assert.rejects(applyMailPage(db, store, blockedPage), MailPageFenceError);
  await db.update(accounts).set({ backfill: 'all' }).where(eq(accounts.id, accountsByName.one));
  await applyMailPage(db, store, page('one', 7, [change('incomplete-sender', { parsed: parsed('invalid-address', { senders: [] }) })]));
  assert.equal((await evaluateStoredMailPrivacy(db, (await item('one', 'incomplete-sender')).id)).canUseAi, false);
  assert.equal((await db.select().from(syncStates).where(eq(syncStates.id, statesByName.one)))[0].sequence, 8);
  console.log('Mail page database gate passed');
} finally {
  await dbHandle.close();
}
