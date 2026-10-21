import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ParseResult } from '@station/shared';
import { parseResultSchema, MAIL_HTML_POLICY_VERSION } from '@station/shared';
import { evaluatePrivacy, privacyDefaultsSchema, type ScopedPrivacyRule, type PrivacyDefaults } from '@station/shared';
import { z } from 'zod';
import { openDatabase } from './connection.js';
import { PrivateBlobStore } from './private-blob-store.js';
import { accounts, attachments, blobIntents, exclusionRules, identities, itemLabels, itemOrbits, itemRecipients, items, labels, orbits, people, settings, syncPages, syncStates, threads } from './schema.js';
import { appendSyncEvent } from './sync-events.js';

type Database = ReturnType<typeof openDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Address = { name: string; address: string };
export type MailChange = {
  externalId: string; threadExternalId: string | null; providerRevision: string | null;
  internalAt: Date | null; receivedAt: Date | null; snippet: string | null; // receivedAt is an observation time, excluded from replay identity.
  flags: Record<string, boolean>; labelRefs: readonly { ref: string; name: string | null }[];
  providerSent: boolean; deleted: boolean; parsed: ParseResult | null;
  // Explicit routed membership is determined before application; the account Orbit is added here.
  routedOrbitIds: readonly string[];
};
export type MailPage = {
  accountId: string; stateId: string; collectionId: string; pageId: string;
  configuredOrigin: string;
  expectedLeaseGeneration: number; expectedCredentialGeneration: number; expectedSequence: number;
  cursorAfter: unknown; changes: readonly MailChange[];
};
export class MailPageFenceError extends Error { constructor() { super('Mail page lease, account, or cursor is stale'); } }
export const MAIL_PAGE_LIMITS = { totalBytes: 24 * 1024 * 1024, maxNodes: 100_000, cursorBytes: 16_384, cursorDepth: 8, cursorNodes: 256, flagsPerItem: 32 } as const;

function preflightPage(page: MailPage): void {
  if (!page || typeof page !== 'object' || !Array.isArray(page.changes) || page.changes.length > 500) throw new Error('Invalid mail page');
  const scan = (root: unknown, maxBytes: number, maxNodes: number, maxDepth: number): number => {
    const active = new WeakSet<object>();
    const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value: root, depth: 0 }];
    let used = 0;
    let visited = 0;
    while (stack.length) {
      const { value, depth, exit } = stack.pop()!;
      if (exit) { active.delete(value as object); continue; }
      if (++visited > maxNodes || depth > maxDepth) throw new Error('Mail page structure exceeds limit');
      used += 16;
      if (typeof value === 'string') used += Buffer.byteLength(value, 'utf8');
      else if (value instanceof Date) used += 32;
      else if (Array.isArray(value)) {
        if (active.has(value)) throw new Error('Cyclic mail page');
        active.add(value);
        stack.push({ value, depth, exit: true });
        if (value.length > maxNodes) throw new Error('Mail page array exceeds limit');
        for (const entry of value) stack.push({ value: entry, depth: depth + 1 });
      } else if (value && typeof value === 'object') {
        if (active.has(value)) throw new Error('Cyclic mail page');
        active.add(value);
        stack.push({ value, depth, exit: true });
        let keys = 0;
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          if (++keys > maxNodes) throw new Error('Mail page object exceeds limit');
          used += Buffer.byteLength(key, 'utf8');
          stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
        }
      }
      if (used > maxBytes) throw new Error('Mail page bytes exceed limit');
    }
    return used;
  };
  for (const change of page.changes) {
    if (!change || typeof change !== 'object' || !change.flags || typeof change.flags !== 'object') throw new Error('Mail page flags exceed limit');
    let flags = 0;
    for (const key in change.flags) if (Object.hasOwn(change.flags, key) && ++flags > MAIL_PAGE_LIMITS.flagsPerItem) throw new Error('Mail page flags exceed limit');
  }
  const bytes = scan(page, MAIL_PAGE_LIMITS.totalBytes, MAIL_PAGE_LIMITS.maxNodes, 24);
  const nodes = scan(page.cursorAfter, MAIL_PAGE_LIMITS.cursorBytes, MAIL_PAGE_LIMITS.cursorNodes, MAIL_PAGE_LIMITS.cursorDepth);
  if (bytes > MAIL_PAGE_LIMITS.totalBytes || nodes > MAIL_PAGE_LIMITS.cursorBytes) throw new Error('Mail page exceeds limit');
}

