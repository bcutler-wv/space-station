import { z } from 'zod';
import { MAIL_LIMITS } from './mail-parser.js';

export const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const historyId = z.string().min(1).max(64).regex(/^[0-9]+$/);
export const token = z.string().min(1).max(2048).refine((value) => Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
export const labels = z.array(id).max(10000);
export const positiveInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const internalDate = z.string().regex(/^[0-9]{1,16}$/).refine((value) => Number(value) <= 8_640_000_000_000_000);
export const profile = z.object({ emailAddress: z.email().max(320), historyId, messagesTotal: positiveInt.optional(), threadsTotal: positiveInt.optional() });
export const label = z.object({ id, name: z.string().min(1).max(1000), type: z.enum(['system', 'user']).optional() });
export const labelPage = z.object({ labels: z.array(label).max(10000).default([]) });
export const messageRef = z.object({ id, threadId: id });
export const messagePage = z.object({ messages: z.array(messageRef).max(100).default([]), nextPageToken: token.optional(), resultSizeEstimate: positiveInt.optional() });
export const metadata = z.object({ id, threadId: id, historyId, labelIds: labels.default([]), internalDate, sizeEstimate: positiveInt.optional() });
export const minimalMessage = z.object({ id, threadId: id, historyId: historyId.optional(), labelIds: labels.default([]), internalDate: internalDate.optional(), sizeEstimate: positiveInt.optional() });
// The transport caps the full JSON response. Leave room for a bounded oversize
// raw field so the adapter can classify it as too_large after schema validation.
export const rawMessage = metadata.extend({ raw: z.string().max(Math.ceil(MAIL_LIMITS.rawBytes / 3) * 4 + 64 * 1024).regex(/^[A-Za-z0-9_-]+={0,2}$/) });
export const change = z.object({ message: messageRef.extend({ labelIds: labels.optional() }) });
export const labelChange = z.object({ message: messageRef.extend({ labelIds: labels.optional() }), labelIds: labels.max(10000) });
export const history = z.object({ id: historyId, messagesAdded: z.array(change).max(100).optional(), messagesDeleted: z.array(change).max(100).optional(), labelsAdded: z.array(labelChange).max(100).optional(), labelsRemoved: z.array(labelChange).max(100).optional() });
export const historyPage = z.object({ history: z.array(history).max(100).default([]), nextPageToken: token.optional(), historyId });

export type GmailProfile = z.infer<typeof profile>;
export type GmailLabelPage = z.infer<typeof labelPage>;
export type GmailMessagePage = z.infer<typeof messagePage>;
export type GmailHistoryPage = z.infer<typeof historyPage>;
export type GmailMessageMetadata = z.infer<typeof minimalMessage> & { trustedSent: boolean };
