import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { validateCapturedAttestorPublic,
  validateCapturedAttestorPublicAtTime } from './search-attestor-command-core.mjs';
import { capturePublicDirectory, capturePublicFile } from './search-create-intent-public.mjs';

const fail = () => { throw Error('Private writer mapping public capture failed.'); };
const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const names = ['query.key', 'query.pem', 'writer.key', 'writer.pem'];
const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Capture only the candidate writer public certificate and the original public CA. */
async function captureWriterPublic(input, approvedOnly) {
  try {
    const values = canonicalAttestorValue(input, 4096).value;
    const { repository, uid, gid, candidateToken } = values;
    const signer = approvedOnly ? values.approvedWriter : values.signerResult;
    if (Object.keys(values).sort().join('|') !==
        (approvedOnly ? 'approvedWriter|candidateToken|gid|repository|uid' :
          'candidateToken|gid|repository|signerResult|uid') ||
        !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) ||
        uid !== process.getuid?.() || gid !== process.getgid?.() ||
        typeof repository !== 'string' || path.resolve(repository) !== repository ||
        typeof candidateToken !== 'string' || !uuid.test(candidateToken) ||
        !signer || Object.keys(signer).sort().join('|') !==
          (approvedOnly ? 'writerCertFingerprint|writerPrincipal' :
            'generationToken|queryCertFingerprint|queryPrincipal|writerCertFingerprint|writerPrincipal')) fail();
    const suffix = candidateToken.replaceAll('-', '').toLowerCase();
    const principal = `station-search-indexer-${suffix}`;
    if (!approvedOnly && signer.generationToken !== candidateToken ||
        signer.writerPrincipal !== principal ||
        !approvedOnly && signer.queryPrincipal !== `station-search-query-${suffix}` ||
        typeof signer.writerCertFingerprint !== 'string' ||
        !sha.test(signer.writerCertFingerprint) ||
        !approvedOnly && (typeof signer.queryCertFingerprint !== 'string' ||
          !sha.test(signer.queryCertFingerprint))) fail();

    const cache = path.join(repository, '.cache');
    const security = path.join(cache, 'search-security');
    const generations = path.join(cache, 'search-generations');
    const candidate = path.join(generations, suffix);
    const scratch = path.join(cache, 'search-writer-mapping-public');
    const dirs = new Map();
    for (const [name, mode] of [[repository, null], [cache, null], [security, 0o700],
      [generations, 0o700], [candidate, 0o700], [scratch, 0o700]])
      dirs.set(name, { mode, stat: await capturePublicDirectory(name, uid, gid, mode) });
    const inventory = async () => {
      if (JSON.stringify((await readdir(candidate)).sort()) !== JSON.stringify(names) ||
          (await readdir(scratch)).length !== 0) fail();
    };
    await inventory();
    const caName = path.join(security, 'ca.pem');
    const writerName = path.join(candidate, 'writer.pem');
    const ca = await capturePublicFile(caName, uid, gid);
    const writer = await capturePublicFile(writerName, uid, gid);
    const caBytes = Buffer.from(ca.bytes);
    const writerBytes = Buffer.from(writer.bytes);
    const logicalWriter = `generations/${suffix}/writer.pem`;
    const publicFiles = [
      { path: 'ca.pem', role: 'ca', principal: null, fingerprint: null },
      { path: logicalWriter, role: 'writer', principal,
        fingerprint: signer.writerCertFingerprint },
    ];
    const bytes = new Map([['ca.pem', caBytes], [logicalWriter, writerBytes]]);
    const manifest = { publicFiles };
    const recheckDirectories = async (includeScratch = true) => {
      for (const [name, { mode, stat }] of dirs) {
        if (!includeScratch && name === scratch) continue;
        const current = await capturePublicDirectory(name, uid, gid, mode, stat);
        if (!sameDirectory(current, stat)) fail();
      }
      if (includeScratch) await inventory();
      else if (JSON.stringify((await readdir(candidate)).sort()) !==
          JSON.stringify(names)) fail();
    };
    const recheckSources = async (includeScratch = true) => {
      await recheckDirectories(includeScratch);
      await capturePublicFile(caName, uid, gid, ca);
      await capturePublicFile(writerName, uid, gid, writer);
      if (!caBytes.equals(ca.bytes) || !writerBytes.equals(writer.bytes)) fail();
      await recheckDirectories(includeScratch);
    };
    await recheckSources();
    await validateCapturedAttestorPublic(manifest, bytes, new Date(), scratch);
    await recheckSources();
    validateCapturedAttestorPublicAtTime(manifest, bytes, new Date());
    const publicDigests = Object.freeze([
      Object.freeze({ path: 'ca.pem', sha256: digest(caBytes) }),
      Object.freeze({ path: logicalWriter, sha256: digest(writerBytes) }),
    ]);
    return Object.freeze({ candidateToken, writerPrincipal: principal,
      writerCertFingerprint: signer.writerCertFingerprint, publicDigests,
      publicBytes: () => new Map([['ca.pem', Buffer.from(caBytes)],
        [logicalWriter, Buffer.from(writerBytes)]]),
      recheck: async () => {
        try {
          await recheckSources();
          validateCapturedAttestorPublicAtTime(manifest, bytes, new Date());
          return true;
        } catch { fail(); }
      },
      recheckSourceOnly: async () => {
        try {
          await recheckSources(false);
          validateCapturedAttestorPublicAtTime(manifest, bytes, new Date());
          return true;
        } catch { fail(); }
      } });
  } catch { fail(); }
}

export function captureCandidateWriterPublic(input) {
  return captureWriterPublic(input, false);
}

/** Offline approval has only sealed writer evidence, never a query fingerprint. */
export function captureApprovedWriterMappingPublic(input) {
  return captureWriterPublic(input, true);
}
