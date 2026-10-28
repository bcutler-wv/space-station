import assert from 'node:assert/strict';
import process from 'node:process';
import { sql } from 'drizzle-orm';
import { databaseUrl, loadRuntimeConfig, openDatabase,
  reserveSearchGeneration, searchGenerationControl } from '../../packages/db/dist/index.js';

const token = '11111111-1111-4111-8111-111111111111';
const candidate = { transitionToken: '22222222-2222-4222-8222-222222222222',
  generationToken: token, physicalIndex: `station-mail-v2-g${token.replaceAll('-', '')}` };
const { db, close } = openDatabase(databaseUrl(loadRuntimeConfig(process.env)));
try {
  const [row] = await db.select().from(searchGenerationControl);
  assert.equal(row?.stage, 'disabled');
  assert.equal(row.revision, 2);
  assert.equal(row.sourceGenerationToken, 'legacy-v1');
  const expected = { revision: row.revision, stage: row.stage,
    transitionToken: row.transitionToken, sourceGenerationToken: row.sourceGenerationToken,
    generationToken: row.generationToken, physicalIndex: row.physicalIndex,
    indexUuid: row.indexUuid, profileId: row.profileId };
  const reserved = await db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    await tx.execute(sql`set local lock_timeout = '750ms'`);
    return reserveSearchGeneration(tx, expected, candidate);
  });
  assert.equal(reserved?.revision, 3);
  assert.equal(reserved.stage, 'disabled_intent');
  assert.equal(reserved.generationToken, token);
  assert.equal(reserved.publicationEnabled, false);
  assert.equal(reserved.servingReady, false);
  process.stdout.write('Fixture create candidate reserved through finite database API.\n');
} finally { await close(); }
