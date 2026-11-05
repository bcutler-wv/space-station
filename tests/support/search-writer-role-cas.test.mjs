/* global structuredClone */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { URL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { searchGenerationDispatchSpec } from '../../packages/db/dist/search-generation-manifest.js';
import { readSearchAdminRegistrySnapshot } from '../../packages/db/dist/search-admin-connection.js';
import { runWriterRoleCas, runWriterMappingCas } from
  '../../packages/db/dist/search-writer-role-cas.js';

const requireDb = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Pool } = requireDb('pg');
const installed = (await readdir('/usr/lib/postgresql'))
  .filter(value => /^\d+$/.test(value) && Number(value) >= 15)
  .sort((a, b) => Number(a) - Number(b));
assert.ok(installed.length, 'disposable PostgreSQL server binaries required');
const bin = `/usr/lib/postgresql/${installed.includes('16') ? '16' : installed[0]}/bin`;
const token = '11111111-1111-4111-8111-111111111111';
const suffix = token.replaceAll('-', '');
const index = `station-mail-v2-g${suffix}`;
const createId = '33333333-3333-4333-8333-333333333333';
const createOwner = '44444444-4444-4444-8444-444444444444';
const roleId = '55555555-5555-4555-8555-555555555555';
const roleOwner = '66666666-6666-4666-8666-666666666666';
const micro = '2026-10-22 18:00:00.123456+00';
const candidate = { generationToken: token, physicalIndex: index, profileId: 'station-mail-v2',
  indexUuid: 'created_uuid', lifecycle: 'bound', writerRole: `station_indexer_${suffix}`,
  queryRole: `station_query_${suffix}`, writerPrincipal: `station-search-indexer-${suffix}`,
  queryPrincipal: `station-search-query-${suffix}`, writerCertFingerprint: null,
  queryCertFingerprint: null };

