import { Buffer } from 'node:buffer';
import { createHash, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseWriterMappingPrepareInvocation } from './search-writer-mapping-prepare-reader.mjs';
import { validateWriterRoleCopiedEvidence } from './search-writer-role-apply-evidence.mjs';
import { writerRoleApplyDir as dir, writerRoleApplyFile as file,
  syncWriterRoleApplyDir as syncDir } from './search-writer-role-apply-files.mjs';

const fail = () => { throw Error('Private writer mapping preparation transfer failed.'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const files = Object.freeze({ createIntentFile: ['create-intent.json', 256 * 1024],
  createBindingFile: ['create-binding.json', 1024],
  roleIntentFile: ['role-intent.json', 256 * 1024],
  roleBindingFile: ['role-binding.json', 1024],
  invocationFile: ['invocation.json', 4096],
  passwordFile: ['transition.password', 43] });
const rootNames = 'create-binding.json|create-intent.json|invocation.json|public|role-binding.json|role-intent.json|transition.password';

/** One networkless copy. Copied approval hashes are consistency data, not authority. */
export async function transferWriterMappingPrepareInputs(input, fixture = {}) {
  try {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).some(key => typeof key !== 'string' ||
          !Object.getOwnPropertyDescriptor(input, key)?.enumerable ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) ||
        Object.keys(input).sort().join('|') !==
        'createBindingFile|createIntentFile|invocationFile|passwordFile|publicRoot|roleBindingFile|roleIntentFile|volumeRoot' ||
        Object.values(input).some(value => typeof value !== 'string' || !path.isAbsolute(value) ||
          path.resolve(value) !== value) ||
        Object.keys(fixture).some(key => !['fixture', 'creatorUid', 'targetUid',
          'beforeWrite', 'beforeSync'].includes(key)) ||
        (fixture.beforeWrite !== undefined || fixture.beforeSync !== undefined) &&
          (fixture.fixture !== true ||
            [fixture.beforeWrite, fixture.beforeSync].some(value => value !== undefined &&
              typeof value !== 'function'))) fail();
    input = Object.freeze({ ...input });
    const uid = (await lstat(input.roleIntentFile)).uid;
    if (fixture.fixture ? process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE !== '1' ||
        uid !== process.getuid?.() || fixture.creatorUid !== uid ||
        fixture.targetUid !== uid || !input.volumeRoot.includes('/.cache/results/') :
      ![1000, 1001].includes(uid) || fixture.creatorUid !== undefined ||
        fixture.targetUid !== undefined) fail();
    const creator = fixture.creatorUid ?? 0, target = fixture.targetUid ?? 1000;
    const parents = new Map(), originals = new Map();
    for (const [key, [relative, max]] of Object.entries(files)) {
      const name = input[key], parent = path.dirname(name);
      if (parents.has(parent)) fail();
      parents.set(parent, await dir(parent, creator, 0o755));
      if ((await readdir(parent)).join('|') !== path.basename(name)) fail();
      originals.set(relative, await file(name, uid,
        key === 'passwordFile' ? [0o400, 0o600] : 0o400, max));
    }
    const invocation = parseWriterMappingPrepareInvocation(originals.get('invocation.json').bytes);
    const evidence = validateWriterRoleCopiedEvidence({
      createIntent: originals.get('create-intent.json').bytes,
      createBinding: originals.get('create-binding.json').bytes,
      intent: originals.get('role-intent.json').bytes,
      binding: originals.get('role-binding.json').bytes }, invocation.project);
    if (invocation.createApprovedSha256 !== hash(originals.get('create-intent.json').bytes) ||
        invocation.roleApprovedSha256 !== evidence.approvedSha256 ||
        invocation.databaseOid !== evidence.intent.databaseOid ||
        invocation.systemIdentifier !== evidence.intent.systemIdentifier ||
        invocation.signerResult.generationToken !== evidence.intent.candidateToken ||
        new Set([invocation.invocationId, invocation.dispatchId, invocation.ownerId,
          evidence.intent.dispatchId, evidence.intent.ownerId, evidence.binding.invocationId,
          evidence.create.dispatchId, evidence.create.ownerId,
          evidence.createBinding.invocationId]).size !== 9) fail();
    const password = originals.get('transition.password').bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(password) ||
        Buffer.from(password, 'base64url').length !== 32) fail();
    const suffix = evidence.intent.candidateToken.replaceAll('-', '');
    const writerPath = `generations/${suffix}/writer.pem`;
    const sourceDirs = new Map(), sourceFiles = new Map();
    for (const [relative, children] of [['', 'ca.pem|generations'],
      ['generations', suffix], [`generations/${suffix}`, 'writer.pem']]) {
      const name = path.join(input.publicRoot, relative);
      sourceDirs.set(relative, await dir(name, uid, 0o700));
      if ((await readdir(name)).sort().join('|') !== children) fail();
    }
    for (const relative of ['ca.pem', writerPath])
      sourceFiles.set(relative, await file(path.join(input.publicRoot, relative),
        uid, 0o400, 16_384));
    if (hash(sourceFiles.get('ca.pem').bytes) !== evidence.intent.publicDigests.find(row =>
      row.path === 'ca.pem')?.sha256 || sourceFiles.get(writerPath).bytes.length < 100 ||
      new X509Certificate(sourceFiles.get(writerPath).bytes).fingerprint256
        .replaceAll(':', '').toLowerCase() !== invocation.signerResult.writerCertFingerprint) fail();
    const sourceCheck = async () => {
      const inventories = async () => {
        for (const [key, stat] of parents) {
          await dir(key, creator, 0o755, stat);
          const source = Object.values(input).find(value => path.dirname(value) === key);
          if ((await readdir(key)).join('|') !== path.basename(source)) fail();
        }
        for (const [relative, stat] of sourceDirs) {
          const name = path.join(input.publicRoot, relative);
          await dir(name, uid, 0o700, stat);
          if ((await readdir(name)).sort().join('|') !==
              (relative === '' ? 'ca.pem|generations' :
                relative === 'generations' ? suffix : 'writer.pem')) fail();
        }
      };
      await inventories();
      for (const [key, [relative, max]] of Object.entries(files)) {
        const item = originals.get(relative);
        await file(input[key], uid, key === 'passwordFile' ? [0o400, 0o600] : 0o400,
          max, item);
      }
      for (const [relative, item] of sourceFiles)
        await file(path.join(input.publicRoot, relative), uid, 0o400, 16_384, item);
      await inventories();
    };
    await sourceCheck();
    const root = await dir(input.volumeRoot, creator, 0o755);
    if ((await readdir(input.volumeRoot)).length) fail();
    const createdDirs = new Map();
    for (const relative of ['public', 'public/generations', `public/generations/${suffix}`]) {
      const name = path.join(input.volumeRoot, relative);
      await mkdir(name, { mode: 0o700 });
      createdDirs.set(relative, await lstat(name));
      await syncDir(path.dirname(name));
    }
    const output = new Map([...originals,
      ...[...sourceFiles].map(([name, item]) => [`public/${name}`, item])]);
    const createdFiles = new Map();
    for (const [relative, item] of output) {
      await fixture.beforeWrite?.(relative);
      const name = path.join(input.volumeRoot, relative);
      const handle = await open(name, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const original = await handle.stat();
        if (!original.isFile() || original.nlink !== 1 ||
            !sameInode(original, await lstat(name))) fail();
        createdFiles.set(relative, original);
        await handle.writeFile(item.bytes);
        await handle.chmod(0o400);
        await handle.chown(target, target);
        await fixture.beforeSync?.(relative);
        if (!sameInode(original, await handle.stat()) ||
            !sameInode(original, await lstat(name))) fail();
        await handle.sync();
        if (!sameInode(original, await lstat(name))) fail();
      } finally { await handle.close(); }
      await syncDir(path.dirname(name));
    }
    await sourceCheck();
    for (const [relative, original] of [...createdDirs].reverse()) {
      const name = path.join(input.volumeRoot, relative);
      if (!sameInode(original, await lstat(name))) fail();
      const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY |
        constants.O_NOFOLLOW);
      try {
        if (!sameInode(original, await handle.stat())) fail();
        await handle.chmod(0o700); await handle.chown(target, target);
        await handle.sync();
        if (!sameInode(original, await lstat(name))) fail();
      } finally { await handle.close(); }
    }
    const rootHandle = await open(input.volumeRoot, constants.O_RDONLY |
      constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const before = await rootHandle.stat(), named = await lstat(input.volumeRoot);
      if (!sameInode(root, before) || !sameInode(root, named) ||
          before.uid !== creator || before.gid !== creator ||
          (before.mode & 0o777) !== 0o755 ||
          named.uid !== creator || named.gid !== creator ||
          (named.mode & 0o777) !== 0o755) fail();
      await rootHandle.chmod(0o700); await rootHandle.chown(target, target);
      const after = await rootHandle.stat(), afterNamed = await lstat(input.volumeRoot);
      if (!sameInode(root, after) || !sameInode(root, afterNamed) ||
          after.uid !== target || after.gid !== target ||
          (after.mode & 0o777) !== 0o700 ||
          afterNamed.uid !== target || afterNamed.gid !== target ||
          (afterNamed.mode & 0o777) !== 0o700) fail();
      await rootHandle.sync();
      if (!sameInode(root, await lstat(input.volumeRoot))) fail();
    } finally { await rootHandle.close(); }
    const targetRoot = await dir(input.volumeRoot, target, 0o700);
    if (!sameInode(root, targetRoot) ||
        (await readdir(input.volumeRoot)).sort().join('|') !== rootNames) fail();
    for (const [relative, item] of output) {
      const copied = await file(path.join(input.volumeRoot, relative), target, 0o400,
        relative === 'transition.password' ? 43 : relative === 'invocation.json' ? 4096 :
          relative.endsWith('binding.json') ? 1024 :
            relative.endsWith('intent.json') ? 256 * 1024 : 16_384);
      if (!sameInode(createdFiles.get(relative), copied.stat) ||
          !copied.bytes.equals(item.bytes)) fail();
    }
    for (const [relative, stat] of createdDirs) {
      const name = path.join(input.volumeRoot, relative);
      await dir(name, target, 0o700);
      if (!sameInode(stat, await lstat(name)) ||
          (await readdir(name)).sort().join('|') !==
            (relative === 'public' ? 'ca.pem|generations' :
              relative === 'public/generations' ? suffix : 'writer.pem')) fail();
    }
    await sourceCheck();
    if (!sameInode(root, await lstat(input.volumeRoot)) ||
        (await readdir(input.volumeRoot)).sort().join('|') !== rootNames) fail();
    for (const [relative, item] of output) {
      const copied = await file(path.join(input.volumeRoot, relative), target, 0o400,
        relative === 'transition.password' ? 43 : relative === 'invocation.json' ? 4096 :
          relative.endsWith('binding.json') ? 1024 :
            relative.endsWith('intent.json') ? 256 * 1024 : 16_384);
      if (!sameInode(createdFiles.get(relative), copied.stat) ||
          !copied.bytes.equals(item.bytes)) fail();
    }
    for (const [relative, stat] of createdDirs) {
      const name = path.join(input.volumeRoot, relative);
      await dir(name, target, 0o700);
      if (!sameInode(stat, await lstat(name)) ||
          (await readdir(name)).sort().join('|') !==
            (relative === 'public' ? 'ca.pem|generations' :
              relative === 'public/generations' ? suffix : 'writer.pem')) fail();
    }
    await syncDir(input.volumeRoot);
    const finalRoot = await dir(input.volumeRoot, target, 0o700);
    if (!sameInode(root, finalRoot) ||
        (await readdir(input.volumeRoot)).sort().join('|') !== rootNames) fail();
    return Object.freeze({ invocationId: invocation.invocationId });
  } catch { fail(); }
}

export const productionWriterMappingPrepareTransferPaths = Object.freeze({
  createIntentFile: '/run/writer-mapping-prepare-create-intent/create-intent.json',
  createBindingFile: '/run/writer-mapping-prepare-create-binding/create-binding.json',
  roleIntentFile: '/run/writer-mapping-prepare-role-intent/role-intent.json',
  roleBindingFile: '/run/writer-mapping-prepare-role-binding/role-binding.json',
  invocationFile: '/run/writer-mapping-prepare-invocation/invocation.json',
  passwordFile: '/run/writer-mapping-prepare-password/password',
  publicRoot: '/run/writer-mapping-prepare-public',
  volumeRoot: '/run/search-writer-mapping-prepare',
});
