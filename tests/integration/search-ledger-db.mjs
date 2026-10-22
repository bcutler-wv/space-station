import assert from 'node:assert/strict';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { URL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { accounts, identities, itemOrbits, itemRecipients, items, oauthApps, orbits, people,
  searchDocuments, searchEpochs,
  settings, threads, users, bumpSearchAccountEpoch, bumpSearchGlobalEpoch, dirtySearchItems,
  reconcileSearchBatch, readSearchProjection, recordSearchProjectionError,
  databaseUrl, loadRuntimeConfig } from '../../packages/db/dist/index.js';

const socket = process.env.SEARCH_TEST_PG_SOCKET;
const { Pool } = createRequire(new URL('../../packages/db/package.json', import.meta.url))('pg');
const pool = new Pool(socket
  ? { host: socket, port: 55432, user: process.env.USER,
    database: process.env.SEARCH_TEST_PG_DATABASE ?? 'postgres', connectionTimeoutMillis: 3_000 }
  : { connectionString: databaseUrl(loadRuntimeConfig(process.env)), connectionTimeoutMillis: 3_000 });
const db = drizzle(pool);
const id = () => randomUUID();
const origin = 'https://example.com';
const owner = id(), orbit = id(), app = id(), a = id(), b = id(), ta = id(), tb = id();
const ia = id(), ib = id(), missing = id();
const allow = { index: 'allow', ai: 'exclude' };
const forcedFailure = process.env.SEARCH_TEST_FORCE_FAILURE;
const awaitAcquisition = (promise, label) => Promise.race([promise,
  setTimeout(3_000, undefined, { ref: false }).then(() => { throw new Error(`${label} acquisition timed out`); })]);
const row = async (accountId, itemId) => (await db.select().from(searchDocuments)
  .where(and(eq(searchDocuments.accountId, accountId), eq(searchDocuments.itemId, itemId))))[0];
try {
  await db.insert(users).values({ id: owner, displayName: 'Example Owner' });
  await db.insert(orbits).values({ id: orbit, name: 'Example Orbit', slug: 'example-orbit', colorSlot: 1,
    context: '', privacyDefaults: allow });
  await db.insert(settings).values({ key: 'first_orbit_setup_v1',
    value: { version: 1, orbitId: orbit, confirmedOrigin: origin, globalDefaults: allow } });
  await db.insert(oauthApps).values({ id: app, provider: 'google', ownerId: owner,
    clientId: 'example-client', encryptedClientSecret: 'fixture', redirectUri: `${origin}/callback` });
  await db.insert(accounts).values([a, b].map((accountId, n) => ({ id: accountId, provider: 'google', appId: app,
    orbitId: orbit, email: `account${n}@example.com`, encryptedRefreshToken: 'fixture',
    encryptedAccessToken: 'fixture', grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
    backfill: 'all' })));
  await db.insert(threads).values([{ id: ta, accountId: a, collectionId: 'primary', externalId: 'a' },
    { id: tb, accountId: b, collectionId: 'primary', externalId: 'b' }]);
  const source = (itemId, accountId, threadId) => ({ id: itemId, accountId, threadId,
    collectionId: 'primary', externalId: itemId, appliedSequence: 1, direction: 'in',
    directionProvenance: 'incoming', parseStatus: 'supported', observedActionEpoch: 0,
    observedCredentialGeneration: 1, observedAuthorizationGeneration: 1,
    senderIdentitiesComplete: true, flags: { read: false, starred: true }, subject: 'Example subject',
    bodyText: 'Example body' });
  await db.insert(items).values([source(ia, a, ta), source(ib, b, tb)]);
  await db.insert(itemOrbits).values([{ itemId: ia, orbitId: orbit, reason: 'account' },
    { itemId: ib, orbitId: orbit, reason: 'account' }]);
  const person = id(), identity = id();
  await db.insert(people).values({ id: person, accountId: a, displayName: 'Example Hidden' });
  await db.insert(identities).values({ id: identity, accountId: a, personId: person,
    provider: 'google', kind: 'email', normalizedValue: 'hidden@example.com' });
  await db.insert(itemRecipients).values({ itemId: ia, accountId: a, identityId: identity, role: 'bcc' });

  assert.equal((await reconcileSearchBatch(db, 'global', 1)).scanned, 1);
  assert.equal((await reconcileSearchBatch(db, 'global', 1)).scanned, 1);
  assert.equal((await reconcileSearchBatch(db, 'global', 1)).finished, true);
  assert.equal((await reconcileSearchBatch(db, 'global', 1)).scanned, 0);
  assert.equal((await row(a, ia)).desiredRevision, 1);
  assert.equal((await row(b, ib)).desiredRevision, 1);
  const good = await readSearchProjection(db, ia, origin);
  assert.equal(good.status, 'eligible');
  assert.equal(good.fields.kind, 'mail');
  assert.equal(good.fields.unread, true);
  assert.equal(good.fields.starred, true);
  assert.ok(good.fields.searchText.includes('hidden@example.com'), 'BCC recipient is in free text');
  assert.deepEqual(good.fields.toValues, [], 'BCC is not a structured To value');
  assert.equal((await readSearchProjection(db, ia, 'https://other.example.com')).status, 'denied');
  let releasePolicy, announcePolicy, rejectPolicy;
  const policyHeld = new Promise((resolve, reject) => { announcePolicy = resolve; rejectPolicy = reject; });
  const policyRelease = new Promise((resolve) => { releasePolicy = resolve; });
  const writer = db.transaction(async (tx) => {
    try {
      if (forcedFailure === 'policy_acquire') throw new Error('forced policy lock acquisition failure');
      await tx.execute(sql`set local lock_timeout = '750ms'`);
      await tx.execute(sql`set local statement_timeout = '3000ms'`);
      await tx.execute(sql`lock table settings in access exclusive mode`);
      announcePolicy(); await policyRelease;
      await tx.update(items).set({ subject: 'Changed after snapshot' }).where(eq(items.id, ia));
      await tx.update(settings).set({ value: { version: 1, orbitId: orbit,
        confirmedOrigin: 'https://changed.example.com', globalDefaults: allow } })
        .where(eq(settings.key, 'first_orbit_setup_v1'));
      await bumpSearchGlobalEpoch(tx);
    } catch (error) { rejectPolicy(error); throw error; }
  });
  void writer.catch(() => {});
  let frozen;
  try {
    await awaitAcquisition(policyHeld, 'policy lock');
    frozen = readSearchProjection(db, ia, origin);
    void frozen.catch(() => {});
    let sawWait = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const active = await pool.query("select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type='Lock' and query like '%settings%' limit 1");
      if (active.rowCount) { sawWait = true; break; }
      await setTimeout(25);
    }
    assert.equal(sawWait, forcedFailure === 'policy_assert' ? false : true,
      'projection reached the policy read after taking its source snapshot');
    releasePolicy(); await writer;
    const frozenResult = await frozen;
    assert.equal(frozenResult.status, 'eligible');
    assert.deepEqual(frozenResult.fields.subjectValues, ['Example subject'], 'old policy and source share a snapshot');
  } finally {
    releasePolicy();
    await Promise.allSettled([writer, ...(frozen ? [frozen] : [])]);
  }
  assert.equal((await readSearchProjection(db, ia, origin)).status, 'denied', 'new origin denies old caller');
  await db.transaction(async (tx) => {
    await tx.update(items).set({ subject: 'Example subject' }).where(eq(items.id, ia));
    await tx.update(settings).set({ value: { version: 1, orbitId: orbit,
      confirmedOrigin: origin, globalDefaults: allow } }).where(eq(settings.key, 'first_orbit_setup_v1'));
    await bumpSearchGlobalEpoch(tx);
  });
  await reconcileSearchBatch(db, 'global', 50);
  await db.update(orbits).set({ privacyDefaults: { index: 'exclude', ai: 'allow' } }).where(eq(orbits.id, orbit));
  await db.transaction(async (tx) => { await bumpSearchGlobalEpoch(tx); });
  await reconcileSearchBatch(db, 'global', 50);
  assert.equal((await readSearchProjection(db, ia, origin)).status, 'denied', 'index exclusion wins over AI allowance');
  await db.update(orbits).set({ privacyDefaults: allow }).where(eq(orbits.id, orbit));
  await db.transaction(async (tx) => { await bumpSearchGlobalEpoch(tx); });
  await reconcileSearchBatch(db, 'global', 50);
  assert.equal((await readSearchProjection(db, ia, origin)).status, 'eligible');

  await db.transaction(async (tx) => { await bumpSearchAccountEpoch(tx, a); });
  assert.equal((await readSearchProjection(db, ia, origin)).status, 'denied', 'stale account pair denies');
  assert.equal((await readSearchProjection(db, ib, origin)).status, 'eligible', 'other account remains current');
  assert.equal((await reconcileSearchBatch(db, a, 1)).scanned, 1);
  const afterAccountBump = (await row(a, ia)).desiredRevision;
  await reconcileSearchBatch(db, a, 1);
  assert.equal((await readSearchProjection(db, ia, origin)).status, 'eligible');
  assert.equal((await reconcileSearchBatch(db, a, 1, true)).scanned, 1, 'explicit periodic restart scans');
  assert.equal((await row(a, ia)).desiredRevision, afterAccountBump, 'unchanged pass does not churn');

  await db.transaction(async (tx) => { await bumpSearchGlobalEpoch(tx); });
  assert.equal((await readSearchProjection(db, ib, origin)).status, 'denied');
  await reconcileSearchBatch(db, 'global', 2); await reconcileSearchBatch(db, 'global', 2);
  assert.equal((await row(a, ia)).desiredRevision, afterAccountBump + 1);
  assert.equal((await row(b, ib)).desiredRevision, afterAccountBump);
  assert.equal((await readSearchProjection(db, ib, origin)).status, 'eligible');
  await db.transaction(async (tx) => {
    await tx.update(items).set({ actionEpoch: 1, observedActionEpoch: 1 }).where(eq(items.id, ia));
    await dirtySearchItems(tx, a, [ia]);
  });
  const afterSourceMutation = (await row(a, ia)).desiredRevision;
  await reconcileSearchBatch(db, a, 50, true);
  assert.equal((await row(a, ia)).desiredRevision, afterSourceMutation,
    'source hook captures metadata so the next pass does not double-bump');

  await db.update(items).set({ bodyText: 'x'.repeat(193 * 1024) }).where(eq(items.id, ia));
  await db.transaction(async (tx) => { await dirtySearchItems(tx, a, [ia]); });
  const oversized = await readSearchProjection(db, ia, origin);
  assert.equal(oversized.status, 'error');
  assert.equal(oversized.code, 'oversize');
  assert.equal(await recordSearchProjectionError(db, oversized.evidence, oversized.code, origin), true);
  assert.equal((await row(a, ia)).errorCode, 'oversize');
  await db.transaction(async (tx) => { await dirtySearchItems(tx, a, [ia]); });
  assert.equal(await recordSearchProjectionError(db, oversized.evidence, oversized.code, origin), false,
    'stale projection cannot record an error');
  await db.update(items).set({ bodyText: 'Example body', flags: { read: 'broken' } }).where(eq(items.id, ia));
  const malformed = await readSearchProjection(db, ia, origin);
  assert.equal(malformed.status, 'error'); assert.equal(malformed.code, 'malformed');

  await assert.rejects(db.transaction(async (tx) => {
    await tx.update(searchDocuments).set({ desiredRevision: 2_147_483_647 })
      .where(and(eq(searchDocuments.accountId, a), eq(searchDocuments.itemId, ia)));
    await dirtySearchItems(tx, a, [ia]);
  }), /revision exhausted/);
  assert.notEqual((await row(a, ia)).desiredRevision, 2_147_483_647, 'overflow rolls back');
  const globalBeforeOverflow = (await db.select().from(searchEpochs).where(eq(searchEpochs.scope, 'global')))[0].epoch;
  await assert.rejects(db.transaction(async (tx) => {
    await tx.update(searchEpochs).set({ epoch: 2_147_483_647 }).where(eq(searchEpochs.scope, 'global'));
    await bumpSearchGlobalEpoch(tx);
  }), /epoch exhausted/);
  assert.equal((await db.select().from(searchEpochs).where(eq(searchEpochs.scope, 'global')))[0].epoch,
    globalBeforeOverflow, 'epoch exhaustion rolls back');

  let unlock, locked, rejectLock;
  const held = new Promise((resolve, reject) => { locked = resolve; rejectLock = reject; });
  const release = new Promise((resolve) => { unlock = resolve; });
  const blocker = db.transaction(async (tx) => {
    try {
      if (forcedFailure === 'lock_acquire') throw new Error('forced epoch lock acquisition failure');
      await tx.execute(sql`set local lock_timeout = '750ms'`);
      await tx.execute(sql`set local statement_timeout = '3000ms'`);
      await tx.select().from(searchEpochs).where(eq(searchEpochs.scope, 'global')).for('update');
      locked();
      await release;
    } catch (error) { rejectLock(error); throw error; }
  });
  void blocker.catch(() => {});
  try {
    await awaitAcquisition(held, 'epoch lock');
    await assert.rejects(reconcileSearchBatch(db, a, 1), (error) =>
      forcedFailure !== 'lock_assert' && (error?.cause?.code === '55P03' || error?.code === '55P03'),
    'account sweep has a bounded global-lock wait');
  } finally {
    unlock();
    await Promise.allSettled([blocker]);
  }
  await blocker;
  assert.equal((await reconcileSearchBatch(db, a, 1, true)).scanned, 1,
    'a fresh transaction can retry after lock contention');
  await db.transaction(async (tx) => { await dirtySearchItems(tx, a, [missing]); });
  await reconcileSearchBatch(db, a, 50, true);
  assert.equal((await row(a, missing)).desiredState, 'purge');
  await db.delete(itemOrbits).where(eq(itemOrbits.itemId, ib));
  await db.delete(items).where(eq(items.id, ib));
  await db.delete(threads).where(eq(threads.id, tb));
  await db.delete(accounts).where(eq(accounts.id, b));
  await reconcileSearchBatch(db, 'global', 50, true);
  assert.equal((await row(b, ib)).desiredState, 'purge', 'source deletion keeps content-free evidence');
  assert.equal((await db.select({ count: sql`count(*)` }).from(searchDocuments))[0].count, '3');
  const resumed = await reconcileSearchBatch(db, 'global', 1, true);
  assert.equal(resumed.finished, false, 'a restarted pass persists its first cursor');
  const behind = '00000000-0000-4000-8000-000000000001';
  await db.transaction(async (tx) => { await dirtySearchItems(tx, resumed.cursor.account_id, [behind]); });
  const continued = await reconcileSearchBatch(db, 'global', 1);
  assert.equal(continued.scanned, 1, 'a partial restarted pass must not appear complete');
  for (let n = 0; n < 5; n++) {
    const batch = await reconcileSearchBatch(db, 'global', 1);
    if (batch.finished) break;
    assert.ok(n < 4, 'bounded pass finishes');
  }
  const directPurge = await row(resumed.cursor.account_id, behind);
  assert.equal(directPurge.desiredState, 'purge', 'new missing source is purged by its direct hook');
  await reconcileSearchBatch(db, 'global', 50, true);
  assert.equal((await row(resumed.cursor.account_id, behind)).desiredState, 'purge',
    'the next full pass reconciles a new key behind the old cursor');
  assert.equal((await row(resumed.cursor.account_id, behind)).desiredRevision, directPurge.desiredRevision,
    'the restarted pass does not churn an already materialized deletion');
  const columns = await pool.query("select column_name from information_schema.columns where table_name='search_documents'");
  assert.equal(columns.rows.some((x) => /body|subject|address|snippet|digest/i.test(x.column_name)), false);
  console.log('search ledger PostgreSQL fixture passed');
} finally { await pool.end(); }
