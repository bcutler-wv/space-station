import { fastifySSE } from '@fastify/sse';
import type { FastifyInstance } from 'fastify';
import { count, eq, isNull } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { accounts, items, readSyncEvents, syncStates } from '@station/db';
import { syncChangeEventSchema, syncEventIdSchema, syncProgressResponseSchema, SYNC_EVENT_NAMES } from '@station/shared';
import { validOwnerSession } from './auth-store.js';
import type { AuthConfig } from './auth.js';

const MAX_STREAMS = 8;
const POLL_MS = 2_000;
const AUTH_CHECK_MS = 1_500;
const SEND_MS = 2_000;
const HEARTBEAT_MS = 20_000;
const MAX_BUFFER = 16_384;
const repairCodes = new Set(['needs_reconnect', 'permission_denied', 'sync_cursor_invalid']);

function phase(state: typeof syncStates.$inferSelect | undefined, account: typeof accounts.$inferSelect) {
  const cursor = state?.cursor && typeof state.cursor === 'object' ? state.cursor as Record<string, unknown> : null;
  const retryPending = typeof cursor?.retryAt === 'number' && Number.isSafeInteger(cursor.retryAt) && cursor.retryAt > Date.now();
  // Gmail Retry-After can exceed year 9999; expose the retry state without an
  // invalid API timestamp in that case.
  const retryAt = retryPending && (cursor.retryAt as number) <= 253_402_300_799_000
    ? new Date(cursor.retryAt as number).toISOString() : null;
  const repairCode = state?.lastError && repairCodes.has(state.lastError) ? state.lastError as 'needs_reconnect' | 'permission_denied' | 'sync_cursor_invalid' : null;
  if (account.revokedAt || repairCode || state?.status === 'blocked') return { phase: 'repair' as const, repairCode: repairCode ?? 'needs_reconnect' as const, retryAt: null };
  if (!account.backfill || !state) return { phase: 'waiting' as const, repairCode: null, retryAt: null };
  if (retryPending) return { phase: 'retry' as const, repairCode: null, retryAt };
  if (cursor?.phase === 'full' || cursor?.phase === 'reconcile_delete') return { phase: 'backfill' as const, repairCode: null, retryAt: null };
  if (cursor?.phase === 'history') return { phase: 'catchup' as const, repairCode: null, retryAt: null };
  if (cursor?.phase === 'ready') return { phase: 'current' as const, repairCode: null, retryAt: null };
  return { phase: 'waiting' as const, repairCode: null, retryAt: null };
}

