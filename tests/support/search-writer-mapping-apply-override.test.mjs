import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fixedWriterMappingApplyCommand } from
  '../../scripts/search-writer-mapping-apply-service-config.mjs';
import { stageWriterMappingApplyOverride } from
  '../../scripts/search-writer-mapping-apply-override.mjs';

const invocationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const suffix = invocationId.replaceAll('-', '');
const transferName = `station_mapping_apply_transfer_${suffix}`;
const applyName = `station_mapping_apply_${suffix}`;
const transferCommand = ['node', 'scripts/search-writer-mapping-apply-transfer.mjs'];
const applyCommand = fixedWriterMappingApplyCommand([
  'a'.repeat(64), '7', '22222222-2222-4222-8222-222222222222',
  'legacy-v1', 'station-mail-v1', 'legacy_uuid',
  '11111111-1111-4111-8111-111111111111',
  'station-mail-v2-g11111111111141118111111111111111', 'created_uuid',
  invocationId, 'mapping_apply_fixture', '16384', '123']);
async function fixture(t) {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.resolve('.cache/results/mapping-override-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await mkdir(path.join(repository, '.cache'), { mode: 0o700 });
  const input = { repository, uid: process.getuid(), gid: process.getgid(),
    invocationId, transferName, applyName, transferCommand, applyCommand };
  return { repository, input };
}

test('fixed mapping override pins original canonical bytes and checked absence', async t => {
  const { input } = await fixture(t);
  const override = await stageWriterMappingApplyOverride(input);
  const bytes = await readFile(override.file);
  assert.ok(bytes.length > 20);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')).services,
    { 'search-writer-mapping-apply-transfer': { command: transferCommand,
      container_name: transferName },
    'search-writer-mapping-apply': { command: applyCommand,
      container_name: applyName } });
  assert.equal(await override.recheck(), true);
  await override.cleanup();
  assert.equal(await override.recheck(), true);
  await assert.rejects(() => override.cleanup());
});

test('same-byte foreign replacement is not adopted or removed', async t => {
  const { input } = await fixture(t);
  const override = await stageWriterMappingApplyOverride(input);
  const original = `${override.file}.original`;
  await rename(override.file, original);
  await writeFile(override.file, await readFile(original), { mode: 0o400 });
  await assert.rejects(() => override.cleanup());
  assert.ok(Buffer.isBuffer(await readFile(override.file)));
});

test('successful root mkdir with failed first identity capture is never claimed owned', async t => {
  const { repository, input } = await fixture(t);
  const root = path.join(repository, '.cache/search-writer-mapping-apply-overrides', invocationId);
  const original = fs.promises.lstat;
  let reached = false;
  fs.promises.lstat = async (...args) => {
    if (args[0] === root && !reached) {
      reached = true;
      throw Object.assign(Error('private fixture fault'), { code: 'EIO' });
    }
    return original(...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(() => stageWriterMappingApplyOverride(input)); }
  finally { fs.promises.lstat = original; syncBuiltinESMExports(); }
  assert.equal(reached, true);
  assert.equal((await lstat(root)).isDirectory(), true);
});

test('cleanup preserves a same-name foreign root installed during directory sync', async t => {
  const { input } = await fixture(t);
  const override = await stageWriterMappingApplyOverride(input);
  const root = path.dirname(override.file);
  const originalOpen = fs.promises.open;
  let reached = false;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === root) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        if (!reached) {
          reached = true;
          await rename(root, `${root}.original`);
          await mkdir(root, { mode: 0o700 });
        }
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(() => override.cleanup()); }
  finally { fs.promises.open = originalOpen; syncBuiltinESMExports(); }
  assert.equal(reached, true);
  assert.equal((await lstat(root)).isDirectory(), true);
});

test('cleaned preexisting parent cannot rebase to a foreign cache inode', async t => {
  const { repository, input } = await fixture(t);
  const cache = path.join(repository, '.cache');
  const parent = path.join(cache, 'search-writer-mapping-apply-overrides');
  await mkdir(parent, { mode: 0o700 });
  const oldCache = await lstat(cache);
  const override = await stageWriterMappingApplyOverride(input);
  await override.cleanup();
  const originalRead = fs.promises.readdir;
  let reached = false;
  fs.promises.readdir = async (...args) => {
    const result = await originalRead(...args);
    if (args[0] === parent && !reached) {
      reached = true;
      await rename(cache, `${cache}.original`);
      await mkdir(cache, { mode: 0o700 });
      await rename(path.join(`${cache}.original`, path.basename(parent)), parent);
    }
    return result;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(() => override.recheck()); }
  finally { fs.promises.readdir = originalRead; syncBuiltinESMExports(); }
  assert.equal(reached, true);
  assert.notEqual((await lstat(cache)).ino, oldCache.ino);
});

test('CLI denies missing, malformed and wrong-UID inputs before Docker', () => {
  const valid = applyCommand.slice(2, 11);
  const malformed = [...valid]; malformed[0] = 'invalid';
  for (const [args, uidValue] of [
    [[], String(process.getuid())],
    [malformed, String(process.getuid())],
    [valid, String(process.getuid() + 1)],
  ]) {
    const result = spawnSync(process.execPath,
      [path.resolve('scripts/search-writer-mapping-apply-owner.mjs'), ...args],
      { env: { ...process.env, APP_UID: uidValue,
        APP_GID: String(process.getgid()) }, encoding: 'utf8', timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Private writer mapping apply owner failed.\n');
  }
});
