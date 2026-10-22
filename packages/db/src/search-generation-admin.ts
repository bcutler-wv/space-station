import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { openDatabase } from './connection.js';
import { searchGenerationControl, searchGenerationDispatch, searchGenerationHistory } from './schema.js';
import { boundSearchTransaction } from './search-ledger.js';
import { searchGenerationDispatchSpec } from './search-generation-manifest.js';

type Database = ReturnType<typeof openDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Control = typeof searchGenerationControl.$inferSelect;
export type GenerationExpected = Pick<Control, 'revision' | 'stage' | 'transitionToken' |
  'generationToken' | 'physicalIndex' | 'indexUuid' | 'profileId' | 'sourceGenerationToken'>;
type Operation = 'create_index' | 'writer_role' | 'writer_mapping' | 'query_role' | 'query_mapping';
const uuid = z.string().uuid();
const indexName = /^station-mail-v2-g[a-z0-9]{16,64}$/;
const engineUuid = /^[A-Za-z0-9_-]{1,128}$/;
const MAX = 2_147_483_647;
const next: Record<string, string> = {
  disabled_intent: 'create_requested', create_requested: 'uuid_bound',
  uuid_bound: 'writer_role_requested', writer_role_requested: 'writer_role_attested',
  writer_role_attested: 'writer_mapping_requested', writer_mapping_requested: 'writer_attested',
  writer_attested: 'query_role_requested', query_role_requested: 'query_role_attested',
  query_role_attested: 'query_mapping_requested', query_mapping_requested: 'roles_attested',
};
const stageOperation: Record<string, Operation> = {
  create_requested: 'create_index', writer_role_requested: 'writer_role',
  writer_mapping_requested: 'writer_mapping', query_role_requested: 'query_role',
  query_mapping_requested: 'query_mapping',
};

function same(row: Control, expected: GenerationExpected): boolean {
  return row.revision === expected.revision && row.stage === expected.stage &&
    row.transitionToken === expected.transitionToken &&
    row.sourceGenerationToken === expected.sourceGenerationToken &&
    row.generationToken === expected.generationToken &&
    row.physicalIndex === expected.physicalIndex && row.indexUuid === expected.indexUuid &&
    row.profileId === expected.profileId;
}
async function locked(tx: Transaction, expected: GenerationExpected): Promise<Control | null> {
  await boundSearchTransaction(tx);
  const [row] = await tx.select().from(searchGenerationControl)
    .where(eq(searchGenerationControl.singleton, 1)).for('update');
  if (!row) throw new Error('Missing search generation control');
  if (!same(row, expected)) return null;
  if (row.publicationEnabled || row.servingReady) throw new Error('Search generation enabled');
  if (row.revision >= MAX) throw new Error('Search generation revision exhausted');
  return row;
}
async function bump(tx: Transaction, set: Partial<Control>): Promise<Control> {
  const [row] = await tx.update(searchGenerationControl).set({ ...set,
    revision: sql`${searchGenerationControl.revision} + 1`, updatedAt: sql`now()` })
    .where(eq(searchGenerationControl.singleton, 1)).returning();
  if (!row) throw new Error('Missing search generation control');
  return row;
}
function names(token: string) {
  const suffix = uuid.parse(token).replaceAll('-', '').toLowerCase();
  return { writerRole: `station_indexer_${suffix}`, queryRole: `station_query_${suffix}`,
    writerPrincipal: `station-search-indexer-${suffix}`,
    queryPrincipal: `station-search-query-${suffix}` };
}
function exactUuid(value: string): string {
  if (!engineUuid.test(value)) throw new Error('Invalid search index UUID');
  return value;
}

