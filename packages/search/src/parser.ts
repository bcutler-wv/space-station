import { parse as parseGenerated, SyntaxError as GrammarSyntaxError } from './generated-parser.js';

export type TextField = 'from' | 'to' | 'cc' | 'subject' | 'filename' | 'label' | 'orbit' | 'account';
export type SearchNode =
  | { kind: 'and' | 'or'; children: SearchNode[] }
  | { kind: 'not'; child: SearchNode }
  | { kind: 'term'; value: string; phrase: boolean }
  | { kind: 'filter'; field: TextField; value: string; phrase: boolean }
  | { kind: 'filter'; field: 'has'; value: 'attachment' }
  | { kind: 'filter'; field: 'in'; value: 'sent' | 'inbox' | 'chat' }
  | { kind: 'filter'; field: 'is'; value: 'unread' | 'starred' | 'needs-reply' }
  | { kind: 'filter'; field: 'before' | 'after'; date: string }
  | { kind: 'filter'; field: 'older_than' | 'newer_than'; amount: number; unit: 'd' | 'm' | 'y' };
export type SearchParseResult =
  | { status: 'ok'; ast: SearchNode }
  | { status: 'empty' }
  | { status: 'error'; code: 'incomplete' | 'invalid' | 'unknown_operator' | 'invalid_value' | 'limit'; offset: number; message: string };
export const SEARCH_PARSE_LIMITS = { utf8Bytes: 4096, nesting: 8, unaryPrefixes: 8,
  lexemes: 128, nodes: 128, leaves: 64, valueCodePoints: 256 } as const;

type RawNode =
  | { kind: 'and'; children: RawNode[] }
  | { kind: 'or'; children: RawNode[] }
  | { kind: 'not'; child: RawNode }
  | { kind: 'term'; value: string; quoted: boolean; unescapedColon?: boolean }
  | { kind: 'filter'; name: string; value: { text: string; quoted: boolean }; offset: number };
type ErrorCode = Extract<SearchParseResult, { status: 'error' }>['code'];
class QueryIssue extends Error {
  constructor(readonly code: ErrorCode, readonly offset: number) { super(code); }
}
const errors = {
  incomplete: 'Finish the search expression.', invalid: 'Invalid search syntax.',
  unknown_operator: 'Unknown search operator.', invalid_value: 'Invalid search operator value.',
  limit: 'Search is too long or complex.',
} as const;
const textFields = new Set<string>(['from', 'to', 'cc', 'subject', 'filename', 'label', 'orbit', 'account']);

function preflight(input: string): void {
  if (Buffer.byteLength(input, 'utf8') > SEARCH_PARSE_LIMITS.utf8Bytes) throw new QueryIssue('limit', 0);
  let quote = false, escape = false, depth = 0, lexemes = 0, unary = 0, boundary = true;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new QueryIssue('invalid', index);
      index++;
      if (boundary) { lexemes++; boundary = false; }
      escape = false;
      unary = 0;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new QueryIssue('invalid', index);
    if ((code < 0x20 && ![9, 10, 13].includes(code)) || (code >= 0x7f && code <= 0x9f)) throw new QueryIssue('invalid', index);
    const char = input[index]!;
    if (escape) { escape = false; boundary = false; unary = 0; continue; }
    if (char === '\\') { escape = true; if (boundary) { lexemes++; boundary = false; } unary = 0; continue; }
    if (char === '"') { quote = !quote; if (boundary) { lexemes++; boundary = false; } unary = 0; continue; }
    if (quote) continue;
    if (char === '{' || char === '}') throw new QueryIssue('invalid', index);
    if (char === '(') { if (++depth > SEARCH_PARSE_LIMITS.nesting) throw new QueryIssue('limit', index); boundary = true; unary = 0; continue; }
    if (char === ')') { if (--depth < 0) throw new QueryIssue('invalid', index); boundary = true; unary = 0; continue; }
    if (' \t\n\r'.includes(char)) { boundary = true; unary = 0; continue; }
    if (char === '-' && (boundary || unary > 0)) {
      if (++unary > SEARCH_PARSE_LIMITS.unaryPrefixes) throw new QueryIssue('limit', index);
      if (boundary) { lexemes++; boundary = false; }
      continue;
    }
    unary = 0;
    if (boundary) { lexemes++; boundary = false; }
    if (lexemes > SEARCH_PARSE_LIMITS.lexemes) throw new QueryIssue('limit', index);
  }
  if (escape || quote || depth > 0) throw new QueryIssue('incomplete', input.length);
  if (lexemes > SEARCH_PARSE_LIMITS.lexemes) throw new QueryIssue('limit', input.length);
}

