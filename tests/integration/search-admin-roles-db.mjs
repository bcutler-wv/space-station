import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { URL } from 'node:url';
import { advanceSearchGeneration, armSearchGenerationDispatch, enrollLegacySearchGeneration,
  readSearchAdminPassword, readSearchAdminSnapshot, recheckSearchAdminSnapshot,
  recordSearchGenerationCertEvidence, updateSearchGenerationDispatch,
  reserveSearchGeneration, searchGenerationDispatchSpec, SearchAdminDatabaseError,
  withSearchAdminDatabase } from '../../packages/db/dist/index.js';

const { Client } = createRequire(new URL('../../packages/db/package.json', import.meta.url))('pg');
const root = process.env.SEARCH_ADMIN_TEST_SECRET_ROOT;
const host = process.env.SEARCH_ADMIN_TEST_HOST;
const port = Number(process.env.SEARCH_ADMIN_TEST_PORT ?? '5432');
assert.ok(root?.startsWith('/') && (host === 'postgres' || host === '127.0.0.1'));
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
const options = role => ({ role: `station_search_${role}`, host, port, database: 'station',
  passwordFile: `${root}/${role}.password` });
const owner = new Client({ user: 'station', host: process.env.SEARCH_ADMIN_TEST_OWNER_HOST ?? host,
  port, database: 'station', password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: 3_000, query_timeout: 5_000, statement_timeout: 3_000, lock_timeout: 750 });
const passwords = {};
const clients = [];
let phase = 'secret validation', scratch, failure = null;
const openRole = async role => {
  const client = new Client({ user: `station_search_${role}`, password: passwords[role], host, port,
    database: 'station', connectionTimeoutMillis: 3_000, query_timeout: 5_000,
    statement_timeout: 3_000, lock_timeout: 750, idle_in_transaction_session_timeout: 3_000 });
  await client.connect(); clients.push(client); return client;
};
const denied = async (client, statement, label, code = '42501') => {
  await assert.rejects(client.query(statement), error => error.code === code,
    `${label}: exact authorization SQLSTATE`);
};
const expected = row => ({ revision: row.revision, stage: row.stage,
  transitionToken: row.transitionToken, sourceGenerationToken: row.sourceGenerationToken,
  generationToken: row.generationToken, physicalIndex: row.physicalIndex,
  indexUuid: row.indexUuid, profileId: row.profileId });
const tx = (db, action) => db.transaction(action);
const transitionTx = action => withSearchAdminDatabase(options('transition'), db => tx(db, action));

