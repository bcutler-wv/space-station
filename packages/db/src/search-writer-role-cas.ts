import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readTransitionRegistryInTransaction, SearchAdminDatabaseError } from
  './search-admin-connection.js';
import { advanceSearchGeneration, armSearchGenerationDispatch,
  updateSearchGenerationDispatch, type GenerationExpected } from './search-generation-admin.js';
import { searchGenerationControl } from './schema.js';
import { boundSearchTransaction } from './search-ledger.js';

type Snapshot = Awaited<ReturnType<typeof readTransitionRegistryInTransaction>>;
type Kind = 'request' | 'arm' | 'send' | 'confirm' | 'attest';
type Input = Readonly<Record<string, unknown>>;
const invalid = (): never => { throw new SearchAdminDatabaseError('snapshot'); };
const exact = (value: unknown, names: readonly string[]): Input => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' ||
      !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value')) ||
      keys.slice().sort().join('|') !== [...names].sort().join('|')) return invalid();
  return value as Input;
};
const micro = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value));
function safeSnapshot(value: unknown, seen = new Set<object>(), depth = 0,
  budget = { count: 0, bytes: 0 }): void {
  if (++budget.count > 20_000 || depth > 12) invalid();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return;
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > 256 * 1024) invalid();
    return;
  }
  if (value && typeof value === 'object' &&
      Object.getPrototypeOf(value) === Date.prototype && Reflect.ownKeys(value).length === 0) {
    try {
      if (Number.isNaN(Date.prototype.getTime.call(value))) return invalid();
    } catch { return invalid(); }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value) ||
      Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) invalid();
  const item = value as object;
  seen.add(item);
  const keys = Reflect.ownKeys(item);
  if (keys.length > 2600 || keys.some(key => typeof key !== 'string')) invalid();
  if (Array.isArray(item) && (item.length > 2600 ||
      Object.keys(item).length !== item.length ||
      Object.keys(item).some((key, i) => key !== String(i)))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(item);
  for (const key of keys) {
    if (typeof key !== 'string') return invalid();
    if (Array.isArray(item) && key === 'length') continue;
    const descriptor = descriptors[key as string];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || key.length > 256)
      return invalid();
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > 256 * 1024) invalid();
    safeSnapshot(descriptor.value, seen, depth + 1, budget);
  }
  seen.delete(item);
}
const insertDispatch = <T extends { generationToken: string; operation: string; dispatchId: string }>(
  rows: T[], row: T) => {
  const key = (item: T) => `${item.generationToken}|${item.operation}|${item.dispatchId}`;
  const at = rows.findIndex(item => key(item) > key(row));
  rows.splice(at < 0 ? rows.length : at, 0, row);
};
const expectedControl = (snapshot: Snapshot): GenerationExpected => ({
  revision: snapshot.control.revision, stage: snapshot.control.stage,
  transitionToken: snapshot.control.transitionToken,
  sourceGenerationToken: snapshot.control.sourceGenerationToken,
  generationToken: snapshot.control.generationToken,
  physicalIndex: snapshot.control.physicalIndex, indexUuid: snapshot.control.indexUuid,
  profileId: snapshot.control.profileId,
});

function validateOperation(kind: Kind, operation: unknown): Input {
  if (kind === 'request') {
    const input = exact(operation, ['stage']);
    if (input.stage !== 'writer_role_requested') invalid();
    return input;
  }
  if (kind === 'attest') {
    const input = exact(operation, ['stage']);
    if (input.stage !== 'writer_role_attested') invalid();
    return input;
  }
  const names = kind === 'arm' ?
    ['operation', 'dispatchId', 'ownerId', 'target', 'bodyIdentity'] :
    ['operation', 'dispatchId', 'ownerId', 'state'];
  const input = exact(operation, names);
  if (input.operation !== 'writer_role' ||
      typeof input.dispatchId !== 'string' || typeof input.ownerId !== 'string' ||
      (kind === 'send' && input.state !== 'sent_unknown') ||
      (kind === 'confirm' && input.state !== 'response_confirmed') ||
      (kind === 'arm' && (typeof input.target !== 'string' ||
        typeof input.bodyIdentity !== 'string'))) invalid();
  return input;
}

