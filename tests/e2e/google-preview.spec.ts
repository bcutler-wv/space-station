import { expect, test } from '@playwright/test';

const origin = 'https://localhost:8083';
const accountId = '11111111-1111-4111-8111-111111111111';
const orbitId = '22222222-2222-4222-8222-222222222222';
const setup = { version: 1, configuredOrigin: origin, confirmedOrigin: origin, completed: true,
  orbit: { id: orbitId, name: 'Example work', colorSlot: 1, context: 'Example only' },
  globalDefaults: { index: 'exclude', ai: 'exclude' }, orbitDefaults: { index: 'exclude', ai: 'exclude' }, exclusions: [] };
const status = { redirectUri: `${origin}/api/google/callback`, pendingConfirmation: false, pendingReconnectAccountId: null,
  accounts: [{ id: accountId, email: 'owner@example.com', orbitId, grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'], backfill: null, status: 'connected' }] };

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
  await expect(page.getByText('Backfill choice: 1 year. Mail sync is pending implementation.')).toBeVisible();
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
