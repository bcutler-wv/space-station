import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { accounts, drafts, identities, itemRecipients, items, orbits, threads } from '@station/db';
import { GmailReadAdapter, GmailReadError, GoogleCredentialService, GMAIL_MODIFY_SCOPE } from '@station/connectors';
import { addressParser } from 'postal-mime';
import { z } from 'zod';
import { draftCreateSchema, draftDiscardSchema, draftSummaryPageSchema, draftQuerySchema, draftSchema,
  draftScopeSchema, draftUpdateSchema, readerIdSchema, replyContextQuerySchema, replyContextSchema } from '@station/shared';
import type { AuthConfig } from './auth.js';

type Tx = Parameters<Parameters<AuthConfig['db']['transaction']>[0]>[0];
const OWNER = 'owner';
const unavailable = { error: 'This draft or message is unavailable in this account and Orbit.' };
const bad = { error: 'Check the draft fields and try again.' };
const conflict = { error: 'This draft changed in another tab. Reload it before saving.' };
const atom = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const domain = '[A-Za-z0-9]+(?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9]+(?:[A-Za-z0-9-]*[A-Za-z0-9])?)*';
const msgId = `<${atom}(?:\\.${atom})*@${domain}>`;
const headerId = new RegExp(`^${msgId}$`);
const headerList = new RegExp(`^${msgId}(?:[ \\t]+${msgId})*$`);
// eslint-disable-next-line no-control-regex
const noControls = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
type ReplyMetadata = { messageId: string; references: string | null; to: string };
type ParsedReplyMetadata = ReplyMetadata & { from: string; replyTo: string | null };
function normalizedAddress(value: string): string | null {
  const result = value.trim().toLowerCase();
  return result.length <= 254 && z.email().safeParse(result).success ? result : null;
}
// PostalMime extracts addresses from imperfect mail. Reply selection only accepts
// its result when the complete field has one plain mailbox or one angle mailbox.
function supportedSingleAddress(field: string, address: string): boolean {
  const raw = field.trim();
  if (raw.length > 2048 || raw.split('@').length !== 2) return false;
  const open = raw.indexOf('<');
  const close = raw.indexOf('>');
  if (open === -1 && close === -1) return raw.toLowerCase() === address;
  if (open < 0 || close < open || raw.indexOf('<', open + 1) !== -1 ||
    raw.indexOf('>', close + 1) !== -1 || raw.slice(close + 1).trim() !== '' ||
    raw.slice(open + 1, close).trim().toLowerCase() !== address) return false;
  const name = raw.slice(0, open).trim();
  return !name || /^"(?:[^"\\]|\\.)*"$/.test(name) || /^[^",:;<>@]+$/.test(name);
}
function validatedReplyMetadata(headers: readonly { name: string; value: string }[]): ParsedReplyMetadata | null {
  const allowed = new Set(['message-id', 'in-reply-to', 'references', 'reply-to', 'from']);
  const fields = new Map<string, string>();
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (!allowed.has(name) || fields.has(name) || !noControls(header.value) || Buffer.byteLength(header.value) > 8192) return null;
    fields.set(name, header.value);
  }
  const messageId = fields.get('message-id');
  const prior = fields.get('in-reply-to');
  const references = fields.get('references');
  if (!messageId || !headerId.test(messageId) ||
    (prior !== undefined && (!headerList.test(prior) || prior.length > 8192)) ||
    (references !== undefined && (!headerList.test(references) || references.length > 8192))) return null;
  const parseAddress = (field: string | undefined) => {
    if (field === undefined) return null;
    const parsed = addressParser(field);
    if (parsed.length !== 1 || parsed[0]?.group) return null;
    const address = normalizedAddress(parsed[0]!.address);
    return address && supportedSingleAddress(field, address) ? address : null;
  };
  const from = parseAddress(fields.get('from'));
  const replyTo = fields.has('reply-to') ? parseAddress(fields.get('reply-to')) : undefined;
  if (!from || (fields.has('reply-to') && !replyTo)) return null;
  const to = replyTo ?? from;
  if (!to || `${references ? `${references} ` : ''}${messageId}`.length > 8192) return null;
  return { messageId, references: references ?? null, to, from, replyTo: replyTo ?? null };
}
function storedReplyMetadata(value: unknown): ReplyMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== 3 || !['messageId', 'references', 'to'].every((key) => keys.includes(key))) return null;
  if (typeof row.messageId !== 'string' || typeof row.to !== 'string' ||
    (row.references !== null && typeof row.references !== 'string') ||
    row.messageId.length > 4096 || row.to.length > 254 ||
    (typeof row.references === 'string' && row.references.length > 8192) ||
    !noControls(row.messageId) || !noControls(row.to) ||
    (typeof row.references === 'string' && !noControls(row.references)) ||
    !headerId.test(row.messageId) || !normalizedAddress(row.to) || row.to !== normalizedAddress(row.to) ||
    (row.references !== null && !headerList.test(row.references)) ||
    `${row.references ? `${row.references} ` : ''}${row.messageId}`.length > 8192) return null;
  return { messageId: row.messageId, references: row.references, to: row.to } as ReplyMetadata;
}
const iso = (date: Date) => date.toISOString();
function view(row: typeof drafts.$inferSelect) {
  return draftSchema.parse({ id: row.id, accountId: row.accountId, orbitId: row.orbitId,
    parentItemId: row.parentItemId, threadId: row.threadId,
    to: row.to, cc: row.cc, bcc: row.bcc, subject: row.subject, bodyText: row.bodyText,
    attachmentRefs: row.attachmentRefs, revision: row.revision, state: row.state,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
}
function sendDraft(reply: FastifyReply, row: typeof drafts.$inferSelect) {
  const value = view(row);
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024)
    return reply.code(503).send({ error: 'This draft is too large to display.' });
  return reply.send(value);
}
function cursorEncode(value: { at: string; id: string; accountId: string; orbitId: string | null }, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
function cursorDecode(value: string | undefined, accountId: string, orbitId: string | undefined, key: Buffer) {
  if (!value) return null;
  const [body, mac, extra] = value.split('.');
  if (!body || !mac || extra || body.length > 700 || mac.length !== 43) return false;
  const expected = createHmac('sha256', key).update(body).digest();
  const actual = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const result = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { at: string; id: string; accountId: string; orbitId: string | null };
    if (result.accountId !== accountId || result.orbitId !== (orbitId ?? null) ||
      !readerIdSchema.safeParse(result.id).success || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(result.at) ||
      !Number.isFinite(Date.parse(result.at))) return false;
    return result;
  } catch { return false; }
}
export function registerDrafts(app: FastifyInstance, auth: AuthConfig,
  reader: Pick<GmailReadAdapter, 'getReplyHeaders'> = new GmailReadAdapter(new GoogleCredentialService(auth.db, auth.masterKey, auth.googleTransport))): void {
  const db = auth.db;
  const run = <T>(work: (tx: Tx) => Promise<T>, readonly = false): Promise<T> => db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    return work(tx);
  }, readonly ? { accessMode: 'read only' } : undefined);
  const origin = (headers: Record<string, unknown>) =>
    (!headers.origin || headers.origin === auth.origin) && headers['sec-fetch-site'] !== 'cross-site';
  const accountScope = async (tx: Tx, accountId: string, orbitId?: string) => {
    const [account] = await tx.select({ id: accounts.id, orbitId: accounts.orbitId }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!account) return false;
    if (!orbitId) return true;
    const [orbit] = await tx.select({ id: orbits.id }).from(orbits).where(eq(orbits.id, orbitId)).limit(1);
    return !!orbit;
  };
  const parent = async (tx: Tx, parentItemId: string, accountId: string, orbitId?: string) => {
    const [row] = await tx.select({ id: items.id, threadId: items.threadId, accountId: items.accountId,
      direction: items.direction, collectionId: items.collectionId, subject: items.subject, messageId: items.messageId,
      externalId: items.externalId, providerRevision: items.providerRevision, appliedSequence: items.appliedSequence,
      replyMetadata: items.replyMetadata, parseStatus: items.parseStatus,
      senderIdentitiesComplete: items.senderIdentitiesComplete, senderHeaderCount: items.senderHeaderCount,
      replyToIdentitiesComplete: items.replyToIdentitiesComplete, replyToHeaderCount: items.replyToHeaderCount,
      referencesHeader: items.referencesHeader, providerThreadId: threads.externalId }).from(items)
      .innerJoin(threads, eq(threads.id, items.threadId))
      .where(and(eq(items.id, parentItemId), eq(items.accountId, accountId), isNull(items.deletedAt),
        orbitId ? sql`exists (select 1 from item_orbits io where io.item_id = ${items.id} and io.orbit_id = ${orbitId})` : sql`true`)).limit(1);
    return row;
  };
  const context = async (tx: Tx, parentItemId: string, accountId: string, orbitId?: string) => {
    if (!await accountScope(tx, accountId, orbitId)) return null;
    const row = await parent(tx, parentItemId, accountId, orbitId);
    const repaired = storedReplyMetadata(row?.replyMetadata);
    if (!row || row.direction !== 'in' || row.parseStatus !== 'supported' ||
      (!repaired && (!row.senderIdentitiesComplete || row.senderHeaderCount !== 1 ||
      !row.replyToIdentitiesComplete || row.replyToHeaderCount > 1)) ||
      !(repaired?.messageId ?? row.messageId) || !headerId.test(repaired?.messageId ?? row.messageId!) ||
      !noControls(repaired?.messageId ?? row.messageId!) ||
      (row.referencesHeader && (!headerList.test(row.referencesHeader) || !noControls(row.referencesHeader)))) return null;
    const addresses = await tx.select({ role: itemRecipients.role, address: identities.normalizedValue })
      .from(itemRecipients).innerJoin(identities, and(eq(identities.id, itemRecipients.identityId), eq(identities.accountId, itemRecipients.accountId)))
      .where(and(eq(itemRecipients.itemId, row.id), eq(itemRecipients.accountId, accountId),
        sql`${itemRecipients.role} in ('reply_to', 'sender')`)).limit(102);
    const replyTo = addresses.filter((item) => item.role === 'reply_to').map((item) => item.address);
    const senders = addresses.filter((item) => item.role === 'sender').map((item) => item.address);
    const choice = repaired ? [repaired.to] : replyTo.length ? replyTo : senders;
    if (choice.length !== 1 || !noControls(choice[0]!)) return null;
    const messageId = repaired?.messageId ?? row.messageId!;
    const priorReferences = repaired ? repaired.references : row.referencesHeader;
    const references = `${priorReferences ? `${priorReferences} ` : ''}${messageId}`;
    if (references.length > 8192) return null;
    const subject = row.subject ?? '';
    if (!noControls(subject) || subject.length > 4092 || !noControls(row.providerThreadId)) return null;
    return replyContextSchema.safeParse({ accountId, orbitId: orbitId ?? null, parentItemId, threadId: row.threadId, collectionId: row.collectionId,
      providerThreadId: row.providerThreadId, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      to: [{ address: choice[0], name: '' }], messageId, references }).data ?? null;
  };
  app.get('/api/mail/items/:itemId/reply-context', async (request, reply) => {
    if (!origin(request.headers)) return reply.code(403).send(bad);
    const itemId = (request.params as { itemId: string }).itemId;
    const parsed = replyContextQuerySchema.safeParse(request.query);
    if (!readerIdSchema.safeParse(itemId).success || !parsed.success) return reply.code(400).send(bad);
    const { accountId, orbitId } = parsed.data;
    const preflight = await run(async (tx) => {
      if (!await accountScope(tx, accountId, orbitId)) return null;
      const row = await parent(tx, itemId, accountId, orbitId);
      if (!row || row.direction !== 'in' || row.parseStatus !== 'supported') return null;
      const [account] = await tx.select({ provider: accounts.provider, revokedAt: accounts.revokedAt,
        credentialGeneration: accounts.credentialGeneration, grantedScopes: accounts.grantedScopes })
        .from(accounts).where(eq(accounts.id, accountId)).limit(1);
      return { row, account };
    }, true);
    if (!preflight) return reply.code(409).send(unavailable);
    const existing = await run((tx) => context(tx, itemId, accountId, orbitId), true);
    if (existing) return existing;
    const { row, account } = preflight;
    if (row.messageId !== null || row.replyMetadata !== null || !account || account.provider !== 'google' ||
      account.revokedAt || !account.grantedScopes.includes(GMAIL_MODIFY_SCOPE))
      return reply.code(409).send({ error: 'Reply details are unavailable. Reconnect this account or start a new message.' });
    let fetched: Awaited<ReturnType<typeof reader.getReplyHeaders>>;
    try { fetched = await reader.getReplyHeaders(accountId, row.externalId); }
    catch (error) {
      const code = error instanceof GmailReadError ? error.code : 'transient';
      return reply.code(code === 'message_missing' ? 409 : code === 'needs_reconnect' || code === 'permission_denied' ? 409 : 503)
        .send({ error: code === 'message_missing' ? 'This message is no longer available in Gmail.' :
          code === 'needs_reconnect' || code === 'permission_denied' ? 'Reconnect this account to load reply details.' :
          'Reply details could not be loaded. Try again.' });
    }
    const metadata = fetched.id === row.externalId && fetched.threadId === row.providerThreadId &&
      (row.providerRevision === null || fetched.historyId === row.providerRevision)
      ? validatedReplyMetadata(fetched.payload.headers) : null;
    if (!metadata) return reply.code(409).send({ error: 'This message has incomplete or ambiguous reply details.' });
    const outcome = await run(async (tx) => {
      if (!await accountScope(tx, accountId, orbitId)) return false;
      const current = await parent(tx, itemId, accountId, orbitId);
      const [grant] = await tx.select({ generation: accounts.credentialGeneration, revokedAt: accounts.revokedAt,
        scopes: accounts.grantedScopes }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (!current || !grant || grant.revokedAt || grant.generation !== fetched.credentialGeneration ||
        !grant.scopes.includes(GMAIL_MODIFY_SCOPE) || current.externalId !== row.externalId ||
        current.providerThreadId !== row.providerThreadId || current.providerRevision !== row.providerRevision ||
        current.appliedSequence !== row.appliedSequence || current.messageId !== null || current.replyMetadata !== null ||
        current.direction !== 'in' || current.parseStatus !== 'supported' ||
        current.senderHeaderCount > 1 || current.replyToHeaderCount > 1) return false;
      const addresses = await tx.select({ role: itemRecipients.role, address: identities.normalizedValue })
        .from(itemRecipients).innerJoin(identities, and(eq(identities.id, itemRecipients.identityId), eq(identities.accountId, itemRecipients.accountId)))
        .where(and(eq(itemRecipients.itemId, itemId), eq(itemRecipients.accountId, accountId),
          sql`${itemRecipients.role} in ('reply_to', 'sender')`)).limit(102);
      const senders = addresses.filter((value) => value.role === 'sender').map((value) => value.address);
      const replyTo = addresses.filter((value) => value.role === 'reply_to').map((value) => value.address);
      if (senders.length !== 1 || senders[0] !== metadata.from ||
        (metadata.replyTo ? replyTo.length !== 1 || replyTo[0] !== metadata.replyTo : replyTo.length !== 0)) return false;
      const [saved] = await tx.update(items).set({ replyMetadata: { messageId: metadata.messageId,
        references: metadata.references, to: metadata.to } })
        .where(and(eq(items.id, itemId), eq(items.accountId, accountId), isNull(items.deletedAt),
          isNull(items.messageId), isNull(items.replyMetadata), eq(items.appliedSequence, row.appliedSequence),
          row.providerRevision === null ? isNull(items.providerRevision) : eq(items.providerRevision, row.providerRevision),
          sql`exists (select 1 from accounts a where a.id = ${accountId} and a.credential_generation = ${fetched.credentialGeneration}
            and a.revoked_at is null and ${GMAIL_MODIFY_SCOPE} = any(a.granted_scopes))`,
          orbitId ? sql`exists (select 1 from item_orbits io where io.item_id = ${items.id} and io.orbit_id = ${orbitId})` : sql`true`))
        .returning({ id: items.id });
      return !!saved;
    });
    if (!outcome) return reply.code(409).send({ error: 'This message changed while reply details loaded. Try again.' });
    const result = await run((tx) => context(tx, itemId, accountId, orbitId), true);
    return result ?? reply.code(409).send({ error: 'Reply details are unavailable. Start a new message.' });
  });
  app.post('/api/mail/drafts', { bodyLimit: 4_300_000 }, async (request, reply) => {
    const parsed = draftCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(bad);
    const value = parsed.data;
    const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const outcome = await run(async (tx) => {
      if (!await accountScope(tx, value.accountId, value.orbitId)) return { status: 404 };
      if (value.orbitId && !value.parentItemId) {
        const [account] = await tx.select({ orbitId: accounts.orbitId }).from(accounts).where(eq(accounts.id, value.accountId)).limit(1);
        if (account?.orbitId !== value.orbitId) return { status: 404 };
      }
      const [prior] = await tx.select().from(drafts).where(and(eq(drafts.ownerId, OWNER), eq(drafts.creationKey, value.creationKey))).limit(1);
      if (prior) return prior.creationDigest === digest ? { status: 200, row: prior } : { status: 409 };
      const reply = value.parentItemId ? await context(tx, value.parentItemId, value.accountId, value.orbitId) : null;
      if (value.parentItemId && !reply) return { status: 409 };
      const [inserted] = await tx.insert(drafts).values({ id: value.id, ownerId: OWNER, accountId: value.accountId,
        orbitId: value.orbitId ?? null, parentItemId: value.parentItemId ?? null, threadId: reply?.threadId ?? null,
        threadCollectionId: reply?.collectionId ?? null,
        creationKey: value.creationKey, creationDigest: digest, to: value.to, cc: value.cc, bcc: value.bcc,
        subject: value.subject, bodyText: value.bodyText, attachmentRefs: [] }).onConflictDoNothing().returning();
      if (inserted) return { status: 201, row: inserted };
      const [replay] = await tx.select().from(drafts).where(and(eq(drafts.ownerId, OWNER), eq(drafts.creationKey, value.creationKey))).limit(1);
      return replay?.creationDigest === digest ? { status: 200, row: replay } : { status: 409 };
    });
    if (!outcome.row) return reply.code(outcome.status).send(outcome.status === 404 ? unavailable : conflict);
    reply.code(outcome.status);
    return sendDraft(reply, outcome.row);
  });
  app.get('/api/mail/drafts', async (request, reply) => {
    if (!origin(request.headers)) return reply.code(403).send(bad);
    const parsed = draftQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(bad);
    const { accountId, orbitId, limit } = parsed.data;
    const cursor = cursorDecode(parsed.data.cursor, accountId, orbitId, auth.masterKey);
    if (cursor === false) return reply.code(400).send(bad);
    const result = await run(async (tx) => {
      if (!await accountScope(tx, accountId, orbitId)) return null;
      return tx.select({ id: drafts.id, accountId: drafts.accountId, orbitId: drafts.orbitId,
        threadId: drafts.threadId, parentItemId: drafts.parentItemId, subject: drafts.subject,
        revision: drafts.revision, state: drafts.state, updatedAt: drafts.updatedAt,
        updatedAtMicros: sql<string>`to_char(${drafts.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      }).from(drafts).where(and(eq(drafts.ownerId, OWNER), eq(drafts.accountId, accountId),
        orbitId ? eq(drafts.orbitId, orbitId) : undefined, eq(drafts.state, 'editing'),
        cursor ? or(sql`${drafts.updatedAt} < ${cursor.at}::timestamptz`,
          and(sql`${drafts.updatedAt} = ${cursor.at}::timestamptz`, lt(drafts.id, cursor.id))) : undefined))
        .orderBy(desc(drafts.updatedAt), desc(drafts.id)).limit(limit + 1);
    }, true);
    if (!result) return reply.code(404).send(unavailable);
    const page = result.slice(0, limit);
    const last = page.at(-1);
    const response = draftSummaryPageSchema.parse({ drafts: page.map((row) => ({ id: row.id, accountId: row.accountId,
      orbitId: row.orbitId, threadId: row.threadId, parentItemId: row.parentItemId, subject: row.subject,
      revision: row.revision, state: row.state, updatedAt: iso(row.updatedAt) })), nextCursor: result.length > limit && last ?
      cursorEncode({ at: last.updatedAtMicros, id: last.id, accountId, orbitId: orbitId ?? null }, auth.masterKey) : null });
    return Buffer.byteLength(JSON.stringify(response)) <= 512 * 1024 ? response :
      reply.code(503).send({ error: 'This draft page is too large to display.' });
  });
  app.get('/api/mail/drafts/:draftId', async (request, reply) => {
    if (!origin(request.headers)) return reply.code(403).send(bad);
    const id = (request.params as { draftId: string }).draftId;
    const parsed = draftScopeSchema.safeParse(request.query);
    if (!readerIdSchema.safeParse(id).success || !parsed.success) return reply.code(400).send(bad);
    const row = await run(async (tx) => {
      if (!await accountScope(tx, parsed.data.accountId, parsed.data.orbitId)) return null;
      const [found] = await tx.select().from(drafts).where(and(eq(drafts.id, id), eq(drafts.ownerId, OWNER),
        eq(drafts.accountId, parsed.data.accountId), parsed.data.orbitId ? eq(drafts.orbitId, parsed.data.orbitId) : undefined)).limit(1);
      return found ?? null;
    }, true);
    return row ? sendDraft(reply, row) : reply.code(404).send(unavailable);
  });
  const change = async (request: { params: unknown; query: unknown; body: unknown }, reply: FastifyReply, discard: boolean) => {
    const id = (request.params as { draftId: string }).draftId;
    const scope = draftScopeSchema.safeParse(request.query);
    const payload = discard ? draftDiscardSchema.safeParse(request.body) : draftUpdateSchema.safeParse(request.body);
    if (!readerIdSchema.safeParse(id).success || !scope.success || !payload.success) return reply.code(400).send(bad);
    const revision = payload.data.revision;
    const result = await run(async (tx) => {
      if (!await accountScope(tx, scope.data.accountId, scope.data.orbitId)) return { status: 404 };
      const [row] = await tx.select().from(drafts).where(and(eq(drafts.id, id), eq(drafts.ownerId, OWNER),
        eq(drafts.accountId, scope.data.accountId), scope.data.orbitId ? eq(drafts.orbitId, scope.data.orbitId) : undefined)).limit(1);
      if (!row) return { status: 404 };
      if (discard && row.state === 'discarded' && (row.revision === revision || row.revision === revision + 1)) return { status: 200, row };
      if (row.state !== 'editing' || row.revision !== revision) return { status: 409 };
      const data = discard ? { state: 'discarded' } : payload.data as typeof draftUpdateSchema._output;
      const [updated] = await tx.update(drafts).set({ ...(!discard ? { to: (data as typeof draftUpdateSchema._output).to,
        cc: (data as typeof draftUpdateSchema._output).cc, bcc: (data as typeof draftUpdateSchema._output).bcc,
        subject: (data as typeof draftUpdateSchema._output).subject, bodyText: (data as typeof draftUpdateSchema._output).bodyText } : { state: 'discarded' }),
        revision: revision + 1, updatedAt: new Date() })
        .where(and(eq(drafts.id, id), eq(drafts.ownerId, OWNER), eq(drafts.accountId, scope.data.accountId),
          eq(drafts.revision, revision), eq(drafts.state, 'editing'))).returning();
      return updated ? { status: 200, row: updated } : { status: 409 };
    });
    return result.row ? sendDraft(reply, result.row) : reply.code(result.status).send(result.status === 404 ? unavailable : conflict);
  };
  app.put('/api/mail/drafts/:draftId', { bodyLimit: 4_300_000 }, (request, reply) => change(request, reply, false));
  app.post('/api/mail/drafts/:draftId/discard', (request, reply) => change(request, reply, true));
}
