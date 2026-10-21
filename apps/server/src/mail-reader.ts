import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { accounts, attachments, identities, itemLabels, itemRecipients, items, labels, orbits, people, PrivateBlobStore, threads } from '@station/db';
import { MAIL_HTML_POLICY_VERSION, MAIL_LIMITS, mailContextSchema, conversationPageSchema, conversationQuerySchema, itemQuerySchema,
  labelListSchema, labelQuerySchema, messagePageSchema, readerBodySchema, readerIdSchema, threadQuerySchema } from '@station/shared';
import type { AuthConfig } from './auth.js';

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_BODY_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = MAIL_LIMITS.bodyBytes;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const imageRef = /^[a-f0-9]{32}$/;
const missing = { error: 'This mail item is no longer available.' };
const invalid = { error: 'Check the mail address and filters, then try again.' };
type Cursor = { scope: string; date: string | null; id: string };
type Row = Record<string, unknown>;
type ReaderTransaction = Parameters<Parameters<AuthConfig['db']['transaction']>[0]>[0];
function token(cursor: Cursor, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  const signature = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${signature}`;
}
function parseToken(value: string | undefined, scope: string, key: Buffer): Cursor | null | false {
  if (!value) return null;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra || body.length > 700 || signature.length !== 43) return false;
  const expected = createHmac('sha256', key).update(body).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Cursor;
    if (data.scope !== scope || !readerIdSchema.safeParse(data.id).success ||
        !(data.date === null || (typeof data.date === 'string' && !Number.isNaN(Date.parse(data.date))))) return false;
    return data;
  } catch { return false; }
}
function scopeKey(parts: unknown[], key: Buffer): string {
  return createHmac('sha256', key).update(JSON.stringify(parts)).digest('base64url');
}
function respond(reply: FastifyReply, schema: { parse(value: unknown): unknown }, value: unknown) {
  const result = schema.parse(value);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES) return reply.code(503).send({ error: 'This mail page is too large. Narrow the view and try again.' });
  return result;
}
function respondBody(reply: FastifyReply, itemId: string, value: unknown) {
  const result = readerBodySchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BODY_RESPONSE_BYTES)
    return reply.send(readerBodySchema.parse({ itemId, status: 'unavailable', text: null, html: null,
      htmlPolicyVersion: null, imageRefs: [] }));
  return result;
}
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const cursorDate = (value: Date | string | null) => value === null ? null : typeof value === 'string' ? value : value.toISOString();
const safeFilename = (value: string | null): string => {
  // Provider display names are untrusted response header input.
  // eslint-disable-next-line no-control-regex
  const cleaned = (value ?? 'attachment').replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e]/g, '_').replace(/^[.\s]+/, '').trim();
  // Array.from keeps supplementary characters intact. Persisted legacy data
  // may already contain a lone surrogate, which cannot be URI encoded.
  const bounded = Array.from(cleaned, (character) => {
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff ? '\ufffd' : character;
  }).slice(0, 180).join('');
  return bounded || 'attachment';
};
function disposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
export function registerMailReader(app: FastifyInstance, auth: AuthConfig, blobStore?: PrivateBlobStore): void {
  const db = auth.db;
  // Every reader DB stage has transaction-local deadlines. File I/O happens
  // after the transaction closes, so a slow blob read cannot hold a client.
  const readerDb = <T>(work: (tx: ReaderTransaction) => Promise<T>): Promise<T> => db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    return work(tx);
  }, { accessMode: 'read only' });
  const sameOrigin = (headers: Record<string, unknown>) =>
    (!headers.origin || headers.origin === auth.origin) && headers['sec-fetch-site'] !== 'cross-site';
  const visible = (orbitId?: string) => orbitId ? sql`exists (select 1 from item_orbits io where io.item_id = ${items.id} and io.orbit_id = ${orbitId})` : sql`true`;
  const accountExists = async (tx: ReaderTransaction, accountId: string) => {
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    return !!account;
  };
  const orbitExists = async (tx: ReaderTransaction, orbitId: string) => {
    const [orbit] = await tx.select({ id: orbits.id }).from(orbits).where(eq(orbits.id, orbitId)).limit(1);
    return !!orbit;
  };
  const selectedItem = async (tx: ReaderTransaction, itemId: string, accountId: string, orbitId?: string) => {
    const [item] = await tx.select({ id: items.id, threadId: items.threadId, accountId: items.accountId,
      bodyText: items.bodyText, bodyHtmlPath: items.bodyHtmlPath, htmlPolicyVersion: items.htmlPolicyVersion,
      imageMetadata: items.imageMetadata, parseStatus: items.parseStatus }).from(items)
      .where(and(eq(items.id, itemId), eq(items.accountId, accountId), isNull(items.deletedAt), visible(orbitId))).limit(1);
    return item;
  };
  app.get('/api/mail/context', async (request, reply) => {
    if (!sameOrigin(request.headers)) return reply.code(403).send(invalid);
    const result = await readerDb(async (tx) => {
      const orbitRows = await tx.select({ id: orbits.id, name: orbits.name, colorSlot: orbits.colorSlot })
        .from(orbits).orderBy(asc(orbits.createdAt), asc(orbits.id)).limit(101);
      const accountRows = await tx.select({ id: accounts.id, orbitId: accounts.orbitId, email: accounts.email,
        provider: accounts.provider, revokedAt: accounts.revokedAt }).from(accounts)
        .orderBy(asc(accounts.email), asc(accounts.id)).limit(101);
      return { orbitRows, accountRows };
    });
    if (result.orbitRows.length > 100 || result.accountRows.length > 100)
      return reply.code(503).send({ error: 'Too many mail contexts to display.' });
    return respond(reply, mailContextSchema, { orbits: result.orbitRows,
      accounts: result.accountRows.map(({ revokedAt, ...account }) => ({ ...account, needsReconnect: revokedAt !== null })) });
  });
  app.get('/api/mail/labels', async (request, reply) => {
    if (!sameOrigin(request.headers)) return reply.code(403).send(invalid);
    const parsed = labelQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(invalid);
    const { accountId, orbitId } = parsed.data;
    const rows = await readerDb(async (tx) => {
      if (accountId ? !await accountExists(tx, accountId) : !await orbitExists(tx, orbitId!)) return null;
      return tx.select({ id: labels.id, accountId: labels.accountId, name: labels.name }).from(labels)
        .where(accountId ? eq(labels.accountId, accountId) : sql`exists (
          select 1 from item_labels il join items i on i.id = il.item_id and i.account_id = il.account_id
          join item_orbits io on io.item_id = i.id
          where il.label_id = ${labels.id} and i.deleted_at is null and io.orbit_id = ${orbitId}
        )`)
        .orderBy(asc(labels.name), asc(labels.id)).limit(501);
    });
    if (!rows) return reply.code(404).send(missing);
    if (rows.length > 500) return reply.code(503).send({ error: 'Too many labels to display.' });
    return respond(reply, labelListSchema, { labels: rows });
  });
  app.get('/api/mail/conversations', async (request, reply) => {
    if (!sameOrigin(request.headers)) return reply.code(403).send(invalid);
    const parsed = conversationQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(invalid);
    const { accountId, orbitId, labelId, subject, limit } = parsed.data;
    const scope = scopeKey(['conversations', accountId ?? null, orbitId ?? null, labelId ?? null, subject ?? null], auth.masterKey);
    const cursor = parseToken(parsed.data.cursor, scope, auth.masterKey);
    if (cursor === false) return reply.code(400).send(invalid);
    const accountWhere = accountId ? sql`i.account_id = ${accountId}` : sql`true`;
    const orbitWhere = orbitId ? sql`exists (select 1 from item_orbits io where io.item_id = i.id and io.orbit_id = ${orbitId})` : sql`true`;
    const labelWhere = labelId ? sql`exists (select 1 from item_labels il where il.item_id = i.id and il.label_id = ${labelId})` : sql`true`;
    const subjectWhere = subject ? sql`position(lower(${subject}) in lower(coalesce(i.subject, ''))) > 0` : sql`true`;
    const after = !cursor ? sql`true` : cursor.date === null
      ? sql`activity is null and thread_id < ${cursor.id}`
      : sql`(activity < ${cursor.date}::timestamptz or activity is null or (activity = ${cursor.date}::timestamptz and thread_id < ${cursor.id}))`;
    // The statement deadline bounds work even when a broad filter touches a large mailbox.
    const result = await readerDb(async (tx) => {
      if (accountId ? !await accountExists(tx, accountId) : !await orbitExists(tx, orbitId!)) return null;
      if (labelId) {
        const [label] = await tx.select({ accountId: labels.accountId }).from(labels).where(eq(labels.id, labelId)).limit(1);
        if (!label || (accountId && label.accountId !== accountId)) return null;
      }
      return tx.execute(sql`with visible as (
        select i.id, i.thread_id, i.account_id, i.subject, i.snippet,
          coalesce(i.internal_at, i.received_at, i.sent_at) activity
        from items i where i.deleted_at is null and ${accountWhere} and ${orbitWhere} and ${labelWhere} and ${subjectWhere}
      ), ranked as (
        select *, count(*) over (partition by thread_id) message_count,
          row_number() over (partition by thread_id order by activity desc nulls last, id desc) rn
        from visible
      ), summaries as (
        select thread_id, account_id, subject, snippet, activity, message_count from ranked where rn = 1
      ) select thread_id, account_id, subject, snippet, activity, message_count from summaries
      where ${after} order by activity desc nulls last, thread_id desc limit ${limit + 1}`);
    });
    if (!result) return reply.code(404).send(missing);
    const rows = result.rows as Array<{ thread_id: string; account_id: string; subject: string | null; snippet: string | null; activity: string | null; message_count: string }>;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return respond(reply, conversationPageSchema, { conversations: page.map((row) => ({
      threadId: row.thread_id, accountId: row.account_id, subject: row.subject, snippet: row.snippet,
      lastActivityAt: iso(row.activity), messageCount: Number(row.message_count),
    })), nextCursor: rows.length > limit && last ? token({ scope, date: cursorDate(last.activity), id: last.thread_id }, auth.masterKey) : null });
  });
  app.get('/api/mail/threads/:threadId/messages', async (request, reply) => {
    if (!sameOrigin(request.headers)) return reply.code(403).send(invalid);
    const threadId = (request.params as Row).threadId;
    const parsed = threadQuerySchema.safeParse(request.query);
    if (!readerIdSchema.safeParse(threadId).success || !parsed.success) return reply.code(400).send(invalid);
    const { accountId, orbitId, limit } = parsed.data;
    const scope = scopeKey(['thread', threadId, accountId, orbitId ?? null], auth.masterKey);
    const cursor = parseToken(parsed.data.cursor, scope, auth.masterKey);
    if (cursor === false) return reply.code(400).send(invalid);
    const activity = sql<Date | null>`date_trunc('milliseconds', coalesce(${items.internalAt}, ${items.receivedAt}, ${items.sentAt}))`;
    const after = !cursor ? sql`true` : cursor.date === null
      ? sql`${activity} is null and ${items.id} > ${cursor.id}`
      : sql`(${activity} > ${cursor.date}::timestamptz or ${activity} is null or (${activity} = ${cursor.date}::timestamptz and ${items.id} > ${cursor.id}))`;
    const metadata = await readerDb(async (tx) => {
      const [thread] = await tx.select({ id: threads.id }).from(threads)
        .where(and(eq(threads.id, threadId as string), eq(threads.accountId, accountId))).limit(1);
      if (!thread) return null;
      const rows = await tx.select({ id: items.id, threadId: items.threadId, accountId: items.accountId,
        subject: items.subject, snippet: items.snippet, internalAt: items.internalAt, sentAt: items.sentAt,
        receivedAt: items.receivedAt, direction: items.direction, parseStatus: items.parseStatus,
        itemSequence: items.appliedSequence, itemRevision: items.providerRevision,
        fromPersonId: items.fromPersonId, activity }).from(items)
        .where(and(eq(items.threadId, thread.id), eq(items.accountId, accountId), isNull(items.deletedAt), visible(orbitId), after))
        .orderBy(asc(activity), asc(items.id)).limit(limit + 1);
      if (!rows.length) {
        const [stillVisible] = await tx.select({ id: items.id }).from(items)
          .where(and(eq(items.threadId, thread.id), eq(items.accountId, accountId), isNull(items.deletedAt), visible(orbitId))).limit(1);
        if (!stillVisible) return null;
      }
      const page = rows.slice(0, limit);
      const ids = page.map((row) => row.id);
      const labelRows = await tx.select({ itemId: itemLabels.itemId, id: labels.id, name: labels.name }).from(itemLabels)
        .innerJoin(labels, and(eq(labels.id, itemLabels.labelId), eq(labels.accountId, itemLabels.accountId)))
        .where(inArray(itemLabels.itemId, ids)).limit(3001);
      const recipientRows = await tx.select({ itemId: itemRecipients.itemId, role: itemRecipients.role, address: identities.normalizedValue,
        name: people.displayName }).from(itemRecipients)
        .innerJoin(identities, and(eq(identities.id, itemRecipients.identityId), eq(identities.accountId, itemRecipients.accountId)))
        .innerJoin(people, eq(people.id, identities.personId)).where(inArray(itemRecipients.itemId, ids)).limit(3001);
      const attachmentRows = await tx.select({ itemId: attachments.itemId, id: attachments.id, filename: attachments.filename,
        mimeType: attachments.mimeType, size: attachments.size, related: attachments.related }).from(attachments)
        .where(inArray(attachments.itemId, ids)).limit(1921);
      const fromRows = await tx.select({ id: people.id, name: people.displayName, address: identities.normalizedValue }).from(people)
        .innerJoin(identities, eq(identities.personId, people.id))
        .where(and(inArray(people.id, page.map((row) => row.fromPersonId).filter((id): id is string => id !== null)), eq(identities.accountId, accountId))).limit(3001);
      return { rows, page, labelRows, recipientRows, attachmentRows, fromRows };
    });
    if (!metadata) return reply.code(404).send(missing);
    const { rows, page, labelRows, recipientRows, attachmentRows, fromRows } = metadata;
    if (labelRows.length > 3000 || recipientRows.length > 3000 || attachmentRows.length > 1920 || fromRows.length > 3000)
      return reply.code(503).send({ error: 'This thread has too much metadata to display.' });
    const last = page.at(-1);
    return respond(reply, messagePageSchema, { messages: page.map((row) => ({ id: row.id, threadId: row.threadId,
      accountId: row.accountId, itemSequence: row.itemSequence, itemRevision: row.itemRevision,
      subject: row.subject, snippet: row.snippet, internalAt: iso(row.internalAt),
      sentAt: iso(row.sentAt), receivedAt: iso(row.receivedAt), direction: row.direction, parseStatus: row.parseStatus,
      from: (() => { const person = fromRows.find((entry) => entry.id === row.fromPersonId);
        return person ? { name: person.name, address: person.address } : null; })(),
      labels: labelRows.filter((label) => label.itemId === row.id).map(({ id, name }) => ({ id, name })),
      recipients: recipientRows.filter((recipient) => recipient.itemId === row.id).map(({ role, address, name }) => ({ role, address, name })),
      attachments: attachmentRows.filter((attachment) => attachment.itemId === row.id).map(({ id, filename, mimeType, size, related }) => ({ id, filename, mimeType, size, related })),
    })), nextCursor: rows.length > limit && last ? token({ scope, date: iso(last.activity), id: last.id }, auth.masterKey) : null });
  });
  app.get('/api/mail/items/:itemId/body', async (request, reply) => {
    if (!sameOrigin(request.headers)) return reply.code(403).send(invalid);
    const itemId = (request.params as Row).itemId;
    const parsed = itemQuerySchema.safeParse(request.query);
    if (!readerIdSchema.safeParse(itemId).success || !parsed.success) return reply.code(400).send(invalid);
    const item = await readerDb((tx) => selectedItem(tx, itemId as string, parsed.data.accountId, parsed.data.orbitId));
    if (!item) return reply.code(404).send(missing);
    if (item.parseStatus !== 'supported') return respondBody(reply, itemId as string, { itemId, status: 'unsupported', text: null, html: null, htmlPolicyVersion: null, imageRefs: [] });
    let html: string | null = null;
    let unavailable = false;
    if (item.bodyHtmlPath) {
      if (!blobStore || item.htmlPolicyVersion !== MAIL_HTML_POLICY_VERSION || !Array.isArray(item.imageMetadata)) unavailable = true;
      else try {
        const bytes = await blobStore.read(item.bodyHtmlPath);
        if (bytes.byteLength > 1_048_576) unavailable = true;
        else html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch { unavailable = true; }
    }
    if (item.bodyText && Buffer.byteLength(item.bodyText) > MAX_TEXT_BYTES) unavailable = true;
    const metadata = item.imageMetadata;
    const refs = Array.isArray(metadata) ? metadata.flatMap((entry) =>
      entry && typeof entry === 'object' && 'refId' in entry && typeof entry.refId === 'string' && imageRef.test(entry.refId) ? [entry.refId] : []) : [];
    const htmlRefs = html ? [...html.matchAll(/data-station-image-ref="([^"]*)"/g)].map((match) => match[1]) : [];
    if (Array.isArray(metadata) && (refs.length !== metadata.length || new Set(refs).size !== refs.length)) unavailable = true;
    if (refs.length > 64 || htmlRefs.length !== refs.length || !htmlRefs.every((ref) => refs.includes(ref))) unavailable = true;
    return respondBody(reply, itemId as string, { itemId, status: unavailable ? 'unavailable' : 'available',
      text: unavailable ? null : item.bodyText, html: unavailable ? null : html,
      htmlPolicyVersion: unavailable || !html ? null : MAIL_HTML_POLICY_VERSION,
      imageRefs: unavailable ? [] : refs });
  });
  app.get('/api/mail/items/:itemId/attachments/:attachmentId/download', async (request, reply) => {
    if (!sameOrigin(request.headers)) return reply.code(403).send(invalid);
    const { itemId, attachmentId } = request.params as Record<string, unknown>;
    const parsed = itemQuerySchema.safeParse(request.query);
    if (!readerIdSchema.safeParse(itemId).success || !readerIdSchema.safeParse(attachmentId).success || !parsed.success)
      return reply.code(400).send(invalid);
    const file = await readerDb(async (tx) => {
      const item = await selectedItem(tx, itemId as string, parsed.data.accountId, parsed.data.orbitId);
      if (!item) return null;
      const [attachment] = await tx.select({ filename: attachments.filename, size: attachments.size, key: attachments.storagePath })
        .from(attachments).where(and(eq(attachments.id, attachmentId as string), eq(attachments.itemId, item.id),
          eq(attachments.accountId, item.accountId))).limit(1);
      return attachment ?? null;
    });
    if (!file) return reply.code(404).send(missing);
    if (file.size > MAX_ATTACHMENT_BYTES || !blobStore) return reply.code(503).send({ error: 'This attachment is unavailable.' });
    let data: Buffer;
    try { data = await blobStore.read(file.key); } catch { return reply.code(503).send({ error: 'This attachment is unavailable.' }); }
    if (data.byteLength !== file.size || data.byteLength > MAX_ATTACHMENT_BYTES) return reply.code(503).send({ error: 'This attachment is unavailable.' });
    reply.header('Content-Disposition', disposition(safeFilename(file.filename)));
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(data);
  });
}
