import { Buffer } from 'node:buffer';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { digestCreatePriorPublic } from './search-create-intent-pure.mjs';
import { validateWriterRoleCopiedEvidence } from './search-writer-role-apply-evidence.mjs';
import { writerRoleApplyDir, writerRoleApplyFile,
  writerRoleApplyPublicTree } from './search-writer-role-apply-files.mjs';

const fail = () => { throw Error('Private writer role apply input failed.'); };
const rootNames = 'binding.json|create-binding.json|create-intent.json|intent.json|public|transition.password';
const fixedFiles = Object.freeze({ 'intent.json': 256 * 1024, 'binding.json': 1024,
  'create-intent.json': 256 * 1024, 'create-binding.json': 1024,
  'transition.password': 43 });

/** Copied bytes remain evidence only; no fresh operator approval or live U is inferred. */
export async function openWriterRoleApplyInput(root = '/run/search-writer-role-apply',
  scratchRoot = '/tmp/.cache/search-writer-role-apply', fixture = undefined) {
  try {
    if (!path.isAbsolute(root) || !path.isAbsolute(scratchRoot) ||
        !scratchRoot.includes('/.cache/') || fixture !== undefined &&
        (process.env.STATION_WRITER_ROLE_APPLY_FIXTURE !== '1' ||
          Object.keys(fixture).sort().join('|') !== 'gid|uid' ||
          fixture.uid !== process.getuid?.() || fixture.gid !== process.getgid?.() ||
          !root.includes('/.cache/results/'))) fail();
    const uid = fixture?.uid ?? 1000, gid = fixture?.gid ?? 1000;
    if (uid !== gid) fail();
    for (const name of [path.dirname(scratchRoot), scratchRoot]) {
      const scratchStat = await lstat(name);
      if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink() ||
          scratchStat.uid !== uid || scratchStat.gid !== gid ||
          (scratchStat.mode & 0o777) !== 0o700 || await realpath(name) !== name) fail();
    }
    const rootStat = await writerRoleApplyDir(root, uid, 0o700);
    if ((await readdir(root)).sort().join('|') !== rootNames) fail();
    const files = new Map();
    for (const [name, max] of Object.entries(fixedFiles)) files.set(name,
      await writerRoleApplyFile(path.join(root, name), uid, 0o400, max));
    const roleBytes = files.get('intent.json').bytes;
    const role = JSON.parse(roleBytes.toString('utf8'));
    const evidence = validateWriterRoleCopiedEvidence({ intent: roleBytes,
      binding: files.get('binding.json').bytes,
      createIntent: files.get('create-intent.json').bytes,
      createBinding: files.get('create-binding.json').bytes }, role.project);
    const secret = files.get('transition.password').bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, 'base64url').length !== 32) fail();
    const publicRoot = path.join(root, 'public');
    const publicOriginal = await writerRoleApplyPublicTree(publicRoot, role.publicFiles, uid);
    const recheck = async () => {
      await writerRoleApplyDir(root, uid, 0o700, rootStat);
      if ((await readdir(root)).sort().join('|') !== rootNames) fail();
      for (const [name, original] of files) await writerRoleApplyFile(path.join(root, name),
        uid, 0o400, fixedFiles[name], original);
      await writerRoleApplyPublicTree(publicRoot, role.publicFiles, uid, publicOriginal);
      return true;
    };
    const capturePriorPublic = async filesArgument => {
      if (!canonicalAttestorValue(filesArgument).bytes.equals(
        canonicalAttestorValue(role.publicFiles).bytes)) fail();
      await recheck();
      const actual = await digestCreatePriorPublic(role.publicFiles,
        new Map([...publicOriginal.files].map(([name, item]) => [name, Buffer.from(item.bytes)])),
        new Date(), scratchRoot);
      await recheck();
      if (!canonicalAttestorValue(actual).bytes.equals(
        canonicalAttestorValue(role.publicDigests).bytes)) fail();
      return actual;
    };
    await capturePriorPublic(role.publicFiles);
    return Object.freeze({ recheck, capturePriorPublic, readInput: async () => {
      await recheck();
      return { approvedSha256: evidence.approvedSha256,
        invocationId: evidence.invocationId,
        intent: JSON.parse(roleBytes.toString('utf8')),
        binding: JSON.parse(files.get('binding.json').bytes.toString('utf8')),
        createEvidence: {
          intent: JSON.parse(files.get('create-intent.json').bytes.toString('utf8')),
          binding: JSON.parse(files.get('create-binding.json').bytes.toString('utf8')) },
        transitionPassword: Buffer.from(files.get('transition.password').bytes),
        publicDigests: JSON.parse(canonicalAttestorValue(role.publicDigests).bytes.toString('utf8')) };
    } });
  } catch { fail(); }
}
