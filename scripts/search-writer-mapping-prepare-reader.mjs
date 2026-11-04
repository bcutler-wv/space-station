import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { validateCapturedAttestorPublic,
  validateCapturedAttestorPublicAtTime } from './search-attestor-command-core.mjs';
import { fixedDir, fixedFile } from './search-writer-role-prepare-input.mjs';
import { parseWriterMappingPrepareInput } from './search-writer-mapping-prepare-input.mjs';

const fail = () => { throw Error('Private writer mapping preparation input failed.'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const exact = (value, names) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === names.length &&
  names.every(name => Object.hasOwn(value, name) &&
    Object.getOwnPropertyDescriptor(value, name)?.enumerable &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, name), 'value'));
const canon = (value, cap = 512 * 1024) => canonicalAttestorValue(value, cap).bytes;
const files = Object.freeze([['create-binding.json', 1024],
  ['create-intent.json', 256 * 1024], ['invocation.json', 4096],
  ['role-binding.json', 1024], ['role-intent.json', 256 * 1024],
  ['transition.password', 43]]);
const rootNames = 'create-binding.json|create-intent.json|invocation.json|public|role-binding.json|role-intent.json|transition.password';

export function parseWriterMappingPrepareInvocation(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 4096) fail();
    const value = JSON.parse(bytes.toString('utf8'));
    if (!canon(value, 4096).equals(bytes) || !exact(value, ['version', 'project',
      'databaseOid', 'systemIdentifier', 'invocationId', 'dispatchId', 'ownerId',
      'createApprovedSha256', 'roleApprovedSha256', 'signerResult']) ||
      value.version !== 1 || typeof value.project !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.project) ||
      !Number.isSafeInteger(value.databaseOid) || value.databaseOid < 1 ||
      typeof value.systemIdentifier !== 'string' ||
      !/^[0-9]{1,20}$/.test(value.systemIdentifier) ||
      ![value.invocationId, value.dispatchId, value.ownerId].every(uuid) ||
      new Set([value.invocationId, value.dispatchId, value.ownerId]).size !== 3 ||
      !sha(value.createApprovedSha256) || !sha(value.roleApprovedSha256) ||
      !exact(value.signerResult, ['generationToken', 'writerPrincipal',
        'queryPrincipal', 'writerCertFingerprint', 'queryCertFingerprint']) ||
      !uuid(value.signerResult.generationToken) ||
      !sha(value.signerResult.writerCertFingerprint) ||
      !sha(value.signerResult.queryCertFingerprint)) fail();
    const suffix = value.signerResult.generationToken.replaceAll('-', '');
    if (value.signerResult.writerPrincipal !== `station-search-indexer-${suffix}` ||
        value.signerResult.queryPrincipal !== `station-search-query-${suffix}`) fail();
    return value;
  } catch { fail(); }
}