function digestPage(page: MailPage): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(page.cursorAfter));
  for (const change of page.changes) {
    let parsed = change.parsed;
    if (parsed?.ok && parsed.mail.sanitizedHtml) {
      const html = parsed.mail.sanitizedHtml;
      const refs = new Map(html.images.map((image, index) => [image.refId, `image-${index}`]));
      const canonicalHtml = html.html.replace(/data-station-image-ref="([a-f0-9]{32})"/g, (_match, ref: string) => {
        const canonical = refs.get(ref);
        if (!canonical) throw new Error('Unmatched sanitized image reference');
        return `data-station-image-ref="${canonical}"`;
      });
      parsed = { ok: true, mail: { ...parsed.mail, sanitizedHtml: { ...html, html: canonicalHtml,
        images: html.images.map((image, index) => ({ ...image, refId: `image-${index}` })) } } };
    }
    hash.update(JSON.stringify({ ...change, receivedAt: undefined, parsed }));
  }
  return hash.digest('hex');
}

function email(value: string): string | null {
  const result = value.trim().toLowerCase();
  return result.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) ? result : null;
}
function safeFilename(value: string | null): string | null {
  if (!value) return null;
  // Provider names are display metadata, never filesystem paths.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  return cleaned.slice(0, 255) || null;
}
function validPage(page: MailPage): void {
  preflightPage(page);
  const pageShape = z.object({ accountId: z.string().uuid(), stateId: z.string().uuid(), collectionId: z.string().min(1).max(1024),
    pageId: z.string().min(1).max(200), configuredOrigin: z.url().max(2048),
    expectedSequence: z.number().int().nonnegative(), expectedLeaseGeneration: z.number().int().nonnegative(),
    expectedCredentialGeneration: z.number().int().nonnegative(), cursorAfter: z.json(),
    changes: z.array(z.object({ externalId: z.string().min(1).max(1024), threadExternalId: z.string().min(1).max(1024).nullable(),
      providerRevision: z.string().max(1024).nullable(), internalAt: z.date().nullable(), receivedAt: z.date().nullable(),
      snippet: z.string().max(4096).nullable(), flags: z.record(z.string().max(64), z.boolean()),
      labelRefs: z.array(z.object({ ref: z.string().min(1).max(1024), name: z.string().max(1024).nullable() })).max(100),
      providerSent: z.boolean(), deleted: z.boolean(), parsed: parseResultSchema.nullable(),
      routedOrbitIds: z.array(z.string().uuid()).max(32), })).max(500) }).strict();
  pageShape.parse(page);
  if (!Number.isSafeInteger(page.expectedSequence) || !Number.isSafeInteger(page.expectedLeaseGeneration) || !Number.isSafeInteger(page.expectedCredentialGeneration)) throw new Error('Invalid mail page fence');
  const keys = new Set<string>();
  for (const change of page.changes) {
    if (!change.externalId || change.externalId.length > 1024 || (!change.deleted && !change.threadExternalId) || keys.has(change.externalId)) throw new Error('Invalid or duplicate item key');
    keys.add(change.externalId);
    if (change.providerRevision !== null && change.providerRevision.length > 1024) throw new Error('Invalid provider revision');
    if (change.deleted && change.parsed !== null) throw new Error('Deleted item carries content');
    if (!change.deleted && (!change.parsed || !parseResultSchema.safeParse(change.parsed).success)) throw new Error('Missing or invalid parse result');
    if (change.parsed && !change.parsed.ok && ['timeout', 'busy', 'service_unavailable'].includes(change.parsed.code)) throw new Error('Transient parser failure');
    if (change.parsed?.ok) {
      const total = change.parsed.mail.attachments.reduce((sum, item) => sum + Buffer.from(item.contentBase64, 'base64').byteLength, 0);
      if (total > 8_388_608) throw new Error('Decoded attachments exceed byte limit');
    }
  }
}

