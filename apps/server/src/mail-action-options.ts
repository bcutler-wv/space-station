import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GmailChangeAdapter, GoogleCredentialError, GoogleCredentialService, GMAIL_MODIFY_SCOPE } from '@station/connectors';
import { accounts, items, labels, mailChangeOperations } from '@station/db';
import { mailActionOptionsQuerySchema, mailActionOptionsSchema } from '@station/shared';
import type { AuthConfig } from './auth.js';

type Tx = Parameters<Parameters<AuthConfig['db']['transaction']>[0]>[0];
type Provider = Pick<GmailChangeAdapter, 'credential' | 'inspectOptions'>;
const unavailable = { error: 'This message is no longer available in this account and Orbit. Reload the message.' };
const changed = { error: 'The message, labels, or connection changed. Reload the message before choosing an action.' };

export function registerMailActionOptions(app: FastifyInstance, auth: AuthConfig,
  provider: Provider = new GmailChangeAdapter(new GoogleCredentialService(auth.db, auth.masterKey, auth.googleTransport))): void {
  let active = 0;
  const run = <T>(work: (tx: Tx) => Promise<T>): Promise<T> => auth.db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    return work(tx);
  }, { accessMode: 'read only' });
  const snapshot = (itemId: string, accountId: string, orbitId?: string) => run(async (tx) => {
    const [item] = await tx.select({ id: items.id, externalId: items.externalId, itemSequence: items.appliedSequence,
      itemRevision: items.providerRevision, updatedAt: items.updatedAt }).from(items).where(and(eq(items.id, itemId), eq(items.accountId, accountId),
      isNull(items.deletedAt), orbitId ? sql`exists (select 1 from item_orbits io where io.item_id = ${items.id} and io.orbit_id = ${orbitId})` : undefined)).limit(1);
    if (!item) return null;
    const [account] = await tx.select({ provider: accounts.provider, email: accounts.email,
      generation: accounts.credentialGeneration, revokedAt: accounts.revokedAt, scopes: accounts.grantedScopes })
      .from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!account || account.provider !== 'google' || account.revokedAt || !account.scopes.includes(GMAIL_MODIFY_SCOPE)) return null;
    const stored = await tx.select({ id: labels.id, name: labels.name, providerRef: labels.providerRef })
      .from(labels).where(eq(labels.accountId, accountId)).orderBy(asc(labels.id)).limit(501);
    if (stored.length > 500) throw new Error('too_many_labels');
    const [blocking] = await tx.select({ id: mailChangeOperations.id, state: mailChangeOperations.state,
      orbitId: mailChangeOperations.orbitId }).from(mailChangeOperations)
      .where(and(eq(mailChangeOperations.itemId, itemId), sql`(${mailChangeOperations.state} in ('pending', 'in_flight', 'outcome_unknown') or
        (${mailChangeOperations.state} = 'succeeded' and ${mailChangeOperations.attemptCount} = 1 and
          (${mailChangeOperations.itemSequence} >= ${item.itemSequence} or ${mailChangeOperations.completedAt} is null or
            ${mailChangeOperations.completedAt} >= ${item.updatedAt})))`)).limit(1);
    return { item, account, stored, blocking: blocking ?? null };
  });
  app.get('/api/mail/items/:itemId/action-options', async (request, reply) => {
    if ((request.headers.origin && request.headers.origin !== auth.origin) || request.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send(unavailable);
    const itemId = (request.params as { itemId?: string }).itemId;
    const parsed = mailActionOptionsQuerySchema.safeParse(request.query);
    if (!z.uuid().safeParse(itemId).success || !parsed.success) return reply.code(400).send({ error: 'Check the message address and try again.' });
    if (active >= 2) return reply.code(503).send({ error: 'Action options are busy. Try again shortly.' });
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const onClose = () => controller.abort();
    reply.raw.on('close', onClose);
    try {
      const { accountId, orbitId } = parsed.data;
      const before = await snapshot(itemId!, accountId, orbitId);
      if (!before) return reply.code(404).send(unavailable);
      const credential = await provider.credential(accountId);
      if (controller.signal.aborted) return reply.code(503).send({ error: 'Action options timed out. Reload the message and try again.' });
      const evidence = await provider.inspectOptions(credential.accessToken, before.item.externalId, controller.signal);
      if (controller.signal.aborted) return reply.code(503).send({ error: 'Action options timed out. Reload the message and try again.' });
      const after = await snapshot(itemId!, accountId, orbitId);
      if (controller.signal.aborted) return reply.code(503).send({ error: 'Action options timed out. Reload the message and try again.' });
      if (!after || after.item.externalId !== before.item.externalId ||
        after.item.itemSequence !== before.item.itemSequence || after.item.itemRevision !== before.item.itemRevision ||
        after.account.generation !== credential.generation || after.account.email !== before.account.email ||
        JSON.stringify(after.stored) !== JSON.stringify(before.stored)) return reply.code(409).send(changed);
      const providerLabels = new Map(evidence.labels.filter((label) => label.type === 'user' && label.name)
        .map((label) => [label.id, label.name!]));
      const allProviderLabels = new Map(evidence.labels.map((label) => [label.id, label]));
      const storedRefs = new Set(after.stored.map((label) => label.providerRef));
      const labelsIncomplete = after.stored.some((label) => {
        const currentLabel = allProviderLabels.get(label.providerRef);
        return !currentLabel || !currentLabel.type || (currentLabel.type === 'user' && !currentLabel.name);
      }) ||
        [...providerLabels.keys()].some((ref) => !storedRefs.has(ref));
      const current = new Set(evidence.labelIds);
      const draft = current.has('DRAFT');
      const blocked = Boolean(after.blocking) || draft;
      const response = mailActionOptionsSchema.parse({ itemId, accountId, orbitId: orbitId ?? null,
        itemSequence: after.item.itemSequence, itemRevision: after.item.itemRevision,
        unread: current.has('UNREAD'), inInbox: current.has('INBOX'), blocked,
        blockedReason: after.blocking ? after.blocking.state === 'succeeded' ? 'awaiting_sync' : 'operation_pending' : draft ? 'draft' : null,
        blockingOperationId: after.blocking?.id ?? null,
        blockingOrbitId: after.blocking?.orbitId ?? null,
        labelsIncomplete,
        canArchive: !blocked && current.has('INBOX'), canMarkRead: !blocked && current.has('UNREAD'),
        canMarkUnread: !blocked && !current.has('UNREAD'),
        labels: after.stored.filter((label) => providerLabels.has(label.providerRef)).map((label) => ({
          id: label.id, name: providerLabels.get(label.providerRef)!, applied: current.has(label.providerRef),
          canAdd: !blocked && !current.has(label.providerRef), canRemove: !blocked && current.has(label.providerRef),
        })),
        message: after.blocking?.state === 'succeeded' ? 'The last change is waiting for mail sync. Reload the message after it refreshes.' :
          after.blocking ? 'A message change is pending or needs review. Check its status before another action.' :
          draft ? 'Gmail identifies this as a draft. Message actions are unavailable.' :
            labelsIncomplete ? 'Some Gmail labels are not synced here yet. Refresh mail sync before choosing a missing label.' :
              'Options reflect Gmail now. Reload if the message changes before you act.',
      });
      if (Buffer.byteLength(JSON.stringify(response)) > 128 * 1024) return reply.code(503).send({ error: 'Too many action options to display.' });
      return response;
    } catch (error) {
      if (error instanceof GoogleCredentialError && error.code === 'needs_reconnect')
        return reply.code(409).send({ error: 'Google mail access needs renewal. Reconnect this account, then reload the message.' });
      return reply.code(503).send({ error: 'Action options could not be checked. Check the Google connection and try again.' });
    } finally { clearTimeout(timer); reply.raw.off('close', onClose); active--; }
  });
}
