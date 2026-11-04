import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { stageWriterRoleApplyOverride } from '../../scripts/search-writer-role-apply-override.mjs';

const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const suffix = invocationId.replaceAll('-', '');
const input = repository => ({ repository, uid: process.getuid(), gid: process.getgid(),
  invocationId, transferName: `station_writer_transfer_${suffix}`,
  applyName: `station_writer_apply_${suffix}`,
  transferCommand: ['node', 'scripts/search-writer-role-apply-transfer.mjs'],
  applyCommand: ['node', 'scripts/search-writer-role-consumer.mjs',
    ...Array(13).fill('fixed-approval')] });
async function fixture(t) {
  const root = await mkdtemp(path.resolve('.cache/results/writer-role-override-'));
  await mkdir(path.join(root, '.cache'), { mode: 0o700 });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

test('private override pins canonical bytes and original inode through owned cleanup', async t => {
  const root = await fixture(t);
  const item = await stageWriterRoleApplyOverride(input(root));
  const parsed = JSON.parse(await readFile(item.file, 'utf8'));
  assert.deepEqual(Object.keys(parsed), ['services']);
  assert.deepEqual(Object.keys(parsed.services).sort(),
    ['search-writer-role-apply', 'search-writer-role-apply-transfer']);
  assert.equal((await lstat(item.file)).mode & 0o777, 0o400);
  await item.recheck();
  await item.cleanup();
  await item.recheck();
  await assert.rejects(lstat(item.file), { code: 'ENOENT' });
  await mkdir(path.dirname(item.file), { mode: 0o700 });
  await assert.rejects(item.recheck());
  await assert.rejects(item.cleanup());
});

test('same-byte override inode replacement cannot authorize create or cleanup', async t => {
  const root = await fixture(t);
  const item = await stageWriterRoleApplyOverride(input(root));
  const before = await lstat(item.file), bytes = await readFile(item.file);
  await rename(item.file, path.join(root, 'moved-override'));
  await writeFile(item.file, bytes, { mode: 0o400 });
  assert.notEqual((await lstat(item.file)).ino, before.ino);
  await assert.rejects(item.recheck());
  await assert.rejects(item.cleanup());
  await assert.rejects(stageWriterRoleApplyOverride(input(root)));
});
