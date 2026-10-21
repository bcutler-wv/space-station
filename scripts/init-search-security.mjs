import { spawnSync } from 'node:child_process';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Create only. A partial or altered identity set must be repaired deliberately;
// silently rotating it would strand the retained private index and its clients.
const root = '.cache/search-security';
const names = ['ca.key', 'ca.pem', 'node.key', 'node.pem', 'admin.key', 'admin.pem',
  'query.key', 'query.pem', 'indexer.key', 'indexer.pem', 'outsider.key', 'outsider.pem'];
const run = (...args) => {
  const result = spawnSync('openssl', args, { stdio: 'ignore', timeout: 15_000 });
  if (result.status !== 0) throw new Error('Could not create or verify private search certificates.');
};
const output = (...args) => {
  const result = spawnSync('openssl', args, { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0 || result.stdout.length > 16_384) throw new Error('Private search certificate verification failed.');
  return result.stdout;
};

async function verify(directory) {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077))
    throw new Error('Private search certificate directory permissions are invalid.');
  const found = (await readdir(directory)).sort();
  if (JSON.stringify(found) !== JSON.stringify([...names].sort()))
    throw new Error('Private search certificate set is incomplete or contains unexpected files.');
  for (const name of names) {
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.size < 100 || info.size > 16_384 || (info.mode & 0o077))
      throw new Error('Private search certificate permissions or size are invalid.');
  }
  for (const name of ['ca', 'node', 'admin', 'query', 'indexer', 'outsider']) {
    const certPath = join(directory, `${name}.pem`);
    const keyPath = join(directory, `${name}.key`);
    const certificate = new X509Certificate(await readFile(certPath));
    const privateKey = await readFile(keyPath);
    const expectedName = name === 'ca' ? 'station-search-ca' : name === 'node' ? 'opensearch' : `station-search-${name}`;
    if (certificate.subject !== `CN=${expectedName}` ||
        certificate.issuer !== 'CN=station-search-ca' ||
        !certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(
          createPublicKey(privateKey).export({ type: 'spki', format: 'der' })))
      throw new Error('Private search certificate identity or key pair is invalid.');
    run('x509', '-checkend', '86400', '-noout', '-in', certPath);
    if (name === 'ca') run('verify', '-CAfile', certPath, certPath);
    else {
      run('verify', '-CAfile', join(directory, 'ca.pem'), certPath);
      run('verify', '-purpose', 'sslclient', '-CAfile', join(directory, 'ca.pem'), certPath);
      const usage = output('x509', '-noout', '-ext', 'extendedKeyUsage', '-in', certPath);
      if (!usage.includes('TLS Web Client Authentication') ||
          (name === 'node') !== usage.includes('TLS Web Server Authentication'))
        throw new Error('Private search certificate usage is invalid.');
    }
  }
  run('verify', '-purpose', 'sslserver', '-CAfile', join(directory, 'ca.pem'), join(directory, 'node.pem'));
  run('x509', '-checkhost', 'opensearch', '-noout', '-in', join(directory, 'node.pem'));
  if (!output('x509', '-noout', '-ext', 'subjectAltName', '-in', join(directory, 'node.pem')).includes('DNS:opensearch'))
    throw new Error('Private search node hostname is invalid.');
}

await mkdir('.cache', { recursive: true, mode: 0o700 });
let existing = false;
try { await lstat(root); existing = true; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
if (existing) {
  await verify(root);
  console.info('Private search identities verified; existing certificates left unchanged.');
} else {
  const temporary = await mkdtemp('.cache/search-security-build-');
  try {
    await chmod(temporary, 0o700);
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-subj', '/CN=station-search-ca', '-keyout', join(temporary, 'ca.key'), '-out', join(temporary, 'ca.pem'));
    for (const [name, subject, usage] of [
      ['node', 'opensearch', 'serverAuth,clientAuth'],
      ['admin', 'station-search-admin', 'clientAuth'],
      ['query', 'station-search-query', 'clientAuth'],
      ['indexer', 'station-search-indexer', 'clientAuth'],
      ['outsider', 'station-search-outsider', 'clientAuth'],
    ]) {
      const key = join(temporary, `${name}.key`);
      const csr = join(temporary, `${name}.csr`);
      const ext = join(temporary, `${name}.ext`);
      await writeFile(ext, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n${name === 'node' ? 'subjectAltName=DNS:opensearch\n' : ''}`, { mode: 0o600 });
      run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${subject}`, '-keyout', key, '-out', csr);
      run('x509', '-req', '-sha256', '-days', '3650', '-in', csr, '-CA', join(temporary, 'ca.pem'),
        '-CAkey', join(temporary, 'ca.key'), '-CAcreateserial', '-extfile', ext,
        '-out', join(temporary, `${name}.pem`));
      await rm(csr); await rm(ext);
    }
    await rm(join(temporary, 'ca.srl'));
    for (const name of names) await chmod(join(temporary, name), 0o600);
    await verify(temporary);
    await rename(temporary, root);
    console.info('Created private search CA and distinct node, admin, query, indexer and unprivileged test identities.');
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