/** Fixed copied public-only evidence. The approval SHAs are transported, not authenticated. */
export async function openWriterMappingPrepareInput(
  root = '/run/search-writer-mapping-prepare',
  scratch = '/tmp/.cache/search-writer-mapping-prepare', fixture = undefined) {
  try {
    const uid = fixture?.uid ?? 1000, gid = fixture?.gid ?? 1000;
    if (!path.isAbsolute(root) || path.resolve(root) !== root ||
        !path.isAbsolute(scratch) || path.resolve(scratch) !== scratch ||
        fixture === undefined && (root !== '/run/search-writer-mapping-prepare' ||
          scratch !== '/tmp/.cache/search-writer-mapping-prepare') ||
        fixture !== undefined && (process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE !== '1' ||
          !(exact(fixture, ['uid', 'gid']) ||
            exact(fixture, ['uid', 'gid', 'purposeExec']) &&
              typeof fixture.purposeExec === 'function') ||
          uid !== process.getuid?.() ||
          gid !== process.getgid?.() ||
          !root.startsWith(`${path.resolve('.cache/results')}${path.sep}`) ||
          !scratch.startsWith(`${path.resolve('.cache/results')}${path.sep}`))) fail();
    const rootStat = await fixedDir(root, uid, gid);
    const scratchParent = path.dirname(scratch);
    const scratchParentStat = await fixedDir(scratchParent, uid, gid);
    const scratchStat = await fixedDir(scratch, uid, gid);
    const inventory = async () => {
      await fixedDir(root, uid, gid, rootStat);
      await fixedDir(scratchParent, uid, gid, scratchParentStat);
      await fixedDir(scratch, uid, gid, scratchStat);
      if ((await readdir(root)).sort().join('|') !== rootNames ||
          (await readdir(scratch)).length !== 0) fail();
      await fixedDir(root, uid, gid, rootStat);
      await fixedDir(scratchParent, uid, gid, scratchParentStat);
      await fixedDir(scratch, uid, gid, scratchStat);
    };
    await inventory();
    const originals = new Map();
    for (const [name, max] of files)
      originals.set(name, await fixedFile(path.join(root, name), uid, gid, max));
    await inventory();
    const invocation = parseWriterMappingPrepareInvocation(originals.get('invocation.json').bytes);
    const expected = Object.freeze({ project: invocation.project,
      databaseOid: invocation.databaseOid, systemIdentifier: invocation.systemIdentifier,
      invocationId: invocation.invocationId, dispatchId: invocation.dispatchId,
      ownerId: invocation.ownerId,
      createApprovedSha256: invocation.createApprovedSha256,
      roleApprovedSha256: invocation.roleApprovedSha256 });
    const password = originals.get('transition.password').bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(password) ||
        Buffer.from(password, 'base64url').length !== 32) fail();
    const role = JSON.parse(originals.get('role-intent.json').bytes.toString('utf8'));
    if (typeof role.candidateToken !== 'string' ||
        role.candidateToken !== invocation.signerResult.generationToken ||
        !uuid(role.candidateToken)) fail();
    const suffix = role.candidateToken.replaceAll('-', '');
    const writerPath = `generations/${suffix}/writer.pem`;
    const publicRoot = path.join(root, 'public');
    const generations = path.join(publicRoot, 'generations');
    const candidate = path.join(generations, suffix);
    const dirs = new Map();
    for (const name of [publicRoot, generations, candidate])
      dirs.set(name, await fixedDir(name, uid, gid));
    const publicNames = new Map([[publicRoot, 'ca.pem|generations'],
      [generations, suffix], [candidate, 'writer.pem']]);
    const publicInventory = async () => {
      for (const [name, stat] of dirs) {
        await fixedDir(name, uid, gid, stat);
        if ((await readdir(name)).sort().join('|') !== publicNames.get(name)) fail();
      }
    };
    await publicInventory();
    const ca = await fixedFile(path.join(publicRoot, 'ca.pem'), uid, gid, 16_384);
    const writer = await fixedFile(path.join(candidate, 'writer.pem'), uid, gid, 16_384);
    await inventory();
    await publicInventory();
    const caBytes = Buffer.from(ca.bytes), writerBytes = Buffer.from(writer.bytes);
    const priorPublicDigests = role.publicDigests;
    if (!Array.isArray(priorPublicDigests) ||
        priorPublicDigests.find(row => row.path === 'ca.pem')?.sha256 !== hash(caBytes)) fail();
    const principal = invocation.signerResult.writerPrincipal;
    const candidateDigests = [{ path: 'ca.pem', sha256: hash(caBytes) },
      { path: writerPath, sha256: hash(writerBytes) }];
    const publicEvidence = { originalCaPemHex: caBytes.toString('hex'),
      candidateCaPemHex: caBytes.toString('hex'), writerPemHex: writerBytes.toString('hex'),
      candidateDigests, writerPrincipal: principal,
      writerCertFingerprint: invocation.signerResult.writerCertFingerprint };
    const envelope = { invocation: { version: 1, project: expected.project,
      databaseOid: expected.databaseOid, systemIdentifier: expected.systemIdentifier,
      invocationId: expected.invocationId, dispatchId: expected.dispatchId,
      ownerId: expected.ownerId },
    files: { intent: originals.get('role-intent.json').bytes.toString('hex'),
      binding: originals.get('role-binding.json').bytes.toString('hex'),
      createIntent: originals.get('create-intent.json').bytes.toString('hex'),
      createBinding: originals.get('create-binding.json').bytes.toString('hex') },
    priorPublicDigests, publicEvidence };
    const inputBytes = Buffer.from(canon(envelope));
    parseWriterMappingPrepareInput(inputBytes, expected);
    const manifest = { publicFiles: [
      { path: 'ca.pem', role: 'ca', principal: null, fingerprint: null },
      { path: writerPath, role: 'writer', principal,
        fingerprint: invocation.signerResult.writerCertFingerprint }] };
    const publicBytes = new Map([['ca.pem', caBytes], [writerPath, writerBytes]]);
    const recheck = async () => {
      try {
        await inventory();
        await publicInventory();
        for (const [name, max] of files)
          await fixedFile(path.join(root, name), uid, gid, max, originals.get(name));
        await fixedFile(path.join(publicRoot, 'ca.pem'), uid, gid, 16_384, ca);
        await fixedFile(path.join(candidate, 'writer.pem'), uid, gid, 16_384, writer);
        await inventory();
        await publicInventory();
        await inventory();
        validateCapturedAttestorPublicAtTime(manifest, publicBytes, new Date());
        return true;
      } catch { fail(); }
    };
    await recheck();
    await validateCapturedAttestorPublic(manifest, publicBytes, new Date(), scratch,
      fixture?.purposeExec);
    await recheck();
    return Object.freeze({ inputBytes: Buffer.from(inputBytes), expected,
      readInputBytes: async () => { await recheck(); return Buffer.from(inputBytes); },
      recheckInput: recheck });
  } catch { fail(); }
}
