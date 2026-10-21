import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, gt, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { GmailReadAdapter, GmailReadError, type GmailRawMessage, type GmailMessageMetadata, type GmailHistoryPage } from '@station/connectors';
import { accounts, appendSyncEvent, applyMailPage, collectOrphanBlobs, items, labels, openDatabase, orbits, PrivateBlobStore, settings, syncStates,
  MailPageFenceError, type MailChange } from '@station/db';
import { privacyDefaultsSchema, type ParseResult } from '@station/shared';
import { z } from 'zod';
import { parseMail } from './mail-parser-client.js';

type Database = ReturnType<typeof openDatabase>['db'];
type Reader = Pick<GmailReadAdapter, 'getProfile' | 'listLabels' | 'listMessageIds' | 'getMessageRaw' | 'getMessageMinimal' | 'listHistory'>;
type Parser = (raw: Uint8Array, signal: AbortSignal) => Promise<ParseResult>;
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const COLLECTION = 'primary';
const LEASE_MS = 180_000;
const ID_BATCH = 10;
const LABEL_BATCH = 100;
const OBSERVATION_REFRESH_LIMIT = 5;
const MAX_RUN_STEPS = 200;
const MAX_RUN_MS = 720_000;
const MAX_RETRY_MS = 15 * 60_000;
const cursorSchema = z.object({
  version: z.literal(1), phase: z.enum(['anchor', 'full', 'history', 'reconcile_delete', 'ready']),
  cutoff: z.number().int().nonnegative(), anchor: z.string().nullable(), historyStart: z.string().nullable(),
  listToken: z.string().nullable(), pending: z.array(z.string()).max(ID_BATCH), offset: z.number().int().nonnegative(),
  historyToken: z.string().nullable(), historyOffset: z.number().int().nonnegative(),
  scanStart: z.number().int().nonnegative(), retryAt: z.number().int().nonnegative(), failures: z.number().int().nonnegative(),
  nextCallAt: z.number().int().nonnegative().default(0), blockedGeneration: z.number().int().nonnegative().nullable().default(null),
  observationAfter: z.string().uuid().nullable().default(null),
});
type Cursor = z.infer<typeof cursorSchema>;
type State = typeof syncStates.$inferSelect;
type Account = typeof accounts.$inferSelect;

function cutoffFor(backfill: string, now: Date): number {
  if (backfill === 'all') return 0;
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - (backfill === '30_days' ? 30 : 365));
  return Math.floor(date.getTime() / 1000);
}
function initialCursor(account: Account, now: Date): Cursor {
  return { version: 1, phase: 'anchor', cutoff: cutoffFor(account.backfill!, now), anchor: null, historyStart: null,
    listToken: null, pending: [], offset: 0, historyToken: null, historyOffset: 0, scanStart: 0, retryAt: 0, failures: 0,
    nextCallAt: 0, blockedGeneration: null, observationAfter: null };
}
function cursorOf(state: State, account: Account, now: Date): Cursor {
  if (state.cursor === null) return initialCursor(account, now);
  const result = cursorSchema.safeParse(state.cursor);
  if (!result.success) throw new Error('sync_cursor_invalid');
  return result.data;
}
function eligible(account: Account): boolean {
  return account.provider === 'google' && !!account.backfill && !account.revokedAt && account.grantedScopes.includes(SCOPE);
}
function safeCode(error: unknown): string {
  if (error instanceof GmailReadError) return error.code;
  if (error instanceof MailPageFenceError) return 'stale_lease';
  if (error instanceof Error && error.message === 'parser_transient') return 'parser_unavailable';
  if (error instanceof Error && error.message === 'sync_cursor_invalid') return 'sync_cursor_invalid';
  return 'sync_transient';
}
function retryTime(nowMs: number, failures: number, error: unknown): number {
  const base = Math.min(MAX_RETRY_MS, 5_000 * 2 ** Math.min(failures, 8));
  const requested = error instanceof GmailReadError ? error.retryAfterMs ?? 0 : 0;
  // A provider hint is a minimum. The cap applies only to our exponential delay.
  return nowMs + Math.min(8_640_000_000_000_000 - nowMs - 1, Math.max(base, requested));
}
function finishFull(cursor: Cursor): Cursor {
  return { ...cursor, pending: [], offset: 0, phase: cursor.scanStart ? 'reconcile_delete' : 'history', historyStart: cursor.anchor };
}

