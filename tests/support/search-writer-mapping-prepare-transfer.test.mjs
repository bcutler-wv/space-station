import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import fsPromises, { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rename,
  rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { ensureSearchGenerationIdentity } from '../../scripts/search-generation-identity.mjs';
import { transferWriterMappingPrepareInputs } from
  '../../scripts/search-writer-mapping-prepare-transfer-core.mjs';
import { openWriterMappingPrepareInput } from
  '../../scripts/search-writer-mapping-prepare-reader.mjs';
import { fixture as mappingFixture } from './search-writer-mapping-intent-pure.test.mjs';

const token = '11111111-1111-4111-8111-111111111111';
const suffix = token.replaceAll('-', '');
const canonical = value => canonicalAttestorValue(value, 256 * 1024).bytes;
const options = { fixture: true, creatorUid: process.getuid(), targetUid: process.getuid() };
const denied = fn => assert.rejects(fn,
  { message: 'Private writer mapping preparation transfer failed.' });

async function setup(t, variant = {}) {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/results/writer-mapping-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.resolve('scripts/init-search-security.mjs')],
    { cwd: root, stdio: 'ignore', timeout: 30_000 });
  const security = path.join(root, '.cache/search-security');
  const generations = path.join(root, '.cache/search-generations');
  const signer = await ensureSearchGenerationIdentity(token,
    { v1Root: security, outputRoot: generations });
  const ca = await readFile(path.join(security, 'ca.pem'));
  const writer = await readFile(path.join(generations, suffix, 'writer.pem'));
  const f = mappingFixture({ ...variant, caPem: ca, writerPem: writer });
  const publicRoot = path.join(root, 'stage');
  const candidate = path.join(publicRoot, 'generations', suffix);
  const volumeRoot = path.join(root, '.cache/results/volume');
  const scratch = path.join(root, '.cache/results/private/scratch');
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  await mkdir(volumeRoot, { recursive: true, mode: 0o755 });
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  await writeFile(path.join(publicRoot, 'ca.pem'), ca, { mode: 0o400 });
  await writeFile(path.join(candidate, 'writer.pem'), writer, { mode: 0o400 });
  const invocation = { version: 1, project: f.roleEvidence.intent.project,
    databaseOid: f.roleEvidence.intent.databaseOid,
    systemIdentifier: f.roleEvidence.intent.systemIdentifier,
    invocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    dispatchId: f.sealed.intent.dispatchId, ownerId: f.sealed.intent.ownerId,
    createApprovedSha256: f.createEvidence.approvedSha256,
    roleApprovedSha256: f.roleEvidence.approvedSha256, signerResult: signer };
  const names = {
    createIntentFile: ['create-intent.json', canonical(f.createEvidence.intent)],
    createBindingFile: ['create-binding.json', canonical(f.createEvidence.binding)],
    roleIntentFile: ['role-intent.json', canonical(f.roleEvidence.intent)],
    roleBindingFile: ['role-binding.json', canonical(f.roleEvidence.binding)],
    invocationFile: ['invocation.json', canonical(invocation)],
    passwordFile: ['password', Buffer.from(Buffer.alloc(32, 7).toString('base64url'))],
  };
  const paths = { publicRoot, volumeRoot };
  for (const [key, [leaf, bytes]] of Object.entries(names)) {
    const parent = path.join(root, key);
    await mkdir(parent, { mode: 0o755 });
    paths[key] = path.join(parent, leaf);
    await writeFile(paths[key], bytes, { mode: key === 'passwordFile' ? 0o600 : 0o400 });
  }
  return { root, paths, f, ca, writer, invocation, scratch, candidate };
}

test('networkless transfer copies exact public-only legacy and retained evidence',
  { timeout: 90_000 }, async t => {
    process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE = '1';
    for (const variant of [{}, { retainedSource: true, absent: true }]) {
      const f = await setup(t, variant);
      const result = await transferWriterMappingPrepareInputs(f.paths, options);
      assert.equal(result.invocationId, f.invocation.invocationId);
      assert.deepEqual((await readdir(f.paths.volumeRoot)).sort(), [
        'create-binding.json', 'create-intent.json', 'invocation.json', 'public',
        'role-binding.json', 'role-intent.json', 'transition.password']);
      assert.deepEqual((await readdir(path.join(f.paths.volumeRoot, 'public'))).sort(),
        ['ca.pem', 'generations']);
      assert.deepEqual(await readdir(path.join(f.paths.volumeRoot,
        'public/generations', suffix)), ['writer.pem']);
      assert.deepEqual(await readFile(path.join(f.paths.volumeRoot, 'public/ca.pem')), f.ca);
      assert.deepEqual(await readFile(path.join(f.paths.volumeRoot,
        'public/generations', suffix, 'writer.pem')), f.writer);
      const opened = await openWriterMappingPrepareInput(f.paths.volumeRoot, f.scratch,
        { uid: process.getuid(), gid: process.getgid() });
      assert.equal(await opened.recheckInput(), true);
      await denied(() => transferWriterMappingPrepareInputs(f.paths, options));
    }
  });

