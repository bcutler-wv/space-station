import { expect, test } from '@playwright/test';

const origin = 'https://localhost:8083';
const accountId = '11111111-1111-4111-8111-111111111111';
const orbitId = '22222222-2222-4222-8222-222222222222';
const setup = { version: 1, configuredOrigin: origin, confirmedOrigin: origin, completed: true,
  orbit: { id: orbitId, name: 'Example work', colorSlot: 1, context: 'Example only' },
  globalDefaults: { index: 'exclude', ai: 'exclude' }, orbitDefaults: { index: 'exclude', ai: 'exclude' }, exclusions: [] };
const status = { redirectUri: `${origin}/api/google/callback`, pendingConfirmation: false,
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
