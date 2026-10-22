import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { openDatabase } from './connection.js';
import { searchGenerationControl, searchGenerationHistory } from './schema.js';
import { boundSearchTransaction } from './search-ledger.js';

type Database = ReturnType<typeof openDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Control = typeof searchGenerationControl.$inferSelect;
export type SearchGenerationExpectation = Pick<Control,
  'revision' | 'stage' | 'transitionToken' | 'generationToken' | 'physicalIndex' | 'indexUuid' | 'profileId'>;
type DisabledChange =
  | { stage: 'disabled_intent'; transitionToken: string; generationToken: string; physicalIndex: string }
  | { stage: 'disabled' | 'unavailable' };
const token = z.string().uuid();
const physicalName = /^station-mail-v2-g[a-z0-9]{16,64}$/;
const MAX_REVISION = 2_147_483_647;

function sameExpected(row: Control, expected: SearchGenerationExpectation): boolean {
  return row.revision === expected.revision && row.stage === expected.stage &&
    row.transitionToken === expected.transitionToken && row.generationToken === expected.generationToken &&
    row.physicalIndex === expected.physicalIndex && row.indexUuid === expected.indexUuid &&
    row.profileId === expected.profileId;
}

/** Lock first in every future claim, precheck and ack transaction. Missing means deny. */
export async function lockSearchGenerationControl(tx: Transaction): Promise<Control> {
  await boundSearchTransaction(tx);
  const [row] = await tx.select().from(searchGenerationControl)
    .where(eq(searchGenerationControl.singleton, 1)).for('share');
  if (!row) throw new Error('Missing search generation control');
  return row;
}

/** Disabled-only short CAS. No engine operation or source lock belongs in this transaction. */
export async function casDisabledSearchGeneration(tx: Transaction,
  expected: SearchGenerationExpectation, change: DisabledChange): Promise<Control | null> {
  await boundSearchTransaction(tx);
  if (!Number.isInteger(expected.revision) || expected.revision < 1 || expected.revision >= MAX_REVISION)
    throw new Error('Search generation control revision exhausted');
  const [current] = await tx.select().from(searchGenerationControl)
    .where(eq(searchGenerationControl.singleton, 1)).for('update');
  if (!current) throw new Error('Missing search generation control');
  if (!sameExpected(current, expected)) return null;
  if (current.publicationEnabled || current.servingReady) throw new Error('Search generation is enabled');
  if (change.stage === 'disabled_intent') {
    token.parse(change.transitionToken);
    token.parse(change.generationToken);
    if (!physicalName.test(change.physicalIndex)) throw new Error('Invalid search physical index');
    // Unique token and literal name enforce never-reuse even after clearing control.
    await tx.insert(searchGenerationHistory).values({ generationToken: change.generationToken,
      physicalIndex: change.physicalIndex, profileId: 'station-mail-v2' });
  }
  const set = change.stage === 'disabled_intent' ? {
    stage: change.stage, transitionToken: change.transitionToken,
    generationToken: change.generationToken, physicalIndex: change.physicalIndex,
    profileId: 'station-mail-v2', indexUuid: null,
  } : change.stage === 'disabled' ? {
    stage: change.stage, transitionToken: null, generationToken: null,
    physicalIndex: null, profileId: null, indexUuid: null,
  } : { stage: change.stage };
  const [updated] = await tx.update(searchGenerationControl).set({ ...set,
    revision: sql`${searchGenerationControl.revision} + 1`, updatedAt: sql`now()` })
    .where(and(eq(searchGenerationControl.singleton, 1), eq(searchGenerationControl.revision, expected.revision),
      lt(searchGenerationControl.revision, MAX_REVISION),
      expected.generationToken === null ? isNull(searchGenerationControl.generationToken) :
        eq(searchGenerationControl.generationToken, expected.generationToken)))
    .returning();
  if (!updated) throw new Error('Search generation CAS lost after row lock');
  return updated;
}
