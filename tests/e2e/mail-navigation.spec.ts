import { expect, test, type Page } from '@playwright/test';
const orbit = '22222222-2222-4222-8222-222222222222';
const account = '11111111-1111-4111-8111-111111111111';
const account2 = '66666666-6666-4666-8666-666666666666';
const thread = '77777777-7777-4777-8777-777777777777';
const thread2 = '88888888-8888-4888-8888-888888888888';
const item = '33333333-3333-4333-8333-333333333333';
const label = '99999999-9999-4999-8999-999999999999';
const attachment = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const next = 'fixture-cursor';
const context = { orbits: [{ id: orbit, name: 'Example work', colorSlot: 1 }], accounts: [
  { id: account, orbitId: orbit, email: 'owner@example.com', provider: 'google', needsReconnect: false },
  { id: account2, orbitId: orbit, email: 'second@example.com', provider: 'google', needsReconnect: false },
] };
const row = (id: string, owner: string, subject: string) => ({ threadId: id, accountId: owner, subject, snippet: 'A useful preview', lastActivityAt: '2026-10-20T12:00:00.000Z', messageCount: 2 });
const message = { id: item, threadId: thread, accountId: account, itemSequence: 1, itemRevision: '7', subject: 'Budget %_literal', snippet: 'A useful preview', internalAt: '2026-10-20T12:00:00.000Z', sentAt: null, receivedAt: null, direction: 'in', parseStatus: 'supported', from: { name: 'Sender', address: 'sender@example.com' }, labels: [{ id: label, name: 'Important' }], recipients: [{ role: 'to', name: 'Owner', address: 'owner@example.com' }], attachments: [{ id: attachment, filename: 'report.pdf', mimeType: 'application/pdf', size: 1024, related: false }] };
async function fixture(page: Page) {
  const calls: string[] = [];
  const threadCalls: string[] = [];
  let bodyCalls = 0;
  await page.route('**/api/mail/context', route => route.fulfill({ json: context }));
  await page.route('**/api/mail/labels?**', route => route.fulfill({ json: { labels: [{ id: label, accountId: account, name: 'Important' }] } }));
  await page.route('**/api/mail/conversations?**', route => {
    const url = new URL(route.request().url()); calls.push(url.search);
    if (url.searchParams.get('cursor')) return route.fulfill({ json: { conversations: [row(thread2, account2, 'Second account')], nextCursor: null } });
    if (url.searchParams.get('subject') === 'missing') return route.fulfill({ json: { conversations: [], nextCursor: null } });
    return route.fulfill({ json: { conversations: [row(thread, account, 'Budget %_literal')], nextCursor: next } });
  });
  await page.route('**/api/mail/threads/*/messages?**', route => {
    const url = new URL(route.request().url()); threadCalls.push(url.search);
    const second = url.searchParams.get('accountId') === account2;
    return route.fulfill({ json: { messages: [{ ...message, ...(second ? { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', threadId: thread2, accountId: account2, subject: 'Second account' } : {}) }], nextCursor: null } });
  });
  await page.route('**/api/mail/items/*/body?**', route => { bodyCalls++; return route.fulfill({ json: { itemId: item, status: 'available', text: 'The complete message', html: null, htmlPolicyVersion: null, imageRefs: [] } }); });
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false, messageChoice: null, senderEnabled: false, effectiveRemoteEnabled: false, senderAddress: 'sender@example.com', refs: [] } }));
  return { calls, threadCalls, get bodyCalls() { return bodyCalls; } };
}
test('mail scopes, literal subject, cursor, thread history and lazy body', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  const data = await fixture(page);
  await page.goto(`${baseURL}/mail`);
  await expect(page.getByRole('heading', { name: 'Mail', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/mail-navigation-light-desktop.png', fullPage: true });
  expect(data.calls.at(-1)).toContain(`orbitId=${orbit}`);
  await page.getByRole('combobox', { name: 'Mailbox' }).selectOption(`account:${account}`);
  await expect.poll(() => data.calls.at(-1)).toContain(`accountId=${account}`);
  await page.getByRole('combobox', { name: 'Label' }).selectOption(label);
  await expect.poll(() => data.calls.at(-1)).toContain(`labelId=${label}`);
  await page.getByRole('textbox', { name: 'Subject contains' }).fill('%_literal');
  await expect.poll(() => data.calls.at(-1)).toContain('subject=%25_literal');
  await page.getByRole('button', { name: 'Load more conversations' }).click();
  await expect(page.getByRole('button', { name: /Second account/ })).toBeVisible();
  expect(data.calls.at(-1)).toContain(`cursor=${next}`);
  await page.getByRole('button', { name: /Budget %_literal/ }).click();
  await expect(page).toHaveURL(new RegExp(`/mail/thread/${account}/${thread}`));
  expect(data.bodyCalls).toBe(0);
  await expect(page.getByText('report.pdf')).toBeVisible();
  await expect(page.getByRole('link', { name: /report.pdf/ })).toHaveAttribute('href', new RegExp(`accountId=${account}`));
  await page.getByRole('button', { name: 'Read message' }).click();
  await expect(page.getByText('The complete message')).toBeVisible();
  expect(data.bodyCalls).toBe(1);
  await page.getByRole('button', { name: 'Close message' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Read message' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('list', { name: 'Conversations' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Budget %_literal' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Read message' })).toBeVisible();
  await page.goto(`${baseURL}/mail/thread/${account2}/${thread2}`);
  await expect(page.getByRole('heading', { name: 'Second account' })).toBeVisible();
  expect(data.threadCalls.at(-1)).toContain(`accountId=${account2}`);
  expect(data.threadCalls.at(-1)).not.toContain('orbitId=');
  await page.getByRole('button', { name: 'Read message' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('list', { name: 'Conversations' })).toBeVisible();
});
test('old account response cannot replace a newly selected mailbox', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  await fixture(page);
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route('**/api/mail/conversations?**', async route => {
    const accountId = new URL(route.request().url()).searchParams.get('accountId');
    if (accountId === account) {
      started = true;
      await slow;
      return route.fulfill({ json: { conversations: [row(thread, account, 'Old account result')], nextCursor: null } }).catch(() => undefined);
    }
    if (accountId === account2) return route.fulfill({ json: { conversations: [row(thread2, account2, 'Second account')], nextCursor: null } });
    return route.fallback();
  });
  await page.goto(`${baseURL}/mail`);
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toBeVisible();
  await page.getByRole('combobox', { name: 'Mailbox' }).selectOption(`account:${account}`);
  await expect.poll(() => started).toBe(true);
  await page.getByRole('combobox', { name: 'Mailbox' }).selectOption(`account:${account2}`);
  await expect(page.getByRole('button', { name: /Second account/ })).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: /Old account result/ })).toHaveCount(0);
});
test('keyboard respects text input; event prompts for manual refresh; empty and error states', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  const data = await fixture(page);
  let sendEvent!: () => void;
  const fire = new Promise<void>(resolve => { sendEvent = resolve; });
  await page.route('**/api/sync/events', async route => {
    await fire;
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
      body: `event: mail-changed\nid: 1\ndata: "${account}"\n\n` });
  });
  await page.goto(`${baseURL}/mail`);
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toBeVisible();
  await page.getByRole('button', { name: 'Load more conversations' }).click();
  await page.locator('.mail-workspace h1').focus();
  await page.keyboard.press('j');
  await expect(page.getByRole('button', { name: /Second account/ })).toBeFocused();
  await page.keyboard.press('k');
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toBeFocused();
  await page.getByRole('textbox', { name: 'Subject contains' }).fill('missing');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'No conversations here' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Subject contains' }).fill('');
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toBeVisible();
  const before = data.calls.length;
  sendEvent();
  await expect(page.getByText('New mail available.')).toBeVisible();
  expect(data.calls.length).toBe(before);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => data.calls.length).toBeGreaterThan(before);
  await page.route('**/api/mail/conversations?**', route => route.fulfill({ status: 503, json: { error: 'Mail is temporarily unavailable. Try again.' } }));
  await page.getByRole('button', { name: 'Refresh mail' }).click();
  await expect(page.getByRole('alert')).toContainText('Mail is temporarily unavailable');
});
test('mobile Mission Control enters Mail and stays readable', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${baseURL}/`);
  const mailNav = page.getByRole('button', { name: 'Mail', exact: true });
  await expect(mailNav).toBeVisible();
  await mailNav.click();
  await expect(page).toHaveURL(/\/mail(?:\?|$)/);
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toBeVisible();
  await expect(mailNav).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: 'test-results/mail-navigation-dark-mobile.png', fullPage: true });
});
test('invalid mail selectors retain their address without any reader request', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  await fixture(page);
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/mail/')) requests.push(request.url()); });
  const invalidAddresses = [
    `/mail?orbitId=bad`,
    `/mail?orbitId=${orbit}&unexpected=1`,
    `/mail?accountId=${account}&orbitId=${orbit}`,
    `/mail?orbitId=${orbit}&orbitId=${orbit}`,
    `/mail?accountId=${account}&accountId=${account2}`,
    `/mail/thread/${account}/${thread}?orbitId=${orbit}&labelId=bad`,
    `/mail/thread/${account}/${thread}?orbitId=${orbit}&unexpected=1`,
    `/mail/thread/${account}/${thread}?accountId=${account2}`,
  ];
  for (const address of invalidAddresses) {
    await page.goto(`${baseURL}${address}`);
    await expect(page.getByRole('alert')).toContainText('invalid filters');
    await expect(page).toHaveURL(`${baseURL}${address}`);
    await expect(page.getByRole('list', { name: 'Conversations' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Read message' })).toHaveCount(0);
    expect(requests, address).toEqual([]);
  }
});
test('invalid same-document selector hides cached mail without a broader read', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  await fixture(page);
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/mail/')) requests.push(request.url()); });
  await page.goto(`${baseURL}/mail?orbitId=${orbit}`);
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toBeVisible();
  requests.length = 0;
  const invalid = `/mail?orbitId=${orbit}&labelId=bad`;
  await page.evaluate((address) => { window.history.pushState({}, '', address); window.dispatchEvent(new PopStateEvent('popstate')); }, invalid);
  await expect(page.getByRole('alert')).toContainText('invalid filters');
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toHaveCount(0);
  await expect(page).toHaveURL(`${baseURL}${invalid}`);
  expect(requests).toEqual([]);
  await page.goto(`${baseURL}/mail/thread/${account}/${thread}?orbitId=${orbit}`);
  await expect(page.getByRole('heading', { name: 'Budget %_literal' })).toBeVisible();
  requests.length = 0;
  const invalidThread = `/mail/thread/${account}/${thread}?orbitId=${orbit}&labelId=bad`;
  await page.evaluate((address) => { window.history.pushState({}, '', address); window.dispatchEvent(new PopStateEvent('popstate')); }, invalidThread);
  await expect(page.getByRole('alert')).toContainText('invalid filters');
  await expect(page.getByRole('heading', { name: 'Budget %_literal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Read message' })).toHaveCount(0);
  await expect(page).toHaveURL(`${baseURL}${invalidThread}`);
  expect(requests).toEqual([]);
});
test('logout hides a held conversation page and prevents late private rendering', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  await fixture(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route('**/api/mail/conversations?**', async route => {
    started = true;
    await held;
    return route.fulfill({ json: { conversations: [row(thread, account, 'Late private subject')], nextCursor: null } }).catch(() => undefined);
  });
  await page.goto(`${baseURL}/mail`);
  await expect.poll(() => started).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
  await expect(page.getByText('Signing out…')).toBeVisible();
  release();
  await expect(page.getByText('Late private subject')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Mailbox' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mission Control' }).click();
  await page.getByRole('button', { name: 'Mail', exact: true }).click();
  await expect(page.getByText('Signing out…')).toBeVisible();
  await expect(page.getByText('Late private subject')).toHaveCount(0);
});
test('logout hides held thread metadata and blocks later body reads', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  const data = await fixture(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route('**/api/mail/threads/*/messages?**', async route => {
    started = true;
    await held;
    return route.fulfill({ json: { messages: [message], nextCursor: null } }).catch(() => undefined);
  });
  await page.goto(`${baseURL}/mail`);
  await page.getByRole('button', { name: /Budget %_literal/ }).click();
  await expect.poll(() => started).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
  await expect(page.getByText('Signing out…')).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: 'Read message' })).toHaveCount(0);
  expect(data.bodyCalls).toBe(0);
});
test('oversized reader JSON is rejected before rendering', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  await fixture(page);
  await page.route('**/api/mail/conversations?**', route => route.fulfill({ contentType: 'application/json', body: 'x'.repeat(600 * 1024) }));
  await page.goto(`${baseURL}/mail`);
  await expect(page.getByRole('alert')).toContainText('Mail response is too large');
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toHaveCount(0);
});
test('logout while Mail is unmounted clears cached private rows before returning', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  const data = await fixture(page);
  await page.goto(`${baseURL}/mail`);
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toBeVisible();
  await page.getByRole('button', { name: 'Mission Control' }).click();
  const before = data.calls.length;
  await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
  await page.getByRole('button', { name: 'Mail', exact: true }).click();
  await expect(page.getByText('Signing out…')).toBeVisible();
  await expect(page.getByRole('button', { name: /Budget %_literal/ })).toHaveCount(0);
  expect(data.calls.length).toBe(before);
});
