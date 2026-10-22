import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { openDatabase } from './connection.js';
import { evaluateDerivedMailEligibilityInTransaction } from './mail-page.js';
import { accounts, attachments, identities, itemLabels, itemOrbits, itemRecipients, items,
  labels, oauthApps, people, searchDocuments, searchEpochs } from './schema.js';
import { boundSearchTransaction } from './search-ledger.js';

type Database = ReturnType<typeof openDatabase>['db'];
const MAX_FIELD_BYTES = 256 * 1024;
// Leave room in the future 256 KiB engine request for IDs and the JSON envelope.
const MAX_TOTAL_BYTES = 192 * 1024;
const MAX_FIELD_VALUES = 256;

type SearchEvidence = {
  accountId: string; itemId: string; desiredRevision: number; globalEpoch: number; accountEpoch: number;
  sourceSequence: number; actionEpoch: number; observedActionEpoch: number; observedAuthorizationGeneration: number;
  authorizationGeneration: number;
};
export type SearchProjection =
  | { status: 'denied' }
  | { status: 'error'; code: 'oversize' | 'malformed'; evidence: SearchEvidence }
  | { status: 'eligible'; evidence: SearchEvidence; fields: {
      ownerId: string; accountId: string; orbitIds: string[]; labelIds: string[];
      kind: 'mail'; mailboxes: string[]; hasAttachment: boolean; unread: boolean; starred: boolean;
      sentAt: string | null; searchText: string; subjectValues: string[]; fromValues: string[];
      toValues: string[]; ccValues: string[]; filenameValues: string[];
    } };

function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8'); }
function valuesWithinLimit(values: string[]): boolean {
  return values.length <= MAX_FIELD_VALUES && values.every((value) => byteLength(value) <= 1024);
}

