import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { validateWriterRoleCopiedEvidence } from './search-writer-role-apply-evidence.mjs';
import { validateSerializedWriterMappingIntent } from './search-writer-mapping-intent-pure.mjs';
import { syncWriterRoleApplyDir, writerRoleApplyDir,
  writerRoleApplyFile, writerRoleApplyPublicTree } from './search-writer-role-apply-files.mjs';

const fail = () => { throw Error('Private writer mapping apply transfer failed.'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sourceNames = Object.freeze({ intentFile: ['intent.json', 256 * 1024],
  bindingFile: ['binding.json', 1024], createIntentFile: ['create-intent.json', 256 * 1024],
  createBindingFile: ['create-binding.json', 1024],
  roleIntentFile: ['role-intent.json', 256 * 1024],
  roleBindingFile: ['role-binding.json', 1024],
  passwordFile: ['transition.password', 43] });
const rootNames = 'binding.json|candidate-public|create-binding.json|create-intent.json|intent.json|prior-public|role-binding.json|role-intent.json|transition.password';
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

/** Fixed offline copy. A matching copied digest is evidence, never an operator approval. */
export async function transferWriterMappingApplyInputs(input, fixture = {}) {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(input).some(key => typeof key !== 'string' ||
        !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) ||
        Object.keys(input).sort().join('|') !==
        'bindingFile|createBindingFile|createIntentFile|intentFile|passwordFile|publicRoot|roleBindingFile|roleIntentFile|volumeRoot' ||
        Object.values(input).some(value => typeof value !== 'string' ||
          !path.isAbsolute(value) || path.resolve(value) !== value) ||
        Object.keys(fixture).some(key => !['fixture', 'creatorUid', 'targetUid',
          'beforeWrite', 'beforeSync'].includes(key)) || fixture.targetUid !== undefined && fixture.fixture !== true ||
        (fixture.beforeWrite !== undefined || fixture.beforeSync !== undefined) &&
          fixture.fixture !== true) fail();
    input = Object.freeze({ ...input });
    const uid = (await lstat(input.intentFile)).uid;
    if (fixture.fixture ? process.env.STATION_WRITER_MAPPING_APPLY_FIXTURE !== '1' ||
        uid !== process.getuid?.() ||
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
    const role = validateWriterRoleCopiedEvidence({
      intent: sources.get('role-intent.json').bytes,
      binding: sources.get('role-binding.json').bytes,
      createIntent: sources.get('create-intent.json').bytes,
      createBinding: sources.get('create-binding.json').bytes },
    JSON.parse(sources.get('intent.json').bytes.toString('utf8')).project);
    const intentBytes = sources.get('intent.json').bytes;
    const bindingBytes = sources.get('binding.json').bytes;
    const intent = JSON.parse(intentBytes.toString('utf8'));
    const binding = JSON.parse(bindingBytes.toString('utf8'));
    if (!canonicalAttestorValue(intent, 256 * 1024).bytes.equals(intentBytes) ||
        !canonicalAttestorValue(binding, 1024).bytes.equals(bindingBytes) ||
        Object.keys(binding).sort().join('|') !==
          'approvedSha256|dispatchId|invocationId|ownerId|version' ||
        binding.version !== 1 || !uuid(binding.invocationId) ||
        binding.approvedSha256 !== hash(intentBytes) ||
        binding.dispatchId !== intent.dispatchId || binding.ownerId !== intent.ownerId) fail();
    const password = sources.get('transition.password').bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(password) ||
        Buffer.from(password, 'base64url').length !== 32) fail();
    const stage = await writerRoleApplyDir(input.publicRoot, uid, 0o700);
    if ((await readdir(input.publicRoot)).sort().join('|') !==
        'candidate-public|prior-public') fail();
    const priorRoot = path.join(input.publicRoot, 'prior-public');
    const prior = await writerRoleApplyPublicTree(priorRoot,
      role.intent.publicFiles, uid);
    for (const [i, row] of role.intent.publicFiles.entries()) {
      const bytes = prior.files.get(row.path).bytes;
      if (bytes.length < 100 || hash(bytes) !== role.intent.publicDigests[i]?.sha256) fail();
    }
    const candidateRoot = path.join(input.publicRoot, 'candidate-public');
    const suffix = intent.candidateToken.replaceAll('-', '');
    const candidateDirectories = new Map();
    for (const relative of ['', 'generations', `generations/${suffix}`]) {
      const name = path.join(candidateRoot, relative);
      candidateDirectories.set(relative, await writerRoleApplyDir(name, uid, 0o700));
    }
    const candidateNames = async () => {
      if ((await readdir(candidateRoot)).sort().join('|') !== 'ca.pem|generations' ||
          (await readdir(path.join(candidateRoot, 'generations'))).join('|') !== suffix ||
          (await readdir(path.join(candidateRoot, 'generations', suffix))).join('|') !==
            'writer.pem') fail();
    };
    await candidateNames();
    const writerPath = `generations/${suffix}/writer.pem`;
    const ca = await writerRoleApplyFile(path.join(candidateRoot, 'ca.pem'), uid,
      0o400, 16_384);
    const writer = await writerRoleApplyFile(path.join(candidateRoot, writerPath), uid,
      0o400, 16_384);
    const publicEvidence = { originalCaPemHex: ca.bytes.toString('hex'),
      candidateCaPemHex: ca.bytes.toString('hex'), writerPemHex: writer.bytes.toString('hex'),
      candidateDigests: [{ path: 'ca.pem', sha256: hash(ca.bytes) },
        { path: writerPath, sha256: hash(writer.bytes) }],
      writerPrincipal: intent.candidatePublic.writerPrincipal,
      writerCertFingerprint: intent.candidatePublic.writerFingerprint };
    validateSerializedWriterMappingIntent(intent, { invocation: { version: 1,
      project: intent.project, databaseOid: intent.databaseOid,
      systemIdentifier: intent.systemIdentifier, invocationId: binding.invocationId,
      dispatchId: intent.dispatchId, ownerId: intent.ownerId },
    createEvidence: { intent: role.create, binding: role.createBinding,
      approvedSha256: hash(sources.get('create-intent.json').bytes) },
    roleEvidence: { intent: role.intent, binding: role.binding,
      approvedSha256: hash(sources.get('role-intent.json').bytes) },
    priorPublicDigests: intent.priorPublicDigests, publicEvidence });
    const sourceCheck = async () => {
      for (const [key, [relative, max]] of Object.entries(sourceNames))
        await writerRoleApplyFile(input[key], uid,
          key === 'passwordFile' ? [0o400, 0o600] : 0o400,
          max, sources.get(relative));
      await writerRoleApplyPublicTree(priorRoot, role.intent.publicFiles, uid, prior);
      for (const [relative, original] of candidateDirectories)
        await writerRoleApplyDir(path.join(candidateRoot, relative), uid, 0o700, original);
      await candidateNames();
      await writerRoleApplyFile(path.join(candidateRoot, 'ca.pem'), uid, 0o400, 16_384, ca);
      await writerRoleApplyFile(path.join(candidateRoot, writerPath), uid,
        0o400, 16_384, writer);
      for (const [relative, original] of candidateDirectories)
        await writerRoleApplyDir(path.join(candidateRoot, relative), uid, 0o700, original);
      await candidateNames();
      await writerRoleApplyDir(input.publicRoot, uid, 0o700, stage);
      if ((await readdir(input.publicRoot)).sort().join('|') !==
          'candidate-public|prior-public') fail();
      for (const [name, stat] of parents) {
        await writerRoleApplyDir(name, creator, 0o755, stat);
        const source = Object.values(input).find(value => path.dirname(value) === name);
        if ((await readdir(name)).join('|') !== path.basename(source)) fail();
      }
      // The prior tree reader awaits its last leaf; fence its original inventory afterwards.
      for (const [relative, children] of prior.layout) {
        const name = path.join(priorRoot, relative);
        await writerRoleApplyDir(name, uid, 0o700, prior.dirs.get(relative));
        if ((await readdir(name)).sort().join('|') !==
            [...children].sort().join('|')) fail();
      }
      await writerRoleApplyDir(input.publicRoot, uid, 0o700, stage);
      if ((await readdir(input.publicRoot)).sort().join('|') !==
          'candidate-public|prior-public') fail();
    };
    const root = await writerRoleApplyDir(input.volumeRoot, creator, 0o755);
    if ((await readdir(input.volumeRoot)).length) fail();
    const createdDirs = new Map();
    const layouts = new Map();
    for (const relative of prior.layout.keys())
      layouts.set(path.join('prior-public', relative),
        prior.layout.get(relative));
    layouts.set('candidate-public', ['ca.pem', 'generations']);
    layouts.set('candidate-public/generations', [suffix]);
    layouts.set(`candidate-public/generations/${suffix}`, ['writer.pem']);
    for (const relative of layouts.keys()) {
      const name = path.join(input.volumeRoot, relative);
      await mkdir(name, { mode: 0o700 });
      const stat = await lstat(name);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== creator ||
          stat.gid !== creator || (stat.mode & 0o777) !== 0o700) fail();
      createdDirs.set(relative, stat);
    }
    const output = new Map([...sources,
      ...[...prior.files].map(([relative, item]) => [`prior-public/${relative}`, item]),
      ['candidate-public/ca.pem', ca],
      [`candidate-public/${writerPath}`, writer]]);
    const createdFiles = new Map();
    for (const [relative, item] of output) {
      await fixture.beforeWrite?.(relative);
      const name = path.join(input.volumeRoot, relative);
      const handle = await open(name, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const original = await handle.stat();
        if (!original.isFile() || original.nlink !== 1 ||
            original.uid !== creator || original.gid !== creator ||
            (original.mode & 0o777) !== 0o600 ||
            !sameIdentity(original, await lstat(name))) fail();
        createdFiles.set(relative, original);
        await handle.writeFile(item.bytes);
        await handle.chmod(0o400);
        await handle.chown(target, target);
        await fixture.beforeSync?.(relative);
        const after = await handle.stat(), named = await lstat(name);
        if (!sameIdentity(original, after) || !sameIdentity(original, named) ||
            after.uid !== target || after.gid !== target ||
            (after.mode & 0o777) !== 0o400 ||
            named.uid !== target || named.gid !== target ||
            (named.mode & 0o777) !== 0o400) fail();
        await handle.sync();
        if (!sameIdentity(original, await lstat(name))) fail();
      } finally { await handle.close(); }
      await syncWriterRoleApplyDir(path.dirname(name));
    }
    await sourceCheck();
    for (const relative of [...layouts.keys()].reverse()) {
      const name = path.join(input.volumeRoot, relative);
      const named = await lstat(name);
      if (!sameIdentity(createdDirs.get(relative), named) ||
          !named.isDirectory() || named.isSymbolicLink() ||
          named.uid !== creator || named.gid !== creator ||
          (named.mode & 0o777) !== 0o700) fail();
      const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!sameIdentity(createdDirs.get(relative), before) ||
            before.uid !== creator || before.gid !== creator ||
            (before.mode & 0o777) !== 0o700) fail();
        await handle.chmod(0o700); await handle.chown(target, target);
        const after = await handle.stat();
        if (!sameIdentity(createdDirs.get(relative), after) ||
            after.uid !== target || after.gid !== target ||
            (after.mode & 0o777) !== 0o700) fail();
        await handle.sync();
        if (!sameIdentity(createdDirs.get(relative), await lstat(name))) fail();
      } finally { await handle.close(); }
    }
    const handle = await open(input.volumeRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat(), named = await lstat(input.volumeRoot);
      if (!sameIdentity(root, before) || !sameIdentity(root, named) ||
          before.uid !== creator || before.gid !== creator ||
          (before.mode & 0o777) !== 0o755) fail();
      await handle.chmod(0o700); await handle.chown(target, target);
      const after = await handle.stat();
      if (!sameIdentity(root, after) || !sameIdentity(root, await lstat(input.volumeRoot)) ||
          after.uid !== target || after.gid !== target ||
          (after.mode & 0o777) !== 0o700) fail();
      await handle.sync();
    } finally { await handle.close(); }
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
    const targetPrior = await writerRoleApplyPublicTree(
      path.join(input.volumeRoot, 'prior-public'), role.intent.publicFiles, target);
    for (const [relative, original] of createdDirs) {
      const name = path.join(input.volumeRoot, relative);
      await writerRoleApplyDir(name, target, 0o700);
      if (!sameIdentity(original, await lstat(name)) ||
          (await readdir(name)).sort().join('|') !==
            [...layouts.get(relative)].sort().join('|')) fail();
      if (relative.startsWith('prior-public')) {
        const key = path.relative('prior-public', relative);
        if (!sameIdentity(original, targetPrior.dirs.get(key))) fail();
      }
    }
    await sourceCheck();
    if (!sameIdentity(root, await lstat(input.volumeRoot)) ||
        (await readdir(input.volumeRoot)).sort().join('|') !== rootNames) fail();
    for (const [relative, item] of output) {
      const copied = await writerRoleApplyFile(path.join(input.volumeRoot, relative),
        target, 0o400, relative === 'transition.password' ? 43 :
          relative.endsWith('binding.json') ? 1024 :
            relative.endsWith('intent.json') ? 256 * 1024 : 16_384);
      if (!sameIdentity(createdFiles.get(relative), copied.stat) ||
          !copied.bytes.equals(item.bytes)) fail();
    }
    for (const [relative, original] of createdDirs) {
      const name = path.join(input.volumeRoot, relative);
      await writerRoleApplyDir(name, target, 0o700);
      if (!sameIdentity(original, await lstat(name)) ||
          (await readdir(name)).sort().join('|') !==
            [...layouts.get(relative)].sort().join('|')) fail();
    }
    await syncWriterRoleApplyDir(input.volumeRoot);
    for (const [relative, original] of createdDirs) {
      const name = path.join(input.volumeRoot, relative);
      await writerRoleApplyDir(name, target, 0o700);
      if (!sameIdentity(original, await lstat(name)) ||
          (await readdir(name)).sort().join('|') !==
            [...layouts.get(relative)].sort().join('|')) fail();
    }
    const finalRoot = await writerRoleApplyDir(input.volumeRoot, target, 0o700);
    if (!sameIdentity(root, finalRoot) ||
        (await readdir(input.volumeRoot)).sort().join('|') !== rootNames) fail();
    return Object.freeze({ approvedSha256: hash(intentBytes),
      invocationId: binding.invocationId });
  } catch { fail(); }
}

export const productionWriterMappingApplyTransferPaths = Object.freeze({
  intentFile: '/run/writer-mapping-apply-intent/intent.json',
  bindingFile: '/run/writer-mapping-apply-binding/binding.json',
  createIntentFile: '/run/writer-mapping-apply-create-intent/create-intent.json',
  createBindingFile: '/run/writer-mapping-apply-create-binding/create-binding.json',
  roleIntentFile: '/run/writer-mapping-apply-role-intent/role-intent.json',
  roleBindingFile: '/run/writer-mapping-apply-role-binding/role-binding.json',
  passwordFile: '/run/writer-mapping-apply-password/password',
  publicRoot: '/run/writer-mapping-apply-public',
  volumeRoot: '/run/search-writer-mapping-apply',
});
