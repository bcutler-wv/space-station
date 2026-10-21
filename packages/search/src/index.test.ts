import { describe, expect, it } from 'vitest';
import { parseSearchQuery, SEARCH_PARSE_LIMITS } from './index.js';

const ast = (query: string) => {
  const result = parseSearchQuery(query);
  expect(result.status, query).toBe('ok');
  if (result.status !== 'ok') throw new Error(`Expected parsed AST for ${query}`);
  return result.ast;
};
const error = (query: string, code: string) => {
  const result = parseSearchQuery(query);
  expect(result.status, query).toBe('error');
  if (result.status === 'error') expect(result.code, query).toBe(code);
};

describe('bounded Station search query syntax', () => {
  it('preserves mixed text and filter Boolean structure and precedence', () => {
    expect(ast('memo OR from:dana@example.com label:work')).toEqual({ kind: 'or', children: [
      { kind: 'term', value: 'memo', phrase: false },
      { kind: 'and', children: [
        { kind: 'filter', field: 'from', value: 'dana@example.com', phrase: false },
        { kind: 'filter', field: 'label', value: 'work', phrase: false },
      ] },
    ] });
    expect(ast('-(urgent OR subject:"rate sheet") account:work')).toEqual({ kind: 'and', children: [
      { kind: 'not', child: { kind: 'or', children: [
        { kind: 'term', value: 'urgent', phrase: false },
        { kind: 'filter', field: 'subject', value: 'rate sheet', phrase: true },
      ] } },
      { kind: 'filter', field: 'account', value: 'work', phrase: false },
    ] });
    expect(ast('--memo')).toEqual({ kind: 'term', value: 'memo', phrase: false });
    expect(ast('---memo')).toEqual({ kind: 'not', child: { kind: 'term', value: 'memo', phrase: false } });
  });

  it('covers every documented field with typed values', () => {
    const query = 'from:dana@example.com to:@example.com cc:team@example.com subject:"rate sheet" has:attachment '
      + 'filename:invoice.pdf label:vendors orbit:glassworks account:work in:sent in:inbox in:chat '
      + 'is:unread is:starred is:needs-reply before:2026/10/22 after:2026/10/21 older_than:2m newer_than:7d';
    const result = ast(query);
    expect(result.kind).toBe('and');
    if (result.kind !== 'and') return;
    expect(result.children).toHaveLength(19);
    expect(result.children.at(-4)).toEqual({ kind: 'filter', field: 'before', date: '2026/10/22' });
    expect(result.children.at(-3)).toEqual({ kind: 'filter', field: 'after', date: '2026/10/21' });
    expect(result.children.at(-2)).toEqual({ kind: 'filter', field: 'older_than', amount: 2, unit: 'm' });
    expect(result.children.at(-1)).toEqual({ kind: 'filter', field: 'newer_than', amount: 7, unit: 'd' });
  });

  it('preserves quotes, escapes, colons and Unicode without treating them as structure', () => {
    expect(ast('"project (β): launch"')).toEqual({ kind: 'term', value: 'project (β): launch', phrase: true });
    expect(ast('subject:"Quoted \\"rate\\""')).toEqual({ kind: 'filter', field: 'subject', value: 'Quoted "rate"', phrase: true });
    expect(ast('from:a:b@example.com')).toEqual({ kind: 'filter', field: 'from', value: 'a:b@example.com', phrase: false });
    expect(ast('foo\\:bar')).toEqual({ kind: 'term', value: 'foo:bar', phrase: false });
    expect(ast('foo\\{bar\\}')).toEqual({ kind: 'term', value: 'foo{bar}', phrase: false });
    expect(ast('"{from:a to:b}"')).toEqual({ kind: 'term', value: '{from:a to:b}', phrase: true });
    expect(ast('label:客户\\(甲\\)')).toEqual({ kind: 'filter', field: 'label', value: '客户(甲)', phrase: false });
    expect(ast('"x\\😀\\"tail"')).toEqual({ kind: 'term', value: 'x😀"tail', phrase: true });
    expect(ast('foo\\😀\\(bar\\)')).toEqual({ kind: 'term', value: 'foo😀(bar)', phrase: false });
    expect(ast('SUBJECT:Résumé')).toEqual({ kind: 'filter', field: 'subject', value: 'Résumé', phrase: false });
  });

  it('reports empty, incomplete, unknown and invalid syntax without a broad fallback', () => {
    expect(parseSearchQuery(' \t ')).toEqual({ status: 'empty' });
    for (const query of ['from:', 'subject:"unfinished', '(from:alice', 'memo OR', '-']) error(query, 'incomplete');
    for (const query of ['bcc:alice@example.com', 'foo:bar', 'foo:"bar"', 'https://example.com']) error(query, 'unknown_operator');
    for (const query of ['has:drive', 'in:anywhere', 'is:read', 'has:"attachment"', 'newer_than:1w',
      'older_than:0d', 'older_than:3651y', 'after:2026/2/03', 'before:2026/02/29', 'before:0000/01/01']) error(query, 'invalid_value');
    for (const query of ['a )', 'a OR OR b', 'a AND b', '{a b}', 'a(b)', '""', 'a\u0000b', '\ud800']) {
      const result = parseSearchQuery(query);
      expect(result.status, query).toBe('error');
    }
    expect(ast('after:2024/02/29')).toEqual({ kind: 'filter', field: 'after', date: '2024/02/29' });
  });

  it('bounds bytes, lexical work, nesting, unary prefixes and decoded values', () => {
    error('😀'.repeat(SEARCH_PARSE_LIMITS.utf8Bytes / 4 + 1), 'limit');
    error('('.repeat(SEARCH_PARSE_LIMITS.nesting + 1) + 'a' + ')'.repeat(SEARCH_PARSE_LIMITS.nesting + 1), 'limit');
    error('-'.repeat(SEARCH_PARSE_LIMITS.unaryPrefixes + 1) + 'a', 'limit');
    error(Array.from({ length: SEARCH_PARSE_LIMITS.leaves + 1 }, () => 'a').join(' '), 'limit');
    error('subject:' + '界'.repeat(SEARCH_PARSE_LIMITS.valueCodePoints + 1), 'invalid_value');
    expect(ast('"' + '('.repeat(20) + '"')).toEqual({ kind: 'term', value: '('.repeat(20), phrase: true });
    expect(ast('\\('.repeat(9))).toEqual({ kind: 'term', value: '('.repeat(9), phrase: false });
  });
});