export async function registerSync(app: FastifyInstance, auth: AuthConfig): Promise<void> {
  await app.register(fastifySSE, { heartbeatInterval: 0 });
  let active = 0;
  const db = auth.db;
  app.get('/api/sync/progress', async (request, reply) => {
    if (request.headers.origin && request.headers.origin !== auth.origin) return reply.code(403).send({ error: 'Open the configured HTTPS address.' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Open the configured HTTPS address.' });
    const rows = await db.select().from(accounts).where(eq(accounts.provider, 'google'));
    const states = await db.select().from(syncStates).where(eq(syncStates.resource, 'mail'));
    const counts = await db.select({ accountId: items.accountId, status: items.parseStatus, total: count() })
      .from(items).where(isNull(items.deletedAt)).groupBy(items.accountId, items.parseStatus);
    const byState = new Map(states.map((state) => [state.accountId, state]));
    const byCount = new Map<string, { supported: number; unsupported: number }>();
    for (const row of counts) {
      const current = byCount.get(row.accountId) ?? { supported: 0, unsupported: 0 };
      if (row.status === 'supported') current.supported += row.total;
      if (row.status === 'unsupported') current.unsupported += row.total;
      byCount.set(row.accountId, current);
    }
    return syncProgressResponseSchema.parse({ accounts: rows.map((account) => {
      const state = byState.get(account.id);
      const tally = byCount.get(account.id) ?? { supported: 0, unsupported: 0 };
      return { accountId: account.id, orbitId: account.orbitId, ...phase(state, account),
        processedPages: state?.sequence ?? 0, supportedItems: tally.supported, unsupportedItems: tally.unsupported,
        lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null };
    }) });
  });

  app.get('/api/sync/events', { sse: { kind: 'only', heartbeat: false } }, async (request, reply) => {
    if ((request.headers.origin && request.headers.origin !== auth.origin) || request.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: 'Open the configured HTTPS address.' });
    const sessionId = request.session.sessionId;
    const generation = request.session.authGeneration;
    if (!sessionId || generation === undefined || !(await validOwnerSession(db, sessionId, generation)))
      return reply.code(401).send({ error: 'Sign in to view sync activity.' });
    if (active >= MAX_STREAMS) return reply.code(429).send({ error: 'Too many live connections. Close another tab and retry.' });
    const last = reply.sse.lastEventId;
    if (last !== null && !syncEventIdSchema.safeParse(last).success)
      return reply.code(400).send({ error: 'Invalid event cursor. Refresh this page.' });
    let cursor = last === null ? null : Number(last);
    if (cursor !== null && !Number.isSafeInteger(cursor)) return reply.code(400).send({ error: 'Invalid event cursor. Refresh this page.' });
    active++;
    const stopped = new AbortController();
    let lastWrite = Date.now();
    const close = () => { if (!stopped.signal.aborted) { stopped.abort(); active--; reply.sse.close(); } };
    reply.sse.onClose(close);
    const send = async (event: string, id: number | null, accountId = '') => {
      if (stopped.signal.aborted || !reply.sse.isConnected || reply.raw.writableLength > MAX_BUFFER) { close(); return false; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectClosed: ((error: Error) => void) | undefined;
      const onAbort = () => rejectClosed?.(new Error('closed stream'));
      try {
        await Promise.race([
          reply.sse.send({ event, ...(id === null ? {} : { id: String(id) }), data: accountId }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('slow stream')), SEND_MS); }),
          new Promise<never>((_, reject) => { rejectClosed = reject; stopped.signal.addEventListener('abort', onAbort, { once: true }); }),
        ]);
        lastWrite = Date.now();
        return true;
      } catch { close(); reply.raw.destroy(); return false; }
      finally { if (timer) clearTimeout(timer); stopped.signal.removeEventListener('abort', onAbort); }
    };
    reply.header('Cache-Control', 'no-store');
    reply.header('Vary', 'Origin');
    reply.sse.keepAlive();
    const whileConnected = async <T>(work: Promise<T>): Promise<T> => {
      let onAbort: (() => void) | undefined;
      const closed = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('closed stream'));
        if (stopped.signal.aborted) onAbort();
        else stopped.signal.addEventListener('abort', onAbort, { once: true });
      });
      try { return await Promise.race([work, closed]); }
      finally { if (onAbort) stopped.signal.removeEventListener('abort', onAbort); }
    };
    // This loop is independent of replay writes. A slowly draining client can
    // keep a send pending near its deadline, so checking only between batches
    // would let revocation lag for the whole replay window.
    const watchAuthorization = async () => {
      while (!stopped.signal.aborted) {
        try { await delay(POLL_MS, undefined, { signal: stopped.signal }); } catch { break; }
        if (stopped.signal.aborted) break;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const authorized = await Promise.race([
            validOwnerSession(db, sessionId, generation).catch(() => false),
            new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), AUTH_CHECK_MS); }),
          ]);
          if (!authorized) close();
        } finally { if (timeout) clearTimeout(timeout); }
      }
    };
    void watchAuthorization();
    try {
      while (!stopped.signal.aborted) {
        let batch: Awaited<ReturnType<typeof readSyncEvents>>;
        try { batch = await whileConnected(readSyncEvents(db, cursor)); } catch { break; }
        if (cursor === null || batch.gap) {
          if (!await send(SYNC_EVENT_NAMES.reset, batch.head)) break;
          cursor = batch.head;
        } else {
          for (const row of batch.rows) {
            const safeEvent = syncChangeEventSchema.safeParse({ event: row.kind, id: String(row.id), accountId: row.accountId });
            if (!safeEvent.success) { await send(SYNC_EVENT_NAMES.reset, batch.head); cursor = batch.head; break; }
            if (!await send(safeEvent.data.event, row.id, safeEvent.data.accountId)) break;
            cursor = row.id;
          }
        }
        if (stopped.signal.aborted) break;
        if (Date.now() - lastWrite >= HEARTBEAT_MS && !await send(SYNC_EVENT_NAMES.heartbeat, null)) break;
        try { await delay(POLL_MS, undefined, { signal: stopped.signal }); } catch { break; }
      }
    } finally { close(); }
  });
}