async function checkFence(db: Database | Transaction, page: MailPage, lock: boolean, checkSequence = true): Promise<boolean> {
  const accountQuery = db.select().from(accounts).where(eq(accounts.id, page.accountId));
  const [account] = lock ? await accountQuery.for('update') : await accountQuery;
  const stateQuery = db.select().from(syncStates).where(eq(syncStates.id, page.stateId));
  const [state] = lock ? await stateQuery.for('update') : await stateQuery;
  const setupQuery = db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'first_orbit_setup_v1'));
  const [setup] = lock ? await setupQuery.for('share') : await setupQuery;
  const marker = z.object({ version: z.literal(1), orbitId: z.string().uuid(), confirmedOrigin: z.url(), globalDefaults: privacyDefaultsSchema }).safeParse(setup?.value);
  if (!account || !state || account.revokedAt || !account.backfill || !account.grantedScopes.includes('https://www.googleapis.com/auth/gmail.modify') ||
      !marker.success || marker.data.confirmedOrigin !== page.configuredOrigin ||
      state.accountId !== page.accountId || state.resource !== 'mail' || state.collectionId !== page.collectionId ||
      state.generation !== page.expectedLeaseGeneration || account.credentialGeneration !== page.expectedCredentialGeneration ||
      (checkSequence && state.sequence !== page.expectedSequence) || !state.leaseUntil || state.leaseUntil <= new Date() || state.status !== 'running') throw new MailPageFenceError();
  return true;
}

// A committed intent precedes publication. The row lock spans the file write;
// the collector takes the same lock and can never delete an active publication.
async function stageBlob(db: Database, store: PrivateBlobStore, page: MailPage, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const key = PrivateBlobStore.generateKey();
  await db.insert(blobIntents).values({ key, accountId: page.accountId, stateId: page.stateId, pageId: page.pageId,
    leaseGeneration: page.expectedLeaseGeneration, credentialGeneration: page.expectedCredentialGeneration, expectedSequence: page.expectedSequence });
  await db.transaction(async (tx) => {
    signal?.throwIfAborted();
    const [intent] = await tx.select().from(blobIntents).where(eq(blobIntents.key, key)).for('update');
    if (!intent || intent.state !== 'pending' || intent.stateId !== page.stateId || intent.pageId !== page.pageId) throw new Error('Staged blob intent was reclaimed');
    await store.writeReserved(key, bytes, signal);
  });
  return key;
}

async function identityFor(tx: Transaction, accountId: string, provider: string, address: Address): Promise<string | null> {
  const normalizedValue = email(address.address);
  if (!normalizedValue) return null;
  const [known] = await tx.select().from(identities).where(and(eq(identities.accountId, accountId), eq(identities.provider, provider), eq(identities.kind, 'email'), eq(identities.normalizedValue, normalizedValue)));
  if (known) return known.id;
  const personId = randomUUID();
  const id = randomUUID();
  await tx.insert(people).values({ id: personId, accountId, displayName: address.name.trim().slice(0, 512) || normalizedValue });
  await tx.insert(identities).values({ id, accountId, personId, provider, kind: 'email', normalizedValue });
  return id;
}

