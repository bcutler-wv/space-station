import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm,
  writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { buildAttestorPublicFiles } from '../../scripts/search-attestor-pure.mjs';
import { stageCreateApplyPublic } from '../../scripts/search-create-apply-public-stage.mjs';

const uid = process.getuid(), gid = process.getgid();
const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  await mkdir('.cache/results', { recursive: true });
  const repository = await mkdtemp(path.join(process.cwd(), '.cache/results/apply-public-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.resolve('scripts/init-search-security.mjs')],
    { cwd: repository, stdio: 'ignore', timeout: 30_000 });
  await mkdir(path.join(repository, '.cache/search-create-intent'), { mode: 0o700 });
  const files = buildAttestorPublicFiles({ generations: [{ token: 'legacy-v1', presence: 'exact' }] });
  const source = name => path.join(repository, '.cache/search-security',
    name === 'ca.pem' ? name : path.basename(name));
  const publicDigests = [];
  for (const row of files) publicDigests.push({ path: row.path,
    sha256: sha(await readFile(source(row.path))) });
  return { repository, files, publicDigests, source };
}
const stage = f => stageCreateApplyPublic({ repository: f.repository, uid, gid,
  invocationId, files: f.files, publicDigests: f.publicDigests });

test('stages exact real prior PEM bytes, preserves original sources and removes only owned tree', async t => {
  const f = await fixture(t);
  const staged = await stage(f);
  assert.equal(await staged.recheck(), true);
  assert.equal((await readdir(staged.root)).sort().join('|'), 'ca.pem|v1');
  assert.equal((await lstat(staged.root)).mode & 0o777, 0o700);
  for (const row of f.files) {
    const name = path.join(staged.root, row.path);
    assert.equal((await lstat(name)).mode & 0o777, 0o400);
    assert.deepEqual(await readFile(name), await readFile(f.source(row.path)));
  }
  assert.equal(await staged.cleanup(), true);
  await assert.rejects(lstat(staged.root));
  assert.equal(await staged.recheckSource(), true);
  await assert.rejects(staged.cleanup());
});

test('source, staged inode, extra file and partial staging faults fail closed', async t => {
  const sourceDrift = await fixture(t);
  const first = await stage(sourceDrift);
  const original = sourceDrift.source('v1/admin.pem');
  const bytes = await readFile(original);
  await writeFile(`${original}.replacement`, bytes, { mode: 0o600 });
  await rename(`${original}.replacement`, original);
  await assert.rejects(first.recheck());
  await assert.rejects(first.cleanup());

  const outputDrift = await fixture(t);
  const second = await stage(outputDrift);
  const stagedPem = path.join(second.root, 'ca.pem');
  await copyFile(stagedPem, `${stagedPem}.replacement`);
  await chmod(`${stagedPem}.replacement`, 0o400);
  await rename(`${stagedPem}.replacement`, stagedPem);
  await assert.rejects(second.recheck());
  await assert.rejects(second.cleanup());

  const extra = await fixture(t);
  const third = await stage(extra);
  await writeFile(path.join(third.root, 'ca.key'), 'forbidden', { mode: 0o400 });
  await assert.rejects(third.recheck());
  await assert.rejects(third.cleanup());

  const partial = await fixture(t);
  process.env.STATION_CREATE_APPLY_FIXTURE = '1';
  try {
    await assert.rejects(stageCreateApplyPublic({ repository: partial.repository, uid, gid,
      invocationId, files: partial.files, publicDigests: partial.publicDigests },
    { beforeWrite: name => { if (name === 'v1/admin.pem') throw Error('partial'); } }));
  } finally { delete process.env.STATION_CREATE_APPLY_FIXTURE; }
  await assert.rejects(stage(partial));
});
