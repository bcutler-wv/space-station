import { parseSearchQuery, type SearchNode } from './parser.js';

export const OPENSEARCH_PROFILE = 'station-mail-v1' as const;
function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child as object);
  return Object.freeze(value);
}
export const OPENSEARCH_MAPPING = deepFreeze({ dynamic: 'strict',
  _meta: { stationProfile: OPENSEARCH_PROFILE }, properties: {
  id: { type: 'keyword' }, stableId: { type: 'keyword' },
  ownerId: { type: 'keyword' }, accountId: { type: 'keyword' },
  orbitIds: { type: 'keyword' }, labelIds: { type: 'keyword' },
  kind: { type: 'keyword' }, mailboxes: { type: 'keyword' },
  hasAttachment: { type: 'boolean' }, unread: { type: 'boolean' }, starred: { type: 'boolean' },
  sentAt: { type: 'date', format: 'strict_date_time' },
  searchText: { type: 'text', analyzer: 'standard' },
  subjectValues: { type: 'wildcard' }, fromValues: { type: 'wildcard' },
  toValues: { type: 'wildcard' }, ccValues: { type: 'wildcard' },
  filenameValues: { type: 'wildcard' },
} } as const);
export const OPENSEARCH_COMPILE_LIMITS = { accounts: 64, orbits: 256, names: 512,
  idBytes: 128, nameCodePoints: 256, dslBytes: 65_536, dslNodes: 1024 } as const;

type Name = { id: string; name: string };
type LabelName = Name & { accountId: string };
type ContextBase = {
  ownerId: string;
  accountIds: readonly string[];
  authorizedOrbitIds: readonly string[];
  accountNames: readonly Name[];
  orbitNames: readonly Name[];
  labelNames: readonly LabelName[];
  nowUtc: string;
};
/** Caller-authenticated snapshot; validation here cannot itself grant authority. */
export type AuthorizedSearchContext = ContextBase & (
  | { scope: 'accounts' }
  | { scope: 'selected-orbits'; selectedOrbitIds: readonly string[] }
);
export type OpenSearchDsl = Record<string, unknown>;
export type SearchCompileResult =
  | { status: 'ok'; profile: typeof OPENSEARCH_PROFILE; query: OpenSearchDsl }
  | { status: 'empty' }
  | { status: 'error'; code: 'scope' | 'resolution' | 'unsupported' | 'limit' | 'invalid' | 'incomplete' | 'unknown_operator' | 'invalid_value'; message: string };

