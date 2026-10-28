import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm,
  writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { prepareCreateIntentPending, writeCreateIntentPending } from
  '../../scripts/search-create-intent-pending.mjs';

test('fixed pending file is exclusive, mode 0400, byte bound and replacement denied', async t => {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.join(process.cwd(), '.cache/results/intent-pending-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await mkdir(path.join(repository, '.cache'), { mode: 0o755 });
  const uid = process.getuid(), gid = process.getgid();
  const prepared = await prepareCreateIntentPending(repository, uid, gid);
  const intent = { version: 1, project: 'fixture', token: 'public-only' };
  const bytes = canonicalAttestorValue(intent).bytes;
  const sha = createHash('sha256').update(bytes).digest('hex');
  const saved = await writeCreateIntentPending(prepared, intent, sha, uid, gid);
  assert.equal(saved.sha256, sha);
  assert.deepEqual(await readFile(prepared.name), bytes);
  assert.equal((await lstat(prepared.name)).mode & 0o777, 0o400);
  await saved.recheck();
  await assert.rejects(() => prepareCreateIntentPending(repository, uid, gid));
  await assert.rejects(() => writeCreateIntentPending(prepared, intent, sha, uid, gid));
  const extra = path.join(prepared.root, 'unexpected');
  await writeFile(extra, 'fixture');
  await assert.rejects(() => saved.recheck());
  await rm(extra);
  await rename(prepared.name, `${prepared.name}.moved`);
  await writeFile(prepared.name, bytes, { mode: 0o400 });
  await assert.rejects(() => saved.recheck());
  await rm(prepared.name);
  await rename(`${prepared.name}.moved`, prepared.name);
  await chmod(prepared.name, 0o600);
  const handle = await open(prepared.name, 'r+');
  try { await handle.write(Buffer.from('X'), 0, 1, 0); await handle.sync(); }
  finally { await handle.close(); }
  await chmod(prepared.name, 0o400);
  await assert.rejects(() => saved.recheck());
});

test('post-write inode is captured from handle and cannot adopt same-byte replacement before directory fsync', async t => {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.join(process.cwd(), '.cache/results/intent-pending-race-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await mkdir(path.join(repository, '.cache'), { mode: 0o755 });
  const uid = process.getuid(), gid = process.getgid();
  const prepared = await prepareCreateIntentPending(repository, uid, gid);
  const intent = { version: 1, project: 'fixture' };
  const sha = createHash('sha256').update(canonicalAttestorValue(intent).bytes).digest('hex');
  process.env.STATION_INTENT_PENDING_FIXTURE = '1';
  try {
    await assert.rejects(() => writeCreateIntentPending(prepared, intent, sha, uid, gid, {
      afterFileClose: async name => {
        const moved = path.join(repository, '.cache/original-pending');
        await rename(name, moved);
        await copyFile(moved, name);
      },
    }), { message: 'Private create intent pending file failed.' });
  } finally { delete process.env.STATION_INTENT_PENDING_FIXTURE; }
});
