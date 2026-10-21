import { describe, expect, it } from 'vitest';
import { compileSearchQuery, OPENSEARCH_MAPPING, type AuthorizedSearchContext, type OpenSearchDsl } from './index.js';

const context: AuthorizedSearchContext = {
  scope: 'accounts', ownerId: 'owner-1', accountIds: ['account-1', 'account-2'],
  authorizedOrbitIds: ['orbit-1', 'orbit-2'],
  accountNames: [{ id: 'account-1', name: 'Work' }, { id: 'account-2', name: 'Personal' }],
  orbitNames: [{ id: 'orbit-1', name: 'Glassworks' }, { id: 'orbit-2', name: 'Home' }],
  labelNames: [{ accountId: 'account-1', id: 'label-1', name: 'Vendors' },
    { accountId: 'account-2', id: 'label-2', name: 'VENDORS' }],
  nowUtc: '2024-03-31T14:15:16.123Z',
};
const query = (input: string, scope: AuthorizedSearchContext = context): OpenSearchDsl => {
  const result = compileSearchQuery(input, scope);
  if (result.status !== 'ok') throw Error(JSON.stringify(result));
  return result.query;
};
const error = (input: string, code: string, scope: AuthorizedSearchContext = context) =>
  expect(compileSearchQuery(input, scope)).toMatchObject({ status: 'error', code });

describe('pure scoped OpenSearch compiler', () => {
  it('keeps trusted scope outside mixed OR and the identical composite under NOT', () => {
    const positive = query('apple');
    const leaf = (positive.bool as { must: OpenSearchDsl[] }).must[0];
    expect(leaf).toEqual({ bool: { should: [
      { match: { searchText: { query: 'apple', operator: 'and', fuzziness: 1,
        max_expansions: 50, zero_terms_query: 'none' } } },
      { match_bool_prefix: { searchText: { query: 'apple', operator: 'and' } } },
    ], minimum_should_match: 1 } });
    expect((query('-apple').bool as { must: OpenSearchDsl[] }).must[0]).toEqual({ bool: { must_not: [leaf] } });
    const mixed = query('apple OR label:vendors');
    expect((mixed.bool as { filter: unknown[] }).filter).toEqual([
      { term: { ownerId: 'owner-1' } }, { terms: { accountId: ['account-1', 'account-2'] } },
    ]);
    expect(JSON.stringify(mixed)).toContain('"minimum_should_match":1');
    expect(query('-(apple OR label:vendors)')).toMatchObject({ bool: { filter: [
      { term: { ownerId: 'owner-1' } }, { terms: { accountId: ['account-1', 'account-2'] } },
    ] } });
  });

  it('uses ordered analyzed phrases but literal structured fields', () => {
    expect(JSON.stringify(query('"invoice.pdf"'))).toContain('"match_phrase"');
    expect(JSON.stringify(query('subject:"invoice.pdf"'))).toContain('"subjectValues"');
    expect(JSON.stringify(query('subject:"invoice.pdf"'))).not.toContain('"match_phrase"');
    for (const field of ['from', 'to', 'cc', 'subject', 'filename']) {
      const actual = JSON.stringify(query(`${field}:"a*b?c\\\\d"`));
      expect(actual).toContain('"case_insensitive":true');
      expect(actual).toContain({ from: 'fromValues', to: 'toValues', cc: 'ccValues',
        subject: 'subjectValues', filename: 'filenameValues' }[field]);
    }
    expect(JSON.stringify(query('subject:客户'))).toContain('客户');
  });

  it('resolves authorized names, pairs same-name labels by account, and denies unresolved names', () => {
    expect(JSON.stringify(query('label:vendors'))).toContain('"label-1"');
    expect(JSON.stringify(query('label:vendors'))).toContain('"label-2"');
    expect(JSON.stringify(query('account:work orbit:glassworks'))).toContain('"account-1"');
    const selected: AuthorizedSearchContext = { ...context, scope: 'selected-orbits', selectedOrbitIds: ['orbit-1'] };
    expect((query('apple', selected).bool as { filter: unknown[] }).filter).toContainEqual({ terms: { orbitIds: ['orbit-1'] } });
    error('orbit:home', 'resolution', selected);
    error('account:unknown', 'resolution');
    error('-label:unknown', 'resolution');
    error('account:work', 'resolution', { ...context, accountNames: [...context.accountNames,
      { id: 'account-2', name: 'WORK' }] });
    error('label:vendors', 'resolution', { ...context, labelNames: [...context.labelNames,
      { accountId: 'account-1', id: 'label-3', name: 'vendors' }] });
  });

  it('compiles every typed flag and UTC boundary without an AI answer', () => {
    for (const input of ['has:attachment', 'in:sent', 'in:inbox', 'in:chat', 'is:unread', 'is:starred'])
      expect(compileSearchQuery(input, context).status).toBe('ok');
    error('is:needs-reply', 'unsupported');
    error('-is:needs-reply', 'unsupported');
    expect(JSON.stringify(query('after:2024/02/29 before:2024/03/01'))).toContain('2024-02-29T00:00:00.000Z');
    expect(JSON.stringify(query('newer_than:1m'))).toContain('2024-02-29T14:15:16.123Z');
    expect(JSON.stringify(query('older_than:1y'))).toContain('2023-03-31T14:15:16.123Z');
    const leap = { ...context, nowUtc: '2024-02-29T09:00:00.000Z' };
    expect(JSON.stringify(query('newer_than:1y', leap))).toContain('2023-02-28T09:00:00.000Z');
    expect(JSON.stringify(query('newer_than:1d', leap))).toContain('2024-02-28T09:00:00.000Z');
    error('older_than:1y', 'invalid_value', { ...context, nowUtc: '0001-12-31T00:00:00.000Z' });
  });

  it('fails closed for malformed scope, empty input and parser/output limits', () => {
    expect(Object.isFrozen(OPENSEARCH_MAPPING)).toBe(true);
    expect(Object.isFrozen(OPENSEARCH_MAPPING.properties.searchText)).toBe(true);
    expect(compileSearchQuery(' ', context)).toEqual({ status: 'empty' });
    error('apple', 'scope', { ...context, accountIds: [] });
    error('apple', 'scope', { ...context, nowUtc: '2024-02-30T00:00:00.000Z' });
    error('apple', 'scope', { ...context, scope: 'selected-orbits', selectedOrbitIds: [] });
    error('apple', 'scope', { ...context, scope: 'selected-orbits', selectedOrbitIds: ['outside'] });
    error('x'.repeat(4097), 'limit');
    error(Array.from({ length: 65 }, (_, index) => `word${index}`).join(' '), 'limit');
    error('unknown:value', 'unknown_operator');
    error('subject:', 'incomplete');
    const manyAccounts = Array.from({ length: 64 }, (_, index) => `account-${index}`);
    const wide: AuthorizedSearchContext = { ...context, accountIds: manyAccounts,
      accountNames: [], labelNames: manyAccounts.map((accountId, index) =>
        ({ accountId, id: `label-${index}`, name: 'vendors' })) };
    error(Array.from({ length: 10 }, () => 'label:vendors').join(' '), 'limit', wide);
  });
});
