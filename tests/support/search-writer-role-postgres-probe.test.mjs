import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWriterRolePostgres, parseWriterRolePostgresProbe,
  writerRolePostgresInspectArgs } from './search-writer-role-postgres-probe.mjs';

const id = 'a'.repeat(64);
const project = 'stationcreatedefault123456789abc';
const safe = { Id: id, Created: '2026-11-04T12:34:56.123456789Z', AdminIP: '172.20.0.2' };

test('fixed inspect CLI requests only identity, creation time, and admin IP', async () => {
  const expected = writerRolePostgresInspectArgs(id, project);
  assert.deepEqual(expected.slice(0, 3), ['container', 'inspect', '--format']);
  assert.equal(expected[4], id);
  assert.ok(expected[3].includes(`${project}_search_admin_db`));
  assert.equal((expected[3].match(/{{json /g) ?? []).length, 3);
  assert.ok(expected[3].includes('{{json .Id}}'));
  assert.ok(expected[3].includes('{{json .Created}}'));
  assert.ok(expected[3].includes('{{json .IPAddress}}'));
  assert.equal(expected[3].includes('.Config'), false);
  assert.equal(expected[3].includes('.Env'), false);
  let calls = 0;
  const value = await inspectWriterRolePostgres(async args => {
    calls++;
    assert.deepEqual(args, expected);
    return `${JSON.stringify(safe)}\n`;
  }, id, project);
  assert.equal(calls, 1);
  assert.deepEqual(value, { id, created: safe.Created, adminIp: safe.AdminIP });
  assert.equal(Object.isFrozen(value), true);
});

test('hostile or full inspect output cannot pass the exact projection parser', () => {
  const marker = 'fixture-password-1234567890';
  const fullInspect = JSON.stringify({ ...safe, Config: { Env: [`POSTGRES_PASSWORD=${marker}`] } });
  const sameSecretGuard = stdout => assert.equal(stdout.includes(marker), false);
  assert.throws(() => sameSecretGuard(fullInspect));
  sameSecretGuard(JSON.stringify(safe));
  assert.deepEqual(parseWriterRolePostgresProbe(JSON.stringify(safe), id),
    { id, created: safe.Created, adminIp: safe.AdminIP });
  const bad = [
    JSON.parse(fullInspect),
    { ...safe, Id: 'b'.repeat(64) },
    { ...safe, AdminIP: '999.20.0.2' },
    { ...safe, AdminIP: null },
    { ...safe, Created: '' },
  ];
  for (const value of bad) assert.throws(() => parseWriterRolePostgresProbe(JSON.stringify(value), id));
  assert.throws(() => parseWriterRolePostgresProbe(JSON.stringify([safe]), id));
  assert.throws(() => parseWriterRolePostgresProbe(`${JSON.stringify(safe)}\nprivate`, id));
  assert.throws(() => writerRolePostgresInspectArgs(id, `${project}"}}`));
});
