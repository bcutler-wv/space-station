import assert from 'node:assert/strict';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import process from 'node:process';
import { URL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { advanceSearchGeneration, armSearchGenerationDispatch, buildSearchGenerationManifest,
  casDisabledSearchGeneration, databaseUrl, enrollLegacySearchGeneration, loadRuntimeConfig,
  recordSearchGenerationCertEvidence, reserveSearchGeneration, searchGenerationControl,
  searchGenerationDispatch, searchGenerationHistory, updateSearchGenerationDispatch,
  searchGenerationDispatchSpec,
} from '../../packages/db/dist/index.js';

const { Pool } = createRequire(new URL('../../packages/db/package.json', import.meta.url))('pg');
const pool = new Pool({ connectionString: databaseUrl(loadRuntimeConfig(process.env)), max: 5,
  connectionTimeoutMillis: 3_000, query_timeout: 3_000 });
const db = drizzle(pool);
const current = async () => (await db.select().from(searchGenerationControl))[0];
const expect = (row) => ({ revision: row.revision, stage: row.stage,
  transitionToken: row.transitionToken, sourceGenerationToken: row.sourceGenerationToken,
  generationToken: row.generationToken, physicalIndex: row.physicalIndex,
  indexUuid: row.indexUuid, profileId: row.profileId });
const tx = (work) => db.transaction(async (trx) => {
  await trx.execute(sql`set local statement_timeout = '3000ms'`);
  await trx.execute(sql`set local lock_timeout = '750ms'`);
  return work(trx);
});
const proposal = () => ({ transitionToken: randomUUID(), generationToken: randomUUID(),
  physicalIndex: `station-mail-v2-g${randomUUID().replaceAll('-', '')}` });
const fingerprint = 'a'.repeat(64);
const snapshot = async () => ({ control: await current(),
  history: await db.select().from(searchGenerationHistory).orderBy(searchGenerationHistory.generationToken),
  dispatch: await db.select().from(searchGenerationDispatch).orderBy(searchGenerationDispatch.generationToken) });
async function denyAndPreserve(work, message, cause) {
  const before = await snapshot();
  await assert.rejects(tx(work), (error) => cause.test(error.cause?.message ?? ''), message);
  assert.deepEqual(await snapshot(), before, `${message}: failed transaction preserves complete state`);
}

async function dispatch(row, operation) {
  const id = randomUUID(), owner = randomUUID();
  const [history] = await db.select().from(searchGenerationHistory)
    .where(eq(searchGenerationHistory.generationToken, row.generationToken));
  const input = { operation, dispatchId: id, ownerId: owner,
    ...searchGenerationDispatchSpec(history, operation) };
  const armed = await tx((trx) => armSearchGenerationDispatch(trx, expect(row), input));
  assert.equal(armed.revision, row.revision + 1);
  await assert.rejects(tx((trx) => armSearchGenerationDispatch(trx, expect(armed),
    { ...input, dispatchId: randomUUID(), ownerId: randomUUID() })),
  (error) => error.cause?.code === '23505', 'a second owner cannot dispatch');
  const sent = await tx((trx) => updateSearchGenerationDispatch(trx, expect(armed),
    { operation, dispatchId: id, ownerId: owner, state: 'sent_unknown' }));
  await assert.rejects(tx((trx) => updateSearchGenerationDispatch(trx, expect(sent),
    { operation, dispatchId: id, ownerId: randomUUID(), state: 'response_confirmed' })),
  /owner or transition mismatch/, 'stale/foreign completion is denied');
  await assert.rejects(tx((trx) => advanceSearchGeneration(trx, expect(sent),
    { create_index: 'uuid_bound', writer_role: 'writer_role_attested',
      writer_mapping: 'writer_attested', query_role: 'query_role_attested',
      query_mapping: 'roles_attested' }[operation], operation === 'create_index' ? 'fakeUuid1' : undefined)),
  /Unresolved generation dispatch/, 'unknown outcome cannot advance');
  return tx((trx) => updateSearchGenerationDispatch(trx, expect(sent),
    { operation, dispatchId: id, ownerId: owner, state: 'response_confirmed' }));
}

try {
  const initial = await current();
  assert.equal(initial.stage, 'disabled');
  assert.equal(initial.publicationEnabled, false);
  assert.equal(initial.servingReady, false);
  let row = await tx((trx) => enrollLegacySearchGeneration(trx, expect(initial), 'legacyUuid1'));
  assert.equal(row.sourceGenerationToken, 'legacy-v1');
  const absentCandidate = proposal();
  await denyAndPreserve((trx) => trx.update(searchGenerationControl).set({
    stage: 'disabled_intent', revision: row.revision + 1,
    transitionToken: absentCandidate.transitionToken,
    generationToken: absentCandidate.generationToken,
    physicalIndex: absentCandidate.physicalIndex, profileId: 'station-mail-v2',
  }), 'reservation without history is denied', /candidate history mismatch/);
  const mismatchedCandidate = proposal();
  const mismatchedSuffix = mismatchedCandidate.generationToken.replaceAll('-', '');
  await denyAndPreserve(async (trx) => {
    await trx.insert(searchGenerationHistory).values({ generationToken: mismatchedCandidate.generationToken,
      physicalIndex: mismatchedCandidate.physicalIndex, profileId: 'station-mail-v2',
      writerRole: `station_indexer_${mismatchedSuffix}`,
      queryRole: `station_query_${mismatchedSuffix}`,
      writerPrincipal: `station-search-indexer-${mismatchedSuffix}`,
      queryPrincipal: `station-search-query-${mismatchedSuffix}` });
    await trx.update(searchGenerationControl).set({ stage: 'disabled_intent',
      revision: row.revision + 1, transitionToken: mismatchedCandidate.transitionToken,
      generationToken: mismatchedCandidate.generationToken,
      physicalIndex: absentCandidate.physicalIndex, profileId: 'station-mail-v2' });
  }, 'reservation with mismatched history is denied', /candidate history mismatch/);
  await assert.rejects(tx((trx) => casDisabledSearchGeneration(trx, row,
    { stage: 'disabled' })), /cannot alter P2 state/);
  const first = proposal();
  row = await tx((trx) => reserveSearchGeneration(trx, expect(row), first));
  assert.equal(row.sourceGenerationToken, 'legacy-v1');
  await assert.rejects(tx((trx) => casDisabledSearchGeneration(trx, row,
    { stage: 'disabled' })), /cannot alter P2 state/);
  row = await tx((trx) => advanceSearchGeneration(trx, expect(row), 'create_requested'));
  assert.equal(await tx((trx) => armSearchGenerationDispatch(trx, {},
    { operation: 'create_index', dispatchId: randomUUID(), ownerId: randomUUID(),
      target: row.physicalIndex, bodyIdentity: fingerprint })), null,
  'missing expected fields cannot bypass CAS');
  const stale = expect(row);
  const [reservedHistory] = await db.select().from(searchGenerationHistory)
    .where(eq(searchGenerationHistory.generationToken, row.generationToken));
  assert.equal(buildSearchGenerationManifest([reservedHistory])[0].token, first.generationToken,
    'standard lowercase UUID is valid');
  assert.equal(buildSearchGenerationManifest([{ ...reservedHistory,
    generationToken: first.generationToken.toUpperCase() }])[0].token,
  first.generationToken.toUpperCase(), 'standard uppercase UUID is valid');
  assert.throws(() => buildSearchGenerationManifest([{ ...reservedHistory,
    generationToken: first.generationToken.replace(/-([0-9a-f]{4})-([0-9a-f]{12})$/, '-$1$2') }]),
  /Invalid v2 generation identity/, 'missing UUID quartet is invalid');
  const createSpec = searchGenerationDispatchSpec(reservedHistory, 'create_index');
  await assert.rejects(tx((trx) => armSearchGenerationDispatch(trx, stale,
    { operation: 'create_index', dispatchId: randomUUID(), ownerId: randomUUID(),
      target: 'station-mail-v2-gwrong', bodyIdentity: createSpec.bodyIdentity })),
  /Invalid dispatch target/);
  await assert.rejects(tx((trx) => armSearchGenerationDispatch(trx, stale,
    { operation: 'create_index', dispatchId: randomUUID(), ownerId: randomUUID(),
      target: createSpec.target, bodyIdentity: fingerprint })),
  /Invalid dispatch target/);
  for (const state of ['sent_unknown', 'response_confirmed', 'quiesced']) {
    await denyAndPreserve((trx) => trx.insert(searchGenerationDispatch).values({
      generationToken: row.generationToken, operation: 'create_index',
      dispatchId: randomUUID(), ownerId: randomUUID(), target: row.physicalIndex,
      bodyIdentity: createSpec.bodyIdentity, state }),
    `initial ${state} dispatch is denied`, /dispatch must start armed/);
  }
  const contenders = await Promise.allSettled([tx((trx) => armSearchGenerationDispatch(trx, stale,
    { operation: 'create_index', dispatchId: randomUUID(), ownerId: randomUUID(),
      ...createSpec })),
  tx((trx) => armSearchGenerationDispatch(trx, stale,
    { operation: 'create_index', dispatchId: randomUUID(), ownerId: randomUUID(),
      ...createSpec }))]);
  assert.equal(contenders.filter(x => x.status === 'fulfilled' && x.value !== null).length, 1,
    'only one concurrent admin acquires dispatch ownership');
  row = await current();
  const [created] = await db.select().from(searchGenerationDispatch);
  assert.equal(created.state, 'armed');
  row = await tx((trx) => updateSearchGenerationDispatch(trx, expect(row),
    { operation: 'create_index', dispatchId: created.dispatchId,
      ownerId: created.ownerId, state: 'sent_unknown' }));
  const other = proposal();
  const suffix = other.generationToken.replaceAll('-', '').toLowerCase();
  const otherHistory = { generationToken: other.generationToken,
    physicalIndex: other.physicalIndex, profileId: 'station-mail-v2',
    writerRole: `station_indexer_${suffix}`, queryRole: `station_query_${suffix}`,
    writerPrincipal: `station-search-indexer-${suffix}`,
    queryPrincipal: `station-search-query-${suffix}` };
  for (const [change, reason, cause] of [
    [{ generationToken: other.generationToken, physicalIndex: other.physicalIndex,
      transitionToken: other.transitionToken, revision: row.revision + 1 }, 'unknown dispatch cannot be detached', /identity cannot change/],
    [{ transitionToken: randomUUID(), revision: row.revision + 1 }, 'same-stage transition token is fixed', /identity cannot change/],
    [{ transitionToken: null, revision: row.revision + 1 }, 'nullable identity cannot bypass guard', /identity cannot change/],
    [{ sourceGenerationToken: other.generationToken, revision: row.revision + 1 }, 'source identity is fixed', /identity cannot change/],
    [{ generationToken: randomUUID(), revision: row.revision + 1 }, 'missing candidate history is denied', /identity cannot change/],
    [{ physicalIndex: other.physicalIndex, revision: row.revision + 1 }, 'mismatched candidate history is denied', /identity cannot change/],
    [{ revision: row.revision }, 'same revision is denied', /revision must increment once/],
    [{ revision: row.revision - 1 }, 'decreased revision is denied', /revision must increment once/],
  ]) await denyAndPreserve(async (trx) => {
    if (change.generationToken === other.generationToken) await trx.insert(searchGenerationHistory).values(otherHistory);
    await trx.update(searchGenerationControl).set(change);
  }, reason, cause);
  await denyAndPreserve(async (trx) => {
    await trx.insert(searchGenerationHistory).values(otherHistory);
    await trx.insert(searchGenerationDispatch).values({
      generationToken: other.generationToken, operation: 'create_index',
      dispatchId: randomUUID(), ownerId: randomUUID(), target: other.physicalIndex,
      bodyIdentity: fingerprint });
  }, 'wrong candidate dispatch is denied', /candidate, request stage or target mismatch/);
  await denyAndPreserve((trx) => trx.insert(searchGenerationDispatch).values({
    generationToken: row.generationToken, operation: 'writer_role',
    dispatchId: randomUUID(), ownerId: randomUUID(), target: reservedHistory.writerRole,
    bodyIdentity: fingerprint }), 'wrong request-stage dispatch is denied',
  /candidate, request stage or target mismatch/);
  for (const lifecycle of ['bound', 'roles_attested']) {
    const invalid = proposal(), invalidSuffix = invalid.generationToken.replaceAll('-', '');
    await denyAndPreserve((trx) => trx.insert(searchGenerationHistory).values({
      generationToken: invalid.generationToken, physicalIndex: invalid.physicalIndex,
      profileId: 'station-mail-v2', lifecycle, indexUuid: 'manufacturedUuid',
      writerRole: `station_indexer_${invalidSuffix}`, queryRole: `station_query_${invalidSuffix}`,
      writerPrincipal: `station-search-indexer-${invalidSuffix}`,
      queryPrincipal: `station-search-query-${invalidSuffix}`,
      writerCertFingerprint: fingerprint, queryCertFingerprint: fingerprint,
    }), `initial ${lifecycle} history is denied`, /generation must start reserved/);
  }
  await assert.rejects(tx((trx) => advanceSearchGeneration(trx, expect(row),
    'uuid_bound', 'newUuid1')), /Unresolved generation dispatch/);
  row = await tx((trx) => updateSearchGenerationDispatch(trx, expect(row),
    { operation: 'create_index', dispatchId: created.dispatchId,
      ownerId: created.ownerId, state: 'response_confirmed' }));
  row = await tx((trx) => advanceSearchGeneration(trx, expect(row), 'uuid_bound', 'newUuid1'));
  await assert.rejects(db.update(searchGenerationHistory).set({ indexUuid: 'changedUuid' })
    .where(eq(searchGenerationHistory.generationToken, first.generationToken)),
  (error) => /immutable/.test(error.cause?.message ?? ''), 'bound index UUID cannot change');
  row = await tx((trx) => recordSearchGenerationCertEvidence(trx, expect(row),
    { writer: fingerprint, query: 'b'.repeat(64) }));
  for (const [requested, operation, completed] of [
    ['writer_role_requested', 'writer_role', 'writer_role_attested'],
    ['writer_mapping_requested', 'writer_mapping', 'writer_attested'],
    ['query_role_requested', 'query_role', 'query_role_attested'],
    ['query_mapping_requested', 'query_mapping', 'roles_attested'],
  ]) {
    row = await tx((trx) => advanceSearchGeneration(trx, expect(row), requested));
    row = await dispatch(row, operation);
    row = await tx((trx) => advanceSearchGeneration(trx, expect(row), completed));
    await assert.rejects(tx((trx) => casDisabledSearchGeneration(trx, row,
      { stage: 'disabled' })), /cannot alter P2 state/);
  }
  assert.equal(row.stage, 'roles_attested');
  assert.equal(row.publicationEnabled, false);
  await assert.rejects(db.update(searchGenerationControl).set({ publicationEnabled: true,
    revision: row.revision + 1 }),
    (error) => error.cause?.constraint === 'search_generation_disabled_p1');
  await assert.rejects(db.update(searchGenerationControl).set({ servingReady: true,
    revision: row.revision + 1 }),
    (error) => error.cause?.constraint === 'search_generation_disabled_p1');
  const second = proposal();
  row = await tx((trx) => reserveSearchGeneration(trx, expect(row), second));
  assert.equal(row.sourceGenerationToken, first.generationToken);
  await assert.rejects(db.update(searchGenerationControl).set({ stage: 'roles_attested',
    revision: row.revision + 1 }), (error) => /invalid generation control transition/.test(error.cause?.message ?? ''),
  'SQL stage skipping is rejected');
  await assert.rejects(db.update(searchGenerationHistory).set({ physicalIndex: second.physicalIndex })
    .where(eq(searchGenerationHistory.generationToken, first.generationToken)),
  (error) => /immutable/.test(error.cause?.message ?? ''), 'historical literal name is immutable');
  await db.update(searchGenerationHistory).set({ lifecycle: 'retired_retained' })
    .where(eq(searchGenerationHistory.generationToken, first.generationToken));
  const manifest = buildSearchGenerationManifest(await db.select().from(searchGenerationHistory));
  assert.equal(manifest.length, 3);
  assert.equal(manifest.find(x => x.token === 'legacy-v1').presence, 'required');
  assert.equal(manifest.find(x => x.token === first.generationToken).presence, 'required');
  assert.equal(manifest.find(x => x.token === second.generationToken).presence, 'absent');
  assert.deepEqual(manifest, buildSearchGenerationManifest((await db.select().from(searchGenerationHistory)).reverse()),
    'pure manifest order is independent of row order');
  const sample = (await db.select().from(searchGenerationHistory))[0];
  assert.throws(() => buildSearchGenerationManifest(Array(513).fill(sample)),
    /row limit/, 'complete history over limit fails closed');
  const attested = (await db.select().from(searchGenerationHistory))
    .find(x => x.generationToken === first.generationToken);
  assert.throws(() => buildSearchGenerationManifest([{ ...attested, writerCertFingerprint: null }]),
    /Missing attested generation certificate evidence/);
  assert.throws(() => searchGenerationDispatchSpec(attested, 'unexpected_operation'),
    /Unknown search generation operation/);
  await db.update(searchGenerationHistory).set({ lifecycle: 'unavailable' })
    .where(eq(searchGenerationHistory.generationToken, first.generationToken));
  assert.equal(buildSearchGenerationManifest(await db.select().from(searchGenerationHistory))
    .find(x => x.token === first.generationToken).presence, 'incident_missing_allowed');
  console.info('P2a disabled registry, dispatch, guards and manifest fixture passed.');
} finally { await pool.end(); }