function validateSuccessor(before: Snapshot, after: Snapshot, kind: Kind, input: Input): void {
  const expected = structuredClone(before);
  expected.control.revision++;
  const updatedAt = after.exactTimestamps.control.updatedAt;
  if (!micro(updatedAt) || !(after.control.updatedAt instanceof Date) ||
      after.control.updatedAt.getTime() !== Date.parse(updatedAt)) invalid();
  expected.control.updatedAt = after.control.updatedAt;
  expected.exactTimestamps.control.updatedAt = updatedAt;
  if (kind === 'request') expected.control.stage = 'writer_role_requested';
  else if (kind === 'attest') expected.control.stage = 'writer_role_attested';
  else if (kind === 'arm') {
    const row = after.dispatch.find(item => item.generationToken === before.control.generationToken &&
      item.operation === 'writer_role');
    const side = after.exactTimestamps.dispatch.find(item =>
      item.generationToken === before.control.generationToken && item.operation === 'writer_role');
    if (!row || !side) return invalid();
    if (!micro(side.createdAt) || !(row.createdAt instanceof Date) ||
        row.createdAt.getTime() !== Date.parse(side.createdAt)) invalid();
    insertDispatch(expected.dispatch, { generationToken: before.control.generationToken!,
      operation: 'writer_role', dispatchId: input.dispatchId as string,
      ownerId: input.ownerId as string, target: input.target as string,
      bodyIdentity: input.bodyIdentity as string, state: 'armed', createdAt: row.createdAt });
    insertDispatch(expected.exactTimestamps.dispatch, {
      generationToken: before.control.generationToken!, operation: 'writer_role',
      dispatchId: input.dispatchId as string, createdAt: side.createdAt });
  } else {
    const row = expected.dispatch.find(item => item.generationToken === before.control.generationToken &&
      item.operation === 'writer_role');
    if (!row) return invalid();
    row.state = kind === 'send' ? 'sent_unknown' : 'response_confirmed';
  }
  if (!isDeepStrictEqual(after, expected) || after.control.publicationEnabled !== false ||
      after.control.servingReady !== false) invalid();
}

/** One fixed writer operation per committed short transaction; never observes an engine. */
export async function runWriterRoleCas(db: NodePgDatabase, kind: Kind,
  predecessor: Snapshot, operation: unknown): Promise<Snapshot> {
  try {
    if (!['request', 'arm', 'send', 'confirm', 'attest'].includes(kind)) invalid();
    const input = Object.freeze({ ...validateOperation(kind, operation) });
    safeSnapshot(predecessor);
    const original = structuredClone(predecessor);
    return await db.transaction(async tx => {
      await tx.execute('set transaction isolation level repeatable read, read write');
      await boundSearchTransaction(tx);
      await tx.select({ singleton: searchGenerationControl.singleton })
        .from(searchGenerationControl).where(eq(searchGenerationControl.singleton, 1)).for('update');
      const before = await readTransitionRegistryInTransaction(tx);
      if (!isDeepStrictEqual(before, original)) invalid();
      const expected = expectedControl(before);
      const changed = kind === 'request' || kind === 'attest' ?
        await advanceSearchGeneration(tx, expected, input.stage as string) :
        kind === 'arm' ? await armSearchGenerationDispatch(tx, expected, input as Parameters<
          typeof armSearchGenerationDispatch>[2]) :
          await updateSearchGenerationDispatch(tx, expected, input as Parameters<
            typeof updateSearchGenerationDispatch>[2]);
      if (!changed) invalid();
      const after = await readTransitionRegistryInTransaction(tx);
      if (!isDeepStrictEqual(changed, after.control)) invalid();
      validateSuccessor(before, after, kind, input);
      return after;
    });
  } catch { throw new SearchAdminDatabaseError('query'); }
}