/** DB evidence only: caller must attest v1 outside this transaction. */
export async function enrollLegacySearchGeneration(tx: Transaction, expected: GenerationExpected,
  observedUuid: string): Promise<Control | null> {
  const row = await locked(tx, expected);
  if (!row) return null;
  if (row.stage !== 'disabled' || row.sourceGenerationToken || row.generationToken ||
      row.transitionToken || row.indexUuid) throw new Error('Legacy enrollment requires initial disabled state');
  await tx.insert(searchGenerationHistory).values({ generationToken: 'legacy-v1',
    physicalIndex: 'station-mail-v1', profileId: 'station-mail-v1',
    indexUuid: exactUuid(observedUuid), lifecycle: 'roles_attested' });
  return bump(tx, { sourceGenerationToken: 'legacy-v1' });
}

export async function reserveSearchGeneration(tx: Transaction, expected: GenerationExpected,
  candidate: { transitionToken: string; generationToken: string; physicalIndex: string }): Promise<Control | null> {
  const row = await locked(tx, expected);
  if (!row) return null;
  if (!['disabled', 'roles_attested'].includes(row.stage) || !row.sourceGenerationToken)
    throw new Error('No registered source for reservation');
  uuid.parse(candidate.transitionToken);
  if (!indexName.test(candidate.physicalIndex)) throw new Error('Invalid search index name');
  const source = row.stage === 'roles_attested' ? row.generationToken : row.sourceGenerationToken;
  const [sourceRow] = await tx.select().from(searchGenerationHistory)
    .where(eq(searchGenerationHistory.generationToken, source!));
  if (sourceRow?.lifecycle !== 'roles_attested') throw new Error('Source is not registered');
  const unresolved = await tx.select().from(searchGenerationDispatch)
    .where(eq(searchGenerationDispatch.generationToken, source!));
  if (unresolved.some(entry => !['response_confirmed', 'quiesced'].includes(entry.state)))
    throw new Error('Source has unresolved dispatch');
  await tx.insert(searchGenerationHistory).values({ generationToken: candidate.generationToken,
    physicalIndex: candidate.physicalIndex, profileId: 'station-mail-v2', ...names(candidate.generationToken) });
  return bump(tx, { stage: 'disabled_intent', transitionToken: candidate.transitionToken,
    sourceGenerationToken: source, generationToken: candidate.generationToken,
    physicalIndex: candidate.physicalIndex, indexUuid: null, profileId: 'station-mail-v2' });
}

/** Advance exactly one finite stage. A requested stage needs a closed dispatch. */
export async function advanceSearchGeneration(tx: Transaction, expected: GenerationExpected,
  targetStage: string, observedUuid?: string): Promise<Control | null> {
  const row = await locked(tx, expected);
  if (!row) return null;
  if (next[row.stage] !== targetStage || !row.generationToken || !row.sourceGenerationToken)
    throw new Error('Invalid search generation stage advance');
  const [history] = await tx.select().from(searchGenerationHistory)
    .where(eq(searchGenerationHistory.generationToken, row.generationToken));
  if (!history || history.physicalIndex !== row.physicalIndex) throw new Error('Missing candidate reservation');
  const operation = stageOperation[row.stage];
  if (operation) {
    const [dispatch] = await tx.select().from(searchGenerationDispatch).where(and(
      eq(searchGenerationDispatch.generationToken, row.generationToken),
      eq(searchGenerationDispatch.operation, operation)));
    if (!dispatch || !['response_confirmed', 'quiesced'].includes(dispatch.state))
      throw new Error('Unresolved generation dispatch');
  }
  const set: Partial<Control> = { stage: targetStage };
  if (targetStage === 'uuid_bound') {
    if (history.lifecycle !== 'reserved' || !observedUuid) throw new Error('Missing UUID evidence');
    set.indexUuid = exactUuid(observedUuid);
    await tx.update(searchGenerationHistory).set({ lifecycle: 'bound', indexUuid: set.indexUuid })
      .where(eq(searchGenerationHistory.generationToken, row.generationToken));
  } else if (observedUuid !== undefined) throw new Error('Unexpected UUID evidence');
  if (targetStage === 'roles_attested') {
    if (history.lifecycle !== 'bound') throw new Error('Candidate is not bound');
    if (!history.writerCertFingerprint || !history.queryCertFingerprint)
      throw new Error('Certificate evidence is missing');
    await tx.update(searchGenerationHistory).set({ lifecycle: 'roles_attested' })
      .where(eq(searchGenerationHistory.generationToken, row.generationToken));
  }
  return bump(tx, set);
}

