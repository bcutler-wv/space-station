import { expect, test } from '@playwright/test';

const account = '11111111-1111-4111-8111-111111111111';
const orbit = '22222222-2222-4222-8222-222222222222';
const draftId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = '2026-10-20T12:00:00.000Z';

test('Vite StrictMode keeps the draft active and ignores a held save after logout', async ({ page, baseURL }) => {
  let savedBody = 'Initial example text';
  let revision = 1;
  let saveCalls = 0;
  let hold = false;
  let started = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const snapshot = () => ({ id: draftId, accountId: account, orbitId: null, threadId: null, parentItemId: null,
    to: [{ address: 'recipient@example.com', name: '' }], cc: [], bcc: [], subject: 'StrictMode example',
    bodyText: savedBody, attachmentRefs: [], revision, state: 'editing', createdAt: now, updatedAt: now });
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Fixture only.' } }));
  await page.route('**/api/auth/status', (route) => route.fulfill({ json: { ownerExists: true, authenticated: true,
    recoveryAuthenticated: false, recoveryMode: null, pendingTotpUri: null, csrfToken: 'fixture-token' } }));
  await page.route('**/api/sync/events', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/mail/context', (route) => route.fulfill({ json: { orbits: [{ id: orbit, name: 'Example work', colorSlot: 1 }],
    accounts: [{ id: account, orbitId: orbit, email: 'owner@example.com', provider: 'google', needsReconnect: false }] } }));
  await page.route('**/api/mail/drafts/*/attachments?**', (route) => route.fulfill({ json: { attachments: [], revision } }));
  await page.route('**/api/mail/drafts/*?**', async (route) => {
    if (route.request().method() === 'PUT') {
      saveCalls++;
      if (hold) { started = true; await pending; }
      const body = route.request().postDataJSON();
      savedBody = body.bodyText; revision++;
      return route.fulfill({ json: snapshot() }).catch(() => undefined);
    }
    return route.fulfill({ json: snapshot() });
  });
  await page.goto(`${baseURL}/mail/draft/${account}/${draftId}?accountId=${account}`);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Initial example text');
  await page.getByRole('textbox', { name: 'Message' }).fill('Saved from StrictMode');
  await expect.poll(() => saveCalls).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Saved from StrictMode');
  hold = true;
  await page.getByRole('textbox', { name: 'Message' }).fill('Private held text');
  await expect.poll(() => started).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
  release();
  await expect(page.getByText('Private held text')).toHaveCount(0);
  await expect(page.getByText('Signing out…')).toBeVisible();
});
