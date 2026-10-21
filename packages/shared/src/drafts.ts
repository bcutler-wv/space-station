import { z } from 'zod';

const id = z.string().uuid();
// Header fields are plain data until a later send path validates them again.
// eslint-disable-next-line no-control-regex
const noControls = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const address = z.object({
  address: z.email().max(254).refine(noControls),
  name: z.string().max(512).refine(noControls),
}).strict();
const recipients = z.array(address).max(100);
const contents = z.object({
  to: recipients, cc: recipients, bcc: recipients,
  subject: z.string().max(4096).refine(noControls),
  bodyText: z.string().max(4_194_304).refine((value) => new TextEncoder().encode(value).byteLength <= 4_194_304),
  attachmentRefs: z.array(id).max(64),
}).strict().superRefine((value, context) => {
  if (value.to.length + value.cc.length + value.bcc.length > 100)
    context.addIssue({ code: 'custom', message: 'Too many recipients' });
  if (new TextEncoder().encode(value.subject).byteLength > 4096)
    context.addIssue({ code: 'custom', message: 'Subject is too large' });
});
export const draftCreateSchema = contents.safeExtend({
  id, creationKey: id, accountId: id, orbitId: id.optional(), parentItemId: id.optional(),
}).refine((value) => value.attachmentRefs.length === 0);
export const draftUpdateSchema = contents.safeExtend({ revision: z.number().int().min(1).max(2_147_483_646) });
export const draftDiscardSchema = z.object({ revision: z.number().int().min(1).max(2_147_483_646) }).strict();
export const draftQuerySchema = z.object({ accountId: id, orbitId: id.optional(),
  cursor: z.string().max(1024).optional(), limit: z.coerce.number().int().min(1).max(30).default(20) }).strict();
export const draftScopeSchema = z.object({ accountId: id, orbitId: id.optional() }).strict();
export const replyContextQuerySchema = draftScopeSchema;
export const replyContextSchema = z.object({ accountId: id, orbitId: id.nullable(), parentItemId: id,
  threadId: id, collectionId: z.string().min(1).max(1024), providerThreadId: z.string().max(1024), subject: z.string().max(4096),
  to: z.array(address).length(1), messageId: z.string().max(4096),
  references: z.string().max(8192),
}).strict();
export const draftSchema = z.object({ ...contents.shape, id, accountId: id,
  revision: z.number().int().positive(), state: z.enum(['editing', 'discarded', 'sending', 'sent']),
  threadId: id.nullable(), parentItemId: id.nullable(), orbitId: id.nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export const draftPageSchema = z.object({ drafts: z.array(draftSchema).max(30), nextCursor: z.string().nullable() }).strict();
export const draftSummarySchema = z.object({ id, accountId: id, orbitId: id.nullable(), threadId: id.nullable(),
  parentItemId: id.nullable(), subject: z.string().max(4096), revision: z.number().int().positive(),
  state: z.literal('editing'), updatedAt: z.iso.datetime() }).strict();
export const draftSummaryPageSchema = z.object({ drafts: z.array(draftSummarySchema).max(30), nextCursor: z.string().nullable() }).strict();

export const draftAttachmentQuerySchema = draftScopeSchema;
export const draftAttachmentUploadHeadersSchema = z.object({
  'x-attachment-name': z.string().min(1).max(512),
  'x-upload-key': id,
  'x-draft-revision': z.coerce.number().int().min(1).max(2_147_483_646),
  'content-type': z.literal('application/octet-stream'),
}).strict();
export const draftAttachmentSchema = z.object({ id, filename: z.string().min(1).max(180), byteSize: z.number().int().min(0).max(8_388_608),
  status: z.enum(['pending', 'ready', 'unavailable']) }).strict();
export const draftAttachmentListSchema = z.object({ attachments: z.array(draftAttachmentSchema).max(64), revision: z.number().int().positive() }).strict();
export const draftAttachmentMutationSchema = z.object({ attachment: draftAttachmentSchema, revision: z.number().int().positive() }).strict();
export const draftAttachmentRevisionSchema = z.object({ revision: z.number().int().positive() }).strict();
export const draftAttachmentRemoveSchema = draftDiscardSchema;
