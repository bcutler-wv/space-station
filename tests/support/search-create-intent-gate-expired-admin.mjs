import { chmod, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Issue a disposable expired admin leaf from the existing fixture CA and key. */
export async function issueExpiredAdmin(source, scratch, run, stage = () => {}) {
  const request = path.join(scratch, 'intent-expired-admin.csr');
  const extensions = path.join(scratch, 'intent-expired-admin.ext');
  const certificate = path.join(scratch, 'intent-expired-admin.pem');
  await writeFile(extensions, 'basicConstraints=CA:FALSE\n' +
    'keyUsage=digitalSignature,keyEncipherment\n' +
    'extendedKeyUsage=clientAuth\n', { flag: 'wx', mode: 0o600 });
  try {
    stage('request');
    await run(['req', '-new', '-key', path.join(source, 'admin.key'),
      '-subj', '/CN=station-search-admin', '-out', request]);
    stage('issue');
    await run(['x509', '-req', '-sha256', '-days', '0', '-in', request,
      '-CA', path.join(source, 'ca.pem'), '-CAkey', path.join(source, 'ca.key'),
      '-set_serial', '1234567', '-extfile', extensions, '-out', certificate]);
    await chmod(certificate, 0o600);
    return certificate;
  } finally {
    await rm(request, { force: true });
    await rm(extensions, { force: true });
  }
}