/** One runner owns a bounded lease. All provider and parser work happens outside transactions. */
export class GmailSyncRunner {
  constructor(private readonly db: Database, private readonly blobs: PrivateBlobStore, private readonly reader: Reader,
    private readonly origin: string, private readonly parser: Parser = (raw, signal) => parseMail(raw, fetch, signal),
    private readonly now: () => Date = () => new Date(), private readonly runBudgetMs = MAX_RUN_MS) {
    if (!Number.isSafeInteger(runBudgetMs) || runBudgetMs < 1 || runBudgetMs > MAX_RUN_MS) throw new Error('Invalid Gmail run budget');
  }

  async discover(): Promise<string[]> {
    if (!await this.marker()) return [];
    const rows = await this.db.select().from(accounts).where(and(eq(accounts.provider, 'google'), isNull(accounts.revokedAt)));
    const ids: string[] = [];
    for (const account of rows) {
      if (!eligible(account)) continue;
      await this.db.transaction(async (tx) => {
        const [created] = await tx.insert(syncStates).values({ id: randomUUID(), accountId: account.id, resource: 'mail', collectionId: COLLECTION,
          cursor: initialCursor(account, this.now()) }).onConflictDoNothing().returning({ id: syncStates.id });
        if (created) await appendSyncEvent(tx, 'sync-progress', account.id);
      });
      const [state] = await this.db.select().from(syncStates).where(and(eq(syncStates.accountId, account.id), eq(syncStates.resource, 'mail'), eq(syncStates.collectionId, COLLECTION)));
      if (state && (!state.leaseUntil || state.leaseUntil <= this.now())) {
        const cursor = cursorOf(state, account, this.now());
        if (cursor.retryAt <= this.now().getTime() && (state.status !== 'blocked' || cursor.blockedGeneration !== account.credentialGeneration)) ids.push(account.id);
      }
    }
    return ids;
  }