async function fixture(t) {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/results/wc-'));
  const socket = path.join(root, 'sock');
  await mkdir(socket, { mode: 0o700 });
  const call = (name, args, timeout = 20_000) => execFileSync(`${bin}/${name}`, args,
    { cwd: root, encoding: 'utf8', timeout, maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let initialized = false;
  let pool;
  const serverStatus = () => {
    try { call('pg_ctl', ['-D', 'data', 'status']); return 'running'; }
    catch (error) {
      if (error.status === 3 && !error.signal && !error.killed) return 'stopped';
      throw new Error('Disposable writer CAS server status uncertain', { cause: error });
    }
  };
  t.after(async () => {
    if (pool) await pool.end();
    if (initialized) {
      if (serverStatus() === 'running') call('pg_ctl', ['-D', 'data', '-m', 'immediate', '-w', 'stop']);
      assert.equal(serverStatus(), 'stopped');
    }
    await rm(root, { recursive: true, force: true });
  });
  call('initdb', ['-D', 'data', '-A', 'trust', '-U', 'station'], 30_000);
  initialized = true;
  call('pg_ctl', ['-D', 'data', '-l', 'server.log', '-o', `-k ${socket} -h '' -p 55432`, '-w', 'start']);
  call('createdb', ['-h', socket, '-p', '55432', '-U', 'station', 'station']);
  const owner = async statement => call('psql', ['-X', '-h', socket, '-p', '55432',
    '-U', 'station', '-d', 'station', '-v', 'ON_ERROR_STOP=1', '-Atqc', statement]);
  await owner(`CREATE TABLE search_documents (acknowledged_revision integer,
    acknowledged_global_epoch integer, acknowledged_account_epoch integer)`);
  for (const name of ['0017_kind_azazel.sql', '0018_hard_jean_grey.sql'])
    call('psql', ['-X', '-h', socket, '-p', '55432', '-U', 'station', '-d', 'station',
      '-v', 'ON_ERROR_STOP=1', '-f', path.resolve('packages/db/drizzle', name)]);
  const createSpec = searchGenerationDispatchSpec(candidate, 'create_index');
  await owner(`INSERT INTO search_generation_history (generation_token,physical_index,profile_id,
    index_uuid,lifecycle,created_at) VALUES ('legacy-v1','station-mail-v1','station-mail-v1',
    'legacy_uuid','roles_attested','${micro}')`);
  await owner("UPDATE search_generation_control SET revision=2,source_generation_token='legacy-v1' WHERE singleton=1");
  await owner(`INSERT INTO search_generation_history (generation_token,physical_index,profile_id,
    writer_role,query_role,writer_principal,query_principal,created_at)
    VALUES ('${token}','${index}','station-mail-v2','${candidate.writerRole}',
    '${candidate.queryRole}','${candidate.writerPrincipal}','${candidate.queryPrincipal}','${micro}')`);
  await owner(`UPDATE search_generation_control SET revision=3,stage='disabled_intent',
    transition_token='22222222-2222-4222-8222-222222222222',generation_token='${token}',
    physical_index='${index}',profile_id='station-mail-v2',updated_at='${micro}' WHERE singleton=1`);
  await owner("UPDATE search_generation_control SET revision=4,stage='create_requested' WHERE singleton=1");
  await owner(`INSERT INTO search_generation_dispatch (generation_token,operation,dispatch_id,
    owner_id,target,body_identity,created_at) VALUES ('${token}','create_index','${createId}',
    '${createOwner}','${createSpec.target}','${createSpec.bodyIdentity}','${micro}')`);
  await owner(`UPDATE search_generation_dispatch SET state='sent_unknown' WHERE generation_token='${token}'
    AND operation='create_index'`);
  await owner(`UPDATE search_generation_dispatch SET state='response_confirmed'
    WHERE generation_token='${token}' AND operation='create_index'`);
  await owner(`UPDATE search_generation_history SET index_uuid='created_uuid',lifecycle='bound'
    WHERE generation_token='${token}'`);
  await owner(`UPDATE search_generation_control SET revision=5,stage='uuid_bound',
    index_uuid='created_uuid',updated_at='${micro}' WHERE singleton=1`);
  call('psql', ['-X', '-h', socket, '-p', '55432', '-U', 'station', '-d', 'station',
    '-v', 'ON_ERROR_STOP=1', '-f', path.resolve('ops/postgres/search-admin-roles-apply.sql')]);
  await owner('ALTER ROLE station_search_transition LOGIN');
  pool = new Pool({ user: 'station_search_transition', host: socket, port: 55432,
    database: 'station', max: 2, connectionTimeoutMillis: 3000,
    query_timeout: 5000, statement_timeout: 3000 });
  const db = drizzle(pool);
  const read = () => readSearchAdminRegistrySnapshot(db, 'station_search_transition');
  const first = await read();
  assert.equal(first.identity.sessionUser, 'station_search_transition');
  assert.equal(first.control.stage, 'uuid_bound');
  assert.ok(first.exactTimestamps.control.updatedAt.endsWith('.123456Z'));
  assert.equal(await owner(`SELECT has_column_privilege('station_search_transition',
    'search_generation_control','revision','UPDATE')`), 't');
  await assert.rejects(pool.query(`UPDATE search_generation_control
    SET publication_enabled=true WHERE singleton=1`),
  error => error.code === '42501');
  return { db, read, owner };
}

const roleSpec = searchGenerationDispatchSpec(candidate, 'writer_role');
const inputs = [
  ['request', { stage: 'writer_role_requested' }],
  ['arm', { operation: 'writer_role', dispatchId: roleId, ownerId: roleOwner,
    target: roleSpec.target, bodyIdentity: roleSpec.bodyIdentity }],
  ['send', { operation: 'writer_role', dispatchId: roleId, ownerId: roleOwner,
    state: 'sent_unknown' }],
  ['confirm', { operation: 'writer_role', dispatchId: roleId, ownerId: roleOwner,
    state: 'response_confirmed' }],
  ['attest', { stage: 'writer_role_attested' }],
];
const mappingSpec = searchGenerationDispatchSpec(candidate, 'writer_mapping');
const mappingId = '77777777-7777-4777-8777-777777777777';
const mappingOwner = '88888888-8888-4888-8888-888888888888';
const mappingInputs = [
  ['request', { stage: 'writer_mapping_requested' }],
  ['arm', { operation: 'writer_mapping', dispatchId: mappingId, ownerId: mappingOwner,
    target: mappingSpec.target, bodyIdentity: mappingSpec.bodyIdentity }],
  ['send', { operation: 'writer_mapping', dispatchId: mappingId, ownerId: mappingOwner,
    state: 'sent_unknown' }],
  ['confirm', { operation: 'writer_mapping', dispatchId: mappingId, ownerId: mappingOwner,
    state: 'response_confirmed' }],
  ['attest', { stage: 'writer_attested' }],
];
async function completedRole(pg) {
  let before = await pg.read();
  for (const [kind, input] of inputs) before = await runWriterRoleCas(pg.db, kind, before, input);
  assert.equal(before.control.stage, 'writer_role_attested');
  return before;
}

test('restricted transition role captures all five exact successors in committed transactions', async t => {
  const pg = await fixture(t);
  let before = await pg.read();
  for (const [i, [kind, input]] of inputs.entries()) {
    const after = await runWriterRoleCas(pg.db, kind, before, input);
    assert.deepEqual(after, await pg.read());
    assert.equal(after.control.revision, 6 + i);
    assert.equal(after.control.publicationEnabled, false);
    assert.equal(after.control.servingReady, false);
    assert.match(after.exactTimestamps.control.updatedAt, /\.\d{6}Z$/);
    if (i >= 1) assert.equal(after.exactTimestamps.dispatch.find(row =>
      row.operation === 'writer_role').createdAt,
    (i === 1 ? after : before).exactTimestamps.dispatch.find(row =>
      row.operation === 'writer_role').createdAt);
    before = after;
  }
  assert.equal(before.control.stage, 'writer_role_attested');
  assert.equal(before.dispatch.find(row => row.operation === 'writer_role').state,
    'response_confirmed');
});

test('stale, submillisecond and changed immutable predecessor evidence never mutates', async t => {
  const pg = await fixture(t);
  const original = await pg.read();
  const changed = [
    value => { value.control.revision++; },
    value => { value.exactTimestamps.control.updatedAt = '2026-10-22T18:00:00.123457Z'; },
    value => { value.history[0].indexUuid = 'changed'; },
    value => { value.dispatch[0].ownerId = roleOwner; },
    value => { value.exactTimestamps.dispatch[0].createdAt = '2026-10-22T18:00:00.123457Z'; },
  ];
  for (const change of changed) {
    const bad = structuredClone(original); change(bad);
    await assert.rejects(runWriterRoleCas(pg.db, 'request', bad, inputs[0][1]),
      { kind: 'query' });
    assert.deepEqual(await pg.read(), original);
  }
  let getter = 0;
  const bad = structuredClone(original);
  Object.defineProperty(bad.history[0], 'indexUuid', { enumerable: true,
    get() { getter++; throw Error('private accessor'); } });
  await assert.rejects(runWriterRoleCas(pg.db, 'request', bad, inputs[0][1]),
    { kind: 'query' });
  assert.equal(getter, 0);
  const badDate = structuredClone(original);
  Object.defineProperty(badDate.control.updatedAt, 'getTime', { enumerable: true,
    get() { getter++; throw Error('private date accessor'); } });
  await assert.rejects(runWriterRoleCas(pg.db, 'request', badDate, inputs[0][1]),
    { kind: 'query' });
  assert.equal(getter, 0);
  const input = { stage: 'writer_role_requested' };
  const pending = runWriterRoleCas(pg.db, 'request', original, input);
  input.stage = 'wrong';
  assert.equal((await pending).control.stage, 'writer_role_requested');
});

test('a live same-millisecond database timestamp drift rejects the original predecessor', async t => {
  const pg = await fixture(t);
  const original = await pg.read();
  await pg.owner(`BEGIN;
    ALTER TABLE search_generation_control DISABLE TRIGGER search_generation_control_guard_trigger;
    UPDATE search_generation_control SET updated_at='2026-10-22 18:00:00.123457+00'
      WHERE singleton=1;
    ALTER TABLE search_generation_control ENABLE TRIGGER search_generation_control_guard_trigger;
    COMMIT`);
  const changed = await pg.read();
  assert.equal(changed.control.revision, original.control.revision);
  assert.equal(changed.control.updatedAt.getTime(), original.control.updatedAt.getTime());
  assert.notEqual(changed.exactTimestamps.control.updatedAt,
    original.exactTimestamps.control.updatedAt);
  await assert.rejects(runWriterRoleCas(pg.db, 'request', original, inputs[0][1]),
    { kind: 'query' });
  assert.deepEqual(await pg.read(), changed);
});

test('one original predecessor has one winner under concurrent restricted-role attempts', async t => {
  const pg = await fixture(t);
  const original = await pg.read();
  const pair = await Promise.allSettled([
    runWriterRoleCas(pg.db, 'request', original, inputs[0][1]),
    runWriterRoleCas(pg.db, 'request', original, inputs[0][1]),
  ]);
  assert.deepEqual(pair.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await pg.read()).control.revision, original.control.revision + 1);
});

test('a real post-mutation snapshot mismatch rolls the CAS and injected row back', async t => {
  const pg = await fixture(t);
  const original = await pg.read();
  const extraToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const extraSuffix = extraToken.replaceAll('-', '');
  await pg.owner(`CREATE FUNCTION fixture_add_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
      INSERT INTO search_generation_history
        (generation_token,physical_index,profile_id,writer_role,query_role,
          writer_principal,query_principal)
      VALUES ('${extraToken}','station-mail-v2-g${extraSuffix}','station-mail-v2',
        'station_indexer_${extraSuffix}','station_query_${extraSuffix}',
        'station-search-indexer-${extraSuffix}','station-search-query-${extraSuffix}');
      RETURN NEW; END $$`);
  await pg.owner(`CREATE TRIGGER fixture_add_history_trigger AFTER UPDATE ON
    search_generation_control FOR EACH ROW WHEN (NEW.stage='writer_role_requested')
    EXECUTE FUNCTION fixture_add_history()`);
  await assert.rejects(runWriterRoleCas(pg.db, 'request', original, inputs[0][1]),
    { kind: 'query' });
  assert.deepEqual(await pg.read(), original);
  await pg.owner('DROP TRIGGER fixture_add_history_trigger ON search_generation_control');
  await pg.owner('DROP FUNCTION fixture_add_history()');
  assert.equal((await runWriterRoleCas(pg.db, 'request', original, inputs[0][1])).control.revision,
    original.control.revision + 1);
});

test('an uncertain return after a real commit cannot be adopted or replayed', async t => {
  const pg = await fixture(t);
  const original = await pg.read();
  const wrapper = { transaction: async callback => {
    await pg.db.transaction(callback);
    throw Error('private lost return');
  } };
  await assert.rejects(runWriterRoleCas(wrapper, 'request', original, inputs[0][1]),
    { kind: 'query' });
  assert.equal((await pg.read()).control.revision, original.control.revision + 1);
  await assert.rejects(runWriterRoleCas(pg.db, 'request', original, inputs[0][1]),
    { kind: 'query' });
  assert.equal((await pg.read()).control.revision, original.control.revision + 1);
});

test('mapping CAS records five exact committed successors and original microtimes', async t => {
  const pg = await fixture(t);
  let before = await completedRole(pg);
  const original = structuredClone(before);
  for (const [i, [kind, input]] of mappingInputs.entries()) {
    const after = await runWriterMappingCas(pg.db, kind, before, input);
    assert.deepEqual(after, await pg.read());
    assert.equal(after.control.revision, original.control.revision + i + 1);
    assert.equal(after.control.publicationEnabled, false);
    assert.equal(after.control.servingReady, false);
    assert.deepEqual(after.history, original.history);
    assert.deepEqual(after.exactTimestamps.history, original.exactTimestamps.history);
    assert.deepEqual(after.dispatch.filter(row => row.operation !== 'writer_mapping'),
      original.dispatch);
    if (i >= 1) {
      const row = after.dispatch.find(item => item.operation === 'writer_mapping');
      const stamp = after.exactTimestamps.dispatch.find(item => item.operation === 'writer_mapping');
      assert.equal(row.createdAt.getTime(), Date.parse(stamp.createdAt));
      if (i > 1) assert.equal(stamp.createdAt, before.exactTimestamps.dispatch.find(item =>
        item.operation === 'writer_mapping').createdAt);
    }
    before = after;
  }
  assert.equal(before.control.stage, 'writer_attested');
  assert.equal(before.dispatch.find(row => row.operation === 'writer_mapping').state,
    'response_confirmed');
  assert.equal(before.history.find(row => row.generationToken === token).writerCertFingerprint,
    null);
});

test('mapping CAS rejects prohibited but exactly matched locked predecessors', async t => {
  const pg = await fixture(t);
  const original = await completedRole(pg);
  for (const command of [
    `UPDATE search_generation_history SET writer_cert_fingerprint='${'a'.repeat(64)}'
      WHERE generation_token='${token}'`,
    `UPDATE search_generation_dispatch SET state='quiesced'
      WHERE generation_token='${token}' AND operation='writer_role'`,
  ]) {
    await pg.owner(`BEGIN;
      ALTER TABLE search_generation_history DISABLE TRIGGER search_generation_history_guard_trigger;
      ALTER TABLE search_generation_dispatch DISABLE TRIGGER search_generation_dispatch_guard_trigger;
      ${command};
      ALTER TABLE search_generation_dispatch ENABLE TRIGGER search_generation_dispatch_guard_trigger;
      ALTER TABLE search_generation_history ENABLE TRIGGER search_generation_history_guard_trigger;
      COMMIT`);
    const prohibited = await pg.read();
    await assert.rejects(runWriterMappingCas(pg.db, 'request', prohibited, mappingInputs[0][1]),
      { kind: 'query' });
    assert.deepEqual(await pg.read(), prohibited);
    await pg.owner(`BEGIN;
      ALTER TABLE search_generation_history DISABLE TRIGGER search_generation_history_guard_trigger;
      ALTER TABLE search_generation_dispatch DISABLE TRIGGER search_generation_dispatch_guard_trigger;
      UPDATE search_generation_history SET writer_cert_fingerprint=NULL
        WHERE generation_token='${token}';
      UPDATE search_generation_dispatch SET state='response_confirmed'
        WHERE generation_token='${token}' AND operation='writer_role';
      ALTER TABLE search_generation_dispatch ENABLE TRIGGER search_generation_dispatch_guard_trigger;
      ALTER TABLE search_generation_history ENABLE TRIGGER search_generation_history_guard_trigger;
      COMMIT`);
    assert.deepEqual(await pg.read(), original);
  }
});

test('mapping send rejects a newly read but prohibited mapping dispatch state', async t => {
  const pg = await fixture(t);
  let before = await completedRole(pg);
  before = await runWriterMappingCas(pg.db, 'request', before, mappingInputs[0][1]);
  await runWriterMappingCas(pg.db, 'arm', before, mappingInputs[1][1]);
  await pg.owner(`BEGIN;
    ALTER TABLE search_generation_dispatch DISABLE TRIGGER search_generation_dispatch_guard_trigger;
    UPDATE search_generation_dispatch SET state='quiesced'
      WHERE generation_token='${token}' AND operation='writer_mapping';
    ALTER TABLE search_generation_dispatch ENABLE TRIGGER search_generation_dispatch_guard_trigger;
    COMMIT`);
  const prohibited = await pg.read();
  assert.equal(prohibited.dispatch.find(row => row.operation === 'writer_mapping').state,
    'quiesced');
  await assert.rejects(runWriterMappingCas(pg.db, 'send', prohibited,
    mappingInputs[2][1]), { kind: 'query' });
  assert.deepEqual(await pg.read(), prohibited);
});

test('mapping legal stages reject wrong operation, arm target and send owner', async t => {
  const pg = await fixture(t);
  let before = await completedRole(pg);
  before = await runWriterMappingCas(pg.db, 'request', before, mappingInputs[0][1]);
  for (const changed of [
    { ...mappingInputs[1][1], operation: 'writer_role' },
    { ...mappingInputs[1][1], target: 'wrong' },
  ]) {
    await assert.rejects(runWriterMappingCas(pg.db, 'arm', before, changed),
      { kind: 'query' });
    assert.deepEqual(await pg.read(), before);
  }
  before = await runWriterMappingCas(pg.db, 'arm', before, mappingInputs[1][1]);
  await assert.rejects(runWriterMappingCas(pg.db, 'send', before,
    { ...mappingInputs[2][1], ownerId: '99999999-9999-4999-8999-999999999999' }),
  { kind: 'query' });
  assert.deepEqual(await pg.read(), before);
  assert.equal((await runWriterMappingCas(pg.db, 'send', before,
    mappingInputs[2][1])).control.revision, before.control.revision + 1);
});

test('mapping predecessor detects same-millisecond history and dispatch drift', async t => {
  for (const [table, where, trigger] of [
    ['search_generation_history', `generation_token='${token}'`,
      'search_generation_history_guard_trigger'],
    ['search_generation_dispatch', `generation_token='${token}' AND operation='writer_role'`,
      'search_generation_dispatch_guard_trigger'],
  ]) {
    const pg = await fixture(t);
    const original = await completedRole(pg);
    const side = table === 'search_generation_history' ?
      original.exactTimestamps.history.find(row => row.generationToken === token) :
      original.exactTimestamps.dispatch.find(row => row.generationToken === token &&
        row.operation === 'writer_role');
    const stamp = side.createdAt;
    const digits = stamp.slice(-7, -1);
    const changedStamp = `${stamp.slice(0, -7)}${digits.slice(0, 5)}` +
      `${digits[5] === '9' ? '8' : '9'}Z`;
    await pg.owner(`BEGIN;
      ALTER TABLE ${table} DISABLE TRIGGER ${trigger};
      UPDATE ${table} SET created_at='${changedStamp}' WHERE ${where};
      ALTER TABLE ${table} ENABLE TRIGGER ${trigger};
      COMMIT`);
    const drifted = await pg.read();
    const next = table === 'search_generation_history' ?
      drifted.exactTimestamps.history.find(row => row.generationToken === token) :
      drifted.exactTimestamps.dispatch.find(row => row.generationToken === token &&
        row.operation === 'writer_role');
    assert.notEqual(next.createdAt, side.createdAt);
    assert.equal(Date.parse(next.createdAt), Date.parse(side.createdAt));
    await assert.rejects(runWriterMappingCas(pg.db, 'request', original,
      mappingInputs[0][1]), { kind: 'query' });
    assert.deepEqual(await pg.read(), drifted);
  }
});

test('mapping CAS rejects same-millisecond drift, wrong phase and hostile operation input', async t => {
  const pg = await fixture(t);
  const original = await completedRole(pg);
  await assert.rejects(runWriterMappingCas(pg.db, 'arm', original, mappingInputs[1][1]),
    { kind: 'query' });
  let getter = 0;
  const hostile = { stage: 'writer_mapping_requested' };
  Object.defineProperty(hostile, 'stage', { enumerable: true,
    get() { getter++; throw Error('private'); } });
  await assert.rejects(runWriterMappingCas(pg.db, 'request', original, hostile),
    { kind: 'query' });
  const badSnapshot = structuredClone(original);
  Object.defineProperty(badSnapshot.history[0], 'indexUuid', { enumerable: true,
    get() { getter++; throw Error('private'); } });
  await assert.rejects(runWriterMappingCas(pg.db, 'request', badSnapshot,
    mappingInputs[0][1]), { kind: 'query' });
  assert.equal(getter, 0);
  const mutable = { stage: 'writer_mapping_requested' };
  const pending = runWriterMappingCas(pg.db, 'request', original, mutable);
  mutable.stage = 'wrong';
  original.history[0].indexUuid = 'caller-only-mutation';
  const requested = await pending;
  assert.equal(requested.control.stage, 'writer_mapping_requested');
  const stamp = requested.exactTimestamps.control.updatedAt;
  const microdigits = stamp.slice(-7, -1);
  const changedStamp = `${stamp.slice(0, -7)}${microdigits.slice(0, 5)}` +
    `${microdigits[5] === '9' ? '8' : '9'}Z`;
  await pg.owner(`BEGIN;
    ALTER TABLE search_generation_control DISABLE TRIGGER search_generation_control_guard_trigger;
    UPDATE search_generation_control SET updated_at='${changedStamp}'
      WHERE singleton=1;
    ALTER TABLE search_generation_control ENABLE TRIGGER search_generation_control_guard_trigger;
    COMMIT`);
  const drifted = await pg.read();
  assert.equal(drifted.control.updatedAt.getTime(), requested.control.updatedAt.getTime());
  assert.notEqual(drifted.exactTimestamps.control.updatedAt,
    requested.exactTimestamps.control.updatedAt);
  await assert.rejects(runWriterMappingCas(pg.db, 'arm', requested, mappingInputs[1][1]),
    { kind: 'query' });
  assert.deepEqual(await pg.read(), drifted);
});

test('mapping CAS has one winner for a concurrent original predecessor', async t => {
  const pg = await fixture(t);
  const original = await completedRole(pg);
  const pair = await Promise.allSettled([
    runWriterMappingCas(pg.db, 'request', original, mappingInputs[0][1]),
    runWriterMappingCas(pg.db, 'request', original, mappingInputs[0][1]),
  ]);
  assert.deepEqual(pair.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await pg.read()).control.revision, original.control.revision + 1);
});

