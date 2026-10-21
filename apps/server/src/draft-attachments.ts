import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accounts, draftAttachments, drafts, PrivateBlobStore } from '@station/db';
import { draftAttachmentListSchema, draftAttachmentQuerySchema, draftAttachmentRemoveSchema,
  draftAttachmentSchema, draftAttachmentUploadHeadersSchema, draftAttachmentMutationSchema,
  draftAttachmentRevisionSchema, readerIdSchema } from '@station/shared';
import type { AuthConfig } from './auth.js';

const LIMIT = 8 * 1024 * 1024;
const bad = { error: 'Check the attachment request and try again.' };
const missing = { error: 'This draft or attachment is unavailable in this account and Orbit.' };
const conflict = { error: 'This draft changed. Reload it before changing attachments.' };
let activeUploads = 0;
type Tx = Parameters<Parameters<AuthConfig['db']['transaction']>[0]>[0];
function filename(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e]/g, '_').replace(/^[.\s]+/, '').trim();
  let bounded = '';
  for (const character of cleaned) {
    if (bounded.length + character.length > 180) break;
    bounded += character;
  }
  return bounded || 'attachment';
}
function decodeFilename(raw: string): string | null {
  if (!/^[\x21-\x7e]+$/.test(raw)) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return Buffer.byteLength(decoded) <= 512 ? filename(decoded) : null;
  } catch { return null; }
}
const display = (row: typeof draftAttachments.$inferSelect) => draftAttachmentSchema.parse({
  id: row.id, filename: row.filename, byteSize: row.byteSize,
  status: row.state === 'ready' ? 'ready' : row.state === 'pending' ? 'pending' : 'unavailable',
});
const disposition = (name: string) => {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};
export function registerDraftAttachments(app: FastifyInstance, auth: AuthConfig, store: PrivateBlobStore): void {
  const db = auth.db;
  const origin = (headers: Record<string, unknown>) =>
    (!headers.origin || headers.origin === auth.origin) && headers['sec-fetch-site'] !== 'cross-site';
  // Keep the body as a stream until the authenticated route can enforce its
  // own eight MiB cap. The global authentication preHandler runs before it.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
  const run = <T>(work: (tx: Tx) => Promise<T>, readonly = false): Promise<T> => db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    return work(tx);
  }, readonly ? { accessMode: 'read only' } : undefined);
  const scoped = async (tx: Tx, id: string, accountId: string, orbitId?: string, lock = false) => {
    const query = tx.select().from(drafts).where(and(eq(drafts.id, id), eq(drafts.ownerId, 'owner'),
      eq(drafts.accountId, accountId), orbitId ? eq(drafts.orbitId, orbitId) : undefined)).limit(1);
    const [row] = lock ? await query.for('update') : await query;
    if (!row) return null;
    const [account] = await tx.select({ orbitId: accounts.orbitId }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!account || (orbitId && row.orbitId !== orbitId)) return null;
    return row;
  };
  const scope = (request: { params: unknown; query: unknown }) => {
    const id = (request.params as { draftId?: unknown }).draftId;
    const query = draftAttachmentQuerySchema.safeParse(request.query);
    return typeof id === 'string' && readerIdSchema.safeParse(id).success && query.success ? { id, ...query.data } : null;
  };
  app.get('/api/mail/drafts/:draftId/attachments', async (request, reply) => {
    if (!origin(request.headers)) return reply.code(403).send(bad);
    const value = scope(request);
    if (!value) return reply.code(400).send(bad);
    const result = await run(async (tx) => {
      const draft = await scoped(tx, value.id, value.accountId, value.orbitId);
      if (!draft || draft.state !== 'editing') return null;
      const rows = await tx.select().from(draftAttachments).where(and(eq(draftAttachments.draftId, value.id),
        eq(draftAttachments.accountId, value.accountId), inArray(draftAttachments.state, ['pending', 'ready']))).limit(65);
      return draftAttachmentListSchema.parse({ attachments: rows.map(display), revision: draft.revision });
    }, true);
    return result ?? reply.code(404).send(missing);
  });
  app.post('/api/mail/drafts/:draftId/attachments', { bodyLimit: LIMIT + 1 }, async (request, reply) => {
    const value = scope(request);
    const headers = draftAttachmentUploadHeadersSchema.safeParse({
      'x-attachment-name': request.headers['x-attachment-name'], 'x-upload-key': request.headers['x-upload-key'],
      'x-draft-revision': request.headers['x-draft-revision'], 'content-type': request.headers['content-type'],
    });
    if (!value || !headers.success) return reply.code(400).send(bad);
    const name = decodeFilename(headers.data['x-attachment-name']);
    if (!name) return reply.code(400).send(bad);
    const preflight = await run(async (tx) => {
      const draft = await scoped(tx, value.id, value.accountId, value.orbitId);
      if (!draft) return 404;
      const [existing] = await tx.select({ state: draftAttachments.state }).from(draftAttachments)
        .where(and(eq(draftAttachments.draftId, value.id), eq(draftAttachments.uploadKey, headers.data['x-upload-key']))).limit(1);
      return draft.state === 'editing' && (draft.revision === headers.data['x-draft-revision'] || existing?.state === 'ready') ? 200 : 409;
    }, true);
    if (preflight !== 200) return reply.code(preflight).send(preflight === 404 ? missing : conflict);
    const declared = request.headers['content-length'];
    if (typeof declared === 'string' && (!/^\d+$/.test(declared) || Number(declared) > LIMIT))
      return reply.code(413).send({ error: 'Choose a file no larger than 8 MiB.' });
    if (activeUploads >= 4) return reply.code(429).send({ error: 'Too many uploads. Try again shortly.' });
    activeUploads++;
    let released = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); request.raw.destroy(); }, 30_000);
    const release = () => { if (!released) { released = true; activeUploads--; clearTimeout(timeout); } };
    try {
    let bytes: Buffer;
    try {
      if (!request.body || typeof (request.body as AsyncIterable<Buffer>)[Symbol.asyncIterator] !== 'function')
        return reply.code(400).send(bad);
      let allocation: Buffer | undefined;
      let size = 0;
      for await (const chunk of request.body as AsyncIterable<Buffer>) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += part.byteLength;
        if (size > LIMIT) return reply.code(413).send({ error: 'Choose a file no larger than 8 MiB.' });
        allocation ??= Buffer.allocUnsafe(LIMIT);
        part.copy(allocation, size - part.byteLength);
      }
      bytes = allocation?.subarray(0, size) ?? Buffer.alloc(0);
    } catch { return reply.code(400).send({ error: 'The upload was interrupted. Try again.' }); }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const key = PrivateBlobStore.generateKey();
    const uploadKey = headers.data['x-upload-key'];
    const revision = headers.data['x-draft-revision'];
    const reserved = await run(async (tx) => {
      const draft = await scoped(tx, value.id, value.accountId, value.orbitId, true);
      if (!draft) return { status: 404 as const };
      const [existing] = await tx.select().from(draftAttachments).where(and(eq(draftAttachments.draftId, value.id), eq(draftAttachments.uploadKey, uploadKey))).limit(1);
      if (existing) return existing.digest === digest && existing.filename === name && existing.byteSize === bytes.byteLength && existing.state === 'ready'
        ? { status: 200 as const, row: existing, revision: draft.revision } : { status: 409 as const };
      if (draft.state !== 'editing' || draft.revision !== revision) return { status: 409 as const };
      const active = await tx.select({ size: draftAttachments.byteSize }).from(draftAttachments)
        .where(and(eq(draftAttachments.draftId, value.id), inArray(draftAttachments.state, ['pending', 'ready']))).limit(65);
      if (active.length >= 64 || active.reduce((sum, row) => sum + row.size, 0) + bytes.byteLength > LIMIT)
        return { status: 413 as const };
      const [row] = await tx.insert(draftAttachments).values({ id: randomUUID(), draftId: value.id, accountId: value.accountId,
        blobKey: key, uploadKey, digest, filename: name, byteSize: bytes.byteLength }).returning();
      return { status: 201 as const, row: row!, revision };
    });
    if (reserved.status === 404) return reply.code(404).send(missing);
    if (reserved.status === 409) return reply.code(409).send(conflict);
    if (reserved.status === 413) return reply.code(413).send({ error: 'Draft attachments exceed the 64-file or 8 MiB total limit.' });
    if (reserved.status === 200) return reply.send(draftAttachmentMutationSchema.parse({ attachment: display(reserved.row), revision: reserved.revision }));
    const row = reserved.row;
    try {
      // The committed intent is locked through immutable publication, matching
      // the existing mail blob writer/collector contract.
      await run(async (tx) => {
        const [intent] = await tx.select().from(draftAttachments).where(eq(draftAttachments.id, row.id)).for('update');
        if (!intent || intent.state !== 'pending') throw new Error('Draft upload intent was reclaimed');
        if (request.raw.aborted) controller.abort();
        await store.writeReserved(key, bytes, controller.signal);
      });
      const stored = await store.read(key, LIMIT);
      if (stored.byteLength !== bytes.byteLength || createHash('sha256').update(stored).digest('hex') !== digest)
        throw new Error('Published attachment failed verification');
      const finished = await run(async (tx) => {
        const draft = await scoped(tx, value.id, value.accountId, value.orbitId, true);
        const [intent] = await tx.select().from(draftAttachments).where(eq(draftAttachments.id, row.id)).for('update');
        if (!draft || draft.state !== 'editing' || draft.revision !== revision || !intent || intent.state !== 'pending') {
          if (intent?.state === 'pending') await tx.update(draftAttachments).set({ state: 'delete_pending', updatedAt: new Date() }).where(eq(draftAttachments.id, row.id));
          return null;
        }
        await tx.update(draftAttachments).set({ state: 'ready', updatedAt: new Date() }).where(eq(draftAttachments.id, row.id));
        await tx.update(drafts).set({ attachmentRefs: [...(draft.attachmentRefs as string[]), row.id], revision: revision + 1,
          updatedAt: new Date() }).where(eq(drafts.id, value.id));
        return revision + 1;
      });
      return finished ? reply.code(201).send(draftAttachmentMutationSchema.parse({ attachment: display({ ...row, state: 'ready' }), revision: finished })) : reply.code(409).send(conflict);
    } catch {
      await run(async (tx) => {
        await tx.update(draftAttachments).set({ state: 'delete_pending', updatedAt: new Date() })
          .where(and(eq(draftAttachments.id, row.id), eq(draftAttachments.state, 'pending')));
      }).catch(() => undefined);
      return reply.code(503).send({ error: 'The attachment could not be stored. Try again.' });
    }
    } finally { release(); }
  });
  app.delete('/api/mail/drafts/:draftId/attachments/:attachmentId', async (request, reply) => {
    const value = scope(request);
    const id = (request.params as { attachmentId?: unknown }).attachmentId;
    const body = draftAttachmentRemoveSchema.safeParse(request.body);
    if (!value || typeof id !== 'string' || !readerIdSchema.safeParse(id).success || !body.success) return reply.code(400).send(bad);
    const result = await run(async (tx) => {
      const draft = await scoped(tx, value.id, value.accountId, value.orbitId, true);
      if (!draft) return { status: 404 as const };
      const [row] = await tx.select().from(draftAttachments).where(and(eq(draftAttachments.id, id), eq(draftAttachments.draftId, value.id),
        eq(draftAttachments.accountId, value.accountId))).limit(1);
      if (!row) return { status: 404 as const };
      if (row.state === 'delete_pending' && draft.revision === body.data.revision + 1) return { status: 200 as const, revision: draft.revision };
      if (draft.state !== 'editing' || draft.revision !== body.data.revision || row.state !== 'ready') return { status: 409 as const };
      await tx.update(draftAttachments).set({ state: 'delete_pending', updatedAt: new Date() }).where(eq(draftAttachments.id, id));
      await tx.update(drafts).set({ attachmentRefs: (draft.attachmentRefs as string[]).filter((ref) => ref !== id),
        revision: draft.revision + 1, updatedAt: new Date() }).where(eq(drafts.id, draft.id));
      return { status: 200 as const, revision: draft.revision + 1 };
    });
    return result.status === 200 ? draftAttachmentRevisionSchema.parse({ revision: result.revision }) :
      reply.code(result.status).send(result.status === 404 ? missing : conflict);
  });
  app.get('/api/mail/drafts/:draftId/attachments/:attachmentId/download', async (request, reply) => {
    if (!origin(request.headers)) return reply.code(403).send(bad);
    const value = scope(request);
    const id = (request.params as { attachmentId?: unknown }).attachmentId;
    if (!value || typeof id !== 'string' || !readerIdSchema.safeParse(id).success) return reply.code(400).send(bad);
    const row = await run(async (tx) => {
      const draft = await scoped(tx, value.id, value.accountId, value.orbitId);
      if (!draft || draft.state !== 'editing') return null;
      const [attachment] = await tx.select().from(draftAttachments).where(and(eq(draftAttachments.id, id),
        eq(draftAttachments.draftId, value.id), eq(draftAttachments.accountId, value.accountId), eq(draftAttachments.state, 'ready'))).limit(1);
      return attachment ?? null;
    }, true);
    if (!row) return reply.code(404).send(missing);
    try {
      const bytes = await store.read(row.blobKey, LIMIT);
      if (bytes.byteLength !== row.byteSize || createHash('sha256').update(bytes).digest('hex') !== row.digest) throw new Error('Unavailable blob');
      return reply.headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': disposition(row.filename),
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' }).send(bytes);
    } catch { return reply.code(503).send({ error: 'This attachment is unavailable. Try again later.' }); }
  });
}