test('source, parent, destination inode and inventory changes reject at reached fences',
  { timeout: 90_000 }, async t => {
  for (const kind of ['source', 'parent', 'output', 'directory', 'extra',
      'bad-sha', 'link', 'mode', 'symlink']) {
      const f = await setup(t);
      let reached = false;
      const beforeSync = async relative => {
        if (relative !== 'create-intent.json' || reached) return;
        reached = true;
        if (kind === 'source') {
          const old = path.join(f.root, 'old-intent');
          await rename(f.paths.createIntentFile, old);
          await copyFile(old, f.paths.createIntentFile);
          await chmod(f.paths.createIntentFile, 0o400);
        } else if (kind === 'parent') {
          const parent = path.dirname(f.paths.roleIntentFile);
          const old = path.join(f.root, 'old-parent');
          await rename(parent, old); await mkdir(parent, { mode: 0o755 });
          await rename(path.join(old, 'role-intent.json'), f.paths.roleIntentFile);
        } else if (kind === 'output') {
          const name = path.join(f.paths.volumeRoot, relative);
          const old = path.join(f.root, 'old-output');
          await rename(name, old); await copyFile(old, name);
        } else if (kind === 'directory') {
          const name = path.join(f.paths.volumeRoot, 'public');
          const old = path.join(f.root, 'old-public');
          await rename(name, old); await mkdir(name, { mode: 0o700 });
          await mkdir(path.join(name, 'generations', suffix), { recursive: true, mode: 0o700 });
        } else if (kind === 'extra') await writeFile(path.join(f.candidate, 'extra'), 'x');
        else if (kind === 'bad-sha') {
          const changed = { ...f.invocation, roleApprovedSha256: '0'.repeat(64) };
          await chmod(f.paths.invocationFile, 0o600);
          await writeFile(f.paths.invocationFile, canonical(changed));
          await chmod(f.paths.invocationFile, 0o400);
        } else if (kind === 'link') await link(f.paths.roleIntentFile,
          path.join(f.root, 'linked-role'));
        else if (kind === 'mode') await chmod(f.paths.roleIntentFile, 0o600);
        else if (kind === 'symlink') {
          const old = path.join(f.root, 'old-role');
          await rename(f.paths.roleIntentFile, old);
          await symlink(old, f.paths.roleIntentFile);
        }
      };
      await denied(() => transferWriterMappingPrepareInputs(f.paths,
        { ...options, beforeSync }));
      assert.equal(reached, true, kind);
    }
  });

test('fixed transfer CLI rejects unprivileged and argument-bearing calls before input access', () => {
  for (const args of [[], ['unexpected']]) {
    const result = spawnSync(process.execPath,
      [path.resolve('scripts/search-writer-mapping-prepare-transfer.mjs'), ...args],
      { encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Private writer mapping preparation transfer failed.\n');
  }
});

test('partial output remains unusable and cannot be adopted by a second transfer',
  { timeout: 45_000 }, async t => {
    const f = await setup(t);
    let reached = false;
    await denied(() => transferWriterMappingPrepareInputs(f.paths, {
      ...options, beforeWrite: relative => {
        if (relative === 'role-intent.json') { reached = true; throw Error('fixture interruption'); }
      } }));
    assert.equal(reached, true);
    assert.deepEqual((await readdir(f.paths.volumeRoot)).sort(),
      ['create-binding.json', 'create-intent.json', 'public']);
    await denied(() => transferWriterMappingPrepareInputs(f.paths, options));
  });

test('late output root chmod and same-tree root replacement reject after reached reads',
  { timeout: 45_000 }, async t => {
    for (const kind of ['late-mode', 'root-replacement']) {
      const f = await setup(t);
      const originalOpen = fsPromises.open;
      let reached = false, outputReads = 0;
      const writer = path.join(f.paths.volumeRoot, 'public/generations', suffix, 'writer.pem');
      fsPromises.open = async function(name, ...args) {
        const handle = await originalOpen.call(this, name, ...args);
        if (kind === 'late-mode' && name === writer &&
            args[0] === (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)) {
          outputReads++;
          if (outputReads === 2) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
              await close();
              await chmod(f.paths.volumeRoot, 0o777);
              reached = true;
            };
          }
        }
        if (kind === 'root-replacement' && !reached && name === f.paths.volumeRoot &&
            args[0] === (constants.O_RDONLY | constants.O_DIRECTORY |
              constants.O_NOFOLLOW) && await lstat(writer).catch(() => null)) {
          const old = path.join(f.root, 'old-volume');
          await rename(name, old);
          await cp(old, name, { recursive: true });
          await chmod(name, 0o755);
          assert.notEqual((await lstat(old)).ino, (await lstat(name)).ino);
          reached = true;
        }
        return handle;
      };
      syncBuiltinESMExports();
      try { await denied(() => transferWriterMappingPrepareInputs(f.paths, options)); }
      finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
      assert.equal(reached, true, kind);
      if (kind === 'late-mode') assert.equal(outputReads, 2);
    }
  });
