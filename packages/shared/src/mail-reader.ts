import { z } from 'zod';
import { MAIL_LIMITS } from './mail-parser.js';

export const readerIdSchema = z.string().uuid();
export const conversationQuerySchema = z.object({
  accountId: readerIdSchema.optional(), orbitId: readerIdSchema.optional(),
  labelId: readerIdSchema.optional(), subject: z.string().trim().min(1).max(128).optional(),
  cursor: z.string().max(1024).optional(), limit: z.coerce.number().int().min(1).max(30).default(20),
}).strict().refine((value) => Boolean(value.accountId) !== Boolean(value.orbitId));
export const threadQuerySchema = z.object({
  accountId: readerIdSchema, orbitId: readerIdSchema.optional(),
  cursor: z.string().max(1024).optional(), limit: z.coerce.number().int().min(1).max(30).default(20),
}).strict();
export const itemQuerySchema = z.object({ accountId: readerIdSchema, orbitId: readerIdSchema.optional() }).strict();
export const labelQuerySchema = z.object({ accountId: readerIdSchema.optional(), orbitId: readerIdSchema.optional() })
  .strict().refine((value) => Boolean(value.accountId) !== Boolean(value.orbitId));
export const readerAddressSchema = z.object({ address: z.string().max(254), name: z.string().max(512) }).strict();
export const readerAttachmentSchema = z.object({ id: readerIdSchema, filename: z.string().max(255).nullable(),
  mimeType: z.string().max(256), size: z.number().int().nonnegative(), related: z.boolean() }).strict();
export const readerMessageSchema = z.object({ id: readerIdSchema, threadId: readerIdSchema, accountId: readerIdSchema,
  subject: z.string().max(4096).nullable(), snippet: z.string().max(4096).nullable(),
  internalAt: z.iso.datetime().nullable(), sentAt: z.iso.datetime().nullable(), receivedAt: z.iso.datetime().nullable(),
  direction: z.enum(['in', 'out']), parseStatus: z.enum(['supported', 'unsupported']),
  from: readerAddressSchema.nullable(), labels: z.array(z.object({ id: readerIdSchema, name: z.string().max(1024) }).strict()).max(100),
  recipients: z.array(z.object({ role: z.enum(['sender', 'reply_to', 'to', 'cc', 'bcc']), ...readerAddressSchema.shape }).strict()).max(100),
  attachments: z.array(readerAttachmentSchema).max(64),
}).strict();
export const readerConversationSchema = z.object({ threadId: readerIdSchema, accountId: readerIdSchema,
  subject: z.string().max(4096).nullable(), snippet: z.string().max(4096).nullable(),
  lastActivityAt: z.iso.datetime().nullable(), messageCount: z.number().int().positive(),
}).strict();
export const conversationPageSchema = z.object({ conversations: z.array(readerConversationSchema).max(30), nextCursor: z.string().nullable() }).strict();
export const messagePageSchema = z.object({ messages: z.array(readerMessageSchema).max(30), nextCursor: z.string().nullable() }).strict();
export const labelListSchema = z.object({ labels: z.array(z.object({ id: readerIdSchema, accountId: readerIdSchema,
  name: z.string().max(1024) }).strict()).max(500) }).strict();
export const readerBodySchema = z.object({ itemId: readerIdSchema,
  status: z.enum(['available', 'unsupported', 'unavailable']), text: z.string().max(MAIL_LIMITS.bodyBytes).nullable(),
  html: z.string().max(1048576).nullable(), htmlPolicyVersion: z.literal(1).nullable(),
  imageRefs: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(64),
}).strict();
