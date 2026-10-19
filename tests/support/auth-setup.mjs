import { request } from '@playwright/test';
import process from 'node:process';
import { URL } from 'node:url';
import { readFile, mkdir, chmod, writeFile } from 'node:fs/promises';
import { generate } from 'otplib';

export default async function authSetup() {
  const baseURL = process.env.STATION_E2E_BASE_URL;
  if (!baseURL) return;
  const tokenPath = process.env.STATION_E2E_BOOTSTRAP_PATH;
  if (!tokenPath) throw new Error('STATION_E2E_BOOTSTRAP_PATH is required for runtime browser tests.');
  const context = await request.newContext({ baseURL, ignoreHTTPSErrors: true });
  try {
    const bootstrapToken = (await readFile(tokenPath, 'utf8')).trim();
    let state = await (await context.get('/api/auth/status')).json();
    if (!state.ownerExists) {
      const enrolled = await context.post('/api/auth/bootstrap/password', {
        headers: { Origin: baseURL, 'X-CSRF-Token': state.csrfToken },
        data: { bootstrapToken, displayName: 'Example Owner', password: 'Example-only-password-123!' },
      });
      if (!enrolled.ok()) throw new Error(`Owner enrollment failed (${enrolled.status()}).`);
      const { totpUri } = await enrolled.json();
      state = await (await context.get('/api/auth/status')).json();
      const secret = new URL(totpUri).searchParams.get('secret');
      if (!secret) throw new Error('Authenticator enrollment did not return a secret.');
      const verified = await context.post('/api/auth/bootstrap/totp', {
        headers: { Origin: baseURL, 'X-CSRF-Token': state.csrfToken },
        data: { code: await generate({ secret }) },
      });
      if (!verified.ok()) throw new Error(`Authenticator confirmation failed (${verified.status()}).`);
      const { recoveryCodes } = await verified.json();
      await mkdir('test-results', { recursive: true });
      await writeFile('test-results/auth-fixture.json', JSON.stringify({ secret, recoveryCode: recoveryCodes[0] }), { mode: 0o600, flag: 'wx' });
    }
    const destination = 'test-results/auth-state.json';
    await mkdir('test-results', { recursive: true });
    await context.storageState({ path: destination });
    await chmod(destination, 0o600);
  } finally {
    await context.dispose();
  }
}