try {
  passwords.verifier = await readSearchAdminPassword(options('verifier').passwordFile);
  passwords.transition = await readSearchAdminPassword(options('transition').passwordFile);
  scratch = await mkdtemp(`${process.cwd()}/.cache/results/search-admin-secret-probe-`);
  const good = `${scratch}/good`, link = `${scratch}/link`;
  await writeFile(good, passwords.verifier, { mode: 0o600 });
  assert.ok((await readSearchAdminPassword(good)) === passwords.verifier, 'Secret readback mismatch');
  await symlink(good, link);
  await assert.rejects(readSearchAdminPassword(link), error => error.kind === 'secret');
  await chmod(good, 0o644);
  await assert.rejects(readSearchAdminPassword(good), error => error.kind === 'secret');
  await chmod(good, 0o600);
  await writeFile(good, 'invalid');
  await assert.rejects(readSearchAdminPassword(good), error => error.kind === 'secret');
  await writeFile(good, 'a'.repeat(4097));
  await assert.rejects(readSearchAdminPassword(good), error => error.kind === 'secret');
  await assert.rejects(readSearchAdminPassword(`${scratch}/absent`), error => error.kind === 'secret');
  const fifo = `${scratch}/fifo`;
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const fifoStart = performance.now();
  await assert.rejects(readSearchAdminPassword(fifo), error => error.kind === 'secret');
  assert.ok(performance.now() - fifoStart < 1_000, 'FIFO without writer rejected without blocking');
  await assert.rejects(withSearchAdminDatabase({ ...options('verifier'), host: 'other' }, async () => {}),
    error => error.kind === 'configuration');
  const start = performance.now();
  await assert.rejects(withSearchAdminDatabase({ ...options('verifier'), port: 1 }, async () => {}),
    error => error.kind === 'connect');
  assert.ok(performance.now() - start < 5_000, 'connection failure bounded');

  phase = 'actual restricted SCRAM login';
  const verifier = await openRole('verifier'), transition = await openRole('transition');
  for (const [role, client] of [['verifier', verifier], ['transition', transition]]) {
    const login = await client.query('select session_user, current_user');
    assert.equal(login.rows[0].session_user, `station_search_${role}`);
    assert.equal(login.rows[0].current_user, `station_search_${role}`);
  }
  const wrong = new Client({ user: 'station_search_verifier', password: 'A'.repeat(43), host, port,
    database: 'station', connectionTimeoutMillis: 3_000 });
  try { await assert.rejects(wrong.connect(), error => error.code === '28P01', 'wrong SCRAM password denied'); }
  finally { await wrong.end().catch(() => {}); }

  phase = 'retained policy and hostile grants';
  await owner.connect();
  const apply = await readFile(new URL('../../ops/postgres/search-admin-roles-apply.sql', import.meta.url), 'utf8');
  const audit = await readFile(new URL('../../ops/postgres/search-admin-roles-audit.sql', import.meta.url), 'utf8');
  const policy = `BEGIN; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '750ms';\n${apply}\n${audit}\nCOMMIT;`;
  const auditOnly = `BEGIN READ ONLY; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '750ms';\n${audit}\nCOMMIT;`;
  await owner.query(policy);
  await owner.query(auditOnly);
  const rejectPolicy = async expression => {
    await assert.rejects(owner.query(policy), error => expression.test(error.message),
      'owner policy rejects preexisting dangerous state');
    await owner.query('rollback');
  };
  await owner.query('grant select on accounts to station_search_verifier');
  try { await rejectPolicy(/unexpected search admin source access/); }
  finally { await owner.query('revoke select on accounts from station_search_verifier'); }
  await owner.query('grant select on pg_catalog.pg_authid to public');
  try { await rejectPolicy(/search admin credential catalog access/); }
  finally { await owner.query('revoke select on pg_catalog.pg_authid from public'); }
  await owner.query('grant select (rolpassword) on pg_catalog.pg_authid to public');
  try { await rejectPolicy(/search admin credential catalog column access/); }
  finally { await owner.query('revoke select (rolpassword) on pg_catalog.pg_authid from public'); }
  await owner.query('grant references (singleton) on search_generation_control to station_search_verifier');
  try { await rejectPolicy(/unexpected search admin column authority/); }
  finally { await owner.query('revoke references (singleton) on search_generation_control from station_search_verifier'); }
  await owner.query('alter default privileges in schema public grant select on tables to station_search_verifier');
  try { await rejectPolicy(/future-object default grants/); }
  finally { await owner.query('alter default privileges in schema public revoke select on tables from station_search_verifier'); }
  await owner.query("create function public.search_admin_intrusion() returns integer language sql security definer as 'select 1'");
  try { await rejectPolicy(/custom security-definer routine/); }
  finally { await owner.query('drop function public.search_admin_intrusion()'); }
  await owner.query('alter role station_search_verifier createdb');
  try { await rejectPolicy(/unsafe preexisting search admin role/); }
  finally { await owner.query('alter role station_search_verifier nocreatedb'); }
  await owner.query(policy);

  phase = 'effective least privilege';
  const initial = await withSearchAdminDatabase(options('verifier'), readSearchAdminSnapshot);
  assert.equal(initial.control.stage, 'disabled');
  assert.equal(initial.control.publicationEnabled, false);
  assert.equal(initial.control.servingReady, false);
  assert.deepEqual(initial.manifest, []);
  await denied(verifier, 'update search_generation_control set revision=revision+1', 'verifier update');
  await verifier.query('begin');
  try { await denied(verifier, 'select * from search_generation_control for share', 'verifier row lock'); }
  finally { await verifier.query('rollback'); }
  for (const client of [verifier, transition]) {
    for (const [statement, label] of [
      ['select * from accounts limit 1', 'account source'],
      ['select * from auth_credentials limit 1', 'credential source'],
      ['select rolpassword from pg_catalog.pg_authid limit 1', 'credential catalog'],
      ['select passwd from pg_catalog.pg_shadow limit 1', 'password catalog view'],
      ['select subconninfo from pg_catalog.pg_subscription limit 1', 'subscription credential catalog'],
      ['select umoptions from pg_catalog.pg_user_mapping limit 1', 'user mapping credential catalog'],
      ['select * from search_documents limit 1', 'search ledger'],
      ['insert into search_generation_control (singleton) values (2)', 'control insert'],
      ['update search_generation_control set serving_ready=true', 'enable serving'],
      ['update search_generation_control set publication_enabled=true', 'enable publication'],
      ['delete from search_generation_history', 'history delete'],
      ['truncate search_generation_dispatch', 'dispatch truncate'],
      ['create table public.search_admin_intrusion(id integer)', 'schema create'],
      ['create temp table search_admin_intrusion(id integer)', 'temporary create'],
      ['create schema search_admin_intrusion', 'database create'],
      ['alter table search_generation_control disable trigger all', 'trigger disable'],
      ['create role search_admin_intrusion', 'role create'],
      ['alter role station superuser', 'role takeover'],
      ['set role station', 'role membership'],
    ]) await denied(client, statement, label);
  }
  await denied(transition, "update search_generation_history set physical_index='wrong'", 'immutable history update');
  await denied(transition, 'update search_generation_dispatch set owner_id=owner_id', 'immutable dispatch update');
  await denied(transition, 'insert into search_generation_history (created_at) values (now())', 'timestamp insert');

  phase = 'allowed transition helpers';
  let row = await withSearchAdminDatabase(options('transition'), db =>
    tx(db, trx => enrollLegacySearchGeneration(trx, expected(initial.control), 'fixtureLegacyUuid')));
  assert.equal(row.sourceGenerationToken, 'legacy-v1');
  assert.equal(await withSearchAdminDatabase(options('verifier'), db =>
    recheckSearchAdminSnapshot(db, initial)), false, 'verifier recheck sees change');
  const candidate = { transitionToken: randomUUID(), generationToken: randomUUID(),
    physicalIndex: `station-mail-v2-g${randomUUID().replaceAll('-', '')}` };
  row = await withSearchAdminDatabase(options('transition'), db =>
    tx(db, trx => reserveSearchGeneration(trx, expected(row), candidate)));
  row = await withSearchAdminDatabase(options('transition'), db =>
    tx(db, trx => advanceSearchGeneration(trx, expected(row), 'create_requested')));
  const snapshot = await withSearchAdminDatabase(options('verifier'), readSearchAdminSnapshot);
  assert.equal(snapshot.control.stage, 'create_requested');
  assert.equal(snapshot.manifest.length, 2);
  assert.equal(await withSearchAdminDatabase(options('verifier'), db =>
    recheckSearchAdminSnapshot(db, snapshot)), true);
  const reservation = snapshot.manifest.find(item => item.token === candidate.generationToken);
  assert.equal(reservation.presence, 'absent');
  const bodyIdentity = searchGenerationDispatchSpec({ generationToken: reservation.token,
    physicalIndex: reservation.index, profileId: reservation.profile,
    indexUuid: null, lifecycle: 'reserved', writerRole: reservation.writerRole,
    queryRole: reservation.queryRole, writerPrincipal: reservation.writerPrincipal,
    queryPrincipal: reservation.queryPrincipal, writerCertFingerprint: null,
    queryCertFingerprint: null }, 'create_index');
  const dispatch = { operation: 'create_index', dispatchId: randomUUID(), ownerId: randomUUID(),
    ...bodyIdentity };
  row = await withSearchAdminDatabase(options('transition'), db =>
    tx(db, trx => armSearchGenerationDispatch(trx, expected(row), dispatch)));
  assert.equal(row.revision, snapshot.control.revision + 1);
  assert.equal((await withSearchAdminDatabase(options('verifier'), readSearchAdminSnapshot)).dispatch.length, 1);

  phase = 'lock timeout and rollback';
  await owner.query('begin');
  await owner.query('select * from search_generation_control for update');
  const before = performance.now();
  try {
    await assert.rejects(withSearchAdminDatabase(options('transition'), db =>
      tx(db, trx => advanceSearchGeneration(trx, expected(row), 'uuid_bound', 'fixtureUuid'))),
    error => error instanceof SearchAdminDatabaseError && error.kind === 'query');
    assert.ok(performance.now() - before < 2_500, 'lock wait bounded');
  } finally { await owner.query('rollback'); }
  assert.equal((await withSearchAdminDatabase(options('verifier'), readSearchAdminSnapshot)).control.revision,
    row.revision, 'timed-out transition did not mutate control');

  phase = 'complete restricted transition';
  const completeDispatch = async (current, input) => {
    let next = await transitionTx(trx => updateSearchGenerationDispatch(trx, expected(current),
      { operation: input.operation, dispatchId: input.dispatchId, ownerId: input.ownerId,
        state: 'sent_unknown' }));
    next = await transitionTx(trx => updateSearchGenerationDispatch(trx, expected(next),
      { operation: input.operation, dispatchId: input.dispatchId, ownerId: input.ownerId,
        state: 'response_confirmed' }));
    return next;
  };
  row = await completeDispatch(row, dispatch);
  row = await transitionTx(trx => advanceSearchGeneration(trx, expected(row), 'uuid_bound', 'fixtureUuid'));
  row = await transitionTx(trx => recordSearchGenerationCertEvidence(trx, expected(row),
    { writer: 'a'.repeat(64), query: 'b'.repeat(64) }));
  for (const [requested, operation, completed] of [
    ['writer_role_requested', 'writer_role', 'writer_role_attested'],
    ['writer_mapping_requested', 'writer_mapping', 'writer_attested'],
    ['query_role_requested', 'query_role', 'query_role_attested'],
    ['query_mapping_requested', 'query_mapping', 'roles_attested'],
  ]) {
    row = await transitionTx(trx => advanceSearchGeneration(trx, expected(row), requested));
    const current = await withSearchAdminDatabase(options('verifier'), readSearchAdminSnapshot);
    const candidateManifest = current.manifest.find(item => item.token === candidate.generationToken);
    assert.ok(candidateManifest?.uuid, 'Bound candidate remains in verifier manifest');
    const spec = searchGenerationDispatchSpec({
      generationToken: candidateManifest.token, physicalIndex: candidateManifest.index,
      profileId: candidateManifest.profile, indexUuid: candidateManifest.uuid,
      lifecycle: 'bound', writerRole: candidateManifest.writerRole,
      queryRole: candidateManifest.queryRole, writerPrincipal: candidateManifest.writerPrincipal,
      queryPrincipal: candidateManifest.queryPrincipal,
      writerCertFingerprint: candidateManifest.writerCertFingerprint,
      queryCertFingerprint: candidateManifest.queryCertFingerprint,
    }, operation);
    const input = { operation, dispatchId: randomUUID(), ownerId: randomUUID(), ...spec };
    row = await transitionTx(trx => armSearchGenerationDispatch(trx, expected(row), input));
    row = await completeDispatch(row, input);
    row = await transitionTx(trx => advanceSearchGeneration(trx, expected(row), completed));
    assert.equal(row.stage, completed);
    assert.equal(row.publicationEnabled, false);
    assert.equal(row.servingReady, false);
  }
  const attested = await withSearchAdminDatabase(options('verifier'), readSearchAdminSnapshot);
  assert.equal(attested.control.stage, 'roles_attested');
  assert.equal(attested.control.indexUuid, 'fixtureUuid');
  assert.equal(attested.dispatch.length, 5);
  assert.ok(attested.dispatch.every(item => item.state === 'response_confirmed'));
  const attestedCandidate = attested.manifest.find(item => item.token === candidate.generationToken);
  assert.equal(attestedCandidate?.presence, 'required');
  assert.equal(attestedCandidate?.writerCertFingerprint, 'a'.repeat(64));
  assert.equal(attestedCandidate?.queryCertFingerprint, 'b'.repeat(64));

  phase = 'connection loss';
  const lossStart = performance.now();
  await assert.rejects(withSearchAdminDatabase(options('verifier'), async db => {
    const backend = await db.execute('select pg_backend_pid() as pid');
    const stopped = await owner.query('select pg_terminate_backend($1) as stopped', [backend.rows[0].pid]);
    assert.equal(stopped.rows[0].stopped, true);
    await db.execute('select 1');
  }), error => error instanceof SearchAdminDatabaseError && error.kind === 'query');
  assert.ok(performance.now() - lossStart < 5_000, 'connection loss settled without waiting for pool idle');

  phase = 'own password semantics';
  // PostgreSQL permits an ordinary LOGIN role to alter its own password.
  // Demonstrate it by disabling only the disposable verifier's future logins.
  await verifier.query('alter role station_search_verifier password null');
  const disabled = new Client({ user: 'station_search_verifier', password: passwords.verifier, host, port,
    database: 'station', connectionTimeoutMillis: 3_000 });
  try { await assert.rejects(disabled.connect(), error => error.code === '28P01'); }
  finally { await disabled.end().catch(() => {}); }
  console.info('Restricted SCRAM roles, exact grants, bounded snapshot, transition and denial matrix passed.');
} catch (error) {
  failure = `${phase}/${error instanceof SearchAdminDatabaseError ? error.kind : 'assertion'}`;
} finally {
  for (const client of clients) await client.end().catch(() => { failure ??= 'cleanup/client'; });
  await owner.end().catch(() => {});
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => { failure ??= 'cleanup/files'; });
}
if (failure) { console.error(`Restricted search admin fixture failed: ${failure}.`); process.exitCode = 1; }
