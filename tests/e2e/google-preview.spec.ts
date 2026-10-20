import { expect, test } from '@playwright/test';

const origin = 'https://localhost:8083';
const accountId = '11111111-1111-4111-8111-111111111111';
const orbitId = '22222222-2222-4222-8222-222222222222';
const setup = { version: 1, configuredOrigin: origin, confirmedOrigin: origin, completed: true,
  orbit: { id: orbitId, name: 'Example work', colorSlot: 1, context: 'Example only' },
  globalDefaults: { index: 'exclude', ai: 'exclude' }, orbitDefaults: { index: 'exclude', ai: 'exclude' }, exclusions: [] };
const status = { redirectUri: `${origin}/api/google/callback`, pendingConfirmation: false, pendingReconnectAccountId: null,
  accounts: [{ id: accountId, email: 'owner@example.com', orbitId, grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'], backfill: null, status: 'connected' }] };
test.beforeEach(async ({ page }) => {
  await page.route('**/api/sync/progress', route => route.fulfill({ json: { accounts: [{ accountId, orbitId, phase: 'waiting', repairCode: null, retryAt: null, processedPages: 0, supportedItems: 0, unsupportedItems: 0, lastSuccessAt: null }] } }));
});

test('flapping SSE responses back off without repeated auth checks', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  await page.route('**/api/appearance', route => route.fulfill({ json: { mode: 'light', seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
  await page.route('**/api/setup', route => route.fulfill({ json: setup }));
  await page.route('**/api/google/status', route => route.fulfill({ json: status }));
  let opens = 0;
  let authChecks = 0;
  await page.route('**/api/auth/status', route => { authChecks++; return route.continue(); });
  await page.route('**/api/sync/events', route => { opens++; return route.fulfill({ contentType: 'text/event-stream', body: 'event: sync-reset\nid: 0\ndata: ""\n\n' }); });
  await page.goto(`${baseURL}/setup/google`);
  await expect(page.getByRole('heading', { name: 'Connect Google mail' })).toBeVisible();
  await page.waitForTimeout(5_200);
  expect(opens).toBeGreaterThanOrEqual(2);
  expect(opens).toBeLessThanOrEqual(3);
  expect(authChecks).toBe(1);
});

test('stored counts and last mail update stay separate from catch-up state', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  await page.route('**/api/appearance', route => route.fulfill({ json: { mode: 'light', seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
  await page.route('**/api/setup', route => route.fulfill({ json: setup }));
  await page.route('**/api/google/status', route => route.fulfill({ json: { ...status, accounts: [{ ...status.accounts[0], backfill: '1_year' }] } }));
  await page.route('**/api/sync/progress', route => route.fulfill({ json: { accounts: [{ accountId, orbitId, phase: 'catchup', repairCode: null,
    retryAt: null, processedPages: 18, supportedItems: 12, unsupportedItems: 2, lastSuccessAt: '2026-10-20T12:00:00.000Z' }] } }));
  await page.goto(`${baseURL}/setup/google`);
  await expect(page.getByText('12 supported messages stored. 2 unsupported messages.')).toBeVisible();
  await expect(page.getByText(/Unsupported messages could not be processed/)).toBeVisible();
  await expect(page.getByText(/Last mail update:/)).toBeVisible();
  await expect(page.getByText(/ingestion pages processed|% complete/)).toHaveCount(0);
});

test('an open stream recovers after a transient progress read failure', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  await page.addInitScript(() => {
    const Native = window.EventSource;
    (window as unknown as { syncEvents: string[] }).syncEvents = [];
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        for (const name of ['open', 'error', 'sync-reset', 'sync-progress']) this.addEventListener(name, () => {
          (window as unknown as { syncEvents: string[] }).syncEvents.push(name);
        });
      }
    };
  });
  await page.route('**/api/appearance', route => route.fulfill({ json: { mode: 'light', seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
  await page.route('**/api/setup', route => route.fulfill({ json: setup }));
  await page.route('**/api/google/status', route => route.fulfill({ json: { ...status, accounts: [{ ...status.accounts[0], backfill: '1_year' }] } }));
  let recovered = false;
  await page.route('**/api/sync/progress', route => route.fulfill(recovered ? { json: { accounts: [{ accountId, orbitId, phase: 'current', repairCode: null,
    retryAt: null, processedPages: 2, supportedItems: 3, unsupportedItems: 0, lastSuccessAt: '2026-10-20T12:00:00.000Z' }] } }
    : { status: 503, json: { error: 'Fixture unavailable' } }));
  await page.goto(`${baseURL}/setup/google`);
  await expect(page.getByText('Sync status is unavailable. Reload to try again.')).toBeVisible();
  recovered = true;
  const event = await page.request.post(`${baseURL}/fixture/sync-event`);
  expect((await event.json()).streams).toBe(1);
  await expect(page.getByText('Mail is current as of the latest completed catch-up.')).toBeVisible().catch(async (error) => {
    process.stderr.write(`SSE recovery diagnostic: ${JSON.stringify(await page.evaluate(() => (window as unknown as { syncEvents: string[] }).syncEvents))}\n`);
    process.stderr.write(`Stream count: ${JSON.stringify(await (await page.request.post(`${baseURL}/fixture/sync-event`)).json())}\n`);
    throw error;
  });
});

test('hide and reconnect discard a delayed pre-hide progress response', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  await page.route('**/api/appearance', route => route.fulfill({ json: { mode: 'light', seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
  await page.route('**/api/setup', route => route.fulfill({ json: setup }));
  await page.route('**/api/google/status', route => route.fulfill({ json: { ...status, accounts: [{ ...status.accounts[0], backfill: '1_year' }] } }));
  const progress = (phase: 'current' | 'backfill') => ({ accounts: [{ accountId, orbitId, phase, repairCode: null, retryAt: null,
    processedPages: phase === 'current' ? 1 : 2, supportedItems: phase === 'current' ? 1 : 2,
    unsupportedItems: 0, lastSuccessAt: '2026-10-20T12:00:00.000Z' }] });
  let holdNext = false;
  let changed = false;
  let staleStarted!: () => void;
  let releaseStale!: () => void;
  const started = new Promise<void>(resolve => { staleStarted = resolve; });
  const released = new Promise<void>(resolve => { releaseStale = resolve; });
  let requests = 0;
  await page.route('**/api/sync/progress', async route => {
    requests++;
    if (holdNext) {
      holdNext = false;
      staleStarted();
      await released;
      await route.fulfill({ json: progress('current') }).catch(() => undefined);
    } else await route.fulfill({ json: progress(changed ? 'backfill' : 'current') });
  });
  await page.goto(`${baseURL}/setup/google`);
  await expect(page.getByText('Mail is current as of the latest completed catch-up.')).toBeVisible();
  holdNext = true;
  await page.request.post(`${baseURL}/fixture/sync-event`);
  await started;
  changed = true;
  await page.evaluate(() => {
    (window as unknown as { fixtureHidden: boolean }).fixtureHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => (window as unknown as { fixtureHidden: boolean }).fixtureHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.evaluate(() => { (window as unknown as { fixtureHidden: boolean }).fixtureHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByText('Importing the selected backfill window.')).toBeVisible();
  releaseStale();
  await page.waitForTimeout(200);
  await expect(page.getByText('Importing the selected backfill window.')).toBeVisible();
  await expect(page.getByText('Mail is current as of the latest completed catch-up.')).toHaveCount(0);
  expect(requests).toBeGreaterThanOrEqual(3);
});

test('frequent events let a slow healthy progress read finish', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  await page.route('**/api/appearance', route => route.fulfill({ json: { mode: 'light', seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
  await page.route('**/api/setup', route => route.fulfill({ json: setup }));
  await page.route('**/api/google/status', route => route.fulfill({ json: { ...status, accounts: [{ ...status.accounts[0], backfill: '1_year' }] } }));
  let slow = false;
  let slowStarted = 0;
  let slowCompleted = 0;
  await page.route('**/api/sync/progress', async route => {
    if (slow) { slowStarted++; await new Promise(resolve => setTimeout(resolve, 4_000)); }
    await route.fulfill({ json: { accounts: [{ accountId, orbitId, phase: slow ? 'backfill' : 'current', repairCode: null,
      retryAt: null, processedPages: 1, supportedItems: 1, unsupportedItems: 0, lastSuccessAt: '2026-10-20T12:00:00.000Z' }] } }).then(() => { if (slow) slowCompleted++; }).catch(() => undefined);
  });
  await page.goto(`${baseURL}/setup/google`);
  await expect(page.getByText('Mail is current as of the latest completed catch-up.')).toBeVisible();
  slow = true;
  await page.request.post(`${baseURL}/fixture/sync-event`);
  await expect.poll(() => slowStarted, { timeout: 5_000 }).toBeGreaterThan(0);
  const interval = setInterval(() => { void page.request.post(`${baseURL}/fixture/sync-event`); }, 700);
  try {
    await expect(page.getByText('Importing the selected backfill window.')).toBeVisible({ timeout: 5_500 });
    expect(slowCompleted).toBeGreaterThan(0);
  } finally { clearInterval(interval); }
});

test('logout discards a delayed progress response and closes the stream', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  await page.route('**/api/appearance', route => route.fulfill({ json: { mode: 'light', seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
  await page.route('**/api/setup', route => route.fulfill({ json: setup }));
  await page.route('**/api/google/status', route => route.fulfill({ json: { ...status, accounts: [{ ...status.accounts[0], backfill: '1_year' }] } }));
  let holdNext = false;
  let started!: () => void;
  let release!: () => void;
  const pendingStarted = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/sync/progress', async route => {
    if (holdNext) {
      holdNext = false; started(); await released;
      await route.fulfill({ json: { accounts: [{ accountId, orbitId, phase: 'current', repairCode: null, retryAt: null,
        processedPages: 2, supportedItems: 2, unsupportedItems: 0, lastSuccessAt: '2026-10-20T12:00:00.000Z' }] } }).catch(() => undefined);
    } else await route.fulfill({ json: { accounts: [{ accountId, orbitId, phase: 'backfill', repairCode: null, retryAt: null,
      processedPages: 1, supportedItems: 1, unsupportedItems: 0, lastSuccessAt: '2026-10-20T12:00:00.000Z' }] } });
  });
  await page.goto(`${baseURL}/setup/google`);
  await expect(page.getByText('Importing the selected backfill window.')).toBeVisible();
  holdNext = true;
  await page.request.post(`${baseURL}/fixture/sync-event`);
  await pendingStarted;
  await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
  release();
  await page.waitForTimeout(200);
  await expect(page.getByText('Mail is current as of the latest completed catch-up.')).toHaveCount(0);
  expect((await (await page.request.post(`${baseURL}/fixture/sync-event`)).json()).streams).toBe(0);
});

test('a hung progress request times out and a later event recovers', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  await page.route('**/api/appearance', route => route.fulfill({ json: { mode: 'light', seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
  await page.route('**/api/setup', route => route.fulfill({ json: setup }));
  await page.route('**/api/google/status', route => route.fulfill({ json: { ...status, accounts: [{ ...status.accounts[0], backfill: '1_year' }] } }));
  let hangNext = false;
  let recovered = false;
  let started!: () => void;
  let release!: () => void;
  const hanging = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/sync/progress', async route => {
    if (hangNext) {
      hangNext = false; started(); await released;
      await route.fulfill({ json: { accounts: [] } }).catch(() => undefined);
      return;
    }
    await route.fulfill({ json: { accounts: [{ accountId, orbitId, phase: recovered ? 'backfill' : 'current', repairCode: null,
      retryAt: null, processedPages: 1, supportedItems: 1, unsupportedItems: 0, lastSuccessAt: '2026-10-20T12:00:00.000Z' }] } });
  });
  await page.goto(`${baseURL}/setup/google`);
  await expect(page.getByText('Mail is current as of the latest completed catch-up.')).toBeVisible();
  hangNext = true;
  await page.request.post(`${baseURL}/fixture/sync-event`);
  await hanging;
  await expect(page.getByText('Sync status is unavailable. Reload to try again.')).toBeVisible({ timeout: 7_000 });
  recovered = true;
  await page.request.post(`${baseURL}/fixture/sync-event`);
  await expect(page.getByText('Importing the selected backfill window.')).toBeVisible({ timeout: 5_000 });
  release();
});

test('a confirmed passive 401 closes the stream and the sign-in form receives a fresh CSRF token', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  let signedIn = false;
  let statusChecks = 0;
  let streamOpens = 0;
  let loginCsrf = '';
  await page.route('**/api/auth/status', route => {
    statusChecks++;
    const authenticated = statusChecks === 1 || signedIn;
    return route.fulfill({ json: { ownerExists: true, authenticated, recoveryAuthenticated: false,
      recoveryMode: null, pendingTotpUri: null, csrfToken: authenticated ? 'old-csrf' : 'fresh-csrf' } });
  });
  await page.route('**/api/sync/events', route => { streamOpens++; return route.fulfill({ status: 401, json: { error: 'Sign in.' } }); });
  await page.route('**/api/sync/progress', route => route.fulfill({ status: 401, json: { error: 'Sign in.' } }));
  await page.route('**/api/auth/login/password', route => {
    loginCsrf = route.request().headers()['x-csrf-token'] ?? '';
    signedIn = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${baseURL}/`);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(statusChecks).toBe(2);
  expect(streamOpens).toBeLessThanOrEqual(2);
  await page.getByLabel('Password', { exact: true }).fill('Example-only-password-123!');
  await page.getByLabel('Authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Good morning, Alex')).toBeVisible();
  expect(loginCsrf).toBe('fresh-csrf');
});

test('direct Google route shows persisted theme, copy fallback, validation and clears the secret', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }));
  await page.route('**/api/appearance', route => route.fulfill({ json: { mode: 'dark', seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
  await page.route('**/api/setup', route => route.fulfill({ json: setup }));
  await page.route('**/api/google/status', route => route.fulfill({ json: status }));
  let starts = 0;
  await page.route('**/api/google/start', route => {
    starts++;
    return route.fulfill(starts === 1 ? { status: 400, json: { error: 'Check the web client details.' } } : { json: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state' } });
  });
  await page.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture consent</h1>' }));
  await page.goto(`${baseURL}/setup/google`);
  await expect(page.getByRole('heading', { name: 'Connect Google mail' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByText('Orbit: Example work. Gmail mail access is authorized.')).toBeVisible();
  await expect(page.getByLabel('Authorized redirect URI', { exact: true })).toHaveValue(`${origin}/api/google/callback`);
  await expect(page.getByLabel('Gmail scope', { exact: true })).toHaveValue('https://www.googleapis.com/auth/gmail.modify');
  await page.getByRole('button', { name: 'Copy Authorized redirect URI' }).click();
  await expect(page.getByText('Value selected. Copy it with your keyboard.')).toBeVisible();
  await page.getByLabel('Web client ID').fill('bad-id');
  await page.getByLabel('Web client secret').fill('fixture-secret');
  await page.getByRole('button', { name: 'Continue to Google' }).click();
  await expect(page.getByLabel('Web client ID')).toBeFocused();
  await expect.poll(() => starts).toBe(0);
  await page.getByLabel('Web client ID').fill('123456-fixture.apps.googleusercontent.com');
  await page.getByRole('button', { name: 'Continue to Google' }).click();
  await expect(page.getByRole('alert')).toContainText('Check the web client details.');
  await expect(page.getByLabel('Web client secret')).toHaveValue('');
  await page.getByLabel('Web client secret').fill('fixture-secret');
  await page.getByRole('button', { name: 'Continue to Google' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture consent' })).toBeVisible();
  await page.goBack();
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByLabel('Web client secret')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Continue to Google' })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('reconnect keeps an explicit target and clears the secret after errors and browser history restore', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  let mode = 'light';
  await page.route('**/api/appearance', route => route.fulfill({ json: { mode, seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
  await page.route('**/api/setup', route => route.fulfill({ json: setup }));
  await page.route('**/api/google/status', route => route.fulfill({ json: { ...status, accounts: [{ ...status.accounts[0], status: 'needs_reconnect', backfill: '1_year' }] } }));
  const payloads: unknown[] = [];
  await page.route('**/api/google/reconnect/start', route => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill(payloads.length === 1 ? { status: 503, json: { error: 'Google connection could not start. Try again.' } } : { json: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state' } });
  });
  await page.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture consent</h1>' }));
  await page.goto(`${baseURL}/setup/google`);
  await expect(page.getByText(/Gmail mail access needs renewal/)).toBeVisible();
  await expect(page.getByText('Backfill choice: 1 year.')).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect owner@example.com' }).click();
  await expect(page.getByRole('heading', { name: 'Set up a Google web client' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Reconnect Google mail' })).toBeVisible();
  await page.screenshot({ path: 'test-results/google-reconnect-light.png', fullPage: true });
  await page.getByLabel('Web client ID').fill('123456-fixture.apps.googleusercontent.com');
  await page.getByLabel('Web client secret').fill('fixture-secret');
  await page.getByRole('button', { name: 'Continue to Google for owner@example.com' }).click();
  await expect(page.getByRole('alert')).toContainText('Try again');
  await expect(page.getByLabel('Web client secret')).toHaveValue('');
  await expect.poll(() => payloads.length).toBe(1);
  expect(payloads[0]).toEqual({ accountId, clientId: '123456-fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret' });
  await page.getByLabel('Web client secret').fill('fixture-secret');
  await page.getByRole('button', { name: 'Continue to Google for owner@example.com' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture consent' })).toBeVisible();
  await page.goBack();
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByLabel('Web client secret')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Continue to Google for owner@example.com' })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  mode = 'dark';
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/google-reconnect-mobile-dark.png', fullPage: true });
});

test('return confirmation names the reconnect mailbox and waits for an explicit click', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
  await page.route('**/api/appearance', route => route.fulfill({ json: { mode: 'dark', seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
  await page.route('**/api/google/status', route => route.fulfill({ json: { ...status, pendingConfirmation: true, pendingReconnectAccountId: accountId } }));
  let confirms = 0;
  await page.route('**/api/google/confirm', route => { confirms++; return route.fulfill({ status: 409, json: { error: 'Google returned a different mailbox. Choose the original mailbox and try reconnecting.' } }); });
  await page.goto(`${baseURL}/setup/google/continue`);
  await expect(page.getByText(/Confirm reconnecting owner@example.com/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm Google reconnect' })).toBeFocused();
  expect(confirms).toBe(0);
  await page.getByRole('button', { name: 'Confirm Google reconnect' }).click();
  await expect(page.getByRole('alert')).toContainText('Choose the original mailbox');
  expect(confirms).toBe(1);
});

for (const reconnect of [true, false]) {
  test(`${reconnect ? 'reconnect' : 'first connection'} success keeps accurate copy after pending status clears`, async ({ page, baseURL }) => {
    test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'The runtime flow uses the isolated HTTPS Google browser fixture.');
    await page.route('**/api/appearance', route => route.fulfill({ json: { mode: 'light', seed: 4284763300, showWallpaper: true, hasWallpaper: false } }));
    let pending = true;
    let statusLoads = 0;
    await page.route('**/api/google/status', route => {
      statusLoads++;
      return route.fulfill({ json: { ...status, pendingConfirmation: pending, pendingReconnectAccountId: pending && reconnect ? accountId : null } });
    });
    let confirms = 0;
    await page.route('**/api/google/confirm', route => {
      confirms++;
      pending = false;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto(`${baseURL}/setup/google/continue`);
    const confirmButton = page.getByRole('button', { name: reconnect ? 'Confirm Google reconnect' : 'Confirm Google connection' });
    await expect(confirmButton).toBeFocused();
    expect(confirms).toBe(0);
    await confirmButton.click();
    await expect(page.getByRole('status')).toContainText(reconnect ? 'Account reconnected. The account, Orbit, and backfill choice are unchanged.' : 'Account connected.');
    expect(confirms).toBe(1);
    await expect.poll(() => statusLoads).toBeGreaterThan(1);
    await expect(page.getByRole('link', { name: 'View Google accounts' })).toBeVisible();
  });
}
