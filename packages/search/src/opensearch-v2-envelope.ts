import { OPENSEARCH_PROFILE_V2 } from './opensearch-compiler.js';

export const V2_DOCUMENT_BYTES_MAX = 224 * 1024;
const FIELD_VALUES_MAX = 256;
const FIELD_BYTES_MAX = 1024;
const opaqueId = /^[A-Za-z0-9_.:@-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type V2DocumentIdentity = {
  id: string;
  stableId: string;
  accountId: string;
  generationToken: string;
  revision: number;
};
export type V2MailFields = {
  ownerId: string;
  orbitIds: readonly string[];
  labelIds: readonly string[];
  kind: 'mail';
  mailboxes: readonly string[];
  hasAttachment: boolean;
  unread: boolean;
  starred: boolean;
  sentAt: string | null;
  searchText: string;
  subjectValues: readonly string[];
  fromValues: readonly string[];
  toValues: readonly string[];
  ccValues: readonly string[];
  filenameValues: readonly string[];
};

const validId = (value: unknown): value is string => typeof value === 'string' && opaqueId.test(value);
function valuesStatus(value: unknown, ids = false): 'ok' | 'malformed' | 'oversize' {
  if (!Array.isArray(value)) return 'malformed';
  if (value.length > FIELD_VALUES_MAX) return 'oversize';
  for (const part of value) {
    if (typeof part !== 'string' || (ids && !validId(part))) return 'malformed';
    if (Buffer.byteLength(part, 'utf8') > FIELD_BYTES_MAX) return 'oversize';
  }
  return 'ok';
}
const bounded = (value: object) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= V2_DOCUMENT_BYTES_MAX;

function identityValid(value: V2DocumentIdentity): boolean {
  return value && typeof value.accountId === 'string' && uuid.test(value.accountId) &&
    typeof value.stableId === 'string' && uuid.test(value.stableId) &&
    value.id === `mail:${value.accountId}:${value.stableId}` && validId(value.id) &&
    typeof value.generationToken === 'string' && uuid.test(value.generationToken) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 && value.revision <= 2_147_483_647;
}

function validSentAt(value: string | null): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export type V2FenceDocument = Readonly<V2DocumentIdentity & {
  profileId: typeof OPENSEARCH_PROFILE_V2;
  live: false;
}>;
export type V2EligibleDocument = Readonly<V2DocumentIdentity & V2MailFields & {
  profileId: typeof OPENSEARCH_PROFILE_V2;
  live: true;
}>;
export type V2EnvelopeResult<T> = { status: 'ok'; document: T } |
  { status: 'error'; code: 'malformed' | 'oversize' };

/** A fence retains only opaque operational fields, never source text or a digest. */
export function makeV2Fence(identity: V2DocumentIdentity): V2EnvelopeResult<V2FenceDocument> {
  if (!identityValid(identity)) return { status: 'error', code: 'malformed' };
  const document = { id: identity.id, stableId: identity.stableId, accountId: identity.accountId,
    generationToken: identity.generationToken, revision: identity.revision,
    profileId: OPENSEARCH_PROFILE_V2, live: false } as const;
  return bounded(document) ? { status: 'ok', document } : { status: 'error', code: 'oversize' };
}

/** Bounded, explicit v2 shape. A later coherent projection supplies fields. */
export function makeV2Eligible(identity: V2DocumentIdentity, fields: V2MailFields):
  V2EnvelopeResult<V2EligibleDocument> {
  if (!identityValid(identity) || !fields || !validId(fields.ownerId) || fields.kind !== 'mail' ||
    typeof fields.hasAttachment !== 'boolean' || typeof fields.unread !== 'boolean' ||
    typeof fields.starred !== 'boolean' || !validSentAt(fields.sentAt) ||
    typeof fields.searchText !== 'string')
    return { status: 'error', code: 'malformed' };
  const valueStatuses = [valuesStatus(fields.orbitIds, true), valuesStatus(fields.labelIds, true),
    valuesStatus(fields.mailboxes), valuesStatus(fields.subjectValues),
    valuesStatus(fields.fromValues), valuesStatus(fields.toValues),
    valuesStatus(fields.ccValues), valuesStatus(fields.filenameValues)];
  if (valueStatuses.includes('malformed')) return { status: 'error', code: 'malformed' };
  if (valueStatuses.includes('oversize')) return { status: 'error', code: 'oversize' };
  if (Buffer.byteLength(fields.searchText, 'utf8') > V2_DOCUMENT_BYTES_MAX)
    return { status: 'error', code: 'oversize' };
  const document = { id: identity.id, stableId: identity.stableId, accountId: identity.accountId,
    generationToken: identity.generationToken, revision: identity.revision,
    profileId: OPENSEARCH_PROFILE_V2, live: true, ownerId: fields.ownerId,
    orbitIds: [...fields.orbitIds], labelIds: [...fields.labelIds], kind: fields.kind,
    mailboxes: [...fields.mailboxes], hasAttachment: fields.hasAttachment,
    unread: fields.unread, starred: fields.starred, sentAt: fields.sentAt,
    searchText: fields.searchText, subjectValues: [...fields.subjectValues],
    fromValues: [...fields.fromValues], toValues: [...fields.toValues],
    ccValues: [...fields.ccValues], filenameValues: [...fields.filenameValues] } as const;
  return bounded(document) ? { status: 'ok', document } : { status: 'error', code: 'oversize' };
}
