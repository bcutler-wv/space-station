import { and, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { openDatabase } from './connection.js';
import { accounts, items, searchDocuments, searchEpochs } from './schema.js';

type Database = ReturnType<typeof openDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
const MAX_REVISION = 2_147_483_647;
const accountIdSchema = z.uuid();
const itemIdSchema = z.uuid();
export const SEARCH_SWEEP_BATCH_MAX = 50;

export async function boundSearchTransaction(tx: Transaction): Promise<void> {
  await tx.execute(sql`set local statement_timeout = '3000ms'`);
  await tx.execute(sql`set local lock_timeout = '750ms'`);
}

async function ensureGlobal(tx: Transaction) {
  await tx.insert(searchEpochs).values({ scope: 'global' }).onConflictDoNothing();
}

async function ensureAccount(tx: Transaction, accountId: string, globalEpoch: number) {
  await tx.insert(searchEpochs).values({ scope: accountId, sweepTargetGlobal: globalEpoch })
    .onConflictDoNothing();
}

async function readSearchMetadata(tx: Transaction, accountId: string, itemId: string) {
  const [source] = await tx.select({ sequence: items.appliedSequence, actionEpoch: items.actionEpoch,
    observedActionEpoch: items.observedActionEpoch,
    observedAuthorizationGeneration: items.observedAuthorizationGeneration,
    parseStatus: items.parseStatus, deletedAt: items.deletedAt })
    .from(items).where(and(eq(items.accountId, accountId), eq(items.id, itemId)));
  const [account] = await tx.select({ authorizationGeneration: accounts.authorizationGeneration })
    .from(accounts).where(eq(accounts.id, accountId));
  const missing = !source || source.deletedAt !== null || source.parseStatus === 'deleted' || !account;
  return { missing, metadata: { sourceSequence: source?.sequence ?? null,
    actionEpoch: source?.actionEpoch ?? null,
    observedActionEpoch: source?.observedActionEpoch ?? null,
    observedAuthorizationGeneration: source?.observedAuthorizationGeneration ?? null,
    authorizationGeneration: account?.authorizationGeneration ?? null,
    sourceParseStatus: source?.parseStatus ?? null, sourceDeleted: missing } };
}

/** These helpers are inactive until every source mutation is wired in Slice B. */
export async function bumpSearchGlobalEpoch(tx: Transaction): Promise<number> {
  await ensureGlobal(tx);
  const [row] = await tx.update(searchEpochs).set({ epoch: sql`${searchEpochs.epoch} + 1`,
    sweepTarget: sql`${searchEpochs.epoch} + 1`, sweepCursorAccount: null, sweepCursorItem: null })
    .where(and(eq(searchEpochs.scope, 'global'), lt(searchEpochs.epoch, MAX_REVISION)))
    .returning({ epoch: searchEpochs.epoch });
  if (!row) throw new Error('Search global epoch exhausted');
  return row.epoch;
}

export async function bumpSearchAccountEpoch(tx: Transaction, accountId: string) {
  accountIdSchema.parse(accountId);
  await ensureGlobal(tx);
  const [global] = await tx.select().from(searchEpochs).where(eq(searchEpochs.scope, 'global')).for('share');
  if (!global) throw new Error('Missing search global epoch');
  await ensureAccount(tx, accountId, global.epoch);
  const [account] = await tx.update(searchEpochs).set({ epoch: sql`${searchEpochs.epoch} + 1`,
    sweepTarget: sql`${searchEpochs.epoch} + 1`, sweepTargetGlobal: global.epoch,
    sweepCursorAccount: null, sweepCursorItem: null })
    .where(and(eq(searchEpochs.scope, accountId), lt(searchEpochs.epoch, MAX_REVISION)))
    .returning({ epoch: searchEpochs.epoch });
  if (!account) throw new Error('Search account epoch exhausted');
  return { globalEpoch: global.epoch, accountEpoch: account.epoch };
}

/** Call after source writes, before appendSyncEvent. Pass the pair returned by a
 * preceding account bump when that transaction already holds account EXCLUSIVE. */
export async function dirtySearchItems(tx: Transaction, accountId: string, itemIds: readonly string[],
  lockedEpochs?: { globalEpoch: number; accountEpoch: number }): Promise<number> {
  accountIdSchema.parse(accountId);
  const sorted = [...new Set(itemIds.map((id) => itemIdSchema.parse(id)))].sort();
  if (sorted.length > 500) throw new Error('Search item batch exceeds limit');
  if (!sorted.length) return 0;
  let pair = lockedEpochs;
  if (!pair) {
    await ensureGlobal(tx);
    const [global] = await tx.select().from(searchEpochs).where(eq(searchEpochs.scope, 'global')).for('share');
    if (!global) throw new Error('Missing search global epoch');
    await ensureAccount(tx, accountId, global.epoch);
    const [account] = await tx.select().from(searchEpochs).where(eq(searchEpochs.scope, accountId)).for('share');
    if (!account) throw new Error('Missing search account epoch');
    pair = { globalEpoch: global.epoch, accountEpoch: account.epoch };
  }
  for (const itemId of sorted) {
    const { missing, metadata } = await readSearchMetadata(tx, accountId, itemId);
    const [prior] = await tx.select({ revision: searchDocuments.desiredRevision }).from(searchDocuments)
      .where(and(eq(searchDocuments.accountId, accountId), eq(searchDocuments.itemId, itemId))).for('update');
    if (prior) {
      if (prior.revision >= MAX_REVISION) throw new Error('Search document revision exhausted');
      await tx.update(searchDocuments).set({ desiredRevision: prior.revision + 1,
        desiredState: missing ? 'purge' : 'dirty',
        globalEpoch: pair.globalEpoch, accountEpoch: pair.accountEpoch, ...metadata, errorCode: null })
        .where(and(eq(searchDocuments.accountId, accountId), eq(searchDocuments.itemId, itemId)));
    } else {
      await tx.insert(searchDocuments).values({ accountId, itemId, documentId: `mail:${accountId}:${itemId}`,
        desiredState: missing ? 'purge' : 'dirty', globalEpoch: pair.globalEpoch,
        accountEpoch: pair.accountEpoch, ...metadata });
    }
  }
  return sorted.length;
}

type SweepKey = { account_id: string; item_id: string };
export type SearchSweepResult = { scope: string; scanned: number; finished: boolean; cursor: SweepKey | null };

/** One short, callable batch. `restart` begins a periodic full pass after a completed pass. */
export async function reconcileSearchBatch(db: Database, scope: 'global' | string, limit = 25,
  restart = false): Promise<SearchSweepResult> {
  if (scope !== 'global') accountIdSchema.parse(scope);
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_SWEEP_BATCH_MAX) throw new Error('Invalid search sweep limit');
  return db.transaction(async (tx) => {
    await boundSearchTransaction(tx);
    await ensureGlobal(tx);
    const [global] = await tx.select().from(searchEpochs).where(eq(searchEpochs.scope, 'global'))
      .for(scope === 'global' ? 'update' : 'share');
    if (!global) throw new Error('Missing search global epoch');
    if (scope !== 'global') await ensureAccount(tx, scope, global.epoch);
    const [target] = scope === 'global' ? [global] : await tx.select().from(searchEpochs)
      .where(eq(searchEpochs.scope, scope)).for('update');
    if (!target) throw new Error('Missing search account epoch');
    const currentPass = target.sweepTarget === target.epoch && target.sweepTargetGlobal === global.epoch;
    if (!restart && currentPass && target.sweepCursorAccount === null &&
      target.sweepFinishedEpoch === target.epoch &&
      target.sweepFinishedGlobal === global.epoch)
      return { scope, scanned: 0, finished: true, cursor: null };
    const cursorAccount = !restart && currentPass ? target.sweepCursorAccount : null;
    const cursorItem = !restart && currentPass ? target.sweepCursorItem : null;
    const accountFilter = scope === 'global' ? sql`true` : sql`account_id = ${scope}`;
    const keyFilter = cursorAccount && cursorItem
      ? sql`(account_id, id) > (${cursorAccount}, ${cursorItem})` : sql`true`;
    const ledgerKeyFilter = cursorAccount && cursorItem
      ? sql`(account_id, item_id) > (${cursorAccount}, ${cursorItem})` : sql`true`;
    // Each indexed branch yields at most one batch before the final merge.
    const query = sql`select account_id, item_id from (
      (select account_id, id as item_id from items where ${accountFilter} and ${keyFilter}
        order by account_id, id limit ${limit})
      union
      (select account_id, item_id from search_documents where ${accountFilter} and ${ledgerKeyFilter}
        order by account_id, item_id limit ${limit})
    ) candidate order by account_id, item_id limit ${limit}`;
    const keys = (await tx.execute(query)).rows as SweepKey[];
    for (const key of keys) {
      accountIdSchema.parse(key.account_id);
      itemIdSchema.parse(key.item_id);
      let accountEpoch = target;
      if (scope === 'global') {
        await ensureAccount(tx, key.account_id, global.epoch);
        const [row] = await tx.select().from(searchEpochs).where(eq(searchEpochs.scope, key.account_id)).for('share');
        if (!row) throw new Error('Missing search account epoch');
        accountEpoch = row;
      }
      const { missing, metadata } = await readSearchMetadata(tx, key.account_id, key.item_id);
      const [prior] = await tx.select().from(searchDocuments).where(and(
        eq(searchDocuments.accountId, key.account_id), eq(searchDocuments.itemId, key.item_id))).for('update');
      if (!prior) {
        await tx.insert(searchDocuments).values({ accountId: key.account_id, itemId: key.item_id,
          documentId: `mail:${key.account_id}:${key.item_id}`, desiredState: missing ? 'purge' : 'dirty',
          globalEpoch: global.epoch, accountEpoch: accountEpoch.epoch, ...metadata });
      } else if (prior.globalEpoch !== global.epoch || prior.accountEpoch !== accountEpoch.epoch ||
        Object.entries(metadata).some(([field, value]) => prior[field as keyof typeof metadata] !== value)) {
        if (prior.desiredRevision >= MAX_REVISION) throw new Error('Search document revision exhausted');
        await tx.update(searchDocuments).set({ desiredRevision: prior.desiredRevision + 1,
          desiredState: missing ? 'purge' : 'dirty', globalEpoch: global.epoch,
          accountEpoch: accountEpoch.epoch, ...metadata, errorCode: null })
          .where(and(eq(searchDocuments.accountId, key.account_id), eq(searchDocuments.itemId, key.item_id)));
      }
    }
    const last = keys.at(-1) ?? null;
    const finished = keys.length < limit;
    await tx.update(searchEpochs).set({ sweepTarget: target.epoch, sweepTargetGlobal: global.epoch,
      sweepCursorAccount: finished ? null : last!.account_id,
      sweepCursorItem: finished ? null : last!.item_id,
      ...(finished ? { sweepFinishedEpoch: target.epoch, sweepFinishedGlobal: global.epoch } : {}) })
      .where(eq(searchEpochs.scope, scope));
    return { scope, scanned: keys.length, finished, cursor: finished ? null : last };
  });
}
