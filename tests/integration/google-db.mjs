import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { generate } from 'otplib';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../apps/server/dist/app.js';
import { authStore, digest } from '../../apps/server/dist/auth-store.js';
import { databaseUrl, loadRuntimeConfig, openDatabase, accounts, auditLog, oauthApps, oauthAttempts } from '../../packages/db/dist/index.js';
import { databaseSetupStore } from '../../apps/server/dist/setup-store.js';
import { GoogleCredentialService, GoogleCredentialError, openSecret } from '../../packages/connectors/dist/index.js';

const config = loadRuntimeConfig(process.env);
const database = openDatabase(databaseUrl(config));
const origin = 'https://example.com';
const key = Buffer.from(config.STATION_MASTER_KEY, 'base64');
const store = authStore(database.db);
const calls = [];
let profileEmail = 'owner@example.com';
let holdToken = false;
let releaseToken;
let tokenEntered;
let providerMode = 'ok';
const transport = { interceptors: { request: { add() {} }, response: { add() {} } }, async request(options) {
  calls.push(options);
  if (options.url?.includes('/token')) {
    if (holdToken) { tokenEntered(); await new Promise((resolve) => { releaseToken = resolve; }); }
    if (providerMode === 'token_error') throw new Error('raw provider payload fixture-secret fixture-code');
    if (options.data?.get('grant_type') === 'refresh_token') {
      if (providerMode === 'refresh_invalid') throw { response: { data: { error: 'invalid_grant', error_description: 'fixture-private' }, status: 400 } };
      if (providerMode === 'refresh_invalid_client') throw { response: { data: { error: 'invalid_client', error_description: 'fixture-private' }, status: 401 } };
      if (providerMode === 'refresh_transient') throw { response: { data: { error: 'temporarily_unavailable' }, status: 503, headers: { 'retry-after': '0' } } };
      return { data: { access_token: `fixture-${providerMode}-access`,
        ...(providerMode === 'refresh_rotate' ? { refresh_token: 'fixture-rotated-refresh' } : {}),
        ...(providerMode === 'refresh_scope' ? { scope: 'https://www.googleapis.com/auth/gmail.readonly' } : {}),
        expires_in: 3600, token_type: 'Bearer' } };
    }
    return { data: { access_token: 'fixture-access',
      ...(providerMode === 'missing_refresh' ? {} : { refresh_token: 'fixture-refresh' }),
      scope: providerMode === 'missing_scope' ? 'https://www.googleapis.com/auth/gmail.readonly' : 'https://www.googleapis.com/auth/gmail.modify',
      token_type: 'Bearer', expires_in: 3600 } };
  }
  if (options.url?.includes('/profile')) {
    if (providerMode === 'profile_error') throw new Error('raw profile payload fixture-access fixture-refresh');
    return { data: { emailAddress: profileEmail } };
  }
  throw new Error('Unexpected provider URL in fixture.');
} };
const newApp = async () => {
  const app = buildApp(async () => {}, undefined, { origin, masterKey: key, db: database.db, store, googleTransport: transport }, { trustedProxyIp: '127.0.0.1' });
  await app.ready();
  return app;
};
let app = await newApp();
let cookie = '';
const send = async (method, url, payload, authenticated = true, csrf = '') => {
  const response = await app.inject({ method, url, remoteAddress: '127.0.0.1', headers: {
    'x-forwarded-proto': 'https',
    ...(authenticated && cookie ? { cookie } : {}),
    ...(method !== 'GET' ? { origin, 'x-csrf-token': csrf } : {}),
  }, ...(payload === undefined ? {} : { payload }) });
  const setCookie = response.headers['set-cookie'];
  if (authenticated && setCookie) cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  return response;
};
const status = async () => (await send('GET', '/api/auth/status')).json();
const begin = async (csrf) => {
  const response = await send('POST', '/api/google/start', { clientId: '123456-fixture.apps.googleusercontent.com', clientSecret: 'fixture-client-secret' }, true, csrf);
  assert.equal(response.statusCode, 200, response.body);
  return new URL(response.json().authorizationUrl).searchParams.get('state');
};
const callback = (state, code = 'fixture-code') => send('GET', `/api/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`, undefined, false);
const counts = async () => ({ accounts: (await database.db.select().from(accounts)).length, audit: (await database.db.select().from(auditLog)).length });
const nextTotp = async (totpSecret) => {
  await sleep(30_000 - Date.now() % 30_000 + 1200);
  return generate({ secret: totpSecret });
};
const resetTotp = async (recoveryCode) => {
  cookie = '';
  let resetCsrf = (await status()).csrfToken;
  const recovered = await send('POST', '/api/auth/login/recovery', { password: 'Example-only-password-123!', recoveryCode }, true, resetCsrf);
  assert.equal(recovered.statusCode, 200, recovered.body);
  resetCsrf = (await status()).csrfToken;
  const options = await send('POST', '/api/auth/reset/totp/options', {}, true, resetCsrf);
  assert.equal(options.statusCode, 200, options.body);
  const totpSecret = new URL(options.json().totpUri).searchParams.get('secret');
  resetCsrf = (await status()).csrfToken;
  const confirmed = await send('POST', '/api/auth/reset/totp/confirm', { code: await generate({ secret: totpSecret }) }, true, resetCsrf);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  return { totpSecret, recoveryCodes: confirmed.json().recoveryCodes };
};
try {
  assert.equal((await send('GET', '/api/google/status')).statusCode, 401);
  const bootstrap = randomBytes(32).toString('base64url');
  await store.issueBootstrap(digest(bootstrap), new Date(Date.now() + 60_000));
  let csrf = (await status()).csrfToken;
  const enrolled = await send('POST', '/api/auth/bootstrap/password', { bootstrapToken: bootstrap, displayName: 'Example Owner', password: 'Example-only-password-123!' }, true, csrf);
  assert.equal(enrolled.statusCode, 200, enrolled.body);
  csrf = (await status()).csrfToken;
  const secret = new URL(enrolled.json().totpUri).searchParams.get('secret');
  const verified = await send('POST', '/api/auth/bootstrap/totp', { code: await generate({ secret }) }, true, csrf);
  assert.equal(verified.statusCode, 200, verified.body);
  const recoveryCode = verified.json().recoveryCodes[0];
  csrf = (await status()).csrfToken;
  assert.equal((await send('GET', '/api/google/status')).statusCode, 409, 'setup gate');
  const setup = await send('POST', '/api/setup', {
    version: 1, confirmedOrigin: origin,
    orbit: { name: 'Example work', colorSlot: 1, context: 'Fixture Orbit' },
    globalDefaults: { index: 'exclude', ai: 'exclude' }, orbitDefaults: { index: 'exclude', ai: 'exclude' }, exclusions: [],
  }, true, csrf);
  assert.equal(setup.statusCode, 201, setup.body);
  csrf = (await status()).csrfToken;
  const started = await send('POST', '/api/google/start', { clientId: '123456-fixture.apps.googleusercontent.com', clientSecret: 'fixture-client-secret' }, true, csrf);
  assert.equal(started.statusCode, 200, started.body);
  const authorize = new URL(started.json().authorizationUrl);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  const state = authorize.searchParams.get('state');
  const [pending] = await database.db.select().from(oauthAttempts);
  assert.ok(pending);
  assert.equal(pending.stateHash, digest(state));
  assert.ok(pending.encryptedVerifier.startsWith('v1.'));
  assert.equal(JSON.stringify(pending).includes('fixture-client-secret'), false);
  const deniedState = await begin(csrf);
  const denied = await send('GET', `/api/google/callback?state=${encodeURIComponent(deniedState)}&error=access_denied`, undefined, false);
  assert.equal(denied.statusCode, 302);
  const [deniedAttempt] = await database.db.select().from(oauthAttempts).where(eq(oauthAttempts.stateHash, digest(deniedState)));
  assert.equal(deniedAttempt.status, 'failed');
  assert.equal(deniedAttempt.encryptedCode, null);
  assert.equal(deniedAttempt.encryptedVerifier, '');
  for (const mode of ['missing_refresh', 'missing_scope', 'token_error', 'profile_error']) {
    providerMode = mode;
    const failedState = await begin(csrf);
    await callback(failedState, `fixture-code-${mode}`);
    const beforeFailure = await counts();
    const failed = await send('POST', '/api/google/confirm', {}, true, csrf);
    assert.equal(failed.statusCode, mode.startsWith('missing_') ? 403 : 502, `${mode}: ${failed.body}`);
    for (const sensitive of ['fixture-client-secret', 'fixture-code', 'fixture-access', 'fixture-refresh', 'raw provider payload', 'raw profile payload']) {
      assert.equal(failed.body.includes(sensitive), false, `${mode}: API error leaked provider material`);
    }
    const [failedAttempt] = await database.db.select().from(oauthAttempts).where(eq(oauthAttempts.stateHash, digest(failedState)));
    assert.equal(failedAttempt.status, 'failed');
    assert.equal(failedAttempt.encryptedCode, null);
    assert.equal(failedAttempt.encryptedVerifier, '');
    assert.equal((await send('POST', '/api/google/confirm', {}, true, csrf)).statusCode, 409, 'terminal failure cannot replay');
    assert.deepEqual(await counts(), beforeFailure, `${mode}: no link or audit`);
  }
  providerMode = 'ok';
  assert.equal((await send('GET', `/api/google/callback?state=malformed&code=bad`, undefined, false)).statusCode, 302);
  assert.equal((await send('GET', `/api/google/callback?state=${encodeURIComponent(state)}&state=duplicate&code=bad`, undefined, false)).statusCode, 302);
  assert.equal((await send('GET', '/api/google/status')).json().pendingConfirmation, false);
  const returned = await send('GET', `/api/google/callback?state=${encodeURIComponent(state)}&code=fixture-code&scope=mail&authuser=0&prompt=consent`, undefined, false);
  assert.equal(returned.statusCode, 302, returned.body);
  assert.equal(returned.headers.location, '/setup/google/continue');
  assert.equal(returned.headers.location.includes('fixture-code'), false);
  assert.equal(returned.headers['referrer-policy'], 'no-referrer');
  const setupStore = databaseSetupStore(database.db);
  await setupStore.reconfirmOrigin('https://stale.example.com');
  const callsBeforeStale = calls.length;
  assert.equal((await send('GET', '/api/google/status')).statusCode, 409, 'stale configured origin hides connection status');
  assert.equal((await send('POST', '/api/google/confirm', {}, true, csrf)).statusCode, 409, 'stale origin blocks exchange');
  assert.equal((await send('POST', '/api/google/start', { clientId: '123456-fixture.apps.googleusercontent.com', clientSecret: 'fixture-client-secret' }, true, csrf)).statusCode, 409);
  assert.equal(calls.length, callsBeforeStale);
  await setupStore.reconfirmOrigin(origin);
  const replay = await send('GET', `/api/google/callback?state=${encodeURIComponent(state)}&code=second-code`, undefined, false);
  assert.equal(replay.statusCode, 302);
  await app.close();
  app = await newApp();
  assert.equal((await send('GET', '/api/google/status')).json().pendingConfirmation, true, 'continuation survives restart');
  csrf = (await status()).csrfToken;
  const beforeDenied = await counts();
  const callsBeforeDenied = calls.length;
  assert.equal((await send('POST', '/api/google/confirm', {}, false, csrf)).statusCode, 403, 'anonymous request fails CSRF before auth');
  assert.equal((await send('POST', '/api/google/confirm', {}, true, 'wrong')).statusCode, 403);
  const wrongOrigin = await app.inject({ method: 'POST', url: '/api/google/confirm', remoteAddress: '127.0.0.1', headers: { cookie, 'x-forwarded-proto': 'https', origin: 'https://wrong.example.com', 'x-csrf-token': csrf }, payload: {} });
  assert.equal(wrongOrigin.statusCode, 403);
  const originalCookie = cookie;
  cookie = '';
  let otherCsrf = (await status()).csrfToken;
  assert.equal((await send('POST', '/api/google/confirm', {}, true, otherCsrf)).statusCode, 401, 'anonymous session with its own CSRF cannot confirm');
  const secondLogin = await send('POST', '/api/auth/login/password', { password: 'Example-only-password-123!', code: await nextTotp(secret) }, true, otherCsrf);
  assert.equal(secondLogin.statusCode, 200, secondLogin.body);
  otherCsrf = (await status()).csrfToken;
  assert.equal((await send('GET', '/api/google/status')).json().pendingConfirmation, false, 'a different full owner session cannot discover callback');
  assert.equal((await send('POST', '/api/google/confirm', {}, true, otherCsrf)).statusCode, 409, 'a different full owner session cannot confirm callback');
  cookie = '';
  const recoveryCsrf = (await status()).csrfToken;
  const recovery = await send('POST', '/api/auth/login/recovery', { password: 'Example-only-password-123!', recoveryCode }, true, recoveryCsrf);
  assert.equal(recovery.statusCode, 200, recovery.body);
  assert.equal((await send('POST', '/api/google/confirm', {}, true, (await status()).csrfToken)).statusCode, 401, 'recovery session cannot link');
  cookie = originalCookie;
  assert.deepEqual(await counts(), beforeDenied);
  assert.equal(calls.length, callsBeforeDenied, 'session and CSRF denials never call Google');
  const callsBeforeLink = calls.length;
  const confirm = await send('POST', '/api/google/confirm', {}, true, csrf);
  assert.equal(confirm.statusCode, 200, confirm.body);
  assert.equal(calls.length - callsBeforeLink, 2, 'successful link uses only token and profile calls');
  assert.equal((await send('POST', '/api/google/confirm', {}, true, csrf)).statusCode, 409, 'confirmation is single-use');
  const [account] = await database.db.select().from(accounts);
  assert.equal(account.email, 'owner@example.com');
  assert.equal(account.backfill, null, 'sync remains gated');
  assert.ok(account.encryptedRefreshToken.startsWith('v1.'));
  assert.equal(JSON.stringify(account).includes('fixture-refresh'), false);
  assert.equal((await database.db.select().from(auditLog)).length, 1);
  const publicStatus = (await send('GET', '/api/google/status')).body;
  assert.equal(publicStatus.includes('fixture-refresh'), false);
  assert.equal(publicStatus.includes('fixture-client-secret'), false);
  const backfill = await send('POST', '/api/google/backfill', { accountId: account.id, window: '30_days' }, true, csrf);
  assert.equal(backfill.statusCode, 200, backfill.body);
  assert.equal(calls.length - callsBeforeLink, 2, 'backfill selection makes no provider call');
  const [saved] = await database.db.select().from(accounts).where(eq(accounts.id, account.id));
  assert.equal(saved.backfill, '30_days');
  const credentials = new GoogleCredentialService(database.db, key, transport);
  const forceExpiry = async () => database.db.update(accounts).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(accounts.id, account.id));
  await forceExpiry();
  providerMode = 'refresh_rotate';
  assert.equal((await credentials.get(account.id)).accessToken, 'fixture-refresh_rotate-access');
  let [refreshed] = await database.db.select().from(accounts).where(eq(accounts.id, account.id));
  assert.equal(openSecret(refreshed.encryptedRefreshToken, key, `accounts/${account.id}/refresh`), 'fixture-rotated-refresh');
  await forceExpiry();
  providerMode = 'refresh_no_rotation';
  await credentials.get(account.id);
  [refreshed] = await database.db.select().from(accounts).where(eq(accounts.id, account.id));
  assert.equal(openSecret(refreshed.encryptedRefreshToken, key, `accounts/${account.id}/refresh`), 'fixture-rotated-refresh');
  await forceExpiry();
  providerMode = 'refresh_transient';
  await assert.rejects(credentials.get(account.id), (error) => error instanceof GoogleCredentialError && error.code === 'transient');
  assert.equal((await database.db.select().from(accounts).where(eq(accounts.id, account.id)))[0].revokedAt, null);
  providerMode = 'ok';
  const reconnectPayload = { accountId: account.id, clientId: '123456-fixture.apps.googleusercontent.com', clientSecret: 'fixture-client-secret' };
  const reconnect = async () => {
    const started = await send('POST', '/api/google/reconnect/start', reconnectPayload, true, csrf);
    assert.equal(started.statusCode, 200, started.body);
    await callback(new URL(started.json().authorizationUrl).searchParams.get('state'));
    return send('POST', '/api/google/confirm', {}, true, csrf);
  };
  profileEmail = 'wrong@example.com';
  assert.equal((await reconnect()).statusCode, 409, 'reconnect rejects a different mailbox');
  profileEmail = 'owner@example.com';
  await forceExpiry();
  providerMode = 'refresh_hold';
  holdToken = true;
  const refreshEntered = new Promise((resolve) => { tokenEntered = resolve; });
  const heldRefresh = credentials.get(account.id);
  await refreshEntered;
  await assert.rejects(credentials.get(account.id), (error) => error instanceof GoogleCredentialError && error.code === 'busy', 'second refresh observes the lease');
  // The OAuth exchange uses the same fixture transport, so release the held refresh
  // only after reconnect has acquired its provider response.
  holdToken = false;
  providerMode = 'ok';
  assert.equal((await reconnect()).statusCode, 200);
  releaseToken();
  await assert.rejects(heldRefresh, (error) => error instanceof GoogleCredentialError && error.code === 'busy');
  [refreshed] = await database.db.select().from(accounts).where(eq(accounts.id, account.id));
  assert.equal(refreshed.id, account.id);
  assert.equal(refreshed.backfill, '30_days');
  assert.equal(refreshed.orbitId, account.orbitId);
  assert.equal(refreshed.revokedAt, null);
  assert.equal((await database.db.select().from(auditLog)).filter((row) => row.action === 'reconnect_account').length, 1);
  assert.equal((await send('GET', '/api/google/status')).body.includes('fixture-rotated-refresh'), false, 'metadata response has no credentials');
  await forceExpiry();
  providerMode = 'refresh_scope';
  await assert.rejects(credentials.get(account.id), (error) => error instanceof GoogleCredentialError && error.code === 'needs_reconnect');
  assert.equal((await send('GET', '/api/google/status')).json().accounts.find((row) => row.id === account.id).status, 'needs_reconnect');
  providerMode = 'ok';
  assert.equal((await reconnect()).statusCode, 200, 'same account can recover from lost scope');
  await forceExpiry();
  providerMode = 'refresh_invalid';
  await assert.rejects(credentials.get(account.id), (error) => error instanceof GoogleCredentialError && error.code === 'needs_reconnect');
  assert.equal((await send('GET', '/api/google/status')).json().accounts.find((row) => row.id === account.id).status, 'needs_reconnect');
  providerMode = 'ok';
  assert.equal((await reconnect()).statusCode, 200, 'same account can recover from invalid_grant');
  const holdPermanentAfterReconnect = async (mode) => {
    await forceExpiry();
    providerMode = 'ok';
    holdToken = true;
    const entered = new Promise((resolve) => { tokenEntered = resolve; });
    const stale = credentials.get(account.id);
    await entered;
    holdToken = false;
    assert.equal((await reconnect()).statusCode, 200);
    const [afterReconnect] = await database.db.select().from(accounts).where(eq(accounts.id, account.id));
    providerMode = mode;
    releaseToken();
    await assert.rejects(stale, (error) => error instanceof GoogleCredentialError && error.code === 'busy', `${mode} from an old generation is retryable`);
    const [afterStale] = await database.db.select().from(accounts).where(eq(accounts.id, account.id));
    assert.equal(afterStale.credentialGeneration, afterReconnect.credentialGeneration);
    assert.equal(afterStale.encryptedRefreshToken, afterReconnect.encryptedRefreshToken);
    assert.equal(afterStale.encryptedAccessToken, afterReconnect.encryptedAccessToken);
    assert.equal(afterStale.revokedAt, null);
    providerMode = 'ok';
  };
  await holdPermanentAfterReconnect('refresh_invalid');
  await holdPermanentAfterReconnect('refresh_scope');
  await forceExpiry();
  providerMode = 'refresh_invalid_client';
  await assert.rejects(credentials.get(account.id), (error) => error instanceof GoogleCredentialError && error.code === 'needs_reconnect');
  assert.equal((await reconnect()).statusCode, 200, 'incorrect client secret can be replaced');
  providerMode = 'ok';
  const expectCorruptCredentialRecovery = async (field, table) => {
    if (table === 'account') await database.db.update(accounts).set({ [field]: 'corrupt',
      accessTokenExpiresAt: new Date(Date.now() + (field === 'encryptedAccessToken' ? 3_600_000 : -1000)) }).where(eq(accounts.id, account.id));
    else {
      const [linked] = await database.db.select().from(accounts).where(eq(accounts.id, account.id));
      await database.db.update(oauthApps).set({ encryptedClientSecret: 'corrupt' }).where(eq(oauthApps.id, linked.appId));
      await forceExpiry();
    }
    const callsBefore = calls.length;
    await assert.rejects(credentials.get(account.id), (error) => error instanceof GoogleCredentialError && error.code === 'needs_reconnect');
    assert.equal(calls.length, callsBefore, 'unreadable local credentials never reach Google');
    assert.equal((await send('GET', '/api/google/status')).json().accounts.find((row) => row.id === account.id).status, 'needs_reconnect');
    assert.equal((await reconnect()).statusCode, 200, 'reconnect replaces unreadable credentials');
  };
  await expectCorruptCredentialRecovery('encryptedAccessToken', 'account');
  await expectCorruptCredentialRecovery('encryptedRefreshToken', 'account');
  await expectCorruptCredentialRecovery('encryptedClientSecret', 'app');
  await forceExpiry();
  const [beforeRestart] = await database.db.select().from(accounts).where(eq(accounts.id, account.id));
  await database.db.update(accounts).set({ credentialLeaseUntil: new Date(Date.now() - 1000) }).where(eq(accounts.id, account.id));
  assert.equal((await new GoogleCredentialService(database.db, key, transport).get(account.id)).accessToken, 'fixture-ok-access', 'expired lease is recovered by a new service instance');
  assert.equal((await database.db.select().from(accounts).where(eq(accounts.id, account.id)))[0].credentialGeneration, beforeRestart.credentialGeneration + 1);
  profileEmail = 'second@example.com';
  csrf = (await status()).csrfToken;
  const second = await send('POST', '/api/google/start', { clientId: '123456-fixture.apps.googleusercontent.com', clientSecret: 'fixture-client-secret' }, true, csrf);
  assert.equal(second.statusCode, 200, second.body);
  const secondState = new URL(second.json().authorizationUrl).searchParams.get('state');
  await send('GET', `/api/google/callback?state=${encodeURIComponent(secondState)}&code=second-fixture`, undefined, false);
  const concurrent = await Promise.all([send('POST', '/api/google/confirm', {}, true, csrf), send('POST', '/api/google/confirm', {}, true, csrf)]);
  assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal((await database.db.select().from(accounts)).length, 2);
  const racedStarts = await Promise.all(Array.from({ length: 4 }, () => send('POST', '/api/google/start', {
    clientId: '123456-fixture.apps.googleusercontent.com', clientSecret: 'fixture-client-secret',
  }, true, csrf)));
  assert.deepEqual(racedStarts.map((response) => response.statusCode).sort(), [200, 200, 200, 429], 'attempt cap is atomic');
  const expiredState = new URL(racedStarts.find((response) => response.statusCode === 200).json().authorizationUrl).searchParams.get('state');
  const activeAttempts = (await database.db.select().from(oauthAttempts)).filter((row) => row.status === 'started');
  assert.equal(activeAttempts.length, 3);
  for (const row of activeAttempts) await database.db.update(oauthAttempts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(oauthAttempts.id, row.id));
  assert.equal((await send('GET', `/api/google/callback?state=${encodeURIComponent(expiredState)}&code=expired`, undefined, false)).statusCode, 302);
  assert.equal((await send('GET', '/api/google/status')).json().pendingConfirmation, false);
  profileEmail = 'third@example.com';
  const third = await send('POST', '/api/google/start', { clientId: '123456-fixture.apps.googleusercontent.com', clientSecret: 'fixture-client-secret' }, true, csrf);
  assert.equal(third.statusCode, 200, third.body);
  for (const row of activeAttempts) {
    assert.equal((await database.db.select().from(oauthAttempts).where(eq(oauthAttempts.id, row.id))).length, 0, 'expired verifier removed');
    assert.equal((await database.db.select().from(oauthApps).where(eq(oauthApps.id, row.appId))).length, 0, 'orphan client secret removed');
  }
  const thirdState = new URL(third.json().authorizationUrl).searchParams.get('state');
  await send('GET', `/api/google/callback?state=${encodeURIComponent(thirdState)}&code=third-fixture`, undefined, false);
  holdToken = true;
  const entered = new Promise((resolve) => { tokenEntered = resolve; });
  const lateConfirm = send('POST', '/api/google/confirm', {}, true, csrf);
  await entered;
  assert.equal((await send('POST', '/api/auth/logout', {}, true, csrf)).statusCode, 200);
  releaseToken();
  assert.equal((await lateConfirm).statusCode, 409, 'logout during exchange prevents link');
  assert.equal((await database.db.select().from(accounts)).length, 2);
  const logoutAttempt = (await database.db.select().from(oauthAttempts).where(eq(oauthAttempts.stateHash, digest(thirdState))))[0];
  assert.equal(logoutAttempt.status, 'failed');
  assert.equal(logoutAttempt.encryptedCode, null);
  assert.equal(logoutAttempt.encryptedVerifier, '');
  holdToken = false;
  cookie = '';
  let freshCsrf = (await status()).csrfToken;
  const afterLogoutLogin = await send('POST', '/api/auth/login/password', { password: 'Example-only-password-123!', code: await nextTotp(secret) }, true, freshCsrf);
  assert.equal(afterLogoutLogin.statusCode, 200, afterLogoutLogin.body);
  freshCsrf = (await status()).csrfToken;
  const preResetState = await begin(freshCsrf);
  await callback(preResetState, 'before-reset-code');
  const pendingCookie = cookie;
  const beforeReset = await counts();
  const callsBeforeReset = calls.length;
  const resetOne = await resetTotp(verified.json().recoveryCodes[1]);
  cookie = pendingCookie;
  const staleConfirm = await send('POST', '/api/google/confirm', {}, true, freshCsrf);
  assert.ok([401, 403].includes(staleConfirm.statusCode), 'completed reset invalidates old session before exchange');
  assert.equal(calls.length, callsBeforeReset);
  assert.deepEqual(await counts(), beforeReset);
  cookie = '';
  freshCsrf = (await status()).csrfToken;
  const afterResetLogin = await send('POST', '/api/auth/login/password', { password: 'Example-only-password-123!', code: await nextTotp(resetOne.totpSecret) }, true, freshCsrf);
  assert.equal(afterResetLogin.statusCode, 200, afterResetLogin.body);
  freshCsrf = (await status()).csrfToken;
  const heldResetState = await begin(freshCsrf);
  await callback(heldResetState, 'during-reset-code');
  holdToken = true;
  const enteredReset = new Promise((resolve) => { tokenEntered = resolve; });
  const duringReset = send('POST', '/api/google/confirm', {}, true, freshCsrf);
  await enteredReset;
  const beforeHeldReset = await counts();
  await resetTotp(resetOne.recoveryCodes[0]);
  releaseToken();
  assert.equal((await duringReset).statusCode, 409, 'reset during exchange prevents link');
  assert.deepEqual(await counts(), beforeHeldReset);
  const heldAttempt = (await database.db.select().from(oauthAttempts).where(eq(oauthAttempts.stateHash, digest(heldResetState))))[0];
  assert.equal(heldAttempt.status, 'failed');
  assert.equal(heldAttempt.encryptedCode, null);
  assert.equal(heldAttempt.encryptedVerifier, '');
  process.stdout.write('Google strict-cookie callback, restart, single-use link, encrypted storage, and backfill fixture passed.\n');
} finally {
  await app.close();
  await database.close();
}