  private async marker(): Promise<boolean> {
    const [row] = await this.db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'first_orbit_setup_v1'));
    const parsed = z.object({ version: z.literal(1), orbitId: z.string().uuid(), confirmedOrigin: z.url(), globalDefaults: privacyDefaultsSchema }).safeParse(row?.value);
    if (!parsed.success || parsed.data.confirmedOrigin !== this.origin) return false;
    const [orbit] = await this.db.select({ id: orbits.id }).from(orbits).where(eq(orbits.id, parsed.data.orbitId));
    return !!orbit;
  }

  private async lease(accountId: string): Promise<{ account: Account; state: State; cursor: Cursor } | null> {
    if (!await this.marker()) return null;
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, accountId));
    if (!account || !eligible(account)) return null;
    const [before] = await this.db.select().from(syncStates).where(and(eq(syncStates.accountId, accountId), eq(syncStates.resource, 'mail'), eq(syncStates.collectionId, COLLECTION)));
    if (!before) return null;
    const cursor = cursorOf(before, account, this.now());
    if (cursor.retryAt > this.now().getTime() || (before.status === 'blocked' && cursor.blockedGeneration === account.credentialGeneration)) return null;
    // A prior process may have been killed or aborted with an SDK read still
    // outstanding. Reserve a conservative handoff floor before this lease can
    // issue its first read; the old generation cannot extend this cursor.
    const leasedAt = this.now().getTime();
    const leasedCursor = { ...cursor, nextCallAt: Math.max(cursor.nextCallAt, leasedAt + 1_000) };
    const state = await this.db.transaction(async (tx) => {
      const [updated] = await tx.update(syncStates).set({ generation: sql`${syncStates.generation} + 1`,
        cursor: leasedCursor, leaseUntil: new Date(leasedAt + LEASE_MS), status: 'running', updatedAt: this.now() })
        .where(and(eq(syncStates.id, before.id), before.cursor === null ? isNull(syncStates.cursor) : eq(syncStates.cursor, before.cursor),
          or(isNull(syncStates.leaseUntil), lte(syncStates.leaseUntil, this.now())))).returning();
      if (updated) await appendSyncEvent(tx, 'sync-progress', account.id);
      return updated;
    });
    return state ? { account, state, cursor: cursorOf(state, account, this.now()) } : null;
  }

  private async checkpoint(state: State, account: Account, cursor: Cursor, signal: AbortSignal): Promise<State> {
    signal.throwIfAborted();
    if (!await this.marker()) throw new MailPageFenceError();
    signal.throwIfAborted();
    const saved = await this.db.transaction(async (tx) => {
    const [updated] = await tx.update(syncStates).set({ cursor, leaseUntil: new Date(this.now().getTime() + LEASE_MS), updatedAt: this.now() })
      .where(and(eq(syncStates.id, state.id), eq(syncStates.generation, state.generation), eq(syncStates.sequence, state.sequence),
        eq(syncStates.status, 'running'), eq(syncStates.cursor, state.cursor), sql`${syncStates.leaseUntil} > now()`,
        sql`exists (select 1 from accounts where id = ${account.id} and credential_generation = ${account.credentialGeneration}
          and revoked_at is null and backfill is not null and ${SCOPE} = any(granted_scopes))`,
        sql`exists (select 1 from settings where key = 'first_orbit_setup_v1' and value ->> 'confirmedOrigin' = ${this.origin})`))
      .returning();
    if (updated && (state.cursor === null || (state.cursor as Cursor).phase !== cursor.phase)) await appendSyncEvent(tx, 'sync-progress', account.id);
    return updated;
    });
    if (!saved) throw new MailPageFenceError();
    return saved;
  }

  private async refreshLabels(account: Account, state: State, reader: Reader, signal: AbortSignal): Promise<Map<string, string>> {
    const page = await reader.listLabels(account.id);
    signal.throwIfAborted();
    const known = new Map(page.labels.map((label) => [label.id, label.name]));
    await this.db.transaction(async (tx) => {
      signal.throwIfAborted();
      await tx.execute(sql`set local statement_timeout = '3000ms'`);
      await tx.execute(sql`set local lock_timeout = '750ms'`);
      const [currentAccount] = await tx.select().from(accounts).where(eq(accounts.id, account.id)).for('update');
      const [currentState] = await tx.select().from(syncStates).where(eq(syncStates.id, state.id)).for('update');
      const [setup] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, 'first_orbit_setup_v1')).for('share');
      const marker = z.object({ version: z.literal(1), orbitId: z.string().uuid(), confirmedOrigin: z.url(),
        globalDefaults: privacyDefaultsSchema }).safeParse(setup?.value);
      if (!currentAccount || !currentState || !eligible(currentAccount) ||
          currentAccount.credentialGeneration !== account.credentialGeneration ||
          currentState.accountId !== account.id || currentState.resource !== 'mail' || currentState.collectionId !== COLLECTION ||
          currentState.generation !== state.generation || currentState.status !== 'running' ||
          !currentState.leaseUntil || currentState.leaseUntil <= new Date() ||
          !marker.success || marker.data.confirmedOrigin !== this.origin) throw new MailPageFenceError();
      const refs = [...known.keys()];
      const rows = refs.length ? await tx.select({ providerRef: labels.providerRef, name: labels.name })
        .from(labels).where(and(eq(labels.accountId, account.id), inArray(labels.providerRef, refs))) : [];
      const stored = new Map(rows.map((row) => [row.providerRef, row.name]));
      let changed = false;
      const current = [...known].filter(([ref, name]) => stored.get(ref) !== name);
      for (let offset = 0; offset < current.length; offset += LABEL_BATCH) {
        signal.throwIfAborted();
        const batch = current.slice(offset, offset + LABEL_BATCH);
        const updated = await tx.insert(labels).values(batch.map(([providerRef, name]) => ({
          id: randomUUID(), accountId: account.id, providerRef, name,
        }))).onConflictDoUpdate({ target: [labels.accountId, labels.providerRef],
          set: { name: sql`excluded.name`, updatedAt: this.now() },
          setWhere: sql`${labels.name} <> excluded.name` }).returning({ id: labels.id });
        changed ||= updated.length > 0;
      }
      // Keep referenced IDs as unresolved privacy evidence. Unreferenced vanished labels
      // are removed so they cannot accumulate as false incomplete-catalog warnings.
      const absent = refs.length ? notInArray(labels.providerRef, refs) : undefined;
      const [stale] = await tx.select({ id: labels.id }).from(labels)
        .where(and(eq(labels.accountId, account.id), absent, or(sql`${labels.name} <> ''`,
          sql`not exists (select 1 from item_labels where label_id = ${labels.id} and account_id = ${account.id})`))).limit(1);
      if (stale) {
        signal.throwIfAborted();
        await tx.delete(labels).where(and(eq(labels.accountId, account.id), absent,
          sql`not exists (select 1 from item_labels where label_id = ${labels.id} and account_id = ${account.id})`));
        await tx.update(labels).set({ name: '', updatedAt: this.now() })
          .where(and(eq(labels.accountId, account.id), absent, sql`${labels.name} <> ''`));
        changed = true;
      }
      signal.throwIfAborted();
      if (changed) await appendSyncEvent(tx, 'mail-changed', account.id);
      signal.throwIfAborted();
      const [live] = await tx.select({ id: syncStates.id }).from(syncStates).where(and(eq(syncStates.id, state.id),
        eq(syncStates.generation, state.generation), eq(syncStates.status, 'running'),
        sql`${syncStates.leaseUntil} > clock_timestamp()`));
      if (!live) throw new MailPageFenceError();
      signal.throwIfAborted();
    });
    return known;
  }

  private async apply(state: State, account: Account, cursor: Cursor, change: MailChange, signal: AbortSignal): Promise<State> {
    signal.throwIfAborted();
    await applyMailPage(this.db, this.blobs, { accountId: account.id, stateId: state.id, collectionId: COLLECTION,
      pageId: `g${state.generation}-s${state.sequence + 1}`, configuredOrigin: this.origin,
      expectedLeaseGeneration: state.generation, expectedCredentialGeneration: account.credentialGeneration,
      expectedSequence: state.sequence, cursorAfter: cursor, changes: [change] }, signal);
    const [next] = await this.db.select().from(syncStates).where(eq(syncStates.id, state.id));
    if (!next || next.sequence !== state.sequence + 1) throw new MailPageFenceError();
    return next;
  }

  private async skip(state: State, account: Account, cursor: Cursor, signal: AbortSignal): Promise<State> {
    return this.checkpoint(state, account, cursor, signal);
  }

  private async message(account: Account, id: string, names: Map<string, string>, cutoff: number, reader: Reader,
    signal: AbortSignal): Promise<MailChange | null> {
    // Capture before the SDK read. A later action settlement advances the item epoch,
    // so a read begun before settlement cannot clear its derived-data barrier.
    const [prior] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '3000ms'`);
      await tx.execute(sql`set local lock_timeout = '750ms'`);
      return tx.select({ epoch: items.actionEpoch }).from(items).where(and(
        eq(items.accountId, account.id), eq(items.collectionId, COLLECTION), eq(items.externalId, id)));
    }, { accessMode: 'read only' });
    signal.throwIfAborted();
    const observedEpoch = prior?.epoch ?? 0;
    let raw: GmailRawMessage;
    let parsed: ParseResult;
    try {
      raw = await reader.getMessageRaw(account.id, id);
      signal.throwIfAborted();
      parsed = await this.parser(raw.mime, signal);
      signal.throwIfAborted();
      if (!parsed.ok && ['busy', 'timeout', 'service_unavailable'].includes(parsed.code)) throw new Error('parser_transient');
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof GmailReadError && error.code === 'message_missing') return this.tombstone(id);
      if (error instanceof GmailReadError && error.code === 'too_large') {
        const meta = await reader.getMessageMinimal(account.id, id).catch((cause: unknown) => {
          if (cause instanceof GmailReadError && cause.code === 'message_missing') return null;
          throw cause;
        });
        signal.throwIfAborted();
        if (!meta) return this.tombstone(id);
        if (cutoff && !meta.internalDate) throw new GmailReadError('invalid_response');
        if (meta.internalDate && Number(meta.internalDate) < cutoff * 1000 && !await this.retained(account, id)) return null;
        return this.change(meta, { ok: false, code: 'input_too_large' }, names, observedEpoch, account.credentialGeneration);
      }
      throw error;
    }
    if (Number(raw.internalDate) < cutoff * 1000 && !await this.retained(account, id)) return null;
    if (Buffer.byteLength(JSON.stringify(parsed)) > 20 * 1024 * 1024) parsed = { ok: false, code: 'limit_exceeded' };
    return this.change(raw, parsed, names, observedEpoch, account.credentialGeneration);
  }

  private async retained(account: Account, id: string): Promise<boolean> {
    const [existing] = await this.db.select({ id: items.id }).from(items).where(and(eq(items.accountId, account.id), eq(items.collectionId, COLLECTION), eq(items.externalId, id), isNull(items.deletedAt)));
    return !!existing;
  }

  private tombstone(id: string): MailChange {
    return { externalId: id, threadExternalId: null, providerRevision: null, internalAt: null, receivedAt: null,
      snippet: null, flags: {}, labelRefs: [], providerSent: false, deleted: true, parsed: null, routedOrbitIds: [] };
  }
  private change(meta: GmailRawMessage | GmailMessageMetadata, parsed: ParseResult, names: Map<string, string>,
    observedEpoch: number, credentialGeneration: number): MailChange {
    return { externalId: meta.id, threadExternalId: meta.threadId, providerRevision: meta.historyId ?? null,
      internalAt: meta.internalDate ? new Date(Number(meta.internalDate)) : null, receivedAt: this.now(), snippet: null,
      flags: { read: !meta.labelIds.includes('UNREAD'), starred: meta.labelIds.includes('STARRED') },
      labelRefs: meta.labelIds.map((ref) => ({ ref, name: names.get(ref) ?? null })), providerSent: meta.trustedSent,
      deleted: false, parsed, routedOrbitIds: [],
      observedActionEpoch: parsed.ok ? observedEpoch : null,
      observedCredentialGeneration: parsed.ok ? credentialGeneration : null };
  }

  private historyIds(page: GmailHistoryPage): string[] {
    const ids = new Set<string>();
    for (const record of page.history) for (const field of ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved'] as const)
      for (const entry of record[field] ?? []) ids.add(entry.message.id);
    return [...ids];
  }

  async run(accountId: string, jobSignal?: AbortSignal): Promise<void> {
    const signal = jobSignal ? AbortSignal.any([jobSignal, AbortSignal.timeout(this.runBudgetMs)]) : AbortSignal.timeout(this.runBudgetMs);
    signal.throwIfAborted();
    const lease = await this.lease(accountId);
    if (!lease) return;
    const { account } = lease;
    let { state, cursor } = lease;
    try {
      const historyCache = new Map<string, GmailHistoryPage>();
      // The lease transaction itself can be slow; its durable wall deadline
      // may elapse before control returns. Keep a monotonic handoff floor too.
      let localNextCallAt = performance.now() + 1_000;
      const paced = async <T>(request: () => Promise<T>): Promise<T> => {
        signal.throwIfAborted();
        while (true) {
          const waitMs = Math.max(cursor.nextCallAt - this.now().getTime(), localNextCallAt - performance.now());
          if (waitMs <= 0) break;
          await delay(Math.min(waitMs, 60_000), undefined, { signal });
        }
        signal.throwIfAborted();
        // The current per-user quota charges raw reads heavily. One request each second
        // stays below that ceiling even if every call is a raw message retrieval.
        // This pre-call reservation is durable if the process dies before the
        // response. It is not the serial completion floor below.
        cursor = { ...cursor, nextCallAt: Math.max(cursor.nextCallAt, this.now().getTime() + 1_000) };
        state = await this.checkpoint(state, account, cursor, signal);
        signal.throwIfAborted();
        let result: T;
        try { result = await request(); }
        catch (error) {
          localNextCallAt = performance.now() + 1_000;
          cursor = { ...cursor, nextCallAt: Math.max(cursor.nextCallAt, this.now().getTime() + 1_000) };
          // Keep the original provider error. A stale or failed checkpoint
          // cannot authorize another call; run() ends through its error path.
          try { if (!signal.aborted) state = await this.checkpoint(state, account, cursor, signal); }
          catch { /* The outer fenced error path owns state and retry. */ }
          throw error;
        }
        localNextCallAt = performance.now() + 1_000;
        cursor = { ...cursor, nextCallAt: Math.max(cursor.nextCallAt, this.now().getTime() + 1_000) };
        state = await this.checkpoint(state, account, cursor, signal);
        signal.throwIfAborted();
        return result;
      };
      const reader: Reader = {
        getProfile: (id) => paced(() => this.reader.getProfile(id)),
        listLabels: (id) => paced(() => this.reader.listLabels(id)),
        listMessageIds: (id, input) => paced(() => this.reader.listMessageIds(id, input)),
        getMessageRaw: (id, messageId) => paced(() => this.reader.getMessageRaw(id, messageId)),
        getMessageMinimal: (id, messageId) => paced(() => this.reader.getMessageMinimal(id, messageId)),
        listHistory: (id, input) => paced(() => this.reader.listHistory(id, input)),
      };
      let names = await this.refreshLabels(account, state, reader, signal);
      for (let steps = 0; steps < MAX_RUN_STEPS; steps++) {
        signal.throwIfAborted();
        if (cursor.phase === 'anchor') {
          const profile = await reader.getProfile(accountId);
          if (profile.emailAddress.toLowerCase() !== account.email.toLowerCase()) throw new GmailReadError('needs_reconnect');
          cursor = { ...cursor, phase: 'full', anchor: profile.historyId, scanStart: state.sequence };
          state = await this.checkpoint(state, account, cursor, signal);
        } else if (cursor.phase === 'full') {
          if (cursor.offset < cursor.pending.length) {
            const id = cursor.pending[cursor.offset]!;
            const change = await this.message(account, id, names, cursor.cutoff, reader, signal);
            const advanced = { ...cursor, offset: cursor.offset + 1 };
            const next = advanced.offset === advanced.pending.length && !advanced.listToken ? finishFull(advanced) : advanced;
            state = change ? await this.apply(state, account, next, change, signal) : await this.skip(state, account, next, signal);
            cursor = next;
          } else if (cursor.pending.length && !cursor.listToken) {
            // Recover cursors committed by an older run after its last item but before its phase checkpoint.
            cursor = finishFull(cursor);
            state = await this.checkpoint(state, account, cursor, signal);
          } else if (cursor.pending.length) {
            cursor = { ...cursor, pending: [], offset: 0 };
            state = await this.checkpoint(state, account, cursor, signal);
          } else {
            const page = await reader.listMessageIds(accountId, { ...(cursor.cutoff ? { cutoffEpochSeconds: Math.max(0, cursor.cutoff - 1) } : {}),
              ...(cursor.listToken ? { pageToken: cursor.listToken } : {}), maxResults: ID_BATCH, includeSpamTrash: true });
            if (page.messages.length > ID_BATCH) throw new GmailReadError('invalid_response');
            const listed = { ...cursor, pending: page.messages.map((entry) => entry.id), offset: 0, listToken: page.nextPageToken ?? null };
            cursor = !listed.pending.length && !listed.listToken ? finishFull(listed) : listed;
            state = await this.checkpoint(state, account, cursor, signal);
          }
        } else if (cursor.phase === 'reconcile_delete') {
          // appliedSequence is written only by the fenced mail page operation. Every enumerated item
          // received a sequence above scanStart; older retained items are outside the frozen cutoff.
          const candidates = await this.db.select().from(items).where(and(eq(items.accountId, account.id), eq(items.collectionId, COLLECTION),
            isNull(items.deletedAt), lte(items.appliedSequence, cursor.scanStart),
            sql`(${cursor.cutoff} = 0 or ${items.internalAt} >= to_timestamp(${cursor.cutoff}))`)).limit(ID_BATCH);
          signal.throwIfAborted();
          if (!candidates.length) {
            cursor = { ...cursor, phase: 'history', historyStart: cursor.anchor, historyToken: null, historyOffset: 0 };
            state = await this.checkpoint(state, account, cursor, signal);
          } else for (const item of candidates) {
            state = await this.apply(state, account, cursor, this.tombstone(item.externalId), signal);
          }
        } else if (cursor.phase === 'history' || cursor.phase === 'ready') {
          if (cursor.phase === 'ready') {
            cursor = { ...cursor, phase: 'history', historyStart: cursor.anchor, historyToken: null, historyOffset: 0 };
            state = await this.checkpoint(state, account, cursor, signal);
          }
          if (!cursor.historyStart) throw new Error('sync_cursor_invalid');
          let page: GmailHistoryPage;
          try {
            const cacheKey = JSON.stringify([cursor.historyStart, cursor.historyToken]);
            const cached = historyCache.get(cacheKey);
            if (cached) page = cached;
            else {
              page = await reader.listHistory(accountId, { startHistoryId: cursor.historyStart,
                ...(cursor.historyToken ? { pageToken: cursor.historyToken } : {}) });
              historyCache.clear();
              historyCache.set(cacheKey, page);
            }
          }
          catch (error) {
            if (!(error instanceof GmailReadError) || error.code !== 'history_expired') throw error;
            const profile = await reader.getProfile(accountId);
            cursor = { ...cursor, phase: 'full', anchor: profile.historyId, listToken: null, pending: [], offset: 0,
              scanStart: state.sequence, historyToken: null, historyOffset: 0 };
            state = await this.checkpoint(state, account, cursor, signal);
            continue;
          }
          const ids = this.historyIds(page);
          if (cursor.historyOffset < ids.length) {
            const id = ids[cursor.historyOffset]!;
            const change = await this.message(account, id, names, cursor.cutoff, reader, signal);
            const next = { ...cursor, historyOffset: cursor.historyOffset + 1 };
            state = change ? await this.apply(state, account, next, change, signal) : await this.skip(state, account, next, signal);
            cursor = next;
          } else if (page.nextPageToken) {
            cursor = { ...cursor, historyToken: page.nextPageToken, historyOffset: 0 };
            state = await this.checkpoint(state, account, cursor, signal);
          } else {
            cursor = { ...cursor, phase: 'ready', anchor: page.historyId, historyStart: page.historyId,
              historyToken: null, historyOffset: 0, failures: 0, retryAt: 0, blockedGeneration: null };
            state = await this.checkpoint(state, account, cursor, signal);
            break;
          }
        }
        if (steps % 20 === 19) names = await this.refreshLabels(account, state, reader, signal);
      }
      // Gmail may emit no history event for an already-matching no-op. Re-read a
      // bounded set of stale supported items through the same paced SDK/parser,
      // page fence and durable sequence path after normal history catch-up.
      if (cursor.phase === 'ready') {
        const stale = (after: string | null) => this.db.transaction(async (tx) => {
          await tx.execute(sql`set local statement_timeout = '3000ms'`);
          await tx.execute(sql`set local lock_timeout = '750ms'`);
          return tx.select({ id: items.id, externalId: items.externalId }).from(items)
            .where(and(eq(items.accountId, account.id), eq(items.collectionId, COLLECTION), isNull(items.deletedAt),
              eq(items.parseStatus, 'supported'), after ? gt(items.id, after) : undefined,
              sql`(${items.observedActionEpoch} is null or ${items.observedActionEpoch} <> ${items.actionEpoch} or
                ${items.observedCredentialGeneration} is distinct from ${account.credentialGeneration})`,
              sql`not exists (select 1 from mail_change_operations m where m.item_id = ${items.id}
                and m.state in ('pending', 'in_flight', 'outcome_unknown'))`))
            .orderBy(items.id).limit(OBSERVATION_REFRESH_LIMIT);
        }, { accessMode: 'read only' });
        let candidates = await stale(cursor.observationAfter);
        if (!candidates.length && cursor.observationAfter) candidates = await stale(null);
        for (const item of candidates) {
          signal.throwIfAborted();
          cursor = { ...cursor, observationAfter: item.id };
          state = await this.checkpoint(state, account, cursor, signal);
          const change = await this.message(account, item.externalId, names, cursor.cutoff, reader, signal);
          if (change) state = await this.apply(state, account, cursor, change, signal);
        }
      }
      signal.throwIfAborted();
      await this.db.transaction(async (tx) => {
        const [updated] = await tx.update(syncStates).set({ status: 'idle', leaseUntil: null, lastError: null,
          ...(cursor.phase === 'ready' ? { lastSuccessAt: this.now() } : {}), updatedAt: this.now() })
          .where(and(eq(syncStates.id, state.id), eq(syncStates.generation, state.generation))).returning({ id: syncStates.id });
        if (updated) await appendSyncEvent(tx, 'sync-progress', account.id);
      });
    } catch (error) {
      if (signal.aborted) {
        // A timed-out or stopped job leaves the last committed offset intact.
        await this.db.transaction(async (tx) => {
          const [current] = await tx.select().from(syncStates).where(and(eq(syncStates.id, state.id),
            eq(syncStates.generation, state.generation), eq(syncStates.status, 'running'))).for('update');
          if (!current) return;
          const saved = cursorOf(current, account, this.now());
          const [updated] = await tx.update(syncStates).set({ status: 'idle', leaseUntil: null,
            cursor: { ...saved, nextCallAt: Math.max(saved.nextCallAt, this.now().getTime() + 1_000) },
            lastError: 'sync_interrupted', updatedAt: this.now() })
            .where(and(eq(syncStates.id, state.id), eq(syncStates.generation, state.generation), eq(syncStates.status, 'running'))).returning({ id: syncStates.id });
          if (updated) await appendSyncEvent(tx, 'sync-progress', account.id);
        });
        return;
      }
      const [current] = await this.db.select().from(syncStates).where(eq(syncStates.id, state.id));
      if (current?.generation === state.generation) {
        const currentCursor = cursorSchema.safeParse(current.cursor);
        const failures = currentCursor.success ? currentCursor.data.failures + 1 : 1;
        const permanent = error instanceof GmailReadError && ['needs_reconnect', 'permission_denied'].includes(error.code);
        await this.db.transaction(async (tx) => {
        const [updated] = await tx.update(syncStates).set({ status: permanent ? 'blocked' : 'idle', leaseUntil: null, lastError: safeCode(error),
          cursor: currentCursor.success ? { ...currentCursor.data, failures,
            nextCallAt: Math.max(currentCursor.data.nextCallAt, this.now().getTime() + 1_000),
            retryAt: permanent ? 0 : retryTime(this.now().getTime(), failures, error),
            blockedGeneration: permanent ? account.credentialGeneration : null } : current.cursor,
          updatedAt: this.now() }).where(and(eq(syncStates.id, state.id), eq(syncStates.generation, state.generation))).returning({ id: syncStates.id });
        if (updated) await appendSyncEvent(tx, 'sync-progress', account.id);
        });
      }
    }
  }

  async collect(): Promise<number> { return collectOrphanBlobs(this.db, this.blobs, 60_000, 25); }
}
