import { expect, test } from '@playwright/test';
const orbit = '22222222-2222-4222-8222-222222222222';
const account = '11111111-1111-4111-8111-111111111111';
const thread = '77777777-7777-4777-8777-777777777777';
const item = '33333333-3333-4333-8333-333333333333';

test('Vite StrictMode replay loads mail navigation and lazy body across scope changes', async ({ page, baseURL }) => {
  let listReads = 0;
  let bodyReads = 0;
  await page.route('**/api/**', route => route.fulfill({ status: 404, json: { error: 'fixture only' } }));
  await page.route('**/api/auth/status', route => route.fulfill({ json: {
    ownerExists: true, authenticated: true, recoveryAuthenticated: false,
    recoveryMode: null, pendingTotpUri: null, csrfToken: 'fixture-token',
  } }));
  await page.route('**/api/sync/events', route => route.fulfill({ status: 204 }));
  await page.route('**/api/mail/context', route => route.fulfill({ json: {
    orbits: [{ id: orbit, name: 'Example work', colorSlot: 1 }],
    accounts: [{ id: account, orbitId: orbit, email: 'owner@example.com', provider: 'google', needsReconnect: false }],
  } }));
  await page.route('**/api/mail/labels?**', route => route.fulfill({ json: { labels: [] } }));
  await page.route('**/api/mail/conversations?**', route => {
    listReads++;
    return route.fulfill({ json: { conversations: [{ threadId: thread, accountId: account, subject: 'StrictMode conversation', snippet: 'Ready', lastActivityAt: '2026-10-20T12:00:00.000Z', messageCount: 1 }], nextCursor: null } });
  });
  await page.route('**/api/mail/threads/*/messages?**', route => route.fulfill({ json: { messages: [{
    id: item, threadId: thread, accountId: account, subject: 'StrictMode conversation', snippet: 'Ready',
    internalAt: '2026-10-20T12:00:00.000Z', sentAt: null, receivedAt: null, direction: 'in', parseStatus: 'supported',
    from: { name: 'Sender', address: 'sender@example.com' }, labels: [], recipients: [], attachments: [],
  }], nextCursor: null } }));
  await page.route('**/api/mail/items/*/body?**', route => { bodyReads++; return route.fulfill({ json: {
    itemId: item, status: 'available', text: 'StrictMode body is ready.', html: null, htmlPolicyVersion: null, imageRefs: [],
  } }); });
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: {
    messageEnabled: false, messageChoice: null, effectiveRemoteEnabled: false, senderEnabled: false, senderAddress: null, refs: [],
  } }));
  await page.goto(`${baseURL}/mail`);
  await expect(page.getByRole('button', { name: /StrictMode conversation/ })).toBeVisible();
  expect(listReads).toBeGreaterThanOrEqual(1);
  await page.getByRole('combobox', { name: 'Mailbox' }).selectOption(`account:${account}`);
  await expect(page.getByRole('button', { name: /StrictMode conversation/ })).toBeVisible();
  await page.getByRole('button', { name: /StrictMode conversation/ }).click();
  await expect(page.getByRole('button', { name: 'Read message' })).toBeVisible();
  expect(bodyReads).toBe(0);
  await page.getByRole('button', { name: 'Read message' }).click();
  await expect(page.getByText('StrictMode body is ready.')).toBeVisible();
  expect(bodyReads).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
  await expect(page.getByText('Signing out…')).toBeVisible();
  await expect(page.getByText('StrictMode body is ready.')).toHaveCount(0);
});
