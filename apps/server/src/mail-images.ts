import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { attachments, identities, items, mailImageConsent, mailSenderImagePreferences, PrivateBlobStore } from '@station/db';
import { imageConsentSchema, imageFetchSchema, readerIdSchema, readerImageRefSchema, senderImagePreferenceSchema,
  imageConsentResponseSchema, imageChoiceResponseSchema, senderImagePreferenceResponseSchema,
  MAIL_HTML_LIMITS, MAIL_HTML_POLICY_VERSION } from '@station/shared';
import type { AuthConfig } from './auth.js';

const unavailable = { error: 'This image is unavailable.' };
const invalid = { error: 'Check the mail image request and try again.' };
const MAX_INPUT = 4 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_INPUT + MAX_OUTPUT;
const MAX_PIXELS = 4_000_000;
const MAX_ACTIVE = 4;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const WORK_CHARGE = 1_048_576;
const MAX_WORK_ENTRIES = 2048;
export class ImageWorkBudget {
  private active = 0;
  private readonly work = new Map<string, { until: number; bytes: number; reserved: number }>();
  constructor(private readonly maxActive = MAX_ACTIVE, private readonly maxBytes = MAX_MESSAGE_BYTES,
    private readonly chargeBytes = WORK_CHARGE, private readonly maxEntries = MAX_WORK_ENTRIES,
    private readonly reserveBytes = MAX_REQUEST_BYTES, private readonly successMinimum = 32_768) {}
  reserve(key: string, now = Date.now()): { finish: (extraBytes?: number) => void } | null {
    if (this.active >= this.maxActive) return null;
    let budget = this.work.get(key);
    if (budget && budget.until < now) { this.work.delete(key); budget = undefined; }
    if (!budget) {
      if (this.work.size >= this.maxEntries) for (const [oldKey, value] of this.work) if (value.until < now) this.work.delete(oldKey);
      if (this.work.size >= this.maxEntries) return null;
      budget = { until: now + 60_000, bytes: 0, reserved: 0 };
      this.work.set(key, budget);
    }
    if (budget.bytes + budget.reserved + this.reserveBytes > this.maxBytes) return null;
    budget.reserved += this.reserveBytes;
    this.active++;
    let finished = false;
    return { finish: (extraBytes = 0) => {
      if (finished) return;
      finished = true;
      budget.reserved -= this.reserveBytes;
      budget.bytes += extraBytes > 0 ? Math.max(this.successMinimum, extraBytes) : this.chargeBytes;
      this.active--;
    } };
  }
}
const imageWork = new ImageWorkBudget();