export async function applyMailPage(db: Database, store: PrivateBlobStore, page: MailPage, signal?: AbortSignal): Promise<'applied' | 'replayed'> {
  signal?.throwIfAborted();
  validPage(page);
  const pageDigest = digestPage(page);
  await checkFence(db, page, false, false);
  const [existingPage] = await db.select({ digest: syncPages.pageDigest, sequence: syncPages.sequence }).from(syncPages).where(and(eq(syncPages.stateId, page.stateId), eq(syncPages.pageId, page.pageId)));
  if (existingPage) {
    if (existingPage.digest !== pageDigest || existingPage.sequence !== page.expectedSequence + 1) throw new Error('Mail page ID changed content or sequence');
    return 'replayed';
  }
  await checkFence(db, page, false);
  const staged = new Map<string, { html?: string; attachments: string[] }>();
  for (const change of page.changes) {
    signal?.throwIfAborted();
    if (change.deleted || !change.parsed?.ok) continue;
    const entry: { html?: string; attachments: string[] } = { attachments: [] };
    if (change.parsed.mail.sanitizedHtml) entry.html = await stageBlob(db, store, page, Buffer.from(change.parsed.mail.sanitizedHtml.html, 'utf8'), signal);
    for (const attachment of change.parsed.mail.attachments) entry.attachments.push(await stageBlob(db, store, page, Buffer.from(attachment.contentBase64, 'base64'), signal));
    staged.set(change.externalId, entry);
  }
  return db.transaction(async (tx) => {
      signal?.throwIfAborted();
      await checkFence(tx, page, true, false);
      const [replayed] = await tx.select({ digest: syncPages.pageDigest, sequence: syncPages.sequence }).from(syncPages).where(and(eq(syncPages.stateId, page.stateId), eq(syncPages.pageId, page.pageId)));
      if (replayed) {
        if (replayed.digest !== pageDigest || replayed.sequence !== page.expectedSequence + 1) throw new Error('Mail page ID changed content or sequence');
        return 'replayed';
      }
      await checkFence(tx, page, false);
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, page.accountId));
      if (!account) throw new MailPageFenceError();
      const [baseOrbit] = await tx.select({ id: orbits.id }).from(orbits).where(eq(orbits.id, account.orbitId));
      if (!baseOrbit) throw new MailPageFenceError();
      for (const change of page.changes) {
        signal?.throwIfAborted();
        const parsed = change.parsed?.ok ? change.parsed.mail : null;
        const [prior] = await tx.select().from(items).where(and(eq(items.accountId, page.accountId), eq(items.collectionId, page.collectionId), eq(items.externalId, change.externalId)));
        const threadExternalId = change.threadExternalId ?? `tombstone:${change.externalId}`;
        let [thread] = change.deleted && !change.threadExternalId && prior
          ? await tx.select().from(threads).where(eq(threads.id, prior.threadId))
          : await tx.select().from(threads).where(and(eq(threads.accountId, page.accountId), eq(threads.collectionId, page.collectionId), eq(threads.externalId, threadExternalId)));
        if (!thread) {
          [thread] = await tx.insert(threads).values({ id: randomUUID(), accountId: page.accountId, collectionId: page.collectionId, externalId: threadExternalId, subject: parsed?.subject ?? null, lastActivityAt: change.internalAt }).returning();
        } else if (change.internalAt && (!thread.lastActivityAt || change.internalAt > thread.lastActivityAt)) {
          [thread] = await tx.update(threads).set({ lastActivityAt: change.internalAt, updatedAt: new Date() }).where(eq(threads.id, thread.id)).returning();
        }
        if (!thread) throw new Error('Thread insert failed');
        const oldKeys: string[] = [];
        if (prior?.bodyHtmlPath) oldKeys.push(prior.bodyHtmlPath);
        if (prior) {
          const oldAttachments = await tx.select({ key: attachments.storagePath }).from(attachments).where(eq(attachments.itemId, prior.id));
          oldKeys.push(...oldAttachments.map((row) => row.key));
        }
        const sender = parsed?.from ? email(parsed.from.address) : null;
        const senderIdentitiesComplete = !!parsed && !!parsed.from &&
          parsed.senderIdentities.length >= parsed.senderHeaderFieldCount &&
          [parsed.from, ...parsed.senderIdentities].every((address) => email(address.address) !== null);
        const replyToIdentitiesComplete = !!parsed && parsed.replyToHeaderFieldCount <= 1 &&
          (parsed.replyToHeaderFieldCount === 0 || parsed.replyTo.length > 0) &&
          parsed.replyTo.every((address) => email(address.address) !== null);
        const direction = !change.deleted && change.providerSent && change.labelRefs.some((label) => label.ref === 'SENT') && sender === email(account.email) ? 'out' : 'in';
        const fromIdentity = parsed?.from ? await identityFor(tx, page.accountId, account.provider, parsed.from) : null;
        const [fromRow] = fromIdentity ? await tx.select({ personId: identities.personId }).from(identities).where(eq(identities.id, fromIdentity)) : [];
        const files = staged.get(change.externalId);
        const values = { accountId: page.accountId, collectionId: page.collectionId, threadId: thread.id,
          externalId: change.externalId, providerRevision: change.providerRevision, appliedSequence: page.expectedSequence + 1,
          direction, directionProvenance: direction === 'out' ? 'provider_sent_account' : 'incoming', fromPersonId: fromRow?.personId ?? null,
          senderIdentitiesComplete,
          senderHeaderCount: parsed?.senderIdentities.length ?? 0,
          replyToHeaderCount: parsed?.replyTo.length ?? 0,
          replyToIdentitiesComplete,
          internalAt: change.internalAt, receivedAt: change.receivedAt, sentAt: parsed?.date && !Number.isNaN(Date.parse(parsed.date)) ? new Date(parsed.date) : null,
          messageId: parsed?.messageId ?? null, inReplyTo: parsed?.inReplyTo ?? null, referencesHeader: parsed?.references ?? null,
          subject: parsed?.subject ?? null, snippet: change.snippet?.slice(0, 4096) ?? null, bodyText: parsed?.text ?? null,
          bodyHtmlPath: files?.html ?? null, htmlPolicyVersion: parsed?.sanitizedHtml ? MAIL_HTML_POLICY_VERSION : null,
          imageMetadata: parsed?.sanitizedHtml?.images ?? null, flags: change.flags,
          parseStatus: change.deleted ? 'deleted' : parsed ? 'supported' : 'unsupported',
          parseFailureCode: change.parsed && !change.parsed.ok ? change.parsed.code : null,
          deletedAt: change.deleted ? new Date() : null, updatedAt: new Date() };
        const [item] = prior ? await tx.update(items).set(values).where(eq(items.id, prior.id)).returning() :
          await tx.insert(items).values({ id: randomUUID(), ...values }).returning();
        if (!item) throw new Error('Item insert failed');
        await tx.delete(itemRecipients).where(eq(itemRecipients.itemId, item.id));
        await tx.delete(itemLabels).where(eq(itemLabels.itemId, item.id));
        await tx.delete(itemOrbits).where(eq(itemOrbits.itemId, item.id));
        await tx.delete(attachments).where(eq(attachments.itemId, item.id));
        if (!change.deleted) {
          await tx.insert(itemOrbits).values([{ itemId: item.id, orbitId: account.orbitId, reason: 'account' }, ...[...new Set(change.routedOrbitIds)].filter((id) => id !== account.orbitId).map((orbitId) => ({ itemId: item.id, orbitId, reason: 'rule' }))]);
          if (parsed) {
            const roles: [string, readonly Address[]][] = [['sender', parsed.senderIdentities], ['reply_to', parsed.replyTo], ['to', parsed.to], ['cc', parsed.cc], ['bcc', parsed.bcc]];
            if (parsed.from) roles[0]![1] = [parsed.from, ...parsed.senderIdentities];
            for (const [role, addresses] of roles) for (const address of addresses) {
              const identityId = await identityFor(tx, page.accountId, account.provider, address);
              if (identityId) await tx.insert(itemRecipients).values({ itemId: item.id, accountId: page.accountId, identityId, role }).onConflictDoNothing();
            }
            for (const [ordinal, attachment] of parsed.attachments.entries()) {
              const key = files?.attachments[ordinal];
              if (!key) throw new Error('Missing staged attachment');
              await tx.insert(attachments).values({ id: randomUUID(), itemId: item.id, accountId: page.accountId, ordinal, filename: safeFilename(attachment.filename), mimeType: attachment.mimeType,
                disposition: attachment.disposition, contentId: attachment.contentId, related: attachment.related,
                size: Buffer.from(attachment.contentBase64, 'base64').byteLength, storagePath: key });
            }
          }
          for (const label of change.labelRefs) {
            if (!label.ref || label.ref.length > 1024) throw new Error('Invalid provider label');
            let [row] = await tx.select().from(labels).where(and(eq(labels.accountId, page.accountId), eq(labels.providerRef, label.ref)));
            if (!row) [row] = await tx.insert(labels).values({ id: randomUUID(), accountId: page.accountId, providerRef: label.ref, name: label.name ?? '' }).returning();
            else if (row.name !== (label.name ?? '')) [row] = await tx.update(labels).set({ name: label.name ?? '', updatedAt: new Date() }).where(eq(labels.id, row.id)).returning();
            if (!row) throw new Error('Label insert failed');
            await tx.insert(itemLabels).values({ itemId: item.id, accountId: page.accountId, labelId: row.id, source: 'provider' }).onConflictDoNothing();
          }
        }
        if (oldKeys.length) await tx.update(blobIntents).set({ state: 'delete_pending' }).where(and(inArray(blobIntents.key, oldKeys), eq(blobIntents.accountId, page.accountId)));
        const newKeys = [files?.html, ...files?.attachments ?? []].filter((key): key is string => !!key);
        for (const key of newKeys) {
          const [intent] = await tx.select().from(blobIntents).where(and(eq(blobIntents.key, key), eq(blobIntents.accountId, page.accountId), eq(blobIntents.stateId, page.stateId), eq(blobIntents.pageId, page.pageId), eq(blobIntents.state, 'pending'))).for('update');
          if (!intent) throw new Error('Staged blob was reclaimed');
          await store.read(key);
          await tx.update(blobIntents).set({ state: 'referenced', committedAt: new Date() }).where(eq(blobIntents.key, key));
        }
      }
      signal?.throwIfAborted();
      await tx.insert(syncPages).values({ id: randomUUID(), stateId: page.stateId, accountId: page.accountId, pageId: page.pageId, pageDigest, sequence: page.expectedSequence + 1 });
      await tx.update(syncStates).set({ cursor: page.cursorAfter, sequence: page.expectedSequence + 1, lastSuccessAt: new Date(), updatedAt: new Date() }).where(eq(syncStates.id, page.stateId));
      await appendSyncEvent(tx, 'mail-changed', page.accountId);
      signal?.throwIfAborted();
      return 'applied';
  });
}

