import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addressParser } from 'postal-mime';
import { GmailSendAdapter, GoogleCredentialError, GoogleCredentialService, GMAIL_MODIFY_SCOPE, type SentEvidence } from '@station/connectors';
import { accounts, auditLog, draftAttachments, drafts, identities, itemRecipients, items, outboundOperations, PrivateBlobStore, threads } from '@station/db';
import { draftUpdateSchema, sendOperationSchema, sendRequestSchema, sendScopeSchema } from '@station/shared';
import type { AuthConfig } from './auth.js';
import { composeMime, MAX_MIME_BYTES, type Address, type FrozenAttachment } from './send-mime.js';
import { storedReplyMetadata } from './drafts.js';

type Tx = Parameters<Parameters<AuthConfig['db']['transaction']>[0]>[0];
type Row = typeof outboundOperations.$inferSelect;
const OWNER = 'owner';
const absent = { error: 'This send is unavailable in this account and Orbit.' };
const conflict = { error: 'The draft changed. Reload it before sending.' };
const headerId = /^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9]+(?:[A-Za-z0-9.-]*[A-Za-z0-9])?>$/;
// eslint-disable-next-line no-control-regex
const noControl = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const mailbox = z.email().max(254);

function message(row: Row) {
  const state = row.state === 'in_flight' && Date.now() - row.updatedAt.getTime() > 30_000 ? 'outcome_unknown' : row.state;
  const detail = state === 'succeeded' ? 'Gmail confirmed this message.' : state === 'outcome_unknown' ?
    'Delivery may have happened. Check Sent or reconcile; this operation will not resend.' : state === 'failed' ?
    'The message was not submitted. Check the draft and start a new send.' :
    'The send is being prepared or submitted.';
  return sendOperationSchema.parse({ id: row.id, draftId: row.draftId, accountId: row.accountId, orbitId: row.orbitId,
    state, providerResultId: row.providerResultId, updatedAt: row.updatedAt.toISOString(), message: detail });
}

function addresses(value: unknown): Address[] | null {
  if (!Array.isArray(value)) return null;
  const result = z.array(z.object({ address: mailbox, name: z.string().max(512).refine(noControl) }).strict()).max(100).safeParse(value);
  return result.success ? result.data : null;
}

function headers(evidence: SentEvidence, name: string): string[] {
  return evidence.payload.headers.filter((header) => header.name.toLowerCase() === name).map((header) => header.value);
}

function parsedAddresses(values: string[]): string[] | null {
  if (values.length > 1) return null;
  if (!values.length) return [];
  try {
    const entries = addressParser(values[0]!);
    if (entries.some((entry) => !entry.address || !mailbox.safeParse(entry.address).success)) return null;
    return entries.map((entry) => entry.address!.toLowerCase());
  } catch { return null; }
}

function evidenceMatches(row: Row, evidence: SentEvidence): boolean {
  if (!evidence.labelIds.includes('SENT') || headers(evidence, 'message-id').length !== 1 ||
    headers(evidence, 'message-id')[0] !== row.messageId || headers(evidence, 'from').length !== 1) return false;
  const from = parsedAddresses(headers(evidence, 'from'));
  if (!from || from.length !== 1 || from[0] !== row.fromAddress.toLowerCase()) return false;
  const selected = row.recipientAddresses as { to: string[]; cc: string[]; bcc: string[] };
  for (const role of ['to', 'cc', 'bcc'] as const) {
    const actual = parsedAddresses(headers(evidence, role));
    const expected = selected[role].map((value) => value.toLowerCase());
    if (!actual) return false;
    // Gmail may remove Bcc from a Sent copy, but a present Bcc must agree.
    if ((role !== 'bcc' || actual.length) && (actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index]))) return false;
  }
  return !row.providerThreadId || evidence.threadId === row.providerThreadId;
}