function valueLimit(value: string, offset: number): void {
  if (!value || Array.from(value).length > SEARCH_PARSE_LIMITS.valueCodePoints) throw new QueryIssue('invalid_value', offset);
}
function validDate(value: string, offset: number): string {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value);
  if (!match) throw new QueryIssue('invalid_value', offset);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!) throw new QueryIssue('invalid_value', offset);
  return value;
}
function filter(raw: Extract<RawNode, { kind: 'filter' }>): SearchNode {
  const field = raw.name.toLowerCase();
  const { text, quoted } = raw.value;
  if (!textFields.has(field) && !['has', 'in', 'is', 'before', 'after', 'older_than', 'newer_than'].includes(field))
    throw new QueryIssue('unknown_operator', raw.offset);
  valueLimit(text, raw.offset);
  if (textFields.has(field)) return { kind: 'filter', field: field as TextField, value: text, phrase: quoted };
  if (quoted) throw new QueryIssue('invalid_value', raw.offset);
  if (field === 'has') {
    if (text !== 'attachment') throw new QueryIssue('invalid_value', raw.offset);
    return { kind: 'filter', field, value: text };
  }
  if (field === 'in') {
    if (text !== 'sent' && text !== 'inbox' && text !== 'chat') throw new QueryIssue('invalid_value', raw.offset);
    return { kind: 'filter', field, value: text };
  }
  if (field === 'is') {
    if (text !== 'unread' && text !== 'starred' && text !== 'needs-reply') throw new QueryIssue('invalid_value', raw.offset);
    return { kind: 'filter', field, value: text };
  }
  if (field === 'before' || field === 'after') return { kind: 'filter', field, date: validDate(text, raw.offset) };
  if (field === 'older_than' || field === 'newer_than') {
    const match = /^(\d{1,4})([dmy])$/.exec(text);
    if (!match) throw new QueryIssue('invalid_value', raw.offset);
    const amount = Number(match[1]);
    if (amount < 1 || amount > 3650) throw new QueryIssue('invalid_value', raw.offset);
    return { kind: 'filter', field, amount, unit: match[2] as 'd' | 'm' | 'y' };
  }
  throw new QueryIssue('unknown_operator', raw.offset);
}
function normalize(root: RawNode): SearchNode {
  let nodes = 0, leaves = 0;
  const visit = (raw: RawNode): SearchNode => {
    if (++nodes > SEARCH_PARSE_LIMITS.nodes) throw new QueryIssue('limit', 0);
    if (raw.kind === 'and' || raw.kind === 'or') return { kind: raw.kind, children: raw.children.map(visit) };
    if (raw.kind === 'not') return { kind: 'not', child: visit(raw.child) };
    if (++leaves > SEARCH_PARSE_LIMITS.leaves) throw new QueryIssue('limit', 0);
    if (raw.kind === 'filter') return filter(raw);
    valueLimit(raw.value, 0);
    if (!raw.quoted && raw.value === 'AND') throw new QueryIssue('invalid', 0);
    if (raw.unescapedColon) {
      const field = raw.value.slice(0, raw.value.indexOf(':')).toLowerCase();
      const known = textFields.has(field) || ['has', 'in', 'is', 'before', 'after', 'older_than', 'newer_than'].includes(field);
      throw new QueryIssue(known && raw.value.endsWith(':') ? 'incomplete' : 'unknown_operator', 0);
    }
    return { kind: 'term', value: raw.value, phrase: raw.quoted };
  };
  return visit(root);
}
/** Parse only. This AST grants no account scope, policy decision or search-engine filter. */
export function parseSearchQuery(input: string): SearchParseResult {
  try {
    preflight(input);
    if (!input.trim()) return { status: 'empty' };
    return { status: 'ok', ast: normalize(parseGenerated(input) as RawNode) };
  } catch (error) {
    if (error instanceof QueryIssue) return { status: 'error', code: error.code, offset: error.offset, message: errors[error.code] };
    if (error instanceof GrammarSyntaxError) {
      const offset = error.location?.start.offset ?? input.length;
      const code = offset >= input.length || /:\s*$/.test(input) ? 'incomplete' : 'invalid';
      return { status: 'error', code, offset, message: errors[code] };
    }
    throw error;
  }
}