// Consumers re-evaluate this at use time; no cached grant survives a rule edit.
export async function evaluateStoredMailPrivacy(db: Database, itemId: string) {
  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item || item.deletedAt || item.parseStatus !== 'supported') return { canIndex: false, canUseAi: false, canEmbed: false };
  const [account] = await db.select().from(accounts).where(eq(accounts.id, item.accountId));
  const [marker] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'first_orbit_setup_v1'));
  const defaults = z.object({ globalDefaults: privacyDefaultsSchema }).safeParse(marker?.value);
  if (!account || !defaults.success) return { canIndex: false, canUseAi: false, canEmbed: false };
  const memberships = await db.select().from(itemOrbits).where(eq(itemOrbits.itemId, itemId));
  const orbitIds = [...new Set(memberships.map((row) => row.orbitId))];
  if (!orbitIds.includes(account.orbitId)) return { canIndex: false, canUseAi: false, canEmbed: false };
  const orbitRows = await db.select().from(orbits).where(inArray(orbits.id, orbitIds));
  const orbitDefaults = new Map<string, PrivacyDefaults>();
  for (const row of orbitRows) {
    const parsed = privacyDefaultsSchema.safeParse(row.privacyDefaults);
    if (parsed.success) orbitDefaults.set(row.id, parsed.data);
  }
  const recipientRows = await db.select({ role: itemRecipients.role, value: identities.normalizedValue }).from(itemRecipients)
    .innerJoin(identities, and(eq(itemRecipients.identityId, identities.id), eq(itemRecipients.accountId, identities.accountId)))
    .where(eq(itemRecipients.itemId, itemId));
  const labelRows = await db.select({ name: labels.name }).from(itemLabels)
    .innerJoin(labels, and(eq(itemLabels.labelId, labels.id), eq(itemLabels.accountId, labels.accountId)))
    .where(eq(itemLabels.itemId, itemId));
  const rules = await db.select().from(exclusionRules);
  return evaluatePrivacy({ account: account.email, sender: recipientRows.find((row) => row.role === 'sender')?.value ?? '',
    senderIdentities: recipientRows.filter((row) => row.role === 'sender').map((row) => row.value), unresolvedSenders: !item.senderIdentitiesComplete,
    labels: labelRows.map((row) => row.name), unresolvedLabels: labelRows.some((row) => !row.name), orbitIds },
    defaults.data.globalDefaults, orbitDefaults, rules.map((row): ScopedPrivacyRule => ({
      orbitId: row.orbitId, scope: row.orbitId ? 'orbit' : 'global', kind: row.kind as ScopedPrivacyRule['kind'],
      value: row.value, effect: row.effect as ScopedPrivacyRule['effect'],
    })));
}

