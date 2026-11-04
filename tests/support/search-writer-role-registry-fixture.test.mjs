import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { changeWriterPrepareRegistryFixture } from './search-writer-role-registry-fixture.mjs';

const installed = (await readdir('/usr/lib/postgresql'))
  .filter(value => /^\d+$/.test(value) && Number(value) >= 15)
  .sort((a, b) => Number(a) - Number(b));
assert.ok(installed.length > 0, 'disposable PostgreSQL server binaries required');
const bin = `/usr/lib/postgresql/${installed.includes('16') ? '16' : installed[0]}/bin`;
const token = '11111111-1111-4111-8111-111111111111';
const dispatchId = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const index = `station-mail-v2-g${token.replaceAll('-', '')}`;
const micro = '2026-10-22 18:00:00.123456+00';

async function cluster(t) {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/results/p-'));
  const socket = path.join(root, 'sock');
  await mkdir(socket, { mode: 0o700 });
  const call = (name, args, timeout = 20_000) => execFileSync(`${bin}/${name}`, args,
    { cwd: root, encoding: 'utf8', timeout, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let initialized = false;
  const serverStatus = () => {
    try { call('pg_ctl', ['-D', 'data', 'status']); return 'running'; }
    catch (error) {
      if (error.status === 3 && !error.signal && !error.killed) return 'stopped';
      throw new Error('Disposable PostgreSQL status is uncertain', { cause: error });
    }
  };
  t.after(async () => {
    if (initialized) {
      if (serverStatus() === 'running') call('pg_ctl', ['-D', 'data', '-m', 'immediate', '-w', 'stop']);
      assert.equal(serverStatus(), 'stopped');
    }
    await rm(root, { recursive: true, force: true });
  });
  call('initdb', ['-D', 'data', '-A', 'trust', '-U', 'station'], 30_000);
  initialized = true;
  call('pg_ctl', ['-D', 'data', '-l', 'server.log', '-o', `-k ${socket} -h '' -p 55432`, '-w', 'start']);
  const sql = async statement => call('psql', ['-X', '-h', socket, '-p', '55432', '-U', 'station',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atqc', statement]);
  await sql(`CREATE TABLE search_documents (acknowledged_revision integer,
    acknowledged_global_epoch integer, acknowledged_account_epoch integer)`);
  for (const migration of ['0017_kind_azazel.sql', '0018_hard_jean_grey.sql'])
    call('psql', ['-X', '-h', socket, '-p', '55432', '-U', 'station', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-f', path.resolve('packages/db/drizzle', migration)]);
  await sql(`INSERT INTO search_generation_history (generation_token,physical_index,profile_id,
    index_uuid,lifecycle,created_at) VALUES ('legacy-v1','station-mail-v1','station-mail-v1',
    'legacy_uuid','roles_attested','${micro}')`);
  await sql("UPDATE search_generation_control SET revision=2,source_generation_token='legacy-v1' WHERE singleton=1");
  await sql(`INSERT INTO search_generation_history (generation_token,physical_index,profile_id,
    writer_role,query_role,writer_principal,query_principal,created_at)
    VALUES ('${token}','${index}','station-mail-v2',
    'station_indexer_${token.replaceAll('-', '')}','station_query_${token.replaceAll('-', '')}',
    'station-search-indexer-${token.replaceAll('-', '')}',
    'station-search-query-${token.replaceAll('-', '')}','${micro}')`);
  await sql(`UPDATE search_generation_control SET revision=3,stage='disabled_intent',
    transition_token='22222222-2222-4222-8222-222222222222',generation_token='${token}',
    physical_index='${index}',profile_id='station-mail-v2',updated_at='${micro}' WHERE singleton=1`);
  await sql("UPDATE search_generation_control SET revision=4,stage='create_requested' WHERE singleton=1");
  await sql(`INSERT INTO search_generation_dispatch (generation_token,operation,dispatch_id,
    owner_id,target,body_identity,created_at) VALUES ('${token}','create_index',
    '${dispatchId}','${ownerId}','${index}','${'a'.repeat(64)}','${micro}')`);
  await sql(`UPDATE search_generation_dispatch SET state='sent_unknown' WHERE generation_token='${token}'
    AND operation='create_index'`);
  await sql(`UPDATE search_generation_dispatch SET state='response_confirmed'
    WHERE generation_token='${token}' AND operation='create_index'`);
  await sql(`UPDATE search_generation_history SET index_uuid='created_uuid',lifecycle='bound'
    WHERE generation_token='${token}'`);
  await sql(`UPDATE search_generation_control SET revision=5,stage='uuid_bound',
    index_uuid='created_uuid',updated_at='${micro}' WHERE singleton=1`);
  const readRegistry = async () => JSON.parse(await sql(`SELECT json_build_object(
    'control',(SELECT row_to_json(c) FROM search_generation_control c WHERE singleton=1),
    'history',(SELECT coalesce(json_agg(row_to_json(h) ORDER BY generation_token),'[]'::json)
      FROM search_generation_history h),
    'dispatch',(SELECT coalesce(json_agg(row_to_json(d) ORDER BY generation_token,operation),'[]'::json)
      FROM search_generation_dispatch d),
    'microseconds',json_build_object(
      'control',(SELECT to_char(updated_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM search_generation_control WHERE singleton=1),
      'history',(SELECT coalesce(json_agg(json_build_array(generation_token,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
        ORDER BY generation_token),'[]'::json) FROM search_generation_history),
      'dispatch',(SELECT coalesce(json_agg(json_build_array(generation_token,operation,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
        ORDER BY generation_token,operation),'[]'::json) FROM search_generation_dispatch)))`));
  const guardStates = async () => sql(`SELECT string_agg(c.relname||'|'||t.tgname||'|'||t.tgenabled::text,';'
    ORDER BY c.relname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgname IN ('search_generation_control_guard_trigger',
      'search_generation_history_guard_trigger','search_generation_dispatch_guard_trigger')`);
  return { sql, readRegistry, guardStates };
}

test('actual migration guards survive all three fixed mutate and restore transactions', async t => {
  const pg = await cluster(t);
  const original = await pg.readRegistry();
  assert.equal(original.control.stage, 'uuid_bound');
  assert.ok(original.microseconds.control.endsWith('.123456Z'));
  const guards = await pg.guardStates();
  assert.equal(guards.split(';').length, 3);
  assert.equal(guards.split(';').every(row => row.endsWith('|O')), true);
  for (const name of ['registry-revision', 'registry-candidate-uuid', 'create-dispatch-owner']) {
    const altered = await changeWriterPrepareRegistryFixture(name, 'mutate', original,
      { runSql: pg.sql, readRegistry: pg.readRegistry });
    assert.deepEqual(await pg.readRegistry(), altered);
    assert.notDeepEqual(altered, original);
    assert.deepEqual(altered.microseconds, original.microseconds);
    assert.equal(await pg.guardStates(), guards);
    await changeWriterPrepareRegistryFixture(name, 'restore', original,
      { runSql: pg.sql, readRegistry: pg.readRegistry });
    assert.deepEqual(await pg.readRegistry(), original);
    assert.equal(await pg.guardStates(), guards);
  }
  await assert.rejects(pg.sql('UPDATE search_generation_control SET revision=4 WHERE singleton=1'));
  await assert.rejects(pg.sql("UPDATE search_generation_control SET index_uuid='bad' WHERE singleton=1"));
  await assert.rejects(pg.sql(`UPDATE search_generation_dispatch SET owner_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    WHERE generation_token='${token}' AND operation='create_index'`));
  assert.deepEqual(await pg.readRegistry(), original);
  assert.equal(await pg.guardStates(), guards);
  for (const wrong of [
    { ...original, control: { ...original.control, revision: original.control.revision + 1 } },
    { ...original, dispatch: original.dispatch.map(row => ({ ...row,
      owner_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })) },
    { ...original, dispatch: original.dispatch.map(row => ({ ...row,
      dispatch_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })) },
    { ...original, microseconds: { ...original.microseconds,
      control: '2026-10-22T18:00:00.123457Z' } },
  ]) {
    await assert.rejects(changeWriterPrepareRegistryFixture('registry-revision', 'mutate', wrong,
      { runSql: pg.sql, readRegistry: pg.readRegistry }));
    assert.deepEqual(await pg.readRegistry(), original);
    assert.equal(await pg.guardStates(), guards);
  }
  await pg.sql('ALTER TABLE search_generation_control DISABLE TRIGGER search_generation_control_guard_trigger');
  await assert.rejects(changeWriterPrepareRegistryFixture('registry-revision', 'mutate', original,
    { runSql: pg.sql, readRegistry: pg.readRegistry }));
  assert.deepEqual(await pg.readRegistry(), original);
  assert.ok((await pg.guardStates()).includes('|D'));
  await pg.sql('ALTER TABLE search_generation_control ENABLE TRIGGER search_generation_control_guard_trigger');
  assert.equal(await pg.guardStates(), guards);
  await pg.sql(`DROP TRIGGER search_generation_control_guard_trigger ON search_generation_control;
    CREATE TRIGGER search_generation_control_guard_trigger BEFORE UPDATE OR DELETE
    ON search_generation_control FOR EACH ROW EXECUTE FUNCTION search_generation_history_guard()`);
  await assert.rejects(changeWriterPrepareRegistryFixture('registry-revision', 'mutate', original,
    { runSql: pg.sql, readRegistry: pg.readRegistry }));
  assert.deepEqual(await pg.readRegistry(), original);
  await pg.sql(`DROP TRIGGER search_generation_control_guard_trigger ON search_generation_control;
    CREATE TRIGGER search_generation_control_guard_trigger BEFORE UPDATE OR DELETE
    ON search_generation_control FOR EACH ROW EXECUTE FUNCTION search_generation_control_guard()`);
  assert.equal(await pg.guardStates(), guards);
});

test('actual transaction rollback preserves rows and trigger state at each fault point', async t => {
  const pg = await cluster(t);
  const original = await pg.readRegistry(), guards = await pg.guardStates();
  process.env.STATION_WRITER_REGISTRY_FIXTURE_TEST = '1';
  try {
    for (const name of ['registry-revision', 'registry-candidate-uuid', 'create-dispatch-owner']) {
      for (const testFault of ['after-disable', 'after-update', 'before-commit']) {
        await assert.rejects(changeWriterPrepareRegistryFixture(name, 'mutate', original,
          { runSql: pg.sql, readRegistry: pg.readRegistry, testFault }));
        assert.deepEqual(await pg.readRegistry(), original);
        assert.equal(await pg.guardStates(), guards);
      }
      const altered = await changeWriterPrepareRegistryFixture(name, 'mutate', original,
        { runSql: pg.sql, readRegistry: pg.readRegistry });
      await assert.rejects(changeWriterPrepareRegistryFixture(name, 'restore', original,
        { runSql: pg.sql, readRegistry: pg.readRegistry, testFault: 'before-commit' }));
      assert.deepEqual(await pg.readRegistry(), altered);
      assert.equal(await pg.guardStates(), guards);
      await changeWriterPrepareRegistryFixture(name, 'restore', original,
        { runSql: pg.sql, readRegistry: pg.readRegistry });
    }
  } finally { delete process.env.STATION_WRITER_REGISTRY_FIXTURE_TEST; }
});
