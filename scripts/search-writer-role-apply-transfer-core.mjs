import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateWriterRoleCopiedEvidence } from './search-writer-role-apply-evidence.mjs';
import { syncWriterRoleApplyDir, writerRoleApplyDir,
  writerRoleApplyFile, writerRoleApplyPublicTree } from './search-writer-role-apply-files.mjs';

const fail = () => { throw Error('Private writer role apply transfer failed.'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sourceNames = Object.freeze({ intentFile: ['intent.json', 256 * 1024],
  bindingFile: ['binding.json', 1024], createIntentFile: ['create-intent.json', 256 * 1024],
  createBindingFile: ['create-binding.json', 1024],
  passwordFile: ['transition.password', 43] });
const rootNames = 'binding.json|create-binding.json|create-intent.json|intent.json|public|transition.password';

/** Fixed offline copy. A matching copied digest is evidence, never an operator approval. */
export async function transferWriterRoleApplyInputs(input, fixture = {}) {
  try {
    if (Object.keys(input).sort().join('|') !==
        'bindingFile|createBindingFile|createIntentFile|intentFile|passwordFile|publicRoot|volumeRoot' ||
        Object.values(input).some(value => typeof value !== 'string' || !path.isAbsolute(value)) ||
        Object.keys(fixture).some(key => !['fixture', 'creatorUid', 'targetUid',
          'beforeWrite', 'beforeSync'].includes(key)) || fixture.targetUid !== undefined && fixture.fixture !== true ||
        (fixture.beforeWrite !== undefined || fixture.beforeSync !== undefined) &&
          fixture.fixture !== true) fail();
    const uid = (await lstat(input.intentFile)).uid;
    if (fixture.fixture ? uid !== process.getuid?.() ||
        fixture.creatorUid !== uid || fixture.targetUid !== uid ||
        !input.volumeRoot.includes('/.cache/results/') :
      ![1000, 1001].includes(uid) || fixture.creatorUid !== undefined) fail();
    const creator = fixture.creatorUid ?? 0, target = fixture.targetUid ?? 1000;
    const parents = new Map(), sources = new Map();
    for (const [key, [relative, max]] of Object.entries(sourceNames)) {
      const name = input[key], parent = path.dirname(name);
      if (parents.has(parent)) fail();
      parents.set(parent, await writerRoleApplyDir(parent, creator, 0o755));
      if ((await readdir(parent)).join('|') !== path.basename(name)) fail();
      sources.set(relative, await writerRoleApplyFile(name, uid,
        key === 'passwordFile' ? [0o400, 0o600] : 0o400, max));
    }
    const evidence = validateWriterRoleCopiedEvidence({
      intent: sources.get('intent.json').bytes, binding: sources.get('binding.json').bytes,
      createIntent: sources.get('create-intent.json').bytes,
      createBinding: sources.get('create-binding.json').bytes },
    JSON.parse(sources.get('intent.json').bytes.toString('utf8')).project);
    const password = sources.get('transition.password').bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(password) ||
        Buffer.from(password, 'base64url').length !== 32) fail();
    const sourcePublic = await writerRoleApplyPublicTree(input.publicRoot,
      evidence.intent.publicFiles, uid);
    for (const [i, row] of evidence.intent.publicFiles.entries()) {
      const bytes = sourcePublic.files.get(row.path).bytes;
      if (bytes.length < 100 || hash(bytes) !== evidence.intent.publicDigests[i]?.sha256) fail();
    }
    const root = await writerRoleApplyDir(input.volumeRoot, creator, 0o755);
    if ((await readdir(input.volumeRoot)).length) fail();
    const createdDirs = new Map();
    for (const relative of sourcePublic.layout.keys()) {
      const name = path.join(input.volumeRoot, 'public', relative);
      await mkdir(name, { mode: 0o700 });
      const stat = await lstat(name);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== creator ||
          stat.gid !== creator || (stat.mode & 0o777) !== 0o700) fail();
      createdDirs.set(relative, stat);
    }
    const output = new Map([...sources,
      ...[...sourcePublic.files].map(([relative, item]) => [`public/${relative}`, item])]);
    const createdFiles = new Map();
    for (const [relative, item] of output) {
      await fixture.beforeWrite?.(relative);
      const name = path.join(input.volumeRoot, relative);
      const handle = await open(name, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const original = await handle.stat();
        if (!original.isFile() || original.nlink !== 1 ||
            !sameIdentity(original, await lstat(name))) fail();
        createdFiles.set(relative, original);
        await handle.writeFile(item.bytes);
        await handle.chmod(0o400);
        await handle.chown(target, target);
        await fixture.beforeSync?.(relative);
        if (!sameIdentity(original, await handle.stat()) ||
            !sameIdentity(original, await lstat(name))) fail();
        await handle.sync();
        if (!sameIdentity(original, await lstat(name))) fail();
      } finally { await handle.close(); }
      await syncWriterRoleApplyDir(path.dirname(name));
    }
    for (const [relative, item] of sources) await writerRoleApplyFile(item.name, uid,
      relative === 'transition.password' ? [0o400, 0o600] : 0o400,
      sourceNames[Object.keys(sourceNames).find(key => sourceNames[key][0] === relative)][1], item);
    await writerRoleApplyPublicTree(input.publicRoot, evidence.intent.publicFiles, uid, sourcePublic);
    for (const [name, stat] of parents) {
      await writerRoleApplyDir(name, creator, 0o755, stat);
      const source = Object.values(input).find(value => path.dirname(value) === name);
      if ((await readdir(name)).join('|') !== path.basename(source)) fail();
    }
    for (const relative of [...sourcePublic.layout.keys()].reverse()) {
      const name = path.join(input.volumeRoot, 'public', relative);
      if (!sameIdentity(createdDirs.get(relative), await lstat(name))) fail();
      const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!sameIdentity(createdDirs.get(relative), await handle.stat())) fail();
        await handle.chmod(0o700); await handle.chown(target, target);
        await handle.sync();
        if (!sameIdentity(createdDirs.get(relative), await lstat(name))) fail();
      } finally { await handle.close(); }
    }
    const handle = await open(input.volumeRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.chmod(0o700); await handle.chown(target, target);
      await handle.sync(); } finally { await handle.close(); }
    const targetRoot = await writerRoleApplyDir(input.volumeRoot, target, 0o700);
    if (targetRoot.dev !== root.dev || targetRoot.ino !== root.ino ||
        (await readdir(input.volumeRoot)).sort().join('|') !== rootNames) fail();
    for (const [relative, item] of output) {
      const copied = await writerRoleApplyFile(path.join(input.volumeRoot, relative),
        target, 0o400, relative === 'transition.password' ? 43 :
          relative.endsWith('binding.json') ? 1024 : relative.endsWith('intent.json') ?
            256 * 1024 : 16_384);
      if (!sameIdentity(createdFiles.get(relative), copied.stat) ||
          !copied.bytes.equals(item.bytes)) fail();
    }
    const targetPublic = await writerRoleApplyPublicTree(path.join(input.volumeRoot, 'public'),
      evidence.intent.publicFiles, target);
    for (const [relative, original] of createdDirs) {
      if (!sameIdentity(original, targetPublic.dirs.get(relative))) fail();
    }
    await syncWriterRoleApplyDir(input.volumeRoot);
    return Object.freeze({ approvedSha256: evidence.approvedSha256,
      invocationId: evidence.invocationId });
  } catch { fail(); }
}

export const productionWriterRoleApplyTransferPaths = Object.freeze({
  intentFile: '/run/writer-apply-intent/intent.json',
  bindingFile: '/run/writer-apply-binding/binding.json',
  createIntentFile: '/run/writer-apply-create-intent/create-intent.json',
  createBindingFile: '/run/writer-apply-create-binding/create-binding.json',
  passwordFile: '/run/writer-apply-password/password',
  publicRoot: '/run/writer-apply-public',
  volumeRoot: '/run/search-writer-role-apply',
});
