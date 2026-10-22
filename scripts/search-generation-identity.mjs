import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const v1Names = ['ca.key', 'ca.pem', 'node.key', 'node.pem', 'admin.key', 'admin.pem',
  'query.key', 'query.pem', 'indexer.key', 'indexer.pem', 'outsider.key', 'outsider.pem'];
const generationNames = ['writer.key', 'writer.pem', 'query.key', 'query.pem'];
const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BUDGET_MS = 90_000;
const MAX_OUTPUT = 16_384;

// Resolve existing ancestors before creating anything. The output path may not
// exist yet, and a symlink in one of its existing parents can enter the CA tree.
async function prospectiveRealPath(path) {
  let candidate = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  const missing = [];
  for (;;) {
    try { return join(await realpath(candidate), ...missing.reverse()); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

async function requireSeparateRoots(v1Root, outputRoot) {
  const frozen = await realpath(v1Root);
  const output = await prospectiveRealPath(outputRoot);
  if (output === frozen || output.startsWith(`${frozen}${sep}`) || frozen.startsWith(`${output}${sep}`))
    throw new Error('Generation output overlaps frozen v1 identity root');
}

function openssl(deadline, ...args) {
  const remaining = Math.min(15_000, Math.floor(deadline - performance.now()));
  if (remaining < 1) throw new Error('Certificate operation deadline exceeded');
  const result = spawnSync('openssl', args, { encoding: 'utf8', timeout: remaining,
    maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0 || result.stdout.length > MAX_OUTPUT ||
      result.stderr.length > MAX_OUTPUT) throw new Error('Certificate operation failed');
  return result.stdout;
}

async function secureDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error('Private certificate directory is invalid');
}

async function secureFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size < 100 || info.size > MAX_OUTPUT || (info.mode & 0o077) !== 0)
    throw new Error('Private certificate file is invalid');
  return readFile(path);
}

async function verifyCa(v1Root, deadline) {
  await secureDirectory(v1Root);
  if (JSON.stringify((await readdir(v1Root)).sort()) !== JSON.stringify([...v1Names].sort()))
    throw new Error('Frozen v1 certificate set is invalid');
  for (const name of v1Names) await secureFile(join(v1Root, name));
  const key = await secureFile(join(v1Root, 'ca.key'));
  const pem = await secureFile(join(v1Root, 'ca.pem'));
  const ca = new X509Certificate(pem);
  if (ca.subject !== 'CN=station-search-ca' || ca.issuer !== ca.subject ||
      !ca.publicKey.export({ type: 'spki', format: 'der' }).equals(
        createPublicKey(key).export({ type: 'spki', format: 'der' })))
    throw new Error('Frozen v1 CA identity is invalid');
  openssl(deadline, 'verify', '-CAfile', join(v1Root, 'ca.pem'), join(v1Root, 'ca.pem'));
  openssl(deadline, 'x509', '-checkend', '86400', '-noout', '-in', join(v1Root, 'ca.pem'));
}

async function verifyGeneration(directory, v1Root, suffix, deadline) {
  await secureDirectory(directory);
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...generationNames].sort()))
    throw new Error('Generation identity set is incomplete or unexpected');
  const result = {};
  for (const [role, cn] of [['writer', `station-search-indexer-${suffix}`],
    ['query', `station-search-query-${suffix}`]]) {
    const key = await secureFile(join(directory, `${role}.key`));
    const pem = await secureFile(join(directory, `${role}.pem`));
    const cert = new X509Certificate(pem);
    if (cert.subject !== `CN=${cn}` || cert.issuer !== 'CN=station-search-ca' ||
        !cert.publicKey.export({ type: 'spki', format: 'der' }).equals(
          createPublicKey(key).export({ type: 'spki', format: 'der' })))
      throw new Error('Generation certificate identity or key pair is invalid');
    const validFrom = Date.parse(cert.validFrom), validTo = Date.parse(cert.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) ||
        validFrom > Date.now() || validTo <= Date.now() + 86_400_000)
      throw new Error('Generation certificate validity is invalid');
    openssl(deadline, 'verify', '-purpose', 'sslclient', '-CAfile', join(v1Root, 'ca.pem'),
      join(directory, `${role}.pem`));
    openssl(deadline, 'x509', '-checkend', '86400', '-noout', '-in', join(directory, `${role}.pem`));
    const usage = openssl(deadline, 'x509', '-noout', '-ext', 'extendedKeyUsage',
      '-in', join(directory, `${role}.pem`));
    const basic = openssl(deadline, 'x509', '-noout', '-ext', 'basicConstraints',
      '-in', join(directory, `${role}.pem`));
    const keyUsage = openssl(deadline, 'x509', '-noout', '-ext', 'keyUsage',
      '-in', join(directory, `${role}.pem`));
    if (!/^X509v3 Extended Key Usage:\s*\n\s*TLS Web Client Authentication\s*$/m.test(usage) ||
        !/^X509v3 Basic Constraints:\s*\n\s*CA:FALSE\s*$/m.test(basic) ||
        !/^X509v3 Key Usage:\s*\n\s*Digital Signature, Key Encipherment\s*$/m.test(keyUsage))
      throw new Error('Generation certificate usage is invalid');
    result[`${role}Principal`] = cn;
    result[`${role}CertFingerprint`] = createHash('sha256').update(cert.raw).digest('hex');
  }
  return result;
}

