import assert from 'node:assert/strict';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { casDisabledSearchGeneration, lockSearchGenerationControl, searchDocuments,
  searchGenerationControl, searchGenerationHistory,
  databaseUrl, loadRuntimeConfig } from '../../packages/db/dist/index.js';

const { Pool } = createRequire(new URL('../../packages/db/package.json', import.meta.url))('pg');
const pool = new Pool({ connectionString: databaseUrl(loadRuntimeConfig(process.env)),
  max: 5, connectionTimeoutMillis: 3_000, query_timeout: 3_000 });
const db = drizzle(pool);
const forcedFailure = process.env.SEARCH_GENERATION_FORCE_FAILURE;
const awaitAcquisition = (promise, label) => Promise.race([promise,
  delay(3_000, undefined, { ref: false }).then(() => { throw new Error(`${label} acquisition timed out`); })]);
const pgCode = (error) => error?.cause?.code ?? error?.code;
const control = async () => (await db.select().from(searchGenerationControl))[0];
const proposal = { stage: 'disabled_intent', transitionToken: randomUUID(),
  generationToken: randomUUID(), physicalIndex: `station-mail-v2-g${randomUUID().replaceAll('-', '')}` };

try {
  const initial = await control();
  assert.ok(initial, 'migration seeds the permanent singleton');
  assert.equal(initial.singleton, 1);
  assert.equal(initial.stage, 'disabled');
  assert.equal(initial.publicationEnabled, false);
  assert.equal(initial.servingReady, false);
  assert.equal(initial.generationToken, null);
  assert.deepEqual(await db.select().from(searchGenerationHistory), []);

  let signalSnapshot, rejectSnapshot, releaseOld, signalHolder, rejectHolder, releaseHolder;
  const snapshotReady = new Promise((resolve, reject) => { signalSnapshot = resolve; rejectSnapshot = reject; });
  void snapshotReady.catch(() => {});
  const oldRelease = new Promise((resolve) => { releaseOld = resolve; });
  const holderReady = new Promise((resolve, reject) => { signalHolder = resolve; rejectHolder = reject; });
  void holderReady.catch(() => {});
  const holderRelease = new Promise((resolve) => { releaseHolder = resolve; });
  const oldSnapshot = db.transaction(async (tx) => {
    try {
      await tx.execute(sql`set local statement_timeout = '3000ms'`);
      await tx.select().from(searchGenerationControl).where(eq(searchGenerationControl.singleton, 1));
      signalSnapshot();
      await oldRelease;
      return lockSearchGenerationControl(tx);
    } catch (error) { rejectSnapshot(error); throw error; }
  }, { isolationLevel: 'repeatable read' });
  void oldSnapshot.catch(() => {});
  let holder;
  try {
    await awaitAcquisition(snapshotReady, 'old snapshot');
    holder = db.transaction(async (tx) => {
      try {
        if (forcedFailure === 'holder_acquire') throw new Error('forced holder acquisition failure');
        const reserved = await casDisabledSearchGeneration(tx, initial, proposal);
        assert.equal(reserved?.revision, initial.revision + 1);
        signalHolder();
        await holderRelease;
      } catch (error) { rejectHolder(error); throw error; }
    });
    void holder.catch(() => {});
    await awaitAcquisition(holderReady, 'exclusive control lock');
    releaseOld();
    let waiting = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await pool.query("select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type='Lock' and query like '%search_generation_control%' limit 1");
      if (result.rowCount) { waiting = true; break; }
      await delay(25);
    }
    assert.equal(waiting, forcedFailure === 'wait_assert' ? false : true,
      'old RR reader waits on modified control row');
    releaseHolder();
    await holder;
    await assert.rejects(oldSnapshot, (error) => pgCode(error) === '40001',
      'stale RR snapshot cannot lock/ack a transitioned generation');
  } finally {
    releaseOld(); releaseHolder();
    await Promise.allSettled([oldSnapshot, ...(holder ? [holder] : [])]);
  }

  const reserved = await control();
  assert.equal(reserved.generationToken, proposal.generationToken);
  assert.equal((await db.select().from(searchGenerationHistory)).length, 1);
  await assert.rejects(db.transaction(async (tx) => {
    const replacement = { transitionToken: randomUUID(), generationToken: randomUUID(),
      physicalIndex: `station-mail-v2-g${randomUUID().replaceAll('-', '')}` };
    const updated = await casDisabledSearchGeneration(tx, reserved,
      { stage: 'disabled_intent', ...replacement });
    assert.equal(updated.generationToken, replacement.generationToken,
      'P1 may replace an unregistered intent before dispatch');
    throw new Error('rollback P1 replacement probe');
  }), /rollback P1 replacement probe/);
  assert.equal((await control()).generationToken, proposal.generationToken);
  assert.equal(await db.transaction((tx) => casDisabledSearchGeneration(tx, initial,
    { stage: 'disabled' })), null, 'stale revision cannot change current generation');
  assert.equal(await db.transaction((tx) => casDisabledSearchGeneration(tx,
    { ...reserved, generationToken: randomUUID() }, { stage: 'disabled' })), null,
  'generation identity mismatch is denied');

  const disabled = await db.transaction((tx) => casDisabledSearchGeneration(tx, reserved,
    { stage: 'disabled' }));
  assert.equal(disabled?.generationToken, null);
  await assert.rejects(db.transaction(async (tx) => {
    const unavailable = await casDisabledSearchGeneration(tx, disabled, { stage: 'unavailable' });
    const replacement = { transitionToken: randomUUID(), generationToken: randomUUID(),
      physicalIndex: `station-mail-v2-g${randomUUID().replaceAll('-', '')}` };
    const updated = await casDisabledSearchGeneration(tx, unavailable,
      { stage: 'disabled_intent', ...replacement });
    assert.equal(updated.generationToken, replacement.generationToken,
      'P1 may replace an unavailable unregistered intent');
    throw new Error('rollback P1 unavailable replacement probe');
  }), /rollback P1 unavailable replacement probe/);
  await assert.rejects(db.transaction((tx) => casDisabledSearchGeneration(tx, disabled, proposal)),
    (error) => pgCode(error) === '23505', 'reserved names/tokens cannot be reused');
  assert.equal((await control()).revision, disabled.revision, 'failed reuse rolls back CAS');

  await assert.rejects(db.transaction(async (tx) => {
    // Fixture-only counter setup, rolled back with the entire transaction.
    await tx.execute(sql`alter table search_generation_control disable trigger search_generation_control_guard_trigger`);
    await tx.update(searchGenerationControl).set({ revision: 2_147_483_647 });
    await tx.execute(sql`alter table search_generation_control enable trigger search_generation_control_guard_trigger`);
    const [exhausted] = await tx.select().from(searchGenerationControl);
    await assert.rejects(casDisabledSearchGeneration(tx, exhausted,
      { stage: 'unavailable' }), /revision exhausted/);
    await assert.rejects(tx.update(searchGenerationControl).set({ revision: 1 }),
      (error) => /generation revision exhausted/.test(error.cause?.message ?? ''),
      'direct DML cannot wrap an exhausted revision');
    throw new Error('rollback fixture counter setup');
  }), /rollback fixture counter setup/);
  assert.equal((await control()).revision, disabled.revision, 'overflow setup rolls back');

  const accountId = randomUUID(), itemId = randomUUID();
  await assert.rejects(db.insert(searchDocuments).values({ accountId, itemId,
    documentId: `mail:${accountId}:${itemId}`, acknowledgedRevision: 1,
    acknowledgedGlobalEpoch: 1, acknowledgedAccountEpoch: 1 }),
  (error) => pgCode(error) === '23514', 'incomplete generation acknowledgement is rejected');
  assert.equal((await db.select().from(searchDocuments)).length, 0);

  await assert.rejects(db.transaction(async (tx) => {
    await tx.execute(sql`alter table search_generation_control disable trigger search_generation_control_guard_trigger`);
    await tx.delete(searchGenerationControl);
    await lockSearchGenerationControl(tx);
  }), /Missing search generation control/, 'missing singleton denies in the transaction');
  assert.equal((await control()).revision, disabled.revision, 'missing-row probe rolled back');
  console.info('Disabled search generation control, CAS, RR fence and acknowledgement fixture passed.');
} finally {
  await pool.end();
}
