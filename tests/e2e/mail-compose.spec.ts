import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const orbit = '22222222-2222-4222-8222-222222222222';
const account = '11111111-1111-4111-8111-111111111111';
const accountB = '66666666-6666-4666-8666-666666666666';
const thread = '77777777-7777-4777-8777-777777777777';
const item = '33333333-3333-4333-8333-333333333333';
const now = '2026-10-20T12:00:00.000Z';
type Draft = { id: string; accountId: string; orbitId: string | null; threadId: string | null; parentItemId: string | null;
  to: { address: string; name: string }[]; cc: { address: string; name: string }[]; bcc: { address: string; name: string }[];
  subject: string; bodyText: string; attachmentRefs: string[]; revision: number; state: 'editing' | 'sending' | 'sent' | 'discarded';
  createdAt: string; updatedAt: string };
type Operation = { id: string; draftId: string; accountId: string; orbitId: string | null;
  state: 'outcome_unknown' | 'succeeded' | 'failed'; providerResultId: string | null; updatedAt: string; message: string };

async function fixture(page: Page) {
  const drafts = new Map<string, Draft>();
  const attachments = new Map<string, { id: string; filename: string; byteSize: number; status: 'ready' }>();
  const operations = new Map<string, Operation>();
  const operationKeys = new Map<string, string>();
  let sendCalls = 0;
  let draftReads = 0;
  let conflictNext = false;
  let loseSendResponse = false;
  let preflightFail = false;
  let holdUpload = false;
  let holdRemove = false;
  let uploadStarted = false;
  let removeStarted = false;
  let releaseUpload!: () => void;
  let releaseRemove!: () => void;
  let uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
  let removeGate = new Promise<void>((resolve) => { releaseRemove = resolve; });
  const respond = (route: Parameters<Parameters<Page['route']>[1]>[0], json: unknown, status = 200) => route.fulfill({ status, json });
  await page.route('**/api/mail/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === '/api/mail/context') return respond(route, { orbits: [{ id: orbit, name: 'Example work', colorSlot: 1 }], accounts: [
      { id: account, orbitId: orbit, email: 'owner@example.com', provider: 'google', needsReconnect: false },
      { id: accountB, orbitId: orbit, email: 'second@example.com', provider: 'google', needsReconnect: false },
    ] });
    if (path === '/api/mail/labels') return respond(route, { labels: [] });
    if (path === '/api/mail/conversations') return respond(route, { conversations: [{ threadId: thread, accountId: account, subject: 'Example reply', snippet: 'Please reply', lastActivityAt: now, messageCount: 1 }], nextCursor: null });
    if (path.endsWith('/messages')) return respond(route, { messages: [{ id: item, threadId: thread, accountId: account,
      subject: 'Example reply', snippet: 'Please reply', internalAt: now, sentAt: null, receivedAt: null, direction: 'in',
      parseStatus: 'supported', from: { name: 'Example Sender', address: 'sender@example.com' }, labels: [], recipients: [], attachments: [],
    }], nextCursor: null });
    if (path.endsWith('/reply-context')) return respond(route, { accountId: account, orbitId: orbit, parentItemId: item,
      threadId: thread, collectionId: 'primary', providerThreadId: 'provider-thread', subject: 'Re: Example reply',
      to: [{ address: 'sender@example.com', name: '' }], messageId: '<example@example.com>', references: '<example@example.com>' });
    if (path === '/api/mail/drafts' && method === 'POST') {
      const body = request.postDataJSON() as Draft;
      const value: Draft = { id: body.id, accountId: body.accountId, orbitId: body.orbitId ?? null,
        threadId: body.parentItemId ? thread : null, parentItemId: body.parentItemId ?? null,
        to: body.to, cc: body.cc, bcc: body.bcc, subject: body.subject, bodyText: body.bodyText,
        attachmentRefs: [], revision: 1, state: 'editing', createdAt: now, updatedAt: now };
      drafts.set(value.id, value);
      return respond(route, value, 201);
    }
    if (path === '/api/mail/drafts' && method === 'GET') return respond(route, { drafts: [...drafts.values()].filter((draft) => draft.state === 'editing' &&
      draft.accountId === url.searchParams.get('accountId') && (!url.searchParams.get('orbitId') || draft.orbitId === url.searchParams.get('orbitId')))
      .map((draft) => ({ id: draft.id, accountId: draft.accountId, orbitId: draft.orbitId, threadId: draft.threadId,
        parentItemId: draft.parentItemId, subject: draft.subject, revision: draft.revision, state: 'editing', updatedAt: draft.updatedAt })), nextCursor: null });
    if (path === '/api/mail/sends/unresolved') return respond(route, { operations: [...operations.values()].filter((operation) =>
      operation.state !== 'succeeded' && operation.accountId === url.searchParams.get('accountId') &&
      (!url.searchParams.get('orbitId') || operation.orbitId === url.searchParams.get('orbitId'))), nextCursor: null });
    const parts = path.split('/');
    const draftId = parts[4];
    const draft = draftId ? drafts.get(draftId) : undefined;
    if (parts[3] === 'drafts' && parts.length === 5 && method === 'GET') draftReads++;
    if (parts[3] === 'drafts' && draft && draft.accountId === url.searchParams.get('accountId') &&
      (!url.searchParams.get('orbitId') || draft.orbitId === url.searchParams.get('orbitId'))) {
      if (parts.length === 5 && method === 'GET') return respond(route, draft);
      if (parts.length === 5 && method === 'PUT') {
        if (conflictNext) { conflictNext = false; return respond(route, { error: 'This draft changed in another tab.' }, 409); }
        const body = request.postDataJSON() as Draft;
        if (body.revision !== draft.revision) return respond(route, { error: 'This draft changed in another tab.' }, 409);
        Object.assign(draft, { to: body.to, cc: body.cc, bcc: body.bcc, subject: body.subject, bodyText: body.bodyText, revision: draft.revision + 1 });
        return respond(route, draft);
      }
      if (parts[5] === 'attachments' && parts.length === 6 && method === 'GET') return respond(route,
        { attachments: draft.attachmentRefs.map((id) => attachments.get(id)), revision: draft.revision });
      if (parts[5] === 'attachments' && parts.length === 6 && method === 'POST') {
        if (holdUpload) { uploadStarted = true; await uploadGate; holdUpload = false; }
        const id = crypto.randomUUID();
        const filename = decodeURIComponent(request.headers()['x-attachment-name'] ?? 'example.txt');
        const attachment = { id, filename, byteSize: request.postDataBuffer()?.length ?? 0, status: 'ready' as const };
        attachments.set(id, attachment); draft.attachmentRefs.push(id); draft.revision++;
        return respond(route, { attachment, revision: draft.revision });
      }
      if (parts[5] === 'attachments' && parts.length === 7 && method === 'DELETE') {
        if (holdRemove) { removeStarted = true; await removeGate; holdRemove = false; }
        draft.attachmentRefs = draft.attachmentRefs.filter((id) => id !== parts[6]); draft.revision++;
        return respond(route, { revision: draft.revision });
      }
      if (parts[5] === 'discard' && method === 'POST') { draft.state = 'discarded'; draft.revision++; return respond(route, draft); }
      if (parts[5] === 'send' && method === 'POST') {
        sendCalls++;
        if (preflightFail) { preflightFail = false; return respond(route, { error: 'Add a recipient and check the draft before sending.' }, 422); }
        draft.state = 'sending';
        const sendBody = request.postDataJSON() as { idempotencyKey: string };
        const operation: Operation = { id: crypto.randomUUID(), draftId: draft.id, accountId: draft.accountId, orbitId: draft.orbitId,
          state: 'outcome_unknown', providerResultId: null, updatedAt: now,
          message: 'Delivery may have happened. Check Sent or reconcile; this operation will not resend.' };
        operations.set(operation.id, operation); operationKeys.set(sendBody.idempotencyKey, operation.id);
        if (loseSendResponse) { loseSendResponse = false; return route.abort('failed'); }
        return respond(route, operation, 202);
      }
      if (parts[5] === 'send' && method === 'GET') {
        const key = url.searchParams.get('idempotencyKey');
        const operation = key ? operations.get(operationKeys.get(key) ?? '') : [...operations.values()].filter((entry) => entry.draftId === draft.id).at(-1);
        if (operation && operation.draftId !== draft.id) return respond(route, { error: 'Not found.' }, 404);
        return operation ? respond(route, operation) : respond(route, { error: 'Not found.' }, 404);
      }
    }
    if (parts[3] === 'sends' && parts[5] === 'reconcile' && method === 'POST') {
      const operation = operations.get(parts[4]!);
      if (!operation) return respond(route, { error: 'Not found.' }, 404);
      operation.state = 'succeeded'; operation.providerResultId = 'sent_fixture';
      drafts.get(operation.draftId)!.state = 'sent'; return respond(route, operation);
    }
    return respond(route, { error: 'Unavailable fixture route.' }, 404);
  });
  return { drafts, attachments, operations, operationKeys,
    set conflictNext(value: boolean) { conflictNext = value; },
    set loseSendResponse(value: boolean) { loseSendResponse = value; },
    set preflightFail(value: boolean) { preflightFail = value; },
    holdNextUpload() { holdUpload = true; uploadStarted = false; uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; }); },
    holdNextRemove() { holdRemove = true; removeStarted = false; removeGate = new Promise<void>((resolve) => { releaseRemove = resolve; }); },
    releaseUpload: () => releaseUpload(), releaseRemove: () => releaseRemove(),
    get uploadStarted() { return uploadStarted; }, get removeStarted() { return removeStarted; },
    get sendCalls() { return sendCalls; }, get draftReads() { return draftReads; } };
}