export function registerSend(app: FastifyInstance, auth: AuthConfig, store: PrivateBlobStore,
  provider: Pick<GmailSendAdapter, 'credential' | 'send' | 'findSent'> =
    new GmailSendAdapter(new GoogleCredentialService(auth.db, auth.masterKey, auth.googleTransport))): void {
  const db = auth.db;
  let activeSends = 0;
  const run = <T>(work: (tx: Tx) => Promise<T>, readOnly = false): Promise<T> => db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    return work(tx);
  }, readOnly ? { accessMode: 'read only' } : undefined);
  const exactOrigin = (headers: Record<string, unknown>) => headers.origin === auth.origin && headers['sec-fetch-site'] !== 'cross-site';
  const readOrigin = (headers: Record<string, unknown>) => (!headers.origin || headers.origin === auth.origin) &&
    headers['sec-fetch-site'] !== 'cross-site';
  const scoped = (tx: Tx, operationId: string, accountId: string, orbitId?: string) => tx.select().from(outboundOperations)
    .where(and(eq(outboundOperations.id, operationId), eq(outboundOperations.ownerId, OWNER),
      eq(outboundOperations.accountId, accountId), orbitId ? eq(outboundOperations.orbitId, orbitId) : isNull(outboundOperations.orbitId)))
    .limit(1);
  const audit = (tx: Tx, action: string, targetId: string) => tx.insert(auditLog).values({
    id: randomUUID(), actorId: OWNER, action, targetId,
  });
  const failPending = async (id: string, error: string) => run(async (tx) => {
    const [row] = await tx.select().from(outboundOperations).where(eq(outboundOperations.id, id)).for('update');
    if (!row || row.state !== 'pending') return;
    await tx.update(outboundOperations).set({ state: 'failed', lastError: error, updatedAt: new Date(), completedAt: new Date() })
      .where(eq(outboundOperations.id, id));
    await tx.update(drafts).set({ state: 'editing', updatedAt: new Date() })
      .where(and(eq(drafts.id, row.draftId), eq(drafts.state, 'sending')));
    await audit(tx, 'send_failed', row.id);
  });

  app.post('/api/mail/drafts/:draftId/send', async (request, reply) => {
    if (!exactOrigin(request.headers)) return reply.code(403).send({ error: 'Reload this page and try again.' });
    const draftId = (request.params as { draftId?: string }).draftId;
    const scope = sendScopeSchema.safeParse(request.query);
    const body = sendRequestSchema.safeParse(request.body);
    if (!draftId || !z.uuid().safeParse(draftId).success || !scope.success || !body.success)
      return reply.code(400).send({ error: 'Check the send request and try again.' });
    const { accountId, orbitId } = scope.data;
    const { idempotencyKey, revision } = body.data;
    if (activeSends >= 2) return reply.code(503).send({ error: 'Send preparation is busy. Try again shortly.' });
    activeSends++;
    try {
    const requestDigest = createHash('sha256').update(JSON.stringify({ draftId, accountId, orbitId: orbitId ?? null, revision })).digest('hex');
    const reserved = await run(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${idempotencyKey}))`);
      const [prior] = await tx.select().from(outboundOperations).where(and(eq(outboundOperations.ownerId, OWNER),
        eq(outboundOperations.idempotencyKey, idempotencyKey))).limit(1);
      if (prior) return prior.requestDigest === requestDigest ? { status: 200 as const, row: prior } : { status: 409 as const };
      const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, draftId), eq(drafts.ownerId, OWNER),
        eq(drafts.accountId, accountId), orbitId ? eq(drafts.orbitId, orbitId) : isNull(drafts.orbitId))).for('update');
      if (!draft) return { status: 404 as const };
      if (draft.state !== 'editing' || draft.revision !== revision) return { status: 409 as const };
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (!account || account.provider !== 'google' || account.revokedAt || !account.grantedScopes.includes(GMAIL_MODIFY_SCOPE) ||
        !mailbox.safeParse(account.email).success || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(account.email))
        return { status: 409 as const };
      if (!draft.parentItemId && draft.orbitId && draft.orbitId !== account.orbitId) return { status: 409 as const };
      const content = draftUpdateSchema.safeParse({ to: draft.to, cc: draft.cc, bcc: draft.bcc,
        subject: draft.subject, bodyText: draft.bodyText, attachmentRefs: draft.attachmentRefs, revision });
      if (!content.success || !addresses(draft.to) || !addresses(draft.cc) || !addresses(draft.bcc) ||
        content.data.to.length + content.data.cc.length + content.data.bcc.length === 0) return { status: 422 as const };
      const refs = content.data.attachmentRefs;
      if (new Set(refs).size !== refs.length) return { status: 409 as const };
      const attachments = refs.length ? await tx.select().from(draftAttachments).where(and(eq(draftAttachments.draftId, draftId),
        eq(draftAttachments.accountId, accountId), sql`${draftAttachments.id} in (${sql.join(refs.map((ref) => sql`${ref}`), sql`, `)})`)).limit(65) : [];
      if (attachments.length !== refs.length || attachments.some((item) => item.state !== 'ready') ||
        attachments.reduce((sum, item) => sum + item.byteSize, 0) > 8 * 1024 * 1024) return { status: 409 as const };
      let replyContext: { providerThreadId: string; messageId: string; references: string;
        appliedSequence: number; providerRevision: string | null; } | undefined;
      if (draft.parentItemId) {
        const [parent] = await tx.select({ id: items.id, direction: items.direction, parseStatus: items.parseStatus,
          messageId: items.messageId, referencesHeader: items.referencesHeader, replyMetadata: items.replyMetadata,
          subject: items.subject, externalThreadId: threads.externalId, threadId: items.threadId,
          senderComplete: items.senderIdentitiesComplete, senderCount: items.senderHeaderCount,
          replyComplete: items.replyToIdentitiesComplete, replyCount: items.replyToHeaderCount,
          appliedSequence: items.appliedSequence, providerRevision: items.providerRevision })
          .from(items).innerJoin(threads, eq(threads.id, items.threadId))
          .where(and(eq(items.id, draft.parentItemId), eq(items.accountId, accountId), isNull(items.deletedAt),
            orbitId ? sql`exists (select 1 from item_orbits io where io.item_id = ${items.id} and io.orbit_id = ${orbitId})` : undefined)).limit(1);
        const snapshot = storedReplyMetadata(parent?.replyMetadata);
        const parentMessageId = snapshot?.messageId ?? parent?.messageId;
        const prior = snapshot?.references ?? parent?.referencesHeader;
        const references = `${prior ? `${prior} ` : ''}${parentMessageId ?? ''}`;
        const expectedSubject = /^re:/i.test(parent?.subject ?? '') ? parent?.subject : `Re: ${parent?.subject ?? ''}`;
        if (!parent || parent.direction !== 'in' || parent.parseStatus !== 'supported' || parent.threadId !== draft.threadId ||
          (parent.replyMetadata !== null && !snapshot) ||
          (!snapshot && (!parent.senderComplete || parent.senderCount !== 1 || !parent.replyComplete || parent.replyCount > 1)) ||
          !parentMessageId || !headerId.test(parentMessageId) || !noControl(references) || references.length > 8192 ||
          references.split(/\s+/).some((part) => !headerId.test(part)) || draft.subject !== expectedSubject ||
          !noControl(parent.externalThreadId) || parent.externalThreadId.length > 1024) return { status: 409 as const };
        const identitiesForReply = await tx.select({ role: itemRecipients.role, address: identities.normalizedValue })
          .from(itemRecipients).innerJoin(identities, and(eq(identities.id, itemRecipients.identityId),
            eq(identities.accountId, itemRecipients.accountId)))
          .where(and(eq(itemRecipients.itemId, parent.id), eq(itemRecipients.accountId, accountId),
            sql`${itemRecipients.role} in ('sender', 'reply_to')`)).limit(102);
        const senders = identitiesForReply.filter((row) => row.role === 'sender').map((row) => row.address);
        const replyTos = identitiesForReply.filter((row) => row.role === 'reply_to').map((row) => row.address);
        const choice = replyTos.length ? replyTos : senders;
        if (choice.length !== 1 || (snapshot && snapshot.to !== choice[0])) return { status: 409 as const };
        replyContext = { providerThreadId: parent.externalThreadId, messageId: parentMessageId, references,
          appliedSequence: parent.appliedSequence, providerRevision: parent.providerRevision };
      }
      const id = randomUUID();
      const row = (await tx.insert(outboundOperations).values({ id, ownerId: OWNER, draftId, accountId,
        orbitId: orbitId ?? null, idempotencyKey, requestDigest, draftRevision: revision,
        blobKey: PrivateBlobStore.generateKey(), messageId: `<${randomUUID()}@${account.email.split('@')[1]}>`, fromAddress: account.email,
        attachmentRefs: refs,
        recipientAddresses: { to: content.data.to.map((value) => value.address), cc: content.data.cc.map((value) => value.address),
          bcc: content.data.bcc.map((value) => value.address) }, providerThreadId: replyContext?.providerThreadId ?? null,
      }).returning())[0]!;
      await tx.update(drafts).set({ state: 'sending', updatedAt: new Date() }).where(eq(drafts.id, draftId));
      await audit(tx, 'send_requested', id);
      return { status: 201 as const, row, draft: content.data, attachments, replyContext };
    });
    if (!reserved.row) return reply.code(reserved.status).send(reserved.status === 404 ? absent :
      reserved.status === 422 ? { error: 'Add a recipient and check the draft before sending.' } : conflict);
    if (reserved.status === 200) return message(reserved.row);
    let mime: { bytes: Buffer; digest: string };
    try {
      const frozen: FrozenAttachment[] = [];
      for (const ref of reserved.draft.attachmentRefs) {
        const attachment = reserved.attachments.find((item) => item.id === ref)!;
        const bytes = await store.read(attachment.blobKey, Math.max(1, attachment.byteSize));
        if (bytes.length !== attachment.byteSize || createHash('sha256').update(bytes).digest('hex') !== attachment.digest)
          throw new Error('attachment_changed');
        frozen.push({ filename: attachment.filename, bytes });
      }
      mime = await composeMime({ from: reserved.row.fromAddress, to: reserved.draft.to, cc: reserved.draft.cc,
        bcc: reserved.draft.bcc, subject: reserved.draft.subject, body: reserved.draft.bodyText,
        messageId: reserved.row.messageId, date: reserved.row.userActionAt,
        ...(reserved.replyContext ? { inReplyTo: reserved.replyContext.messageId, references: reserved.replyContext.references } : {}),
        attachments: frozen });
      await run(async (tx) => {
        const [locked] = await tx.select().from(outboundOperations).where(eq(outboundOperations.id, reserved.row.id)).for('update');
        if (!locked || locked.state !== 'pending') throw new Error('send_intent_changed');
        await store.writeReserved(locked.blobKey, mime.bytes);
        const published = await store.read(locked.blobKey, MAX_MIME_BYTES);
        if (published.length !== mime.bytes.length || createHash('sha256').update(published).digest('hex') !== mime.digest)
          throw new Error('send_blob_changed');
        await tx.update(outboundOperations).set({ blobReady: true, mimeDigest: mime.digest,
          mimeBytes: mime.bytes.length, updatedAt: new Date() }).where(eq(outboundOperations.id, locked.id));
      });
    } catch {
      await failPending(reserved.row.id, 'preparation_failed');
      return reply.code(422).send({ error: 'This draft cannot be sent. Check attachments and keep the MIME message under 12 MiB.' });
    }
    let credential: Awaited<ReturnType<typeof provider.credential>>;
    try { credential = await provider.credential(accountId); }
    catch (error) {
      await failPending(reserved.row.id, 'credential_preflight');
      return error instanceof GoogleCredentialError && (error.code === 'needs_reconnect' || error.code === 'not_found') ?
        reply.code(409).send({ error: 'Reconnect this Gmail account, then send again.' }) :
        reply.code(503).send({ error: 'Gmail was unavailable before sending. Try again shortly.' });
    }
    const claimed = await run(async (tx) => {
      const [draft] = await tx.select({ state: drafts.state, revision: drafts.revision, orbitId: drafts.orbitId,
        parentItemId: drafts.parentItemId }).from(drafts).where(eq(drafts.id, draftId)).limit(1);
      if (!draft || draft.state !== 'sending' || draft.revision !== revision || draft.orbitId !== (orbitId ?? null)) return false;
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (!account || account.revokedAt || account.credentialGeneration !== credential.generation ||
        !account.grantedScopes.includes(GMAIL_MODIFY_SCOPE) || account.email !== reserved.row.fromAddress) return false;
      if (!draft.parentItemId && draft.orbitId && account.orbitId !== draft.orbitId) return false;
      if (reserved.replyContext) {
        const [parent] = await tx.select({ appliedSequence: items.appliedSequence,
          providerRevision: items.providerRevision, direction: items.direction, parseStatus: items.parseStatus })
          .from(items).where(and(eq(items.id, draft.parentItemId!), eq(items.accountId, accountId), isNull(items.deletedAt),
            orbitId ? sql`exists (select 1 from item_orbits io where io.item_id = ${items.id} and io.orbit_id = ${orbitId})` : undefined)).limit(1);
        if (!parent || parent.appliedSequence !== reserved.replyContext.appliedSequence ||
          parent.providerRevision !== reserved.replyContext.providerRevision || parent.direction !== 'in' ||
          parent.parseStatus !== 'supported') return false;
      }
      const [row] = await tx.update(outboundOperations).set({ state: 'in_flight', attemptCount: 1,
        credentialGeneration: credential.generation, updatedAt: new Date() })
        .where(and(eq(outboundOperations.id, reserved.row.id), eq(outboundOperations.state, 'pending'),
          eq(outboundOperations.blobReady, true))).returning();
      return !!row;
    });
    if (!claimed) { await failPending(reserved.row.id, 'credential_changed');
      return reply.code(409).send({ error: 'The Gmail connection changed. Reload the draft and send again.' }); }
    try {
      // The claim commits before this call. Every thrown error is ambiguous.
      const result = await provider.send(accountId, credential.accessToken, mime.bytes, reserved.row.providerThreadId ?? undefined);
      const complete = await run(async (tx) => {
        const [row] = await tx.update(outboundOperations).set({ state: 'succeeded', providerResultId: result.id,
          completedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(outboundOperations.id, reserved.row.id), eq(outboundOperations.state, 'in_flight'))).returning();
        if (row) {
          await tx.update(drafts).set({ state: 'sent', attachmentRefs: [], updatedAt: new Date() })
            .where(and(eq(drafts.id, row.draftId), eq(drafts.state, 'sending')));
          await tx.update(draftAttachments).set({ state: 'delete_pending', updatedAt: new Date() })
            .where(and(eq(draftAttachments.draftId, row.draftId), eq(draftAttachments.state, 'ready')));
          await audit(tx, 'send_succeeded', row.id);
        }
        return row;
      });
      return complete ? message(complete) : reply.code(503).send({ error: 'Send confirmation could not be saved. Check this operation before doing anything else.' });
    } catch {
      const unknown = await run(async (tx) => {
        const [row] = await tx.update(outboundOperations).set({ state: 'outcome_unknown', lastError: 'provider_outcome_unknown',
          updatedAt: new Date() }).where(and(eq(outboundOperations.id, reserved.row.id), eq(outboundOperations.state, 'in_flight'))).returning();
        if (row) await audit(tx, 'send_unknown', row.id);
        return row;
      }).catch(() => undefined);
      return unknown ? reply.code(202).send(message(unknown)) : reply.code(503).send({
        error: 'Send outcome is unknown. Check this operation and Sent before any new send.' });
    }
    } finally { activeSends--; }
  });

  app.get('/api/mail/sends/:operationId', async (request, reply) => {
    if (!readOrigin(request.headers)) return reply.code(403).send(absent);
    const operationId = (request.params as { operationId?: string }).operationId;
    const scope = sendScopeSchema.safeParse(request.query);
    if (!operationId || !z.uuid().safeParse(operationId).success || !scope.success) return reply.code(400).send(absent);
    const [row] = await run((tx) => scoped(tx, operationId, scope.data.accountId, scope.data.orbitId), true);
    return row ? message(row) : reply.code(404).send(absent);
  });

  app.get('/api/mail/drafts/:draftId/send', async (request, reply) => {
    if (!readOrigin(request.headers)) return reply.code(403).send(absent);
    const draftId = (request.params as { draftId?: string }).draftId;
    const scope = sendScopeSchema.safeParse(request.query);
    if (!draftId || !z.uuid().safeParse(draftId).success || !scope.success) return reply.code(400).send(absent);
    const [row] = await run((tx) => tx.select().from(outboundOperations).where(and(
      eq(outboundOperations.draftId, draftId), eq(outboundOperations.ownerId, OWNER),
      eq(outboundOperations.accountId, scope.data.accountId), scope.data.orbitId ?
        eq(outboundOperations.orbitId, scope.data.orbitId) : isNull(outboundOperations.orbitId)))
      .orderBy(sql`${outboundOperations.userActionAt} desc`).limit(1), true);
    return row ? message(row) : reply.code(404).send(absent);
  });

  app.post('/api/mail/sends/:operationId/reconcile', async (request, reply) => {
    if (!exactOrigin(request.headers)) return reply.code(403).send(absent);
    const operationId = (request.params as { operationId?: string }).operationId;
    const scope = sendScopeSchema.safeParse(request.query);
    if (!operationId || !z.uuid().safeParse(operationId).success || !scope.success) return reply.code(400).send(absent);
    const [row] = await run((tx) => scoped(tx, operationId, scope.data.accountId, scope.data.orbitId), true);
    if (!row) return reply.code(404).send(absent);
    if (row.state === 'succeeded' || row.state === 'failed') return message(row);
    if (row.state === 'pending' || (row.state === 'in_flight' && Date.now() - row.updatedAt.getTime() < 30_000))
      return reply.code(409).send({ error: 'This send is still in progress. Check again shortly.' });
    let found: Awaited<ReturnType<typeof provider.findSent>>;
    try { found = await provider.findSent(row.accountId, row.messageId); }
    catch { return reply.code(503).send({ error: 'Sent could not be checked. Try reconciliation again later.' }); }
    const exact = found.evidence.filter((item) => evidenceMatches(row, item));
    const result = await run(async (tx) => {
      const [account] = await tx.select({ generation: accounts.credentialGeneration, revokedAt: accounts.revokedAt,
        scopes: accounts.grantedScopes, email: accounts.email, orbitId: accounts.orbitId }).from(accounts).where(eq(accounts.id, row.accountId)).limit(1);
      if (!account || account.revokedAt || account.generation !== found.credentialGeneration ||
        !account.scopes.includes(GMAIL_MODIFY_SCOPE) || account.email !== row.fromAddress) return null;
      const [draft] = await tx.select({ parentItemId: drafts.parentItemId }).from(drafts)
        .where(and(eq(drafts.id, row.draftId), eq(drafts.accountId, row.accountId), eq(drafts.ownerId, OWNER))).limit(1);
      if (!draft || (row.orbitId && !draft.parentItemId && account.orbitId !== row.orbitId)) return null;
      if (row.orbitId && draft.parentItemId) {
        const [visible] = await tx.select({ id: items.id }).from(items).where(and(eq(items.id, draft.parentItemId),
          eq(items.accountId, row.accountId), isNull(items.deletedAt),
          sql`exists (select 1 from item_orbits io where io.item_id = ${items.id} and io.orbit_id = ${row.orbitId})`)).limit(1);
        if (!visible) return null;
      }
      const [current] = await tx.select().from(outboundOperations).where(eq(outboundOperations.id, row.id)).for('update');
      if (!current) return null;
      if (current.state === 'succeeded') return current;
      if (current.state === 'in_flight' && Date.now() - current.updatedAt.getTime() < 30_000) return current;
      if (current.state !== 'in_flight' && current.state !== 'outcome_unknown') return current;
      const [saved] = await tx.update(outboundOperations).set(exact.length === 1 ? { state: 'succeeded',
        providerResultId: exact[0]!.id, completedAt: new Date(), updatedAt: new Date() } : {
        state: 'outcome_unknown', lastError: exact.length > 1 ? 'ambiguous_sent_matches' : 'not_found_in_sent', updatedAt: new Date(),
      }).where(eq(outboundOperations.id, current.id)).returning();
      if (saved && exact.length === 1) {
        await tx.update(drafts).set({ state: 'sent', attachmentRefs: [], updatedAt: new Date() })
          .where(and(eq(drafts.id, saved.draftId), eq(drafts.state, 'sending')));
        await tx.update(draftAttachments).set({ state: 'delete_pending', updatedAt: new Date() })
          .where(and(eq(draftAttachments.draftId, saved.draftId), eq(draftAttachments.state, 'ready')));
      }
      if (saved && (exact.length === 1 || current.state === 'in_flight'))
        await audit(tx, exact.length === 1 ? 'send_reconciled' : 'send_unknown', saved.id);
      return saved;
    });
    return result ? message(result) : reply.code(404).send(absent);
  });
}