export type MailImageProxyConfig = { signingKey: string; origin: 'http://go-camo:8080' };
type Image = { refId: string; kind: 'remote' | 'cid'; source: string };
function metadata(value: unknown): Image[] | null {
  if (!Array.isArray(value) || value.length > MAIL_HTML_LIMITS.images) return null;
  const refs = new Set<string>();
  const result: Image[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const image = entry as Record<string, unknown>;
    if (!readerImageRefSchema.safeParse(image.refId).success || refs.has(image.refId as string) ||
        (image.kind !== 'remote' && image.kind !== 'cid') || typeof image.source !== 'string' ||
        image.source.length > MAIL_HTML_LIMITS.urlLength) return null;
    refs.add(image.refId as string);
    result.push(image as Image);
  }
  return result;
}
function remoteUrl(source: string): string | null {
  try {
    // A stored URL is still untrusted metadata.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/.test(source) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(source)) return null;
    const url = new URL(source);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password ||
        !url.hostname || isIP(url.hostname.replace(/^\[|\]$/g, '')) || source.length > MAIL_HTML_LIMITS.urlLength ||
        (url.port && url.port !== (url.protocol === 'http:' ? '80' : '443'))) return null;
    return url.href;
  } catch { return null; }
}
export async function normalizeMailRaster(bytes: Buffer): Promise<{ contentType: string; data: Buffer }> {
  if (bytes.length > MAX_INPUT) throw new Error('image limit');
  const rasterMagic = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    bytes.subarray(0, 4).toString('ascii') === 'GIF8' ||
    (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') ||
    bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (!rasterMagic) throw new Error('image format');
  const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false }).timeout({ seconds: 3 });
  const info = await image.metadata();
  const avif = info.format === 'heif' && info.compression === 'av1' && info.mediaType === 'image/avif';
  if (!info.width || !info.height || info.width * info.height > MAX_PIXELS ||
      (!avif && !['jpeg', 'png', 'webp', 'gif'].includes(info.format ?? ''))) throw new Error('image format');
  const data = await image.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 }).toBuffer();
  if (data.length > MAX_OUTPUT) throw new Error('image output limit');
  return { contentType: 'image/png', data };
}
async function fetchRemote(source: string, config: MailImageProxyConfig): Promise<Buffer> {
  const url = remoteUrl(source);
  if (!url) throw new Error('invalid remote image');
  const signature = createHmac('sha1', config.signingKey).update(url).digest('hex');
  const target = `${config.origin}/${signature}/${Buffer.from(url).toString('hex')}`;
  const response = await fetch(target, { signal: AbortSignal.timeout(6_000), redirect: 'manual', headers: { accept: 'image/*' } });
  if (response.status !== 200 || !/^image\/(?:jpeg|png|webp|gif|avif)(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => {});
    throw new Error('upstream image response');
  }
  if (Number(response.headers.get('content-length') ?? '0') > MAX_INPUT) {
    await response.body?.cancel().catch(() => {});
    throw new Error('image limit');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (!response.body) throw new Error('empty image');
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_INPUT) { await reader.cancel().catch(() => {}); throw new Error('image limit'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function registerMailImages(app: FastifyInstance, auth: AuthConfig, blobs: PrivateBlobStore, proxy: MailImageProxyConfig): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(proxy.signingKey) || proxy.origin !== 'http://go-camo:8080')
    throw new Error('Invalid mail image proxy configuration');
  const db = auth.db;
  type ImageTransaction = Parameters<Parameters<AuthConfig['db']['transaction']>[0]>[0];
  const imageDb = <T>(work: (tx: ImageTransaction) => Promise<T>, write = false): Promise<T> => db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    return work(tx);
  }, write ? {} : { accessMode: 'read only' });
  const exactOrigin = (headers: Record<string, unknown>) => headers.origin === auth.origin && headers['sec-fetch-site'] !== 'cross-site';
  const visible = (orbitId?: string) => orbitId ? sql`exists (select 1 from item_orbits io where io.item_id = ${items.id} and io.orbit_id = ${orbitId})` : sql`true`;
  const selected = (itemId: string, accountId: string, orbitId?: string) => imageDb(async (tx) => {
    const [item] = await tx.select({ id: items.id, accountId: items.accountId, htmlPolicyVersion: items.htmlPolicyVersion,
      bodyHtmlPath: items.bodyHtmlPath, imageMetadata: items.imageMetadata, providerRevision: items.providerRevision,
      parseStatus: items.parseStatus,
      fromPersonId: items.fromPersonId, senderIdentitiesComplete: items.senderIdentitiesComplete })
      .from(items).where(and(eq(items.id, itemId), eq(items.accountId, accountId), isNull(items.deletedAt), visible(orbitId))).limit(1);
    return item;
  });
  const sourceDigest = (item: NonNullable<Awaited<ReturnType<typeof selected>>>) =>
    createHash('sha256').update(JSON.stringify([item.providerRevision, item.bodyHtmlPath, item.htmlPolicyVersion, item.imageMetadata])).digest('hex');
  const sender = async (item: NonNullable<Awaited<ReturnType<typeof selected>>>) => {
    if (!item.senderIdentitiesComplete || !item.fromPersonId) return null;
    const personId = item.fromPersonId;
    const rows = await imageDb((tx) => tx.select({ address: identities.normalizedValue }).from(identities)
      .where(and(eq(identities.personId, personId), eq(identities.accountId, item.accountId), eq(identities.kind, 'email'))).limit(2));
    return rows.length === 1 && /^[^\s@]+@[^\s@]+$/.test(rows[0]!.address) ? rows[0]!.address : null;
  };
  const readChoice = (itemId: string) => imageDb(async (tx) => {
    const [choice] = await tx.select({ enabled: mailImageConsent.enabled, digest: mailImageConsent.sourceDigest })
      .from(mailImageConsent).where(eq(mailImageConsent.itemId, itemId)).limit(1);
    return choice;
  });
  const readPreference = (accountId: string, address: string | null) => address ? imageDb(async (tx) => {
    const [preference] = await tx.select({ enabled: mailSenderImagePreferences.enabled }).from(mailSenderImagePreferences)
      .where(and(eq(mailSenderImagePreferences.accountId, accountId), eq(mailSenderImagePreferences.senderAddress, address))).limit(1);
    return preference;
  }) : Promise.resolve(undefined);
  app.get('/api/mail/items/:itemId/images/consent', async (request, reply) => {
    const itemId = (request.params as { itemId: string }).itemId;
    const query = imageConsentSchema.omit({ enabled: true }).safeParse(request.query);
    if (!readerIdSchema.safeParse(itemId).success || !query.success) return reply.code(400).send(invalid);
    const item = await selected(itemId, query.data.accountId, query.data.orbitId);
    if (!item) return reply.code(404).send(unavailable);
    const message = await readChoice(itemId);
    const address = await sender(item);
    const preference = await readPreference(item.accountId, address);
    return imageConsentResponseSchema.parse({ messageEnabled: Boolean(message?.enabled && message.digest === sourceDigest(item)),
      senderEnabled: preference?.enabled ?? false, senderAddress: address });
  });
  app.post('/api/mail/items/:itemId/images/consent', async (request, reply) => {
    if (!exactOrigin(request.headers)) return reply.code(403).send(invalid);
    const itemId = (request.params as { itemId: string }).itemId;
    const parsed = imageConsentSchema.safeParse(request.body);
    if (!readerIdSchema.safeParse(itemId).success || !parsed.success) return reply.code(400).send(invalid);
    const item = await selected(itemId, parsed.data.accountId, parsed.data.orbitId);
    if (!item) return reply.code(404).send(unavailable);
    const digest = sourceDigest(item);
    await imageDb((tx) => tx.insert(mailImageConsent).values({ itemId, accountId: item.accountId, sourceDigest: digest, enabled: parsed.data.enabled })
      .onConflictDoUpdate({ target: mailImageConsent.itemId, set: { sourceDigest: digest, enabled: parsed.data.enabled, updatedAt: new Date() } }), true);
    return imageChoiceResponseSchema.parse({ enabled: parsed.data.enabled });
  });
  app.post('/api/mail/items/:itemId/images/sender-preference', async (request, reply) => {
    if (!exactOrigin(request.headers)) return reply.code(403).send(invalid);
    const itemId = (request.params as { itemId: string }).itemId;
    const parsed = senderImagePreferenceSchema.safeParse(request.body);
    if (!readerIdSchema.safeParse(itemId).success || !parsed.success) return reply.code(400).send(invalid);
    const item = await selected(itemId, parsed.data.accountId, parsed.data.orbitId);
    if (!item) return reply.code(404).send(unavailable);
    const address = await sender(item);
    if (!address) return reply.code(409).send({ error: 'This message has no single sender address to remember.' });
    await imageDb((tx) => tx.insert(mailSenderImagePreferences).values({ accountId: item.accountId, senderAddress: address, enabled: parsed.data.enabled })
      .onConflictDoUpdate({ target: [mailSenderImagePreferences.accountId, mailSenderImagePreferences.senderAddress],
        set: { enabled: parsed.data.enabled, updatedAt: new Date() } }), true);
    return senderImagePreferenceResponseSchema.parse({ enabled: parsed.data.enabled, senderAddress: address });
  });
  app.post('/api/mail/items/:itemId/images/fetch', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    if (!exactOrigin(request.headers)) return reply.code(403).send(invalid);
    const itemId = (request.params as { itemId: string }).itemId;
    const parsed = imageFetchSchema.safeParse(request.body);
    if (!readerIdSchema.safeParse(itemId).success || !parsed.success) return reply.code(400).send(invalid);
    const item = await selected(itemId, parsed.data.accountId, parsed.data.orbitId);
    if (!item || item.parseStatus !== 'supported' || item.htmlPolicyVersion !== MAIL_HTML_POLICY_VERSION || !item.bodyHtmlPath)
      return reply.code(404).send(unavailable);
    const images = metadata(item.imageMetadata);
    if (!images) return reply.code(404).send(unavailable);
    const image = images?.find((entry) => entry.refId === parsed.data.refId);
    if (!image) return reply.code(404).send(unavailable);
    if (image.kind === 'remote') {
      const message = await readChoice(item.id);
      const address = await sender(item);
      const preference = await readPreference(item.accountId, address);
      if (!(message?.enabled && message.digest === sourceDigest(item)) && !preference?.enabled) return reply.code(403).send(unavailable);
    }
    const key = `${item.accountId}:${item.id}`;
    const reservation = imageWork.reserve(key);
    if (!reservation) return reply.code(429).send(unavailable);
    let totalBytes = 0;
    let attemptedInput = false;
    try {
      const html = await blobs.read(item.bodyHtmlPath, MAIL_HTML_LIMITS.outputBytes);
      const htmlText = new TextDecoder('utf-8', { fatal: true }).decode(html);
      const htmlRefs = [...htmlText.matchAll(/data-station-image-ref="([^"]*)"/g)].map((match) => match[1]);
      if (html.length > MAIL_HTML_LIMITS.outputBytes || htmlRefs.length !== images.length ||
          new Set(htmlRefs).size !== images.length ||
          !htmlRefs.every((ref) => images.some((candidate) => candidate.refId === ref)))
        return reply.code(503).send(unavailable);
      const current = await selected(item.id, item.accountId, parsed.data.orbitId);
      if (!current || current.parseStatus !== 'supported' || sourceDigest(current) !== sourceDigest(item))
        return reply.code(404).send(unavailable);
      if (image.kind === 'remote') {
        const choice = await readChoice(item.id);
        const address = await sender(current);
        const preference = await readPreference(current.accountId, address);
        if (!(choice?.enabled && choice.digest === sourceDigest(current)) && !preference?.enabled)
          return reply.code(403).send(unavailable);
      }
      let bytes: Buffer;
      if (image.kind === 'remote') {
        attemptedInput = true;
        bytes = await fetchRemote(image.source, proxy);
      }
      else {
        if (!/^[a-z0-9_.@+-]{1,1024}$/i.test(image.source)) return reply.code(404).send(unavailable);
        const candidates = await imageDb((tx) => tx.select({ key: attachments.storagePath, size: attachments.size, cid: attachments.contentId,
          related: attachments.related }).from(attachments)
          .where(and(eq(attachments.itemId, item.id), eq(attachments.accountId, item.accountId))).limit(65));
        const matches = candidates.filter((candidate) => candidate.related && candidate.cid?.replace(/^<|>$/g, '').toLowerCase() === image.source.toLowerCase());
        if (candidates.length > 64 || matches.length !== 1 || matches[0]!.size > MAX_INPUT) return reply.code(404).send(unavailable);
        const attachment = matches[0]!;
        attemptedInput = true;
        bytes = await blobs.read(attachment.key, MAX_INPUT);
        if (bytes.length !== attachment.size) {
          totalBytes = MAX_REQUEST_BYTES;
          return reply.code(503).send(unavailable);
        }
      }
      const converted = await normalizeMailRaster(bytes);
      totalBytes = bytes.length + converted.data.length;
      return reply.type(converted.contentType).send(converted.data);
    } catch {
      // A failed transfer or decoder may have consumed bytes that did not reach a complete Buffer.
      // Charge the full reserved ceiling when input work began.
      totalBytes = attemptedInput ? MAX_REQUEST_BYTES : 0;
      return reply.code(503).send(unavailable);
    }
    finally { reservation.finish(totalBytes); }
  });
}