/** Offline, create-only identity provision. It never creates or modifies the frozen v1 root. */
export async function ensureSearchGenerationIdentity(token, { v1Root = '.cache/search-security',
  outputRoot = '.cache/search-generations' } = {}) {
  if (typeof token !== 'string' || !uuid.test(token)) throw new Error('Invalid generation UUID');
  const canonicalToken = token.toLowerCase();
  const suffix = canonicalToken.replaceAll('-', '');
  const deadline = performance.now() + BUDGET_MS;
  await requireSeparateRoots(v1Root, outputRoot);
  await verifyCa(v1Root, deadline);
  try { await mkdir(outputRoot, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  await secureDirectory(outputRoot);
  const destination = join(outputRoot, suffix);
  let found = false;
  try { await lstat(destination); found = true; }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (found) return { generationToken: token,
    ...await verifyGeneration(destination, v1Root, suffix, deadline) };

  const staging = await mkdtemp(join(outputRoot, '.build-'));
  try {
    await chmod(staging, 0o700);
    for (const [role, cn] of [['writer', `station-search-indexer-${suffix}`],
      ['query', `station-search-query-${suffix}`]]) {
      const key = join(staging, `${role}.key`);
      const csr = join(staging, `${role}.csr`);
      const ext = join(staging, `${role}.ext`);
      await writeFile(ext, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n',
        { mode: 0o600 });
      openssl(deadline, 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${cn}`,
        '-keyout', key, '-out', csr);
      openssl(deadline, 'x509', '-req', '-sha256', '-days', '3650', '-in', csr,
        '-CA', join(v1Root, 'ca.pem'), '-CAkey', join(v1Root, 'ca.key'),
        '-set_serial', `0x${randomBytes(20).toString('hex')}`, '-extfile', ext,
        '-out', join(staging, `${role}.pem`));
      await rm(csr); await rm(ext);
      await chmod(key, 0o600);
      await chmod(join(staging, `${role}.pem`), 0o600);
    }
    const result = await verifyGeneration(staging, v1Root, suffix, deadline);
    try { await mkdir(destination, { mode: 0o700 }); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // A concurrent caller owns this name. An in-progress/partial set fails closed.
      return { generationToken: token,
        ...await verifyGeneration(destination, v1Root, suffix, deadline) };
    }
    for (const name of generationNames) await rename(join(staging, name), join(destination, name));
    await verifyGeneration(destination, v1Root, suffix, deadline);
    return { generationToken: token, ...result };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