/** Store public fingerprints only; this does not attest an engine or sign a certificate. */
export async function recordSearchGenerationCertEvidence(tx: Transaction, expected: GenerationExpected,
  evidence: { writer: string; query: string }): Promise<Control | null> {
  const row = await locked(tx, expected);
  if (!row) return null;
  if (!row.generationToken || !row.sourceGenerationToken ||
      !['uuid_bound', 'writer_role_requested', 'writer_role_attested', 'writer_mapping_requested',
        'writer_attested', 'query_role_requested', 'query_role_attested', 'query_mapping_requested'].includes(row.stage))
    throw new Error('Certificate evidence stage mismatch');
  if (![evidence.writer, evidence.query].every(value => /^[0-9a-f]{64}$/.test(value)))
    throw new Error('Invalid public certificate fingerprint');
  const [history] = await tx.select().from(searchGenerationHistory)
    .where(eq(searchGenerationHistory.generationToken, row.generationToken));
  if (!history || (history.writerCertFingerprint && history.writerCertFingerprint !== evidence.writer) ||
      (history.queryCertFingerprint && history.queryCertFingerprint !== evidence.query))
    throw new Error('Certificate evidence conflict');
  await tx.update(searchGenerationHistory).set({ writerCertFingerprint: evidence.writer,
    queryCertFingerprint: evidence.query }).where(eq(searchGenerationHistory.generationToken, row.generationToken));
  return bump(tx, {});
}

/** Permanent one-shot operation owner; neither owner nor timer can take it over. */
export async function armSearchGenerationDispatch(tx: Transaction, expected: GenerationExpected,
  input: { operation: Operation; dispatchId: string; ownerId: string; target: string; bodyIdentity: string }): Promise<Control | null> {
  const row = await locked(tx, expected);
  if (!row) return null;
  if (stageOperation[row.stage] !== input.operation || !row.generationToken ||
      !row.physicalIndex) throw new Error('Wrong generation dispatch stage');
  uuid.parse(input.dispatchId); uuid.parse(input.ownerId);
  const [history] = await tx.select().from(searchGenerationHistory)
    .where(eq(searchGenerationHistory.generationToken, row.generationToken));
  if (!history) throw new Error('Missing candidate reservation');
  const spec = searchGenerationDispatchSpec(history, input.operation);
  if (input.target !== spec.target || input.bodyIdentity !== spec.bodyIdentity)
    throw new Error('Invalid dispatch target or body identity');
  await tx.insert(searchGenerationDispatch).values({ generationToken: row.generationToken,
    ...input, state: 'armed' });
  return bump(tx, {});
}

export async function updateSearchGenerationDispatch(tx: Transaction, expected: GenerationExpected,
  input: { operation: Operation; dispatchId: string; ownerId: string; state: 'sent_unknown' | 'response_confirmed' | 'quiesced' }): Promise<Control | null> {
  const row = await locked(tx, expected);
  if (!row) return null;
  if (stageOperation[row.stage] !== input.operation || !row.generationToken)
    throw new Error('Wrong generation dispatch stage');
  const [dispatch] = await tx.select().from(searchGenerationDispatch).where(and(
    eq(searchGenerationDispatch.generationToken, row.generationToken),
    eq(searchGenerationDispatch.operation, input.operation))).for('update');
  if (!dispatch || dispatch.dispatchId !== input.dispatchId || dispatch.ownerId !== input.ownerId ||
      !(dispatch.state === 'armed' && input.state === 'sent_unknown' ||
        dispatch.state === 'sent_unknown' && input.state !== 'sent_unknown'))
    throw new Error('Dispatch owner or transition mismatch');
  await tx.update(searchGenerationDispatch).set({ state: input.state }).where(and(
    eq(searchGenerationDispatch.generationToken, row.generationToken),
    eq(searchGenerationDispatch.operation, input.operation)));
  return bump(tx, {});
}