test.describe('compose preview fixtures', () => {
test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');

test('compose saves across reload, attaches, recovers an unknown send, and reconciles', async ({ page, baseURL }) => {
  const data = await fixture(page);
  await page.goto(`${baseURL}/mail`);
  await page.getByRole('button', { name: 'New message' }).click();
  await page.getByRole('combobox', { name: 'Send from' }).selectOption(accountB);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Compose message' })).toBeVisible();
  await expect(page.getByText('From second@example.com')).toBeVisible();
  await page.getByRole('textbox', { name: 'To' }).fill('recipient@example.com');
  await page.getByRole('textbox', { name: 'Cc', exact: true }).fill('copy@example.com');
  await page.getByRole('textbox', { name: 'Bcc' }).fill('hidden@example.com');
  await page.getByRole('textbox', { name: 'Subject' }).fill('Example plans');
  await page.getByRole('textbox', { name: 'Message' }).fill('The attached example plan is ready.');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.locator('.mail-compose-upload input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('example attachment') });
  await expect(page.getByRole('link', { name: /plan.txt/ })).toBeVisible();
  await mkdir('results/m1-compose-ui', { recursive: true });
  await page.screenshot({ path: 'results/m1-compose-ui/light-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'results/m1-compose-ui/dark-mobile-editing.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const draftUrl = page.url();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('The attached example plan is ready.');
  await expect(page.getByRole('link', { name: /plan.txt/ })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Drafts and sends' }).click();
  await page.getByRole('combobox', { name: 'Draft account' }).selectOption(accountB);
  await page.getByRole('button', { name: /Example plans/ }).click();
  await expect(page).toHaveURL(draftUrl);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('The attached example plan is ready.');
  await page.getByRole('button', { name: 'Send message' }).evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(page.getByRole('heading', { name: 'Send needs attention' })).toBeVisible();
  expect(data.sendCalls).toBe(1);
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Drafts and sends' }).click();
  await page.getByRole('combobox', { name: 'Draft account' }).selectOption(accountB);
  await expect(page.getByRole('button', { name: /Send needs attention/ })).toBeVisible();
  await page.getByRole('button', { name: /Send needs attention/ }).click();
  await expect(page.getByRole('heading', { name: 'Send needs attention' })).toBeVisible();
  expect(data.sendCalls).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'results/m1-compose-ui/dark-mobile-unknown.png', fullPage: true });
  await page.getByRole('button', { name: 'Check Sent' }).click();
  await expect(page.getByRole('heading', { name: 'Message sent' })).toBeVisible();
  expect(data.sendCalls).toBe(1);
});

test('reply keeps its subject and a conflict requires an explicit leave choice', async ({ page, baseURL }) => {
  const data = await fixture(page);
  await page.goto(`${baseURL}/mail`);
  await page.getByRole('button', { name: /Example reply/ }).click();
  await page.getByRole('button', { name: 'Reply' }).click();
  await expect(page.getByRole('textbox', { name: 'To' })).toHaveValue('sender@example.com');
  await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue('Re: Example reply');
  await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveAttribute('readonly', '');
  data.conflictNext = true;
  await page.getByRole('textbox', { name: 'Message' }).fill('This text must survive a conflict.');
  await expect(page.getByText('Conflict: your text is kept here')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('This text must survive a conflict.');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Message' }).fill('Updated local text after conflict.');
  await expect(page.getByText('Conflict: your text is kept here')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'This draft changed in another tab.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save now' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('Copy your text before leaving.')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Updated local text after conflict.');
  await page.getByRole('button', { name: 'Close' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Leave without saving' }).click();
  await expect(page).toHaveURL(/\/mail(?:\?|$)/);
});

test('held attachment changes preserve later typing, and discard leaves cleanly', async ({ page, baseURL }) => {
  const data = await fixture(page);
  await page.goto(`${baseURL}/mail`);
  await page.getByRole('button', { name: 'New message' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'To' }).fill('recipient@example.com');
  await page.getByRole('textbox', { name: 'Message' }).fill('Before attachment');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  data.holdNextUpload();
  await page.locator('.mail-compose-upload input').setInputFiles({ name: 'example.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture file') });
  await expect.poll(() => data.uploadStarted).toBe(true);
  await page.getByRole('textbox', { name: 'Message' }).fill('Typed while upload waits');
  data.releaseUpload();
  await expect(page.getByRole('link', { name: /example.txt/ })).toBeVisible();
  await expect.poll(() => [...data.drafts.values()][0]?.bodyText).toBe('Typed while upload waits');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  const url = page.url();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Typed while upload waits');
  data.holdNextRemove();
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => data.removeStarted).toBe(true);
  await page.getByRole('textbox', { name: 'Message' }).fill('Typed while removal waits');
  data.releaseRemove();
  await expect(page.getByRole('link', { name: /example.txt/ })).toHaveCount(0);
  await expect.poll(() => [...data.drafts.values()][0]?.bodyText).toBe('Typed while removal waits');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Typed while removal waits');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(/\/mail(?:\?|$)/);
  await page.getByRole('button', { name: 'Drafts and sends' }).click();
  await expect(page.getByRole('button', { name: /No subject/ })).toHaveCount(0);
});

test('dirty navigation requires save, lost send response recovers, and proven preflight permits a new action', async ({ page, baseURL }) => {
  const data = await fixture(page);
  await page.goto(`${baseURL}/mail`);
  await page.getByRole('button', { name: 'New message' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'To' }).fill('recipient@example.com');
  await page.getByRole('textbox', { name: 'Message' }).fill('First version');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).fill('Keep this version');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('Changes are still saving.')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this version');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  data.preflightFail = true;
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Add a recipient' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  data.loseSendResponse = true;
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('heading', { name: 'Send needs attention' })).toBeVisible();
  expect(data.sendCalls).toBe(2);
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Drafts and sends' }).click();
  await expect(page.getByRole('button', { name: /Send needs attention/ })).toBeVisible();
  expect(data.sendCalls).toBe(2);
});

test('invalid draft scopes do not read private draft details', async ({ page, baseURL }) => {
  const data = await fixture(page);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.goto(`${baseURL}/mail/draft/${account}/${id}?accountId=${accountB}`);
  await expect(page.getByRole('alert')).toContainText('invalid filters');
  await page.goto(`${baseURL}/mail/draft/${account}/${id}?accountId=${account}&accountId=${account}`);
  await expect(page.getByRole('alert')).toContainText('invalid filters');
  await page.goto(`${baseURL}/mail/draft/${account}/${id}?orbitId=99999999-9999-4999-8999-999999999999`);
  await expect(page.getByRole('alert').filter({ hasText: 'unavailable' })).toBeVisible();
  expect(data.draftReads).toBe(0);
});

test('mobile keyboard moves through fields and Enter does not send', async ({ page, baseURL }) => {
  const data = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseURL}/mail`);
  await page.getByRole('button', { name: 'New message' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'To' }).focus();
  await page.keyboard.type('recipient@example.com');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Cc', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Bcc' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Subject' })).toBeFocused();
  await page.keyboard.type('Example keyboard draft');
  await page.keyboard.press('Enter');
  expect(data.sendCalls).toBe(0);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused();
  await page.keyboard.type('Plain text on mobile.');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  expect(data.sendCalls).toBe(0);
});

test('reconnect keeps unsaved editor text and makes no passive private draft read', async ({ page, baseURL }) => {
  const data = await fixture(page);
  await page.goto(`${baseURL}/mail`);
  await page.getByRole('button', { name: 'New message' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('Saved original');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.route('**/api/mail/drafts/*?*', async (route) => {
    if (route.request().method() === 'PUT') return route.abort('failed');
    return route.fallback();
  });
  await page.getByRole('textbox', { name: 'Message' }).fill('Unsaved after connection loss');
  await expect(page.getByText('Not saved. Retry when connected.')).toBeVisible();
  const reads = data.draftReads;
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Unsaved after connection loss');
  expect(data.draftReads).toBe(reads);
});

test('reopened failed send restores owned attachments before editing', async ({ page, baseURL }) => {
  const data = await fixture(page);
  const id = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const opId = crypto.randomUUID();
  data.drafts.set(id, { id, accountId: account, orbitId: orbit, threadId: null, parentItemId: null,
    to: [{ address: 'recipient@example.com', name: '' }], cc: [], bcc: [], subject: 'Recovery with attachment',
    bodyText: 'Keep the file', attachmentRefs: [fileId], revision: 3, state: 'sending', createdAt: now, updatedAt: now });
  data.attachments.set(fileId, { id: fileId, filename: 'must-review.txt', byteSize: 12, status: 'ready' });
  data.operations.set(opId, { id: opId, draftId: id, accountId: account, orbitId: orbit, state: 'failed',
    providerResultId: null, updatedAt: now, message: 'The send failed before Gmail accepted it.' });
  await page.route(`**/api/mail/drafts/${id}/send?*`, async (route) => {
    data.drafts.get(id)!.state = 'editing';
    return route.fallback();
  });
  await page.goto(`${baseURL}/mail/draft/${account}/${id}?orbitId=${orbit}`);
  await expect(page.getByRole('heading', { name: 'Compose message' })).toBeVisible();
  await expect(page.getByRole('link', { name: /must-review.txt/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Drafts and sends' }).click();
  await page.getByRole('button', { name: /Recovery with attachment/ }).click();
  await expect(page.getByRole('link', { name: /must-review.txt/ })).toBeVisible();
});

test('late unknown status cannot reverse confirmed send', async ({ page, baseURL }) => {
  const data = await fixture(page);
  const id = crypto.randomUUID();
  const opId = crypto.randomUUID();
  data.drafts.set(id, { id, accountId: account, orbitId: orbit, threadId: null, parentItemId: null,
    to: [{ address: 'recipient@example.com', name: '' }], cc: [], bcc: [], subject: 'Status ordering',
    bodyText: 'Example', attachmentRefs: [], revision: 1, state: 'sending', createdAt: now, updatedAt: now });
  const unknown: Operation = { id: opId, draftId: id, accountId: account, orbitId: orbit, state: 'outcome_unknown',
    providerResultId: null, updatedAt: now, message: 'Delivery may have happened.' };
  data.operations.set(opId, unknown);
  let reads = 0;
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  await page.route(`**/api/mail/drafts/${id}/send?*`, async (route) => {
    reads++;
    if (reads === 2) { await oldGate; return route.fulfill({ json: unknown }); }
    if (reads === 3) return route.fulfill({ json: { ...unknown, state: 'succeeded', providerResultId: 'sent_fixture' } });
    return route.fulfill({ json: unknown });
  });
  await page.goto(`${baseURL}/mail/draft/${account}/${id}?orbitId=${orbit}`);
  await expect(page.getByRole('heading', { name: 'Send needs attention' })).toBeVisible();
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect.poll(() => reads).toBe(2);
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByRole('heading', { name: 'Message sent' })).toBeVisible();
  releaseOld();
  await expect.poll(() => reads).toBe(3);
  await expect(page.getByRole('heading', { name: 'Message sent' })).toBeVisible();
});

test('an old failed operation cannot unlock a newer lost send response', async ({ page, baseURL }) => {
  const data = await fixture(page);
  await page.goto(`${baseURL}/mail`);
  await page.getByRole('button', { name: 'New message' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'To' }).fill('recipient@example.com');
  await page.getByRole('textbox', { name: 'Message' }).fill('New attempt');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  const draft = [...data.drafts.values()][0]!;
  const oldId = crypto.randomUUID();
  data.operations.set(oldId, { id: oldId, draftId: draft.id, accountId: account, orbitId: orbit,
    state: 'failed', providerResultId: null, updatedAt: now, message: 'An earlier attempt failed.' });
  let newKey = '';
  await page.route(`**/api/mail/drafts/${draft.id}/send?*`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    newKey = (route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey;
    return route.abort('failed');
  });
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('heading', { name: 'Send needs attention' })).toBeVisible();
  await expect.poll(() => newKey).not.toBe('');
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByRole('heading', { name: 'Send needs attention' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toHaveCount(0);
  const newId = crypto.randomUUID();
  data.operations.set(newId, { id: newId, draftId: draft.id, accountId: account, orbitId: orbit,
    state: 'outcome_unknown', providerResultId: null, updatedAt: now, message: 'Delivery may have happened.' });
  data.operationKeys.set(newKey, newId);
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByRole('heading', { name: 'Send needs attention' })).toBeVisible();
  expect(data.operationKeys.get(newKey)).toBe(newId);
});
});