test('mapping post-mutation successor mismatch rolls back its real CAS', async t => {
  const pg = await fixture(t);
  const original = await completedRole(pg);
  const extraToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const extraSuffix = extraToken.replaceAll('-', '');
  await pg.owner(`CREATE FUNCTION fixture_add_mapping_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
      INSERT INTO search_generation_history
        (generation_token,physical_index,profile_id,writer_role,query_role,
          writer_principal,query_principal)
      VALUES ('${extraToken}','station-mail-v2-g${extraSuffix}','station-mail-v2',
        'station_indexer_${extraSuffix}','station_query_${extraSuffix}',
        'station-search-indexer-${extraSuffix}','station-search-query-${extraSuffix}');
      RETURN NEW; END $$`);
  await pg.owner(`CREATE TRIGGER fixture_add_mapping_history_trigger AFTER UPDATE ON
    search_generation_control FOR EACH ROW WHEN (NEW.stage='writer_mapping_requested')
    EXECUTE FUNCTION fixture_add_mapping_history()`);
  await assert.rejects(runWriterMappingCas(pg.db, 'request', original,
    mappingInputs[0][1]), { kind: 'query' });
  assert.deepEqual(await pg.read(), original);
  await pg.owner('DROP TRIGGER fixture_add_mapping_history_trigger ON search_generation_control');
  await pg.owner('DROP FUNCTION fixture_add_mapping_history()');
  assert.equal((await runWriterMappingCas(pg.db, 'request', original,
    mappingInputs[0][1])).control.revision, original.control.revision + 1);
});

test('mapping commit followed by lost return is uncertain and old predecessor cannot replay',
  async t => {
    const pg = await fixture(t);
    const original = await completedRole(pg);
    const wrapper = { transaction: async callback => {
      await pg.db.transaction(callback);
      throw Error('private lost mapping return');
    } };
    await assert.rejects(runWriterMappingCas(wrapper, 'request', original,
      mappingInputs[0][1]), { kind: 'query' });
    assert.equal((await pg.read()).control.revision, original.control.revision + 1);
    await assert.rejects(runWriterMappingCas(pg.db, 'request', original,
      mappingInputs[0][1]), { kind: 'query' });
    assert.equal((await pg.read()).control.revision, original.control.revision + 1);
  });
