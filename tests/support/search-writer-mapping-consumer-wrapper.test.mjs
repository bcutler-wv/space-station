import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { initializeWriterMappingScratch, parseWriterMappingConsumerArgs } from
  '../../scripts/search-writer-mapping-consumer-wrapper.mjs';

const approval = ['a'.repeat(64), '7', '22222222-2222-4222-8222-222222222222',
  'legacy-v1', 'station-mail-v1', 'legacy_uuid',
  '11111111-1111-4111-8111-111111111111',
  'station-mail-v2-g11111111111141118111111111111111', 'created_uuid'];
const args = [...approval, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'mapping_apply_fixture', '16384', '123'];

test('thirteen independent fixed command fields reject malformed or accessor values', () => {
  const context = parseWriterMappingConsumerArgs(args);
  assert.equal(context.databaseIdentity.databaseOid, 16384);
  assert.equal(context.databaseIdentity.sessionUser, 'station_search_transition');
  for (const bad of [args.slice(0, 12), [...args, 'extra'],
    args.map((value, i) => i === 9 ? 'wrong' : value),
    args.map((value, i) => i === 11 ? '0' : value),
    args.map((value, i) => i === 12 ? '18446744073709551616' : value)])
    assert.throws(() => parseWriterMappingConsumerArgs(bad),
      { message: 'Private writer mapping apply failed.' });
  let reads = 0;
  const hostile = [...args];
  Object.defineProperty(hostile, '10', { enumerable: true,
    get() { reads++; return 'wrong'; } });
  assert.throws(() => parseWriterMappingConsumerArgs(hostile));
  assert.equal(reads, 0);
});

test('fixed scratch rejects fixture path without marker before I/O', async t => {
  const base = await mkdtemp(path.resolve('.cache/results/mapping-wrapper-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, '.cache/scratch');
  const original = fs.promises.mkdir;
  let calls = 0;
  try {
    fs.promises.mkdir = (...input) => { calls++; return original(...input); };
    syncBuiltinESMExports();
    await assert.rejects(initializeWriterMappingScratch(root, process.getuid(),
      process.getgid(), {}));
    assert.equal(calls, 0);
  } finally { fs.promises.mkdir = original; syncBuiltinESMExports(); }
  process.env.STATION_WRITER_MAPPING_APPLY_FIXTURE = '1';
  t.after(() => { delete process.env.STATION_WRITER_MAPPING_APPLY_FIXTURE; });
  await initializeWriterMappingScratch(root, process.getuid(), process.getgid(), {});
});

test('scratch parent replacement during child mkdir cannot be adopted', async t => {
  const base = await mkdtemp(path.resolve('.cache/results/mapping-wrapper-parent-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, '.cache/scratch');
  const parent = path.dirname(root), moved = `${parent}-old`;
  process.env.STATION_WRITER_MAPPING_APPLY_FIXTURE = '1';
  t.after(() => { delete process.env.STATION_WRITER_MAPPING_APPLY_FIXTURE; });
  const original = fs.promises.mkdir;
  let reached = false;
  try {
    fs.promises.mkdir = async (...input) => {
      const result = await original(...input);
      if (input[0] === root) {
        reached = true;
        await rename(parent, moved);
        await original(parent, { mode: 0o700 });
        await rename(path.join(moved, 'scratch'), root);
      }
      return result;
    };
    syncBuiltinESMExports();
    await assert.rejects(initializeWriterMappingScratch(root, process.getuid(),
      process.getgid(), {}));
    assert.equal(reached, true);
  } finally { fs.promises.mkdir = original; syncBuiltinESMExports(); }
});

test('scratch child replacement during trailing parent check cannot be adopted', async t => {
  const base = await mkdtemp(path.resolve('.cache/results/mapping-wrapper-child-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, '.cache/scratch'), parent = path.dirname(root);
  process.env.STATION_WRITER_MAPPING_APPLY_FIXTURE = '1';
  t.after(() => { delete process.env.STATION_WRITER_MAPPING_APPLY_FIXTURE; });
  const original = fs.promises.lstat;
  let parentReads = 0, reached = false;
  try {
    fs.promises.lstat = async (...input) => {
      if (input[0] === parent && ++parentReads === 2) {
        reached = true;
        await rename(root, `${root}-old`);
        await fs.promises.mkdir(root, { mode: 0o700 });
      }
      return original(...input);
    };
    syncBuiltinESMExports();
    await assert.rejects(initializeWriterMappingScratch(root, process.getuid(),
      process.getgid(), {}));
    assert.equal(reached, true);
  } finally { fs.promises.lstat = original; syncBuiltinESMExports(); }
});
