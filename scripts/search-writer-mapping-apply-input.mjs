/* global structuredClone */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { digestCreatePriorPublic } from './search-create-intent-pure.mjs';
import { validateCapturedAttestorPublic,
  validateCapturedAttestorPublicAtTime } from './search-attestor-command-core.mjs';
import { validateWriterRoleCopiedEvidence } from './search-writer-role-apply-evidence.mjs';
import { validateSerializedWriterMappingIntent } from './search-writer-mapping-intent-pure.mjs';
import { writerRoleApplyDir, writerRoleApplyFile,
  writerRoleApplyPublicTree } from './search-writer-role-apply-files.mjs';

const fail = () => { throw Error('Private writer mapping apply input failed.'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['binding.json', 'candidate-public', 'create-binding.json',
  'create-intent.json', 'intent.json', 'prior-public', 'role-binding.json',
  'role-intent.json', 'transition.password'].join('|');
const limits = Object.freeze({ 'intent.json': 256 * 1024, 'binding.json': 1024,
  'create-intent.json': 256 * 1024, 'create-binding.json': 1024,
  'role-intent.json': 256 * 1024, 'role-binding.json': 1024,
  'transition.password': 43 });
const same = (a, b) => canonicalAttestorValue(a).bytes.equals(canonicalAttestorValue(b).bytes);
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** Fixed copied evidence only; caller approval and host source identity remain external. */
export async function openWriterMappingApplyInput(root = '/run/search-writer-mapping-apply',
  scratchRoot = '/tmp/.cache/search-writer-mapping-apply', fixture = undefined) {
  try {
    if (fixture === undefined ? root !== '/run/search-writer-mapping-apply' ||
      scratchRoot !== '/tmp/.cache/search-writer-mapping-apply' :
      process.env.STATION_WRITER_MAPPING_APPLY_FIXTURE !== '1' ||
      !fixture || Object.keys(fixture).sort().join('|') !== 'gid|uid' ||
      fixture.uid !== process.getuid?.() || fixture.gid !== process.getgid?.() ||
      !path.isAbsolute(root) || !path.isAbsolute(scratchRoot) ||
      !root.startsWith(path.resolve('.cache/results') + path.sep) ||
      !scratchRoot.startsWith(path.resolve('.cache/results') + path.sep) ||
      !scratchRoot.includes('/.cache/')) fail();
    const uid = fixture?.uid ?? 1000;
    if (uid !== (fixture?.gid ?? 1000)) fail();
    const scratchStats = new Map();
    for (const name of [path.dirname(scratchRoot), scratchRoot]) {
      const stat = await lstat(name);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
          stat.gid !== uid || (stat.mode & 0o777) !== 0o700 ||
          await realpath(name) !== name) fail();
      scratchStats.set(name, stat);
    }
    const scratchFence = async () => {
      for (const [name, original] of scratchStats) {
        const current = await lstat(name);
        if (!current.isDirectory() || current.isSymbolicLink() ||
            current.dev !== original.dev || current.ino !== original.ino ||
            current.uid !== uid || current.gid !== uid ||
            (current.mode & 0o777) !== 0o700 || await realpath(name) !== name) fail();
      }
      if ((await readdir(scratchRoot)).length !== 0) fail();
    };
    const parentName = path.dirname(root), parentStat = await lstat(parentName);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
        await realpath(parentName) !== parentName) fail();
    const parentFence = async () => {
      const current = await lstat(parentName);
      if (!current.isDirectory() || current.isSymbolicLink() ||
          current.dev !== parentStat.dev || current.ino !== parentStat.ino ||
          current.uid !== parentStat.uid || current.gid !== parentStat.gid ||
          current.mode !== parentStat.mode || await realpath(parentName) !== parentName) fail();
    };
    const rootStat = await writerRoleApplyDir(root, uid, 0o700);
    if ((await readdir(root)).sort().join('|') !== names) fail();
    const files = new Map();
    for (const [name, max] of Object.entries(limits)) files.set(name,
      await writerRoleApplyFile(path.join(root, name), uid, 0o400, max));
    const parsed = name => {
      const bytes = files.get(name).bytes;
      const value = JSON.parse(bytes.toString('utf8'));
      if (!canonicalAttestorValue(value, limits[name]).bytes.equals(bytes)) fail();
      return value;
    };
    const intent = parsed('intent.json'), binding = parsed('binding.json');
    const role = validateWriterRoleCopiedEvidence({
      intent: files.get('role-intent.json').bytes,
      binding: files.get('role-binding.json').bytes,
      createIntent: files.get('create-intent.json').bytes,
      createBinding: files.get('create-binding.json').bytes }, intent.project);
    const old = { intent: role.create, binding: role.createBinding,
      approvedSha256: hash(files.get('create-intent.json').bytes) };
    const roleEvidence = { intent: role.intent, binding: role.binding,
      approvedSha256: hash(files.get('role-intent.json').bytes) };
    const approvedSha256 = hash(files.get('intent.json').bytes);
    if (Object.keys(binding).sort().join('|') !==
        'approvedSha256|dispatchId|invocationId|ownerId|version' ||
        binding.version !== 1 || !uuid(binding.invocationId) ||
        binding.approvedSha256 !== approvedSha256 ||
        binding.dispatchId !== intent.dispatchId || binding.ownerId !== intent.ownerId) fail();
    const secret = files.get('transition.password').bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret) ||
        Buffer.from(secret, 'base64url').length !== 32) fail();
    const priorRoot = path.join(root, 'prior-public');
    const prior = await writerRoleApplyPublicTree(priorRoot, role.intent.publicFiles, uid);
    const priorDirectories = async () => {
      for (const [relative, children] of prior.layout) {
        const name = path.join(priorRoot, relative);
        await writerRoleApplyDir(name, uid, 0o700, prior.dirs.get(relative));
        if ((await readdir(name)).sort().join('|') !==
            [...children].sort().join('|')) fail();
      }
    };
    const candidateRoot = path.join(root, 'candidate-public');
    const suffix = intent.candidateToken.replaceAll('-', '');
    const generation = path.join(candidateRoot, 'generations');
    const candidateDir = path.join(generation, suffix);
    const candidateDirs = new Map();
    for (const name of [candidateRoot, generation, candidateDir])
      candidateDirs.set(name, await writerRoleApplyDir(name, uid, 0o700));
    const candidateNames = async () => {
      if ((await readdir(candidateRoot)).sort().join('|') !== 'ca.pem|generations' ||
          (await readdir(generation)).join('|') !== suffix ||
          (await readdir(candidateDir)).join('|') !== 'writer.pem') fail();
    };
    await candidateNames();
    const caName = path.join(candidateRoot, 'ca.pem');
    const writerName = path.join(candidateDir, 'writer.pem');
    const ca = await writerRoleApplyFile(caName, uid, 0o400, 16_384);
    const writer = await writerRoleApplyFile(writerName, uid, 0o400, 16_384);
    const writerPath = `generations/${suffix}/writer.pem`;
    const candidateBytes = new Map([['ca.pem', Buffer.from(ca.bytes)],
      [writerPath, Buffer.from(writer.bytes)]]);
    const publicFiles = [{ path: 'ca.pem', role: 'ca', principal: null, fingerprint: null },
      { path: writerPath, role: 'writer',
        principal: intent.candidatePublic.writerPrincipal,
        fingerprint: intent.candidatePublic.writerFingerprint }];
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
    createEvidence: old, roleEvidence, priorPublicDigests: intent.priorPublicDigests,
    publicEvidence });
    const recheck = async () => {
      await scratchFence();
      await parentFence();
      await writerRoleApplyDir(root, uid, 0o700, rootStat);
      if ((await readdir(root)).sort().join('|') !== names) fail();
      for (const [name, original] of files) await writerRoleApplyFile(path.join(root, name),
        uid, 0o400, limits[name], original);
      await writerRoleApplyPublicTree(priorRoot, role.intent.publicFiles, uid, prior);
      for (const [name, original] of candidateDirs)
        await writerRoleApplyDir(name, uid, 0o700, original);
      await candidateNames();
      await writerRoleApplyFile(caName, uid, 0o400, 16_384, ca);
      await writerRoleApplyFile(writerName, uid, 0o400, 16_384, writer);
      for (const [name, original] of candidateDirs)
        await writerRoleApplyDir(name, uid, 0o700, original);
      await candidateNames();
      await writerRoleApplyPublicTree(priorRoot, role.intent.publicFiles, uid, prior);
      await priorDirectories();
      for (const [name, original] of candidateDirs)
        await writerRoleApplyDir(name, uid, 0o700, original);
      await candidateNames();
      await writerRoleApplyDir(root, uid, 0o700, rootStat);
      if ((await readdir(root)).sort().join('|') !== names) fail();
      await parentFence();
      await scratchFence();
      return true;
    };
    const capturePriorPublic = async filesArgument => {
      if (!same(filesArgument, role.intent.publicFiles)) fail();
      await recheck();
      const actual = await digestCreatePriorPublic(role.intent.publicFiles,
        new Map([...prior.files].map(([name, item]) => [name, Buffer.from(item.bytes)])),
        new Date(), scratchRoot);
      await recheck();
      if (!same(actual, intent.priorPublicDigests)) fail();
      return actual;
    };
    const captureCandidatePublic = async () => {
      await recheck();
      await validateCapturedAttestorPublic({ publicFiles }, candidateBytes,
        new Date(), scratchRoot);
      await recheck();
      validateCapturedAttestorPublicAtTime({ publicFiles }, candidateBytes, new Date());
      if (!same(publicEvidence.candidateDigests, intent.candidatePublic.publicDigests)) fail();
      return structuredClone(publicEvidence);
    };
    await capturePriorPublic(role.intent.publicFiles);
    await captureCandidatePublic();
    await recheck();
    const readInput = async () => {
      await recheck();
      return { approvedSha256, invocationId: binding.invocationId,
        intent: parsed('intent.json'), binding: parsed('binding.json'),
        createEvidence: structuredClone(old), roleEvidence: structuredClone(roleEvidence),
        transitionPassword: Buffer.from(files.get('transition.password').bytes),
        priorPublicDigests: structuredClone(intent.priorPublicDigests),
        publicEvidence: structuredClone(publicEvidence) };
    };
    return Object.freeze({ recheck, readInput, capturePriorPublic,
      captureCandidatePublic });
  } catch { fail(); }
}
