import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { parseWriterRoleConsumerArgs, initializeWriterRoleScratch,
  runFixedWriterRoleConsumer } from '../../scripts/search-writer-role-consumer-wrapper.mjs';

const args = [ 'a'.repeat(64), '7', '22222222-2222-4222-8222-222222222222',
  'legacy-v1', 'station-mail-v1', 'legacy_uuid',
  '11111111-1111-4111-8111-111111111111',
  'station-mail-v2-g11111111111141118111111111111111', 'created_uuid',
  '88888888-8888-4888-8888-888888888888', 'stationfixture', '16384', '123' ];

test('thirteen fixed nonsecret arguments pin database identity before I/O', async () => {
  const context = parseWriterRoleConsumerArgs(args);
  assert.deepEqual(context.databaseIdentity, { sessionUser: 'station_search_transition',
    currentUser: 'station_search_transition', database: 'station',
    databaseOwner: 'station', databaseOid: 16384 });
  let calls = 0;
  for (const bad of [args.slice(0, 12), [...args, 'extra'],
    args.map((x, i) => i === 9 ? 'bad' : x),
    args.map((x, i) => i === 11 ? '0' : x),
    args.map((x, i) => i === 12 ? '18446744073709551616' : x)]) {
    assert.throws(() => parseWriterRoleConsumerArgs(bad),
      { message: 'Private writer role apply failed.' });
  }
  const getter = [...args];
  Object.defineProperty(getter, '10', { get() { calls++; return 'wrong'; } });
  assert.throws(() => parseWriterRoleConsumerArgs(getter));
  assert.equal(calls, 0);
  const adapters = { openInput: () => { calls++; throw Error('private sentinel'); } };
  await assert.rejects(runFixedWriterRoleConsumer({ ...context,
    databaseIdentity: { ...context.databaseIdentity, databaseOid: 1 } }, adapters),
  { message: 'Private writer role apply failed.' });
  assert.equal(calls, 0);
  await assert.rejects(runFixedWriterRoleConsumer(context, adapters),
    { message: 'Private writer role apply failed.' });
  assert.equal(calls, 1);
});

test('fresh private scratch and symlink or loose-mode scratch fail closed', async t => {
  const base = await mkdtemp(path.resolve('.cache/results/writer-role-wrapper-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const parent = path.join(base, '.cache');
  const root = path.join(parent, 'scratch');
  await initializeWriterRoleScratch(root, process.getuid(), process.getgid());
  await chmod(root, 0o755);
  await assert.rejects(initializeWriterRoleScratch(root, process.getuid(), process.getgid()));
  await chmod(root, 0o700);
  await rm(root, { recursive: true });
  await mkdir(path.join(base, 'other'));
  await symlink(path.join(base, 'other'), root);
  await assert.rejects(initializeWriterRoleScratch(root, process.getuid(), process.getgid()));
});
