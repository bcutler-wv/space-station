import assert from 'node:assert/strict';
import process from 'node:process';
import { databaseUrl, loadRuntimeConfig, openDatabase, orbits, exclusionRules, searchEpochs } from '../../packages/db/dist/index.js';
import { databaseSetupStore } from '../../apps/server/dist/setup-store.js';

const origin = 'https://example.com';
const config = loadRuntimeConfig(process.env);
const database = openDatabase(databaseUrl(config));
const input = {
  version: 1, confirmedOrigin: origin,
  orbit: { name: 'Example work', colorSlot: 2, context: 'Example account for fixture tests.' },
  globalDefaults: { index: 'allow', ai: 'exclude' },
  orbitDefaults: { index: 'exclude', ai: 'allow' },
  exclusions: [{ scope: 'global', kind: 'sender', value: 'Private@example.com', effect: 'no_ai_and_no_index' }],
};
try {
  const store = databaseSetupStore(database.db);
  assert.equal((await store.get(origin)).completed, false);
  const results = await Promise.all([store.complete(input, origin), store.complete(input, origin)]);
  assert.equal(results.filter(Boolean).length, 1, 'only one setup completion wins');
  assert.equal(results.filter((value) => value === null).length, 1);
  assert.equal((await database.db.select().from(orbits)).length, 1);
  assert.equal((await database.db.select().from(exclusionRules)).length, 1);
  assert.equal((await database.db.select().from(searchEpochs))[0].epoch, 2,
    'one completed setup bumps the global search epoch once');
  assert.deepEqual((await store.get(origin)).globalDefaults, input.globalDefaults);
  assert.equal(await store.isReady(origin), true);
  assert.equal(await store.isReady('https://changed.example.com'), false);
  await store.reconfirmOrigin('https://changed.example.com');
  assert.equal(await store.isReady('https://changed.example.com'), true);
  assert.equal((await database.db.select().from(searchEpochs))[0].epoch, 3);
  await store.reconfirmOrigin('https://changed.example.com');
  assert.equal((await database.db.select().from(searchEpochs))[0].epoch, 3,
    'unchanged confirmed origin does not churn the global epoch');
} finally { await database.close(); }
const reopened = openDatabase(databaseUrl(config));
try {
  const state = await databaseSetupStore(reopened.db).get(origin);
  assert.equal(state.completed, true);
  assert.equal(state.orbit.name, input.orbit.name);
  assert.equal(state.exclusions[0].value, 'private@example.com');
  process.stdout.write('First Orbit setup transaction, race, and reopen passed.\n');
} finally { await reopened.close(); }
