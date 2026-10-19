import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';

const content = [
  `POSTGRES_PASSWORD=${randomBytes(32).toString('base64url')}`,
  `STATION_MASTER_KEY=${randomBytes(32).toString('base64')}`,
  'APP_PORT=8080',
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
