import { describe, expect, it } from 'vitest';
import { compileSearchQuery, compileSearchQueryV2, makeV2Eligible, makeV2Fence,
  OPENSEARCH_MAPPING_V2, V2_DOCUMENT_BYTES_MAX, type AuthorizedSearchContext,
  type V2DocumentIdentity, type V2MailFields } from './index.js';

const context: AuthorizedSearchContext = { scope: 'accounts', ownerId: 'owner',
  accountIds: ['account'], authorizedOrbitIds: [], accountNames: [], orbitNames: [],
  labelNames: [], nowUtc: '2026-01-01T00:00:00.000Z' };
const accountId = '00000000-0000-4000-8000-000000000001';
const itemId = '00000000-0000-4000-8000-000000000002';
const identity: V2DocumentIdentity = { id: `mail:${accountId}:${itemId}`, stableId: itemId, accountId,
  generationToken: '00000000-0000-4000-8000-000000000003', revision: 7 };
const fields: V2MailFields = { ownerId: 'owner', orbitIds: [], labelIds: [], kind: 'mail',
  mailboxes: ['inbox'], hasAttachment: false, unread: true, starred: false,
  sentAt: null, searchText: 'Example subject\nExample body', subjectValues: ['Example subject'],
  fromValues: [], toValues: [], ccValues: [], filenameValues: [] };

describe('disabled v2 lexical contract', () => {
  it('keeps live outside every Boolean expression while v1 stays unchanged', () => {
    for (const expression of ['apple OR banana', '-apple', '-(apple OR banana)']) {
      const v1 = compileSearchQuery(expression, context);
      const v2 = compileSearchQueryV2(expression, context);
      expect(v1.status).toBe('ok'); expect(v2.status).toBe('ok');
      if (v1.status !== 'ok' || v2.status !== 'ok') throw new Error('Unexpected compile result');
      const first = v1.query.bool as { filter: unknown[]; must: unknown[] };
      const second = v2.query.bool as { filter: unknown[]; must: unknown[] };
      expect(second.filter).toEqual([...first.filter, { term: { live: true } }]);
      expect(second.must).toEqual(first.must);
      expect(JSON.stringify(first)).not.toContain('"live"');
    }
    expect(OPENSEARCH_MAPPING_V2.properties.live).toEqual({ type: 'boolean' });
    expect(Object.isFrozen(OPENSEARCH_MAPPING_V2)).toBe(true);
    expect(Object.isFrozen(OPENSEARCH_MAPPING_V2.properties.searchText)).toBe(true);
  });

  it('constructs bounded eligible and content-free fence shapes', () => {
    const eligible = makeV2Eligible(identity, fields);
    const fence = makeV2Fence(identity);
    expect(eligible.status).toBe('ok'); expect(fence.status).toBe('ok');
    if (eligible.status !== 'ok' || fence.status !== 'ok') throw new Error('Unexpected envelope');
    expect(eligible.document.live).toBe(true);
    expect(Object.keys(fence.document)).toEqual(['id', 'stableId', 'accountId', 'generationToken',
      'revision', 'profileId', 'live']);
    expect(JSON.stringify(fence.document)).not.toMatch(/owner|subject|body|orbit|label|digest/i);
    expect(fence.document.live).toBe(false);
    expect(makeV2Fence({ ...identity, revision: 0 })).toMatchObject({ status: 'error', code: 'malformed' });
    expect(makeV2Eligible(identity, { ...fields, searchText: 'a'.repeat(V2_DOCUMENT_BYTES_MAX) }))
      .toMatchObject({ status: 'error', code: 'oversize' });
    expect(makeV2Eligible(identity, { ...fields, subjectValues: ['a'.repeat(1025)] }))
      .toMatchObject({ status: 'error', code: 'oversize' });
    expect(makeV2Eligible(identity, { ...fields, sentAt: '2026-99-99T00:00:00.000Z' }))
      .toMatchObject({ status: 'error', code: 'malformed' });
    expect(makeV2Fence({ ...identity, id: `mail:${itemId}:${accountId}` }))
      .toMatchObject({ status: 'error', code: 'malformed' });
  });
});
