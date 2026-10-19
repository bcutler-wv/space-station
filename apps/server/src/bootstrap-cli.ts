import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { authStore, digest } from './auth-store.js';
import { databaseUrl, loadRuntimeConfig, openDatabase } from '@station/db';

const path = process.argv[2];
if (!path || !path.startsWith('/run/bootstrap/')) throw new Error('Give a private output path under /run/bootstrap/.');
const config = loadRuntimeConfig(process.env);
const db = openDatabase(databaseUrl(config));
try {
  const value = randomBytes(32).toString('base64url');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${value}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await authStore(db.db).issueBootstrap(digest(value), new Date(Date.now() + 15 * 60_000));
  } catch (error) {
    const { unlink } = await import('node:fs/promises');
    await unlink(path);
    throw error;
  }
  process.stdout.write(`Setup token saved to ${path}. It expires in 15 minutes.\n`);
} finally {
  await db.close();
}