class CompileIssue extends Error {
  constructor(readonly code: Extract<SearchCompileResult, { status: 'error' }>['code']) { super(code); }
}
const term = (field: string, value: string | boolean): OpenSearchDsl => ({ term: { [field]: value } });
const terms = (field: string, values: readonly string[]): OpenSearchDsl => ({ terms: { [field]: [...values] } });
const either = (children: OpenSearchDsl[]): OpenSearchDsl => ({ bool: { should: children, minimum_should_match: 1 } });
const normalize = (value: string): string => value.normalize('NFKC').trim().toLowerCase();
const idPattern = /^[A-Za-z0-9_.:@-]{1,128}$/;
const validId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const uniqueIds = (value: unknown, max: number, nonempty: boolean): string[] => {
  if (!Array.isArray(value) || value.length > max || (nonempty && !value.length) ||
      !value.every(validId) || new Set(value).size !== value.length) throw new CompileIssue('scope');
  return value;
};
function validNames(value: unknown, max: number, ids: Set<string>, withAccount = false): asserts value is Name[] & LabelName[] {
  if (!Array.isArray(value) || value.length > max) throw new CompileIssue('scope');
  for (const row of value) {
    if (!row || !validId(row.id) || typeof row.name !== 'string' ||
        row.name.length > OPENSEARCH_COMPILE_LIMITS.nameCodePoints * 2 ||
        !normalize(row.name) || Array.from(row.name).length > OPENSEARCH_COMPILE_LIMITS.nameCodePoints ||
        (withAccount ? !validId(row.accountId) || !ids.has(row.accountId) : !ids.has(row.id)))
      throw new CompileIssue('scope');
  }
}
function utcClock(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) throw new CompileIssue('scope');
  const clock = new Date(value);
  if (!Number.isFinite(clock.getTime()) || clock.toISOString() !== value || clock.getUTCFullYear() < 1)
    throw new CompileIssue('scope');
  return clock;
}
function validateContext(context: AuthorizedSearchContext) {
  if (!context || !validId(context.ownerId)) throw new CompileIssue('scope');
  const accounts = uniqueIds(context.accountIds, OPENSEARCH_COMPILE_LIMITS.accounts, true);
  const orbits = uniqueIds(context.authorizedOrbitIds, OPENSEARCH_COMPILE_LIMITS.orbits, false);
  if (context.scope !== 'accounts' && context.scope !== 'selected-orbits') throw new CompileIssue('scope');
  const selected = context.scope === 'selected-orbits' ?
    uniqueIds(context.selectedOrbitIds, OPENSEARCH_COMPILE_LIMITS.orbits, true) : [];
  if (selected.some(id => !orbits.includes(id))) throw new CompileIssue('scope');
  validNames(context.accountNames, OPENSEARCH_COMPILE_LIMITS.names, new Set(accounts));
  validNames(context.orbitNames, OPENSEARCH_COMPILE_LIMITS.names, new Set(orbits));
  validNames(context.labelNames, OPENSEARCH_COMPILE_LIMITS.names, new Set(accounts), true);
  return { accounts, orbits: context.scope === 'selected-orbits' ? selected : orbits,
    selected, clock: utcClock(context.nowUtc) };
}
function resolveName(rows: readonly Name[], value: string): string {
  const found = new Set(rows.filter(row => normalize(row.name) === normalize(value)).map(row => row.id));
  if (found.size !== 1) throw new CompileIssue('resolution');
  return [...found][0]!;
}
function literal(field: string, value: string): OpenSearchDsl {
  return { wildcard: { [field]: { value: `*${value.replace(/[\\*?]/g, '\\$&')}*`, case_insensitive: true } } };
}
function midnight(value: string): string { return `${value.replaceAll('/', '-')}T00:00:00.000Z`; }
function cutoff(clock: Date, amount: number, unit: 'd' | 'm' | 'y'): string {
  const result = new Date(clock.getTime());
  if (unit === 'd') result.setUTCDate(result.getUTCDate() - amount);
  else {
    const year = clock.getUTCFullYear();
    const month = clock.getUTCMonth();
    const target = unit === 'm' ? year * 12 + month - amount : (year - amount) * 12 + month;
    if (target < 12) throw new CompileIssue('invalid_value');
    const targetYear = Math.floor(target / 12), targetMonth = target % 12;
    result.setUTCDate(1);
    result.setUTCFullYear(targetYear, targetMonth, 1);
    const end = new Date(result.getTime());
    end.setUTCMonth(targetMonth + 1, 0);
    result.setUTCDate(Math.min(clock.getUTCDate(), end.getUTCDate()));
  }
  if (result.getUTCFullYear() < 1 || result.getUTCFullYear() > 9999) throw new CompileIssue('invalid_value');
  return result.toISOString();
}
function lexical(value: string, phrase: boolean): OpenSearchDsl {
  if (phrase) return { match_phrase: { searchText: { query: value, slop: 0, zero_terms_query: 'none' } } };
  return either([
    { match: { searchText: { query: value, operator: 'and', fuzziness: 1, max_expansions: 50, zero_terms_query: 'none' } } },
    { match_bool_prefix: { searchText: { query: value, operator: 'and' } } },
  ]);
}
function compileNode(node: SearchNode, context: AuthorizedSearchContext,
  valid: ReturnType<typeof validateContext>, budget: { nodes: number }): OpenSearchDsl {
  const bump = (count: number) => {
    budget.nodes += count;
    if (budget.nodes > OPENSEARCH_COMPILE_LIMITS.dslNodes) throw new CompileIssue('limit');
  };
  bump(1);
  if ('children' in node) return node.kind === 'and' ?
    { bool: { must: node.children.map(child => compileNode(child, context, valid, budget)) } } :
    either(node.children.map(child => compileNode(child, context, valid, budget)));
  if (node.kind === 'not') return { bool: { must_not: [compileNode(node.child, context, valid, budget)] } };
  if (node.kind === 'term') { bump(node.phrase ? 1 : 3); return lexical(node.value, node.phrase); }
  if (!('field' in node)) throw new CompileIssue('invalid');
  switch (node.field) {
    case 'from': case 'to': case 'cc': case 'subject': case 'filename':
      return literal({ from: 'fromValues', to: 'toValues', cc: 'ccValues',
        subject: 'subjectValues', filename: 'filenameValues' }[node.field], node.value);
    case 'account':
      return term('accountId', resolveName(context.accountNames, node.value));
    case 'orbit':
      return term('orbitIds', resolveName(context.orbitNames.filter(row => valid.orbits.includes(row.id)), node.value));
    case 'label': {
      const pairs = context.labelNames.filter(row => normalize(row.name) === normalize(node.value));
      if (!pairs.length) throw new CompileIssue('resolution');
      const byAccount = new Map<string, string>();
      for (const row of pairs) {
        const prior = byAccount.get(row.accountId);
        if (prior && prior !== row.id) throw new CompileIssue('resolution');
        byAccount.set(row.accountId, row.id);
      }
      bump(byAccount.size * 3);
      return either([...byAccount].map(([accountId, id]) => ({ bool: {
        filter: [term('accountId', accountId), term('labelIds', id)] } })));
    }
    case 'has': return term('hasAttachment', true);
    case 'in': return node.value === 'chat' ? term('kind', 'chat') : term('mailboxes', node.value);
    case 'is':
      if (node.value === 'needs-reply') throw new CompileIssue('unsupported');
      return term(node.value === 'unread' ? 'unread' : 'starred', true);
    case 'before': return { range: { sentAt: { lt: midnight(node.date) } } };
    case 'after': return { range: { sentAt: { gte: midnight(node.date) } } };
    case 'older_than': return { range: { sentAt: { lt: cutoff(valid.clock, node.amount, node.unit) } } };
    case 'newer_than': return { range: { sentAt: { gte: cutoff(valid.clock, node.amount, node.unit) } } };
  }
  throw new CompileIssue('unsupported');
}

