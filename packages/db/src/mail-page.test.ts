import { describe, expect, it } from 'vitest';
import { applyMailPage, MAIL_PAGE_LIMITS, type MailPage } from './mail-page.js';

const base = (): MailPage => ({ accountId: '00000000-0000-4000-8000-000000000001', stateId: '00000000-0000-4000-8000-000000000002',
  collectionId: 'primary', pageId: 'fixture', configuredOrigin: 'https://example.com', expectedLeaseGeneration: 1,
  expectedCredentialGeneration: 1, expectedAuthorizationGeneration: 1, expectedSequence: 0, cursorAfter: {}, changes: [] });
function rejectBeforeDb(page: MailPage, pattern: RegExp) {
  return expect(applyMailPage(undefined as never, undefined as never, page)).rejects.toThrow(pattern);
}
describe('mail page preflight', () => {
  it('rejects aggregate multibyte input before database access', async () => {
    const page: MailPage = { ...base(), changes: [{ externalId: 'big', threadExternalId: 'thread', providerRevision: null, internalAt: null, receivedAt: null,
      snippet: '€'.repeat(Math.floor(MAIL_PAGE_LIMITS.totalBytes / 3) + 1), flags: {}, labelRefs: [], providerSent: false,
      deleted: true, parsed: null, routedOrbitIds: [] }] };
    await rejectBeforeDb(page, /bytes exceed limit/);
  });
  it('bounds flag count and cursor depth before schema cloning', async () => {
    const page: MailPage = { ...base(), changes: [{ externalId: 'x', threadExternalId: 'thread', providerRevision: null, internalAt: null, receivedAt: null,
      snippet: null, flags: Object.fromEntries(Array.from({ length: MAIL_PAGE_LIMITS.flagsPerItem + 1 }, (_, i) => [`f${i}`, true])),
      labelRefs: [], providerSent: false, deleted: true, parsed: null, routedOrbitIds: [] }] };
    await rejectBeforeDb(page, /flags exceed limit/);
    const deep = base();
    let cursor: Record<string, unknown> = {};
    deep.cursorAfter = cursor;
    for (let i = 0; i < MAIL_PAGE_LIMITS.cursorDepth + 1; i++) { const next = {}; cursor.next = next; cursor = next; }
    await rejectBeforeDb(deep, /structure exceeds limit/);
    const wide = base();
    wide.cursorAfter = { token: '€'.repeat(6_000) };
    await rejectBeforeDb(wide, /bytes exceed limit/);
  });
  it('rejects unbounded collector arguments', async () => {
    const { collectOrphanBlobs } = await import('./mail-page.js');
    await expect(collectOrphanBlobs(undefined as never, undefined as never, 0, Infinity)).rejects.toThrow(/Invalid orphan collector bounds/);
  });
});
