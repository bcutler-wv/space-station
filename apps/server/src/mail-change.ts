import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GmailChangeAdapter, GoogleCredentialService, GMAIL_MODIFY_SCOPE } from '@station/connectors';
import { accounts, auditLog, items, labels, mailChangeOperations } from '@station/db';
import { mailChangeCurrentStatusQuerySchema, mailChangeDiscoveryPageSchema, mailChangeDiscoveryQuerySchema, mailChangeOperationSchema,
  mailChangeRequestSchema, mailChangeScopeSchema } from '@station/shared';
import type { AuthConfig } from './auth.js';

type Tx = Parameters<Parameters<AuthConfig['db']['transaction']>[0]>[0];
type Row = typeof mailChangeOperations.$inferSelect;
type Provider = Pick<GmailChangeAdapter, 'credential' | 'inspectMessage' | 'inspectUserLabel' | 'modify'>;
const OWNER = 'owner';
const unavailable = { error: 'This mail change is unavailable in this account and Orbit.' };
const STALE_MS = 30_000;

function status(row: Row) {
  const state = row.state === 'in_flight' && Date.now() - row.updatedAt.getTime() > STALE_MS ? 'outcome_unknown' : row.state;
  const message = state === 'succeeded' ? row.confirmation === 'provider' ?
    'Gmail confirmed the change. Mail labels will refresh with sync.' :
    'Gmail currently shows the requested labels. Mail labels will refresh with sync.' :
    state === 'outcome_unknown' ? 'The change may have happened. Reconcile this operation; it will not repeat the write.' :
    state === 'failed' ? 'The change was not submitted. Reload the message before trying again.' :
    'The change is being checked or submitted.';
  return mailChangeOperationSchema.parse({ id: row.id, itemId: row.itemId, accountId: row.accountId,
    orbitId: row.orbitId, action: row.action, state, confirmation: row.confirmation,
    updatedAt: row.updatedAt.toISOString(), message });
}

function desired(row: Pick<Row, 'addLabels' | 'removeLabels'>, labelsNow: string[]) {
  return row.addLabels.every((id) => labelsNow.includes(id)) && row.removeLabels.every((id) => !labelsNow.includes(id));
}

function discoveryCursor(value: { at: string; id: string; accountId: string; orbitId: string | null }, key: Buffer) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
function readDiscoveryCursor(raw: string | undefined, accountId: string, orbitId: string | undefined, key: Buffer) {
  if (!raw) return null;
  const [body, mac, extra] = raw.split('.');
  if (!body || !mac || extra || body.length > 400 || mac.length !== 43) return false;
  const expected = createHmac('sha256', key).update(body).digest();
  const actual = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (Object.keys(value).length !== 4 || value.accountId !== accountId || value.orbitId !== (orbitId ?? null) ||
      !z.uuid().safeParse(value.id).success || typeof value.at !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.at) || !Number.isFinite(Date.parse(value.at))) return false;
    return { at: value.at, id: value.id as string };
  } catch { return false; }
}