// Bounded collector. A row lock serializes with publication and page commit;
// the FK/reference check precedes deletion in the same transaction.
export async function collectOrphanBlobs(db: Database, store: PrivateBlobStore, minimumAgeMs = 60_000, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0 || minimumAgeMs > 7 * 24 * 60 * 60 * 1000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid orphan collector bounds');
  let count = 0;
  for (let i = 0; i < limit; i++) {
    const didDelete = await db.transaction(async (tx) => {
      const [intent] = await tx.select().from(blobIntents)
        .where(and(inArray(blobIntents.state, ['pending', 'delete_pending']), sql`${blobIntents.createdAt} <= now() - (${minimumAgeMs} * interval '1 millisecond')`,
          sql`(${blobIntents.state} = 'delete_pending' or not exists (
            select 1 from sync_state s join accounts a on a.id = s.account_id
            where s.id = ${blobIntents.stateId} and s.status = 'running'
              and s.generation = ${blobIntents.leaseGeneration} and s.sequence = ${blobIntents.expectedSequence}
              and s.lease_until > now() and a.credential_generation = ${blobIntents.credentialGeneration}
              and a.revoked_at is null))`))
        .orderBy(blobIntents.createdAt).limit(1).for('update', { skipLocked: true });
      if (!intent) return false;
      const [body] = await tx.select({ id: items.id }).from(items).where(eq(items.bodyHtmlPath, intent.key)).limit(1);
      const [attachment] = await tx.select({ id: attachments.id }).from(attachments).where(eq(attachments.storagePath, intent.key)).limit(1);
      if (body || attachment) {
        await tx.update(blobIntents).set({ state: 'referenced' }).where(eq(blobIntents.key, intent.key));
        return false;
      }
      await store.delete(intent.key);
      await store.deleteTemporary(intent.key);
      await tx.delete(blobIntents).where(eq(blobIntents.key, intent.key));
      return true;
    });
    if (!didDelete) break;
    count++;
  }
  return count;
}
