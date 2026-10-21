import { expect, test, type Page } from '@playwright/test';

const account = '11111111-1111-4111-8111-111111111111';
const other = '66666666-6666-4666-8666-666666666666';
const orbit = '22222222-2222-4222-8222-222222222222';
const thread = '77777777-7777-4777-8777-777777777777';
const item = '33333333-3333-4333-8333-333333333333';
const label = '44444444-4444-4444-8444-444444444444';
const now = '2026-10-20T12:00:00.000Z';

test.describe('message action preview fixtures', () => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  async function fixture(page: Page) {
    let reads = 0; let posts = 0; let lost = false; let reject = false; let unread = true; let inInbox = true; let applied = false;
    let blocked = false; let blockedOrbit: string | null = null; let older = false; let hideContext = false; let observed = false; let held = false; let started = false; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let operation: { id: string; itemId: string; accountId: string; orbitId: string | null; action: string; state: string; confirmation: string | null; updatedAt: string; message: string } | null = null;
    let key = '';
    const respond = (route: Parameters<Parameters<Page['route']>[1]>[0], json: unknown, status = 200) => route.fulfill({ json, status });
    await page.route('**/api/**', (route) => respond(route, { error: 'Fixture only.' }, 404));
    await page.route('**/api/auth/status', (route) => respond(route, { ownerExists: true, authenticated: true, recoveryAuthenticated: false, recoveryMode: null, pendingTotpUri: null, csrfToken: 'fixture-token' }));
    await page.route('**/api/sync/events', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/mail/**', async (route) => {
      const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
      if (path === '/api/mail/context') return respond(route, { orbits: [{ id: orbit, name: 'Example work', colorSlot: 1 }], accounts: [
        { id: account, orbitId: orbit, email: 'owner@example.com', provider: 'google', needsReconnect: false },
        { id: other, orbitId: orbit, email: 'other@example.com', provider: 'google', needsReconnect: false }] });
      if (path === '/api/mail/labels') return respond(route, { labels: [] });
      if (path === '/api/mail/conversations') return respond(route, { conversations: [{ threadId: thread, accountId: account, subject: 'Example message', snippet: 'A fixture message', lastActivityAt: now, messageCount: 1 }], nextCursor: null });
      if (path.endsWith('/messages')) return respond(route, { messages: [{ id: item, threadId: thread, accountId: account, itemSequence: 1, itemRevision: '7', subject: 'Example message', snippet: 'A fixture message', internalAt: now, sentAt: null, receivedAt: now, direction: 'in', parseStatus: 'supported', from: { name: 'Example Sender', address: 'sender@example.com' }, recipients: [], labels: [], attachments: [] }], nextCursor: null });
      if (path.endsWith('/action-options')) {
        reads++; if (held) { started = true; await gate; }
        if (url.searchParams.get('accountId') !== account || url.searchParams.get('orbitId') !== orbit) return respond(route, { error: 'Unavailable.' }, 404);
        return respond(route, { itemId: item, accountId: account, orbitId: orbit, itemSequence: 1, itemRevision: '7', unread, inInbox, blocked, blockedReason: blocked ? 'operation_pending' : null, blockingOperationId: blocked ? operation?.id ?? null : null, blockingOrbitId: blocked ? blockedOrbit : null, labelsIncomplete: false, canArchive: !blocked && inInbox, canMarkRead: !blocked && unread, canMarkUnread: !blocked && !unread, labels: [{ id: label, name: 'Long example label for a narrow screen', applied, canAdd: !blocked && !applied, canRemove: !blocked && applied }], message: blocked ? 'A message change needs review.' : 'Options reflect Gmail now.' });
      }
      if (path === `/api/mail/items/${item}/change` && request.method() === 'POST') {
        posts++; const body = request.postDataJSON(); key = body.idempotencyKey;
        if (reject) { reject = false; return respond(route, { error: 'The message changed. Reload it.' }, 409); }
        operation = { id: '88888888-8888-4888-8888-888888888888', itemId: item, accountId: account, orbitId: orbit, action: body.action, state: lost ? 'outcome_unknown' : 'succeeded', confirmation: lost ? null : observed ? 'observed' : 'provider', updatedAt: now, message: 'Fixture change.' };
        blocked = lost; blockedOrbit = orbit;
        if (lost) { lost = false; return route.abort('failed'); }
        return respond(route, operation);
      }
      if (path === `/api/mail/items/${item}/change` && request.method() === 'GET') return key === url.searchParams.get('idempotencyKey') && operation ? respond(route, operation) : respond(route, { error: 'Not found.' }, 404);
      if (path === '/api/mail/changes/unresolved') return respond(route, older && !url.searchParams.get('cursor') ? { operations: Array.from({ length: 20 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, itemId: item, accountId: account, orbitId: orbit, action: 'archive', state: 'outcome_unknown', confirmation: null, updatedAt: now, message: 'Older change.', context: null })), nextCursor: 'fixture-next' } : { operations: blocked && operation ? [{ ...operation, context: hideContext ? null : { subject: 'Example message', threadId: thread } }] : [], nextCursor: null });
      if (path.startsWith('/api/mail/changes/')) {
        if (!operation || url.searchParams.get('accountId') !== account || url.searchParams.get('orbitId') !== (blockedOrbit === null ? null : blockedOrbit)) return respond(route, { error: 'Unavailable.' }, 404);
        if (path.endsWith('/reconcile')) { operation = { ...operation, state: 'succeeded', confirmation: 'observed' }; blocked = false; }
        return respond(route, operation);
      }
      return respond(route, { error: 'Fixture only.' }, 404);
    });
    return { counts: () => ({ reads, posts }), lose: () => { lost = true; }, holdOptions: () => { held = true; }, optionsStarted: () => started, releaseOptions: () => release(), reject: () => { reject = true; }, changeProvider: (next: { unread?: boolean; inInbox?: boolean; applied?: boolean }) => { unread = next.unread ?? unread; inInbox = next.inInbox ?? inInbox; applied = next.applied ?? applied; }, older: () => { older = true; }, hideContext: () => { hideContext = true; }, observed: () => { observed = true; }, staleBlock: () => { blocked = true; blockedOrbit = orbit; if (operation) operation = { ...operation, state: 'outcome_unknown', confirmation: null }; }, block: (origin: string | null = orbit) => { blocked = true; blockedOrbit = origin; operation = { id: '88888888-8888-4888-8888-888888888888', itemId: item, accountId: account, orbitId: origin, action: 'archive', state: 'outcome_unknown', confirmation: null, updatedAt: now, message: 'Result unknown.' }; } };
  }
  const open = async (page: Page, baseURL: string) => { await page.goto(`${baseURL}/mail/thread/${account}/${thread}?orbitId=${orbit}`); await expect(page.getByRole('button', { name: 'Message actions' })).toBeVisible(); };
  test('explicit controls use one message key and recover a lost result without a second write', async ({ page, baseURL }) => {
    const api = await fixture(page); await open(page, baseURL!);
    expect(api.counts()).toEqual({ reads: 0, posts: 0 });
    await page.getByRole('button', { name: 'Read message' }).click(); expect(api.counts().posts).toBe(0);
    await page.getByRole('button', { name: 'Message actions' }).click(); await expect(page.getByRole('button', { name: 'Archive this message' })).toBeEnabled();
    api.lose(); await page.getByRole('button', { name: 'Archive this message' }).dblclick();
    await expect(page.getByText(/The change may have happened/)).toBeVisible(); expect(api.counts().posts).toBe(1);
    await page.getByRole('button', { name: 'Check status' }).click(); await expect(page.getByRole('button', { name: 'Check desired state' })).toBeVisible();
    await page.reload(); await page.getByRole('button', { name: 'Message actions' }).click(); await expect(page.getByRole('button', { name: 'Check desired state' })).toBeVisible();
    await page.getByRole('button', { name: 'Check desired state' }).click(); await expect(page.getByText(/Gmail currently shows the requested state/)).toBeVisible(); expect(api.counts().posts).toBe(1);
    await page.screenshot({ path: 'results/m1-mail-actions-ui/light-desktop.png', fullPage: true });
  });
  test('read, unread and existing label choices follow refreshed provider evidence', async ({ page, baseURL }) => {
    const api = await fixture(page); await open(page, baseURL!); await page.getByRole('button', { name: 'Message actions' }).click();
    await page.getByRole('button', { name: 'Mark read' }).click(); expect(api.counts().posts).toBe(1);
    api.changeProvider({ unread: false }); await page.getByRole('button', { name: 'Refresh options' }).click();
    await expect(page.getByRole('button', { name: 'Mark unread' })).toBeEnabled(); await page.getByRole('button', { name: 'Mark unread' }).click();
    api.changeProvider({ unread: true }); await page.getByRole('button', { name: 'Refresh options' }).click();
    await page.getByRole('button', { name: 'Add Long example label for a narrow screen' }).click();
    api.changeProvider({ applied: true }); await page.getByRole('button', { name: 'Refresh options' }).click();
    await expect(page.getByRole('button', { name: 'Remove Long example label for a narrow screen' })).toBeEnabled();
    await page.getByRole('button', { name: 'Remove Long example label for a narrow screen' }).click(); expect(api.counts().posts).toBe(4);
  });
  test('stale preclaim rejection requires fresh options and never creates a recovery loop', async ({ page, baseURL }) => {
    const api = await fixture(page); await open(page, baseURL!); await page.getByRole('button', { name: 'Message actions' }).click();
    api.reject(); await page.getByRole('button', { name: 'Mark read' }).click();
    await expect(page.getByText(/Refresh options before choosing another action/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check status' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Refresh options' }).click(); await expect(page.getByRole('button', { name: 'Mark read' })).toBeEnabled();
    expect(api.counts().posts).toBe(1);
  });
  test('dark mobile controls wrap and remain keyboard reachable', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
    await fixture(page); await open(page, baseURL!); await page.getByRole('button', { name: 'Message actions' }).focus();
    await page.keyboard.press('Enter'); await expect(page.getByRole('button', { name: 'Mark read' })).toBeEnabled();
    await page.screenshot({ path: 'results/m1-mail-actions-ui/dark-mobile.png', fullPage: true });
    await page.keyboard.press('Escape'); await expect(page.getByRole('region', { name: 'Message actions' })).toHaveCount(0);
  });
  test('held options are ignored after logout', async ({ page, baseURL }) => {
    const api = await fixture(page); api.holdOptions(); await open(page, baseURL!); await page.getByRole('button', { name: 'Message actions' }).click();
    await expect.poll(api.optionsStarted).toBe(true); await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
    api.releaseOptions(); await expect(page.getByText('Signing out…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive this message' })).toHaveCount(0); expect(api.counts().posts).toBe(0);
  });
  test('account and Orbit denial does not expose action options', async ({ page, baseURL }) => {
    const api = await fixture(page); await page.goto(`${baseURL}/mail/thread/${account}/${thread}?accountId=${other}`);
    await expect(page.getByText(/invalid filters/)).toBeVisible(); expect(api.counts()).toEqual({ reads: 0, posts: 0 });
  });
  test('pending overview loads signed cursor pages and checks original null Orbit', async ({ page, baseURL }) => {
    const api = await fixture(page); api.block(null); api.older(); await open(page, baseURL!);
    await page.getByRole('button', { name: 'Pending message changes' }).click();
    await page.getByRole('region', { name: 'Pending message changes' }).getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('button', { name: 'Load more changes' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Pending message changes' }).locator('.mail-pending-row')).toHaveCount(20);
    await page.getByRole('button', { name: 'Load more changes' }).click();
    const overview = page.getByRole('region', { name: 'Pending message changes' });
    await expect(overview.getByText(/Result uncertain/).first()).toBeVisible();
    await overview.locator('.mail-pending-row').last().getByRole('button', { name: 'Check status' }).click();
    await expect(overview.getByText(/Result uncertain/).last()).toBeVisible();
    await page.screenshot({ path: 'results/m1-mail-actions-ui/pending-changes.png', fullPage: true });
    const messageLink = overview.getByRole('link', { name: 'Example message' });
    await messageLink.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(messageLink).toBeFocused();
    expect(await messageLink.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('solid');
    await overview.locator('.mail-pending-row').last().screenshot({ path: 'results/m1-mail-actions-ui/pending-recovery-row.png' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await overview.locator('.mail-pending-row').last().screenshot({ path: 'results/m1-mail-actions-ui/pending-recovery-row-dark.png' });
    await expect(messageLink).toHaveAttribute('href', `/mail/thread/${account}/${thread}?accountId=${account}`); expect(api.counts().posts).toBe(0);
  });
  test('selected Orbit filter stays exact across accounts with different home Orbits', async ({ page, baseURL }) => {
    await fixture(page); const home = '99999999-9999-4999-8999-999999999999';
    await page.route('**/api/mail/context', route => route.fulfill({ json: { orbits: [{ id: orbit, name: 'Example work', colorSlot: 1 }, { id: home, name: 'Example other', colorSlot: 2 }], accounts: [
      { id: account, orbitId: orbit, email: 'owner@example.com', provider: 'google', needsReconnect: false },
      { id: other, orbitId: home, email: 'other@example.com', provider: 'google', needsReconnect: false }] } }));
    let requested: string | null = null;
    await page.route('**/api/mail/changes/unresolved?*', route => { requested = new URL(route.request().url()).searchParams.get('orbitId'); return route.fulfill({ json: { operations: [], nextCursor: null } }); });
    await open(page, baseURL!); await page.getByRole('button', { name: 'Pending message changes' }).click();
    const overview = page.getByRole('region', { name: 'Pending message changes' });
    await overview.getByLabel('Only this Orbit').check(); await overview.getByLabel('Change account').selectOption(other);
    await overview.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(overview.getByText('No pending changes in this scope.')).toBeVisible(); expect(requested).toBe(orbit);
  });
  test('changing the parent mailbox scope clears pending rows immediately', async ({ page, baseURL }) => {
    const api = await fixture(page); api.block(); await open(page, baseURL!);
    await page.getByRole('button', { name: 'Pending message changes' }).click();
    const overview = page.getByRole('region', { name: 'Pending message changes' });
    await overview.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(overview.getByRole('link', { name: 'Example message' })).toBeVisible();
    await page.getByLabel('Mailbox').selectOption(`account:${other}`);
    await expect(overview.getByRole('link', { name: 'Example message' })).toHaveCount(0);
    await expect(overview.getByLabel('Only this Orbit')).toHaveCount(0);
  });
  test('terminal success ignores old status and blocking options', async ({ page, baseURL }) => {
    const api = await fixture(page); await open(page, baseURL!); await page.getByRole('button', { name: 'Message actions' }).click();
    await page.getByRole('button', { name: 'Archive this message' }).click();
    await expect(page.getByText(/Change confirmed/)).toBeVisible(); api.staleBlock();
    await page.getByRole('button', { name: 'Check status' }).click(); await expect(page.getByText(/Change confirmed/)).toBeVisible();
    await expect(page.getByText(/If the state still differs/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Refresh options' }).click(); await expect(page.getByText(/Change confirmed/)).toBeVisible();
    await expect(page.getByText(/If the state still differs/)).toHaveCount(0);
  });
  test('observed state copy and unavailable-message fallback stay clear', async ({ page, baseURL }) => {
    const api = await fixture(page); api.block(); api.hideContext(); await open(page, baseURL!);
    await page.getByRole('button', { name: 'Pending message changes' }).click();
    const overview = page.getByRole('region', { name: 'Pending message changes' });
    await overview.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(overview.getByText(/message is no longer available here/)).toBeVisible();
    await overview.getByRole('button', { name: 'Check desired state' }).click();
    await expect(overview.getByText(/Gmail currently shows the requested state/)).toBeVisible();
  });
  test('persistent unknown stays blocked and uses original Orbit', async ({ page, baseURL }) => {
    const api = await fixture(page); api.block(null); await open(page, baseURL!); await page.getByRole('button', { name: 'Message actions' }).click();
    await expect(page.getByText(/change this message in Gmail/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Archive this message' })).toBeDisabled();
    await page.getByRole('button', { name: 'Check status' }).click(); await expect(page.getByRole('button', { name: 'Check desired state' })).toBeVisible(); expect(api.counts().posts).toBe(0);
  });
});