export function registerMailChange(app: FastifyInstance, auth: AuthConfig,
  provider: Provider = new GmailChangeAdapter(new GoogleCredentialService(auth.db, auth.masterKey, auth.googleTransport))): void {
  const db = auth.db;
  let activeChanges = 0;
  let activeReconciles = 0;
  const run = <T>(work: (tx: Tx) => Promise<T>, readOnly = false): Promise<T> => db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    return work(tx);
  }, readOnly ? { accessMode: 'read only' } : undefined);
  const exactOrigin = (headers: Record<string, unknown>) => headers.origin === auth.origin && headers['sec-fetch-site'] !== 'cross-site';
  const readOrigin = (headers: Record<string, unknown>) => (!headers.origin || headers.origin === auth.origin) &&
    headers['sec-fetch-site'] !== 'cross-site';
  const visible = (orbitId: string | null) => orbitId ?
    sql`exists (select 1 from item_orbits io where io.item_id = ${items.id} and io.orbit_id = ${orbitId})` : undefined;
  const audit = (tx: Tx, action: string, id: string) => tx.insert(auditLog).values({
    id: randomUUID(), actorId: OWNER, action, targetId: id,
  });
  const scoped = (tx: Tx, id: string, accountId: string, orbitId?: string) => tx.select().from(mailChangeOperations)
    .where(and(eq(mailChangeOperations.id, id), eq(mailChangeOperations.ownerId, OWNER),
      eq(mailChangeOperations.accountId, accountId), orbitId ? eq(mailChangeOperations.orbitId, orbitId) : isNull(mailChangeOperations.orbitId)))
    .limit(1);
  const failPending = (id: string, error: string) => run(async (tx) => {
    const [row] = await tx.update(mailChangeOperations).set({ state: 'failed', lastError: error,
      updatedAt: new Date(), completedAt: new Date() }).where(and(eq(mailChangeOperations.id, id),
      eq(mailChangeOperations.state, 'pending'))).returning();
    if (row) await audit(tx, 'mail_change_failed', row.id);
    return row;
  });
  const unknown = (id: string, error: string) => run(async (tx) => {
    const [row] = await tx.update(mailChangeOperations).set({ state: 'outcome_unknown', lastError: error,
      updatedAt: new Date() }).where(and(eq(mailChangeOperations.id, id),
      eq(mailChangeOperations.state, 'in_flight'))).returning();
    if (row) await audit(tx, 'mail_change_unknown', row.id);
    return row;
  });

  app.post('/api/mail/items/:itemId/change', async (request, reply) => {
    if (!exactOrigin(request.headers)) return reply.code(403).send(unavailable);
    const itemId = (request.params as { itemId?: string }).itemId;
    const scope = mailChangeScopeSchema.safeParse(request.query);
    const body = mailChangeRequestSchema.safeParse(request.body);
    if (!itemId || !z.uuid().safeParse(itemId).success || !scope.success || !body.success)
      return reply.code(400).send({ error: 'Check the message change request and try again.' });
    if (activeChanges >= 2) return reply.code(503).send({ error: 'Mail changes are busy. Try again shortly.' });
    activeChanges++;
    try {
    const { accountId, orbitId } = scope.data;
    const { idempotencyKey, action, labelId, itemSequence, itemRevision } = body.data;
    const requestDigest = createHash('sha256').update(JSON.stringify({ itemId, accountId, orbitId: orbitId ?? null,
      action, labelId: labelId ?? null, itemSequence, itemRevision })).digest('hex');
    const reservation = await run(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${idempotencyKey}))`);
      const [prior] = await tx.select().from(mailChangeOperations).where(and(eq(mailChangeOperations.ownerId, OWNER),
        eq(mailChangeOperations.idempotencyKey, idempotencyKey))).limit(1);
      if (prior) return prior.requestDigest === requestDigest ? { code: 200 as const, row: prior } : { code: 409 as const };
      const [item] = await tx.select({ id: items.id, externalId: items.externalId, sequence: items.appliedSequence,
        revision: items.providerRevision, updatedAt: items.updatedAt, parseStatus: items.parseStatus })
        .from(items).where(and(eq(items.id, itemId), eq(items.accountId, accountId), isNull(items.deletedAt), visible(orbitId ?? null)))
        .for('update').limit(1);
      if (!item) return { code: 404 as const };
      const [account] = await tx.select({ provider: accounts.provider, revokedAt: accounts.revokedAt,
        email: accounts.email, scopes: accounts.grantedScopes }).from(accounts)
        .where(eq(accounts.id, accountId)).limit(1);
      if (!account || account.provider !== 'google' || account.revokedAt || !account.scopes.includes(GMAIL_MODIFY_SCOPE) ||
        item.parseStatus === 'deleted') return { code: 409 as const };
      if (item.sequence !== itemSequence || item.revision !== itemRevision) return { code: 409 as const };
      const [blocking] = await tx.select({ id: mailChangeOperations.id }).from(mailChangeOperations)
        .where(and(eq(mailChangeOperations.itemId, itemId),
          sql`(${mailChangeOperations.state} in ('pending', 'in_flight', 'outcome_unknown') or
            (${mailChangeOperations.state} = 'succeeded' and ${mailChangeOperations.attemptCount} = 1 and
              (${mailChangeOperations.itemSequence} >= ${item.sequence} or ${mailChangeOperations.completedAt} is null or
                ${mailChangeOperations.completedAt} >= ${item.updatedAt})))`)).limit(1);
      if (blocking) return { code: 409 as const };
      let providerLabel: string | null = null;
      if (labelId) {
        const [found] = await tx.select({ providerRef: labels.providerRef }).from(labels)
          .where(and(eq(labels.id, labelId), eq(labels.accountId, accountId))).limit(1);
        if (!found) return { code: 404 as const };
        providerLabel = found.providerRef;
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(providerLabel)) return { code: 409 as const };
      }
      const addLabels = action === 'mark_unread' ? ['UNREAD'] : action === 'add_label' ? [providerLabel!] : [];
      const removeLabels = action === 'archive' ? ['INBOX'] : action === 'mark_read' ? ['UNREAD'] :
        action === 'remove_label' ? [providerLabel!] : [];
      const [row] = await tx.insert(mailChangeOperations).values({ id: randomUUID(), ownerId: OWNER,
        itemId, externalId: item.externalId, accountId, orbitId: orbitId ?? null, idempotencyKey, requestDigest,
        action, addLabels, removeLabels, itemRevision, itemSequence }).returning();
      await audit(tx, 'mail_change_requested', row!.id);
      return { code: 201 as const, row: row!, providerLabel, accountEmail: account.email };
    });
    if (reservation.code === 200) return status(reservation.row);
    if (reservation.code !== 201) return reply.code(reservation.code).send(reservation.code === 404 ? unavailable :
      { error: 'The message or its connection changed. Reload it before trying again.' });
    const row = reservation.row;
    let credential: Awaited<ReturnType<Provider['credential']>>;
    let alreadyDesired = false;
    try {
      credential = await provider.credential(accountId);
      if (reservation.providerLabel) await provider.inspectUserLabel(credential.accessToken, reservation.providerLabel);
      const current = await provider.inspectMessage(credential.accessToken, row.externalId);
      if (current.labelIds.includes('DRAFT')) throw new Error('draft_message');
      alreadyDesired = desired(row, current.labelIds);
    } catch {
      const failed = await failPending(row.id, 'preflight_failed');
      return failed ? reply.code(409).send(status(failed)) : reply.code(503).send({ error: 'Change preflight could not be saved. Check operation status.' });
    }
    const claimed = await run(async (tx) => {
      const [item] = await tx.select({ externalId: items.externalId, sequence: items.appliedSequence,
        revision: items.providerRevision }).from(items).where(and(eq(items.id, itemId), eq(items.accountId, accountId),
          isNull(items.deletedAt), visible(orbitId ?? null))).for('update').limit(1);
      const [account] = await tx.select({ generation: accounts.credentialGeneration, revokedAt: accounts.revokedAt,
        scopes: accounts.grantedScopes, email: accounts.email }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (!item || item.externalId !== row.externalId || item.sequence !== row.itemSequence ||
        item.revision !== row.itemRevision || !account || account.revokedAt ||
        account.generation !== credential.generation || account.email !== reservation.accountEmail ||
        !account.scopes.includes(GMAIL_MODIFY_SCOPE)) return false;
      if (reservation.providerLabel) {
        const [label] = await tx.select({ providerRef: labels.providerRef }).from(labels)
          .where(and(eq(labels.id, labelId!), eq(labels.accountId, accountId))).limit(1);
        if (!label || label.providerRef !== reservation.providerLabel) return false;
      }
      if (alreadyDesired) {
        const [observed] = await tx.update(mailChangeOperations).set({ state: 'succeeded', confirmation: 'observed',
          completedAt: new Date(), updatedAt: new Date() }).where(and(eq(mailChangeOperations.id, row.id),
          eq(mailChangeOperations.state, 'pending'))).returning();
        if (observed) {
          await tx.update(items).set({ actionEpoch: sql`${items.actionEpoch} + 1` }).where(eq(items.id, itemId));
          await audit(tx, 'mail_change_observed', observed.id);
        }
        return observed ?? false;
      }
      const [updated] = await tx.update(mailChangeOperations).set({ state: 'in_flight', attemptCount: 1,
        credentialGeneration: credential.generation, updatedAt: new Date() })
        .where(and(eq(mailChangeOperations.id, row.id), eq(mailChangeOperations.state, 'pending'))).returning();
      return updated ?? false;
    });
    if (!claimed) {
      const failed = await failPending(row.id, 'scope_or_credential_changed');
      return failed ? reply.code(409).send(status(failed)) : reply.code(503).send({ error: 'Change status is unavailable. Check the operation.' });
    }
    if (alreadyDesired) return status(claimed);
    try {
      const result = await provider.modify(credential.accessToken, row.externalId, row.addLabels, row.removeLabels);
      if (!desired(row, result.labelIds) || result.labelIds.includes('DRAFT')) throw new Error('unexpected_labels');
      const completed = await run(async (tx) => {
        const [account] = await tx.select({ generation: accounts.credentialGeneration, revokedAt: accounts.revokedAt,
          scopes: accounts.grantedScopes })
          .from(accounts).where(eq(accounts.id, accountId)).limit(1);
        const [item] = await tx.select({ id: items.id }).from(items).where(and(eq(items.id, itemId), eq(items.accountId, accountId),
          isNull(items.deletedAt), visible(orbitId ?? null))).for('update').limit(1);
        if (!account || account.revokedAt || account.generation !== credential.generation ||
          !account.scopes.includes(GMAIL_MODIFY_SCOPE) || !item) return null;
        const [saved] = await tx.update(mailChangeOperations).set({ state: 'succeeded', confirmation: 'provider',
          completedAt: new Date(), updatedAt: new Date() }).where(and(eq(mailChangeOperations.id, row.id),
          eq(mailChangeOperations.state, 'in_flight'))).returning();
        if (saved) {
          await tx.update(items).set({ actionEpoch: sql`${items.actionEpoch} + 1` }).where(eq(items.id, itemId));
          await audit(tx, 'mail_change_confirmed', saved.id);
        }
        return saved;
      });
      return completed ? status(completed) : reply.code(202).send({ ...status(row), state: 'outcome_unknown',
        message: 'Gmail responded, but the account scope changed. Reconcile this operation.' });
    } catch {
      const uncertain = await unknown(row.id, 'provider_outcome_unknown').catch(() => undefined);
      return uncertain ? reply.code(202).send(status(uncertain)) : reply.code(503).send({
        error: 'The change outcome is unknown. Check the operation before trying again.' });
    }
    } finally { activeChanges--; }
  });

  app.get('/api/mail/changes/unresolved', async (request, reply) => {
    if (!readOrigin(request.headers)) return reply.code(403).send(unavailable);
    const query = mailChangeDiscoveryQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(unavailable);
    const { accountId, orbitId, limit } = query.data;
    const cursor = readDiscoveryCursor(query.data.cursor, accountId, orbitId, auth.masterKey);
    if (cursor === false) return reply.code(400).send(unavailable);
    const rows = await run(async (tx) => {
      const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (!account) return null;
      return tx.select().from(mailChangeOperations).where(and(eq(mailChangeOperations.ownerId, OWNER),
        eq(mailChangeOperations.accountId, accountId), orbitId ? eq(mailChangeOperations.orbitId, orbitId) : undefined,
        sql`${mailChangeOperations.state} in ('pending', 'in_flight', 'outcome_unknown')`,
        cursor ? or(sql`${mailChangeOperations.userActionAt} < ${cursor.at}::timestamptz`,
          and(sql`${mailChangeOperations.userActionAt} = ${cursor.at}::timestamptz`, lt(mailChangeOperations.id, cursor.id))) : undefined))
        .orderBy(sql`${mailChangeOperations.userActionAt} desc`, sql`${mailChangeOperations.id} desc`)
        .limit(limit + 1);
    }, true);
    if (!rows) return reply.code(404).send(unavailable);
    const page = rows.slice(0, limit);
    const contexts = page.length ? await run((tx) => tx.select({ operationId: mailChangeOperations.id,
      subject: sql<string | null>`left(${items.subject}, 120)`, threadId: items.threadId }).from(mailChangeOperations)
      .innerJoin(items, and(eq(items.id, mailChangeOperations.itemId), eq(items.accountId, mailChangeOperations.accountId),
        isNull(items.deletedAt), sql`(${mailChangeOperations.orbitId} is null or exists
          (select 1 from item_orbits io where io.item_id = ${items.id} and io.orbit_id = ${mailChangeOperations.orbitId}))`))
      .where(and(eq(mailChangeOperations.ownerId, OWNER), eq(mailChangeOperations.accountId, accountId),
        inArray(mailChangeOperations.id, page.map((row) => row.id)))), true) : [];
    const contextById = new Map(contexts.map((entry) => [entry.operationId,
      { subject: entry.subject, threadId: entry.threadId }]));
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last ? await run(async (tx) => {
      const [time] = await tx.select({ at: sql<string>`to_char(${mailChangeOperations.userActionAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
        .from(mailChangeOperations).where(eq(mailChangeOperations.id, last.id)).limit(1);
      return time ? discoveryCursor({ at: time.at, id: last.id, accountId, orbitId: orbitId ?? null }, auth.masterKey) : null;
    }, true) : null;
    const response = mailChangeDiscoveryPageSchema.parse({ operations: page.map((row) => ({
      ...status(row), context: contextById.get(row.id) ?? null })), nextCursor });
    if (Buffer.byteLength(JSON.stringify(response)) > 64 * 1024)
      return reply.code(503).send({ error: 'There are too many changes to display. Narrow the scope and try again.' });
    return response;
  });

  app.get('/api/mail/changes/:operationId', async (request, reply) => {
    if (!readOrigin(request.headers)) return reply.code(403).send(unavailable);
    const id = (request.params as { operationId?: string }).operationId;
    const scope = mailChangeScopeSchema.safeParse(request.query);
    if (!id || !z.uuid().safeParse(id).success || !scope.success) return reply.code(400).send(unavailable);
    const [row] = await run((tx) => scoped(tx, id, scope.data.accountId, scope.data.orbitId), true);
    return row ? status(row) : reply.code(404).send(unavailable);
  });

  app.get('/api/mail/items/:itemId/change', async (request, reply) => {
    if (!readOrigin(request.headers)) return reply.code(403).send(unavailable);
    const itemId = (request.params as { itemId?: string }).itemId;
    const query = mailChangeCurrentStatusQuerySchema.safeParse(request.query);
    if (!itemId || !z.uuid().safeParse(itemId).success || !query.success) return reply.code(400).send(unavailable);
    const { accountId, orbitId, idempotencyKey } = query.data;
    const [row] = await run((tx) => tx.select().from(mailChangeOperations).where(and(
      eq(mailChangeOperations.ownerId, OWNER), eq(mailChangeOperations.itemId, itemId),
      eq(mailChangeOperations.accountId, accountId), eq(mailChangeOperations.idempotencyKey, idempotencyKey),
      orbitId ? eq(mailChangeOperations.orbitId, orbitId) : isNull(mailChangeOperations.orbitId))).limit(1), true);
    return row ? status(row) : reply.code(404).send(unavailable);
  });

  app.post('/api/mail/changes/:operationId/reconcile', async (request, reply) => {
    if (!exactOrigin(request.headers)) return reply.code(403).send(unavailable);
    const id = (request.params as { operationId?: string }).operationId;
    const scope = mailChangeScopeSchema.safeParse(request.query);
    if (!id || !z.uuid().safeParse(id).success || !scope.success) return reply.code(400).send(unavailable);
    if (activeReconciles >= 2) return reply.code(503).send({ error: 'Mail checks are busy. Try again shortly.' });
    activeReconciles++;
    try {
    const [row] = await run((tx) => scoped(tx, id, scope.data.accountId, scope.data.orbitId), true);
    if (!row) return reply.code(404).send(unavailable);
    if (row.state === 'succeeded' || row.state === 'failed') return status(row);
    if (Date.now() - row.updatedAt.getTime() < STALE_MS) return reply.code(409).send({ error: 'The change is still in progress. Check again shortly.' });
    if (row.state === 'pending') {
      const failed = await failPending(row.id, 'abandoned_before_write');
      return failed ? status(failed) : reply.code(409).send({ error: 'The change state changed. Reload it.' });
    }
    const authorized = await run(async (tx) => {
      const [account] = await tx.select({ provider: accounts.provider, revokedAt: accounts.revokedAt,
        scopes: accounts.grantedScopes }).from(accounts).where(eq(accounts.id, row.accountId)).limit(1);
      const [item] = await tx.select({ externalId: items.externalId }).from(items).where(and(eq(items.id, row.itemId),
        eq(items.accountId, row.accountId), isNull(items.deletedAt), visible(row.orbitId))).limit(1);
      return Boolean(account?.provider === 'google' && !account.revokedAt && account.scopes.includes(GMAIL_MODIFY_SCOPE) &&
        item?.externalId === row.externalId);
    }, true);
    if (!authorized) return reply.code(404).send(unavailable);
    let credential: Awaited<ReturnType<Provider['credential']>>;
    let observed: Awaited<ReturnType<Provider['inspectMessage']>>;
    try {
      credential = await provider.credential(row.accountId);
      observed = await provider.inspectMessage(credential.accessToken, row.externalId);
    } catch { return reply.code(503).send({ error: 'Gmail could not be checked. Reconcile again later.' }); }
    const reconciled = await run(async (tx) => {
      const [account] = await tx.select({ provider: accounts.provider, generation: accounts.credentialGeneration,
        revokedAt: accounts.revokedAt, scopes: accounts.grantedScopes }).from(accounts)
        .where(eq(accounts.id, row.accountId)).limit(1);
      const [item] = await tx.select({ externalId: items.externalId }).from(items).where(and(eq(items.id, row.itemId),
        eq(items.accountId, row.accountId), isNull(items.deletedAt), visible(row.orbitId))).for('update').limit(1);
      if (!account || account.provider !== 'google' || account.revokedAt || account.generation !== credential.generation ||
        !account.scopes.includes(GMAIL_MODIFY_SCOPE) || !item || item.externalId !== row.externalId) return null;
      const [current] = await tx.select().from(mailChangeOperations).where(eq(mailChangeOperations.id, row.id)).for('update').limit(1);
      if (!current) return null;
      if (current.state === 'succeeded' || current.state === 'failed') return current;
      if (current.state === 'in_flight' && Date.now() - current.updatedAt.getTime() < STALE_MS) return current;
      if (current.state !== 'in_flight' && current.state !== 'outcome_unknown') return current;
      const matches = desired(current, observed.labelIds) && !observed.labelIds.includes('DRAFT');
      const [saved] = await tx.update(mailChangeOperations).set(matches ? { state: 'succeeded', confirmation: 'observed',
        completedAt: new Date(), updatedAt: new Date() } : { state: 'outcome_unknown',
        lastError: 'desired_state_not_observed', updatedAt: new Date() }).where(eq(mailChangeOperations.id, current.id)).returning();
      if (saved && matches) {
        await tx.update(items).set({ actionEpoch: sql`${items.actionEpoch} + 1` }).where(eq(items.id, row.itemId));
        await audit(tx, 'mail_change_observed', saved.id);
      }
      else if (saved && current.state === 'in_flight') await audit(tx, 'mail_change_unknown', saved.id);
      return saved;
    });
    return reconciled ? status(reconciled) : reply.code(404).send(unavailable);
    } finally { activeReconciles--; }
  });
}