/** Pure plan only. Future writer/reader must independently revalidate policy and scope. */
export function compileSearchQuery(input: string, context: AuthorizedSearchContext): SearchCompileResult {
  try {
    if (typeof input !== 'string') throw new CompileIssue('invalid');
    const valid = validateContext(context);
    const parsed = parseSearchQuery(input);
    if (parsed.status === 'empty') return { status: 'empty' };
    if (parsed.status === 'error') return { status: 'error', code: parsed.code, message: parsed.message };
    const filters = [term('ownerId', context.ownerId), terms('accountId', valid.accounts)];
    if (context.scope === 'selected-orbits') filters.push(terms('orbitIds', valid.selected));
    const budget = { nodes: filters.length + 1 };
    const query = { bool: { filter: filters, must: [compileNode(parsed.ast, context, valid, budget)] } };
    if (Buffer.byteLength(JSON.stringify(query), 'utf8') > OPENSEARCH_COMPILE_LIMITS.dslBytes)
      throw new CompileIssue('limit');
    return { status: 'ok', profile: OPENSEARCH_PROFILE, query };
  } catch (error) {
    if (!(error instanceof CompileIssue)) throw error;
    return { status: 'error', code: error.code, message: error.code === 'resolution' ?
      'Search name is unavailable or ambiguous.' : error.code === 'unsupported' ?
        'This search operator is not available yet.' : error.code === 'scope' ?
          'Search scope is unavailable.' : 'Search is outside supported limits.' };
  }
}
