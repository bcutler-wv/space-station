import { z } from 'zod';

export const MAIL_LIMITS = {
  rawBytes: 12_582_912,
  decodedAttachmentBytes: 8_388_608,
  bodyBytes: 4_194_304,
  outputBytes: 16_777_216,
  headersBytes: 65_536,
  parts: 128,
  depth: 16,
  rfc822Depth: 3,
  recipients: 100,
  attachments: 64,
  timeoutMs: 3_000,
  concurrency: 2,
} as const;

const bounded = (max: number) => z.string().max(max);
export const rawMailSchema = z.instanceof(Uint8Array).refine((raw) => raw.byteLength <= MAIL_LIMITS.rawBytes);
const address = z.object({ name: bounded(512), address: bounded(512) }).strict();
export const parsedMailSchema = z.object({
  subject: bounded(4_096).nullable(), messageId: bounded(4_096).nullable(),
  inReplyTo: bounded(4_096).nullable(), references: bounded(8_192).nullable(),
  date: bounded(256).nullable(), from: address.nullable(),
  senderIdentities: z.array(address).max(MAIL_LIMITS.recipients),
  replyTo: z.array(address).max(MAIL_LIMITS.recipients),
  to: z.array(address).max(MAIL_LIMITS.recipients),
  cc: z.array(address).max(MAIL_LIMITS.recipients),
  bcc: z.array(address).max(MAIL_LIMITS.recipients),
  text: bounded(MAIL_LIMITS.bodyBytes).nullable(),
  // HTML is hostile until a later reviewed DOMPurify ingest and display boundary.
  untrustedHtml: bounded(MAIL_LIMITS.bodyBytes).nullable(),
  attachments: z.array(z.object({
    filename: bounded(1_024).nullable(), mimeType: bounded(256),
    disposition: bounded(256).nullable(), contentId: bounded(1_024).nullable(),
    related: z.boolean(),
    contentBase64: bounded(Math.ceil(MAIL_LIMITS.decodedAttachmentBytes * 4 / 3) + 4),
  }).strict()).max(MAIL_LIMITS.attachments),
}).strict();

export const parseErrorCodeSchema = z.enum(['input_too_large', 'limit_exceeded', 'malformed', 'timeout', 'busy', 'service_unavailable']);
export const parseResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), mail: parsedMailSchema }).strict(),
  z.object({ ok: z.literal(false), code: parseErrorCodeSchema }).strict(),
]);
export type ParseResult = z.infer<typeof parseResultSchema>;
