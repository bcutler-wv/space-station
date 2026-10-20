import { expect, test } from '@playwright/test';

const account = '11111111-1111-4111-8111-111111111111';
const item = '33333333-3333-4333-8333-333333333333';

test('Vite development StrictMode replay loads body and logout remains terminal', async ({ page, baseURL }) => {
  let reads = 0;
  await page.route('**/api/**', route => route.fulfill({ status: 404, json: { error: 'fixture only' } }));
  await page.route('**/api/auth/status', route => route.fulfill({ json: {
    ownerExists: true, authenticated: true, recoveryAuthenticated: false,
    recoveryMode: null, pendingTotpUri: null, csrfToken: 'fixture-token',
  } }));
  await page.route('**/api/sync/events', route => route.fulfill({ status: 204 }));
  await page.route('**/api/mail/items/*/body?**', route => {
    reads++;
    return route.fulfill({ json: {
      itemId: item, status: 'available', text: null,
      html: '<p>StrictMode body is ready.</p>', htmlPolicyVersion: 1, imageRefs: [],
    } });
  });
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: {
    messageEnabled: false, messageChoice: null, effectiveRemoteEnabled: false,
    senderEnabled: false, senderAddress: null, refs: [],
  } }));

  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await expect(page.frameLocator('iframe[title="Message content"]').getByText('StrictMode body is ready.')).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(1);

  await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
  await expect(page.locator('iframe[title="Message content"]')).toHaveCount(0);
  await expect(page.getByText('Loading message…')).toHaveCount(0);
  const countAfterLogout = reads;
  await page.evaluate((url) => { history.pushState(null, '', url); window.dispatchEvent(new PopStateEvent('popstate')); },
    `/mail/body/${account}/44444444-4444-4444-8444-444444444444`);
  await expect(page.locator('iframe[title="Message content"]')).toHaveCount(0);
  expect(reads).toBe(countAfterLogout);
});