/** Callable proof of one eligibility-and-source snapshot. No production caller in Slice A. */
export async function readSearchProjection(db: Database, itemId: string, configuredOrigin: string): Promise<SearchProjection> {
  z.uuid().parse(itemId);
  const origin = z.url().parse(configuredOrigin);
  if (new URL(origin).origin !== origin) throw new Error('Search configured origin must be exact');
  return db.transaction(async (tx) => {
    await boundSearchTransaction(tx);
    const [source] = await tx.select({ accountId: items.accountId, sequence: items.appliedSequence,
      actionEpoch: items.actionEpoch, observedActionEpoch: items.observedActionEpoch,
      observedAuthorizationGeneration: items.observedAuthorizationGeneration,
      subjectBytes: sql<number>`octet_length(${items.subject})`,
      bodyBytes: sql<number>`octet_length(${items.bodyText})`,
      flagsBytes: sql<number>`octet_length(${items.flags}::text)`,
      sentAt: items.sentAt, internalAt: items.internalAt })
      .from(items).where(eq(items.id, itemId));
    if (!source) return { status: 'denied' };
    const [global] = await tx.select({ epoch: searchEpochs.epoch }).from(searchEpochs)
      .where(eq(searchEpochs.scope, 'global'));
    const [accountEpoch] = await tx.select({ epoch: searchEpochs.epoch }).from(searchEpochs)
      .where(eq(searchEpochs.scope, source.accountId));
    const [ledger] = await tx.select().from(searchDocuments).where(and(
      eq(searchDocuments.accountId, source.accountId), eq(searchDocuments.itemId, itemId)));
    if (!global || !accountEpoch || !ledger || ledger.globalEpoch !== global.epoch ||
      ledger.accountEpoch !== accountEpoch.epoch || ledger.desiredState === 'purge') return { status: 'denied' };
    const permission = await evaluateDerivedMailEligibilityInTransaction(tx, itemId, origin);
    if (!permission.canIndex) return { status: 'denied' };
    if (source.observedActionEpoch === null || source.observedAuthorizationGeneration === null)
      return { status: 'denied' };
    const [account] = await tx.select({ authorizationGeneration: accounts.authorizationGeneration,
      ownerId: oauthApps.ownerId }).from(accounts).innerJoin(oauthApps, eq(accounts.appId, oauthApps.id))
      .where(eq(accounts.id, source.accountId));
    if (!account) return { status: 'denied' };
    const evidence: SearchEvidence = { accountId: source.accountId, itemId,
      desiredRevision: ledger.desiredRevision, globalEpoch: global.epoch, accountEpoch: accountEpoch.epoch,
      sourceSequence: source.sequence, actionEpoch: source.actionEpoch,
      observedActionEpoch: source.observedActionEpoch,
      observedAuthorizationGeneration: source.observedAuthorizationGeneration,
      authorizationGeneration: account.authorizationGeneration };
    if (source.subjectBytes > MAX_FIELD_BYTES || source.bodyBytes > MAX_FIELD_BYTES ||
      source.flagsBytes > 8192) return { status: 'error', code: 'oversize', evidence };
    const [content] = await tx.select({ subject: items.subject, body: items.bodyText,
      flags: items.flags }).from(items).where(eq(items.id, itemId));
    if (!content) return { status: 'denied' };
    const recipientRows = await tx.select({ role: itemRecipients.role, address: identities.normalizedValue,
      name: people.displayName }).from(itemRecipients)
      .innerJoin(identities, and(eq(itemRecipients.identityId, identities.id), eq(itemRecipients.accountId, identities.accountId)))
      .innerJoin(people, eq(identities.personId, people.id))
      .where(eq(itemRecipients.itemId, itemId)).limit(MAX_FIELD_VALUES + 1);
    const labelRows = await tx.select({ id: labels.id, name: labels.name, providerRef: labels.providerRef })
      .from(itemLabels).innerJoin(labels, and(eq(itemLabels.labelId, labels.id), eq(itemLabels.accountId, labels.accountId)))
      .where(eq(itemLabels.itemId, itemId)).limit(MAX_FIELD_VALUES + 1);
    const orbitRows = await tx.select({ orbitId: itemOrbits.orbitId }).from(itemOrbits)
      .where(eq(itemOrbits.itemId, itemId)).limit(65);
    const fileRows = await tx.select({ filename: attachments.filename }).from(attachments)
      .where(eq(attachments.itemId, itemId)).limit(MAX_FIELD_VALUES + 1);
    if (recipientRows.length > MAX_FIELD_VALUES || labelRows.length > MAX_FIELD_VALUES ||
      orbitRows.length > 64 || fileRows.length > MAX_FIELD_VALUES) return { status: 'error', code: 'oversize', evidence };
    if (!content.flags || typeof content.flags !== 'object' || Array.isArray(content.flags) ||
      Object.entries(content.flags).some(([key, value]) => key.length > 64 || typeof value !== 'boolean'))
      return { status: 'error', code: 'malformed', evidence };
    const flags = content.flags as Record<string, boolean>;
    const from = recipientRows.filter((row) => row.role === 'sender').flatMap((row) => [row.name, row.address]);
    const to = recipientRows.filter((row) => row.role === 'to').flatMap((row) => [row.name, row.address]);
    const cc = recipientRows.filter((row) => row.role === 'cc').flatMap((row) => [row.name, row.address]);
    const bcc = recipientRows.filter((row) => row.role === 'bcc').flatMap((row) => [row.name, row.address]);
    const filenames = fileRows.map((row) => row.filename).filter((value): value is string => value !== null);
    const subject = content.subject ?? '';
    const searchText = [subject, content.body ?? '', ...from, ...to, ...cc, ...bcc,
      ...filenames, ...labelRows.map((row) => row.name)].join('\n');
    if (!valuesWithinLimit(from) || !valuesWithinLimit(to) || !valuesWithinLimit(cc) ||
      !valuesWithinLimit(bcc) ||
      !valuesWithinLimit(filenames) || !valuesWithinLimit([subject]) || byteLength(searchText) > MAX_TOTAL_BYTES)
      return { status: 'error', code: 'oversize', evidence };
    const fields = { ownerId: account.ownerId, accountId: source.accountId,
        orbitIds: [...new Set(orbitRows.map((row) => row.orbitId))],
        labelIds: [...new Set(labelRows.map((row) => row.id))], kind: 'mail' as const,
        mailboxes: labelRows.filter((row) => row.providerRef === 'INBOX' || row.providerRef === 'SENT')
          .map((row) => row.providerRef.toLowerCase()),
        hasAttachment: fileRows.length > 0, unread: flags.read === false, starred: flags.starred === true,
        sentAt: (source.sentAt ?? source.internalAt)?.toISOString() ?? null,
        searchText, subjectValues: subject ? [subject] : [], fromValues: from, toValues: to,
        ccValues: cc, filenameValues: filenames };
    if (byteLength(JSON.stringify(fields)) > MAX_TOTAL_BYTES)
      return { status: 'error', code: 'oversize', evidence };
    return { status: 'eligible', evidence, fields };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Record a deterministic error only while its source and permission evidence still matches. */
export async function recordSearchProjectionError(db: Database, evidence: SearchEvidence,
  code: 'oversize' | 'malformed', configuredOrigin: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await boundSearchTransaction(tx);
    const [global] = await tx.select({ epoch: searchEpochs.epoch }).from(searchEpochs)
      .where(eq(searchEpochs.scope, 'global')).for('share');
    const [accountEpoch] = await tx.select({ epoch: searchEpochs.epoch }).from(searchEpochs)
      .where(eq(searchEpochs.scope, evidence.accountId)).for('share');
    if (global?.epoch !== evidence.globalEpoch || accountEpoch?.epoch !== evidence.accountEpoch) return false;
    const [ledger] = await tx.select().from(searchDocuments).where(and(
      eq(searchDocuments.accountId, evidence.accountId), eq(searchDocuments.itemId, evidence.itemId))).for('update');
    if (!ledger || ledger.desiredRevision !== evidence.desiredRevision ||
      ledger.globalEpoch !== evidence.globalEpoch || ledger.accountEpoch !== evidence.accountEpoch ||
      ledger.desiredState === 'purge') return false;
    const [source] = await tx.select({ accountId: items.accountId, sequence: items.appliedSequence,
      actionEpoch: items.actionEpoch, observedActionEpoch: items.observedActionEpoch,
      observedAuthorizationGeneration: items.observedAuthorizationGeneration })
      .from(items).where(eq(items.id, evidence.itemId));
    const [account] = await tx.select({ authorizationGeneration: accounts.authorizationGeneration })
      .from(accounts).where(eq(accounts.id, evidence.accountId));
    if (!source || source.accountId !== evidence.accountId || !account ||
      source.sequence !== evidence.sourceSequence || source.actionEpoch !== evidence.actionEpoch ||
      source.observedActionEpoch !== evidence.observedActionEpoch ||
      source.observedAuthorizationGeneration !== evidence.observedAuthorizationGeneration ||
      account.authorizationGeneration !== evidence.authorizationGeneration ||
      !(await evaluateDerivedMailEligibilityInTransaction(tx, evidence.itemId, configuredOrigin)).canIndex) return false;
    await tx.update(searchDocuments).set({ errorCode: code, desiredState: 'dirty' }).where(and(
      eq(searchDocuments.accountId, evidence.accountId), eq(searchDocuments.itemId, evidence.itemId)));
    return true;
  }, { isolationLevel: 'repeatable read' });
}
