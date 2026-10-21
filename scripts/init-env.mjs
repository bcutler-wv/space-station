import { randomBytes } from 'node:crypto';
import { open, mkdir, chmod, chown, access, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const content = [
  `POSTGRES_PASSWORD=${randomBytes(32).toString('base64url')}`,
  `STATION_MASTER_KEY=${randomBytes(32).toString('base64')}`,
  'APP_PORT=8080',
  'APP_ORIGIN=https://localhost:8080',
  'APP_TLS_KEY_PATH=/run/tls/key.pem',
  'APP_TLS_CERT_PATH=/run/tls/cert.pem',
  `APP_UID=${process.getuid() === 0 ? 1000 : process.getuid()}`,
  `APP_GID=${process.getgid() === 0 ? 1000 : process.getgid()}`,
  '',
].join('\n');

try {
  const file = await open('.env', 'wx', 0o600);
  try { await file.writeFile(content); } finally { await file.close(); }
  console.info('Created .env with new bootstrap secrets.');
} catch (error) {
  if (error?.code === 'EEXIST') {
    console.info('.env already exists; left it unchanged.');
  } else {
    throw error;
  }
}

await mkdir('.cache/tls', { recursive: true, mode: 0o700 });
await mkdir('.cache', { recursive: true, mode: 0o700 });
try {
  const secret = await open('.cache/go-camo.env', 'wx', 0o600);
  try { await secret.writeFile(`GOCAMO_HMAC=${randomBytes(32).toString('base64url')}\n`); }
  finally { await secret.close(); }
  console.info('Created a dedicated private mail-image signing secret.');
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
}
try {
  const secret = await open('.cache/meilisearch.env', 'wx', 0o600);
  try { await secret.writeFile(`MEILI_MASTER_KEY=${randomBytes(32).toString('base64url')}\n`); }
  finally { await secret.close(); }
  console.info('Created a dedicated private search-engine key.');
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
}
await chmod('.cache/tls', 0o700);
let keyExists = true;
let certExists = true;
try { await access('.cache/tls/key.pem'); } catch { keyExists = false; }
try { await access('.cache/tls/cert.pem'); } catch { certExists = false; }
if (keyExists !== certExists) throw new Error('The local TLS pair is incomplete. Repair .cache/tls before starting the app.');
if (keyExists) {
  const validity = spawnSync('openssl', ['x509', '-checkend', '86400', '-noout', '-in', '.cache/tls/cert.pem'], { stdio: 'ignore' });
  if (validity.status !== 0) {
    await unlink('.cache/tls/key.pem');
    await unlink('.cache/tls/cert.pem');
    keyExists = false;
  }
}
if (!keyExists) {
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '.cache/tls/key.pem', '-out', '.cache/tls/cert.pem', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-days', '7'], { stdio: 'ignore' });
  if (result.status !== 0) throw new Error('Could not create the local TLS certificate. Install OpenSSL or configure an HTTPS reverse proxy.');
  await chmod('.cache/tls/key.pem', 0o600);
  console.info('Created a private, short-lived localhost TLS certificate.');
}
if (process.getuid() === 0) {
  await chown('.cache/tls', 1000, 1000);
  await chown('.cache/tls/key.pem', 1000, 1000);
  await chown('.cache/tls/cert.pem', 1000, 1000);
}
