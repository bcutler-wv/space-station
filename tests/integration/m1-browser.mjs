import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, URLSearchParams } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { generate } from 'otplib';

const fetch = globalThis.fetch;
const AbortSignal = globalThis.AbortSignal;

const origin = process.env.STATION_M1_BROWSER_BASE_URL;
const controlOrigin = process.env.STATION_M1_BROWSER_CONTROL_URL;
const tokenPath = process.env.STATION_M1_BROWSER_BOOTSTRAP_PATH;
const artifacts = process.env.M1_BROWSER_HOST_ARTIFACT_ROOT ?? '.cache/results/m1-browser';
if (!origin || !controlOrigin || !tokenPath) throw new Error('Integrated browser origin, control URL and bootstrap token are required');
await mkdir(artifacts, { recursive: true });
const control = async (name, data = {}) => {
  const response = await fetch(`${controlOrigin}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data), signal: AbortSignal.timeout(name === 'expireWorker' ? 45_000 : 5_000) });
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
  return response.json();
};
const until = async (label, probe, timeout = 70_000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await probe(); if (result) return result; }
    catch (error) { last = error; }
    await delay(200);
  }
  throw new Error(`${label} timed out: ${last?.message ?? 'condition absent'}`);
};
const screenshot = (page, name) => page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Create your login' }).waitFor();
  await page.getByLabel('One-time setup token').fill((await readFile(tokenPath, 'utf8')).trim());
  await page.getByLabel('Your name').fill('Example Owner');
  await page.getByLabel('Password', { exact: true }).fill('Example-only-password-123!');
  await page.getByRole('button', { name: 'Create password login' }).click();
  const totpUri = await page.getByLabel('Authenticator setup URI').inputValue();
  const secret = new URL(totpUri).searchParams.get('secret');
  assert.ok(secret);
  await page.getByLabel('Six-digit code').fill(await generate({ secret }));
  await page.getByRole('button', { name: 'Confirm code' }).click();
  await page.getByRole('button', { name: 'I saved my codes' }).click();
  await page.goto(`${origin}/setup`);
  await page.getByRole('heading', { name: 'Set up your first Orbit' }).waitFor();
  await page.getByLabel('I confirm this is the address I will use').check();
  await page.getByLabel('Orbit name').fill('Example work');
  await page.getByLabel('What is this part of your work?').fill('Fixture mail only');
  for (const group of ['Global', 'First Orbit']) {
    await page.getByRole('group', { name: group }).getByLabel('Search indexing').selectOption('exclude');
    await page.getByRole('group', { name: group }).getByLabel('AI processing').selectOption('exclude');
  }
  await page.getByRole('button', { name: 'Save Orbit and privacy choices' }).click();
  await page.getByRole('link', { name: 'Connect Google mail' }).click();
  const redirect = await page.getByLabel('Authorized redirect URI', { exact: true }).inputValue();
  assert.equal(redirect, `${origin}/api/google/callback`);
  await page.route('https://accounts.google.com/**', async (route) => {
    const authorize = new URL(route.request().url());
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    const state = authorize.searchParams.get('state');
    assert.ok(state);
    await route.fulfill({ status: 200, contentType: 'text/html',
      body: `<html><body><a href="${redirect}?state=${encodeURIComponent(state)}&code=fixture-m1-code">Approve example.com account</a></body></html>` });
  });
  await page.getByLabel('Web client ID').fill('123456-fixture.apps.googleusercontent.com');
  await page.getByLabel('Web client secret').fill('fixture-client-secret');
  await page.getByRole('button', { name: 'Continue to Google' }).click();
  await page.getByRole('link', { name: 'Approve example.com account' }).click();
  await page.getByRole('heading', { name: 'Finish Google connection' }).waitFor();
  assert.equal(new URL(page.url()).search, '');
  await page.getByRole('button', { name: 'Confirm Google connection' }).click();
  await page.getByRole('status').getByText('Account connected').waitFor();
  await page.getByRole('link', { name: 'View Google accounts' }).click();
  await page.getByRole('heading', { name: 'owner@example.com' }).waitFor();
  await page.getByLabel('1 year').check();
  await page.getByRole('button', { name: 'Save backfill choice' }).click();
  await page.getByText('Backfill choice: 1 year.').waitFor();
  assert.deepEqual((await control('snapshot')).provider.oauth.map((entry) => entry.kind), ['token', 'profile']);
  await screenshot(page, 'setup-light');

  // The browser-visible import uses the same zero-retry queue and durable cursor
  // that the accepted process fixture proves, while this fixture supplies the UI.
  await control('hold', { path: '/gmail/v1/users/me/messages/b', format: 'raw' });
  const firstWorker = await control('startWorker');
  let initial;
  try {
    initial = await until('durable initial checkpoint', async () => {
      const value = await control('snapshot');
      return value.provider.holds.some((entry) => entry.path.endsWith('/b')) &&
        value.rows.some((entry) => entry.externalId === 'a') && value.state?.cursor?.offset === 1 ? value : null;
    });
  } catch (error) {
    // This reports only fixture IDs, queue/cursor state and provider route shapes.
    // Never persist credentials, request headers, message bodies or a full DB row.
    const value = await control('snapshot').catch(() => null);
    const cursor = value?.state?.cursor;
    const diagnostic = {
      failure: 'durable_initial_checkpoint_timeout',
      accountPresent: Boolean(value?.accountId),
      sync: value?.state ? { status: value.state.status, lastError: value.state.lastError,
        leaseUntil: value.state.leaseUntil, sequence: value.state.sequence,
        cursor: cursor && { phase: cursor.phase, offset: cursor.offset, pending: cursor.pending?.length,
          failures: cursor.failures, retryAt: cursor.retryAt, nextCallAt: cursor.nextCallAt } } : null,
      rows: value?.rows.map((row) => row.externalId),
      jobs: value?.jobs.map((job) => ({ state: job.state, retryCount: job.retry_count,
        accountSingleton: job.singleton_key === value.accountId })),
      provider: value?.provider && { holds: value.provider.holds.map((entry) => entry.path),
        calls: value.provider.calls.slice(-30).map((entry) => ({ path: entry.path, method: entry.method,
          format: new URLSearchParams(entry.query).get('format') })), oauthKinds: value.provider.oauth.map((entry) => entry.kind) },
      pids: value?.pids,
    };
    await writeFile(`${artifacts}/initial-checkpoint-diagnostic.json`, JSON.stringify(diagnostic, null, 2)).catch(() => {});
    await screenshot(page, 'initial-checkpoint-timeout').catch(() => {});
    throw new Error(`Durable initial checkpoint failed; see initial-checkpoint-diagnostic.json: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  const firstJob = initial.jobs.find((job) => job.state === 'active');
  assert.ok(firstJob);
  await control('killWorker');
  await control('expireWorker', { jobId: firstJob.id });
  await control('release');
  const resumedWorker = await control('startWorker');
  assert.notEqual(firstWorker.pid, resumedWorker.pid);
  const initialDone = await until('initial queue successor and ready import', async () => {
    const value = await control('snapshot');
    return value.state?.cursor?.phase === 'ready' && value.rows.length === 2 &&
      value.jobs.some((job) => job.id !== firstJob.id && job.state === 'completed') ? value : null;
  });
  assert.equal(initialDone.jobs.find((job) => job.id === firstJob.id).state, 'failed');
  assert.ok(initialDone.jobs.some((job) => job.id !== firstJob.id && job.singleton_key === initialDone.accountId));
  await page.reload();
  await page.getByText('Mail is current as of the latest completed catch-up.').waitFor();

  await control('killWorker');
  await control('history');
  await control('hold', { path: '/gmail/v1/users/me/messages/a', format: 'raw' });
  const historyWorker = await control('startWorker');
  const historyHeld = await until('durable History tail checkpoint', async () => {
    const value = await control('snapshot');
    return value.provider.holds.some((entry) => entry.path.endsWith('/a')) &&
      value.state?.cursor?.historyToken === 'tail' && value.rows.some((entry) => entry.externalId === 'c') ? value : null;
  });
  const historyJob = historyHeld.jobs.find((job) => job.state === 'active');
  assert.ok(historyJob);
  const cReads = historyHeld.provider.calls.filter((entry) => entry.path.endsWith('/c') && entry.query.includes('format=raw')).length;
  await control('killWorker');
  await control('expireWorker', { jobId: historyJob.id });
  await control('release');
  const historyResumed = await control('startWorker');
  assert.notEqual(historyWorker.pid, historyResumed.pid);
  const historyDone = await until('History successor and ready cursor', async () => {
    const value = await control('snapshot');
    return value.state?.cursor?.phase === 'ready' && value.state?.cursor?.anchor === '20' &&
      value.jobs.some((job) => job.id !== historyJob.id && job.state === 'completed') ? value : null;
  });
  assert.equal(historyDone.provider.calls.filter((entry) => entry.path.endsWith('/c') && entry.query.includes('format=raw')).length, cReads);
  assert.deepEqual(historyDone.rows.map((row) => row.externalId).sort(), ['a', 'b', 'c']);
  const contextResponse = await page.request.get(`${origin}/api/mail/context`);
  assert.equal(contextResponse.status(), 200);
  const mailContext = await contextResponse.json();
  const orbitId = mailContext.orbits.find((entry) => entry.name === 'Example work')?.id;
  assert.ok(orbitId);
  const legacy = historyDone.rows.find((row) => row.externalId === 'c');
  assert.equal(legacy.replyMetadata, null);
  await page.goto(`${origin}/mail/thread/${historyDone.accountId}/${legacy.threadId}?orbitId=${orbitId}`);
  await page.getByRole('button', { name: 'Reply' }).click();
  await expect(page.getByRole('textbox', { name: 'To' })).toHaveValue('sender@example.com');
  await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue('Re: Example c');
  const repaired = await control('snapshot');
  assert.equal(repaired.rows.find((row) => row.externalId === 'c').replyMetadata?.messageId, '<c@example.com>');
  assert.equal(repaired.provider.calls.filter((entry) => entry.path.endsWith('/c') && entry.query.includes('format=metadata')).length, 1);
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.goto(`${origin}/mail?accountId=${historyDone.accountId}`);
  await expect(page.getByRole('combobox', { name: 'Mailbox' })).toHaveValue(`account:${historyDone.accountId}`);
  await page.goto(`${origin}/mail?orbitId=${orbitId}`);
  await page.getByRole('heading', { name: 'Mail', exact: true, level: 1 }).waitFor();
  await expect(page.getByRole('combobox', { name: 'Mailbox' })).toHaveValue(`orbit:${orbitId}`);
  await page.getByRole('textbox', { name: 'Subject contains' }).fill('Example a');
  await page.getByRole('button', { name: /Example a/ }).waitFor();
  await expect(page.getByRole('button', { name: /Example b/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Example c/ })).toHaveCount(0);
  await screenshot(page, 'mail-search-light');
  const providerWritesBeforeOpen = historyDone.provider.modifications.length;
  assert.equal(historyDone.provider.sent.length, 0);
  await page.getByRole('button', { name: /Example a/ }).click();
  await expect(page).toHaveURL(new RegExp(`/mail/thread/${historyDone.accountId}/`));
  assert.equal(new URL(page.url()).searchParams.get('orbitId'), orbitId);
  await page.getByRole('button', { name: 'Read message' }).focus();
  await expect(page.getByRole('button', { name: 'Read message' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.frameLocator('iframe[title="Message content"]').getByText('Safe example').waitFor();
  assert.equal(await page.evaluate(() => Boolean(globalThis.__mailAttack)), false);
  await expect(page.getByRole('link', { name: /example.txt/ })).toBeVisible();
  const attachmentHref = await page.getByRole('link', { name: /example.txt/ }).getAttribute('href');
  assert.ok(attachmentHref);
  const attachment = await page.request.get(new URL(attachmentHref, origin).href);
  assert.equal(attachment.status(), 200);
  assert.equal((await attachment.body()).toString(), 'Example attachment');
  await page.getByRole('button', { name: 'Load images in this message' }).click();
  await page.getByRole('button', { name: 'Block images in this message' }).waitFor();
  await page.getByRole('button', { name: 'Block images in this message' }).click();
  await page.getByRole('button', { name: 'Load images in this message' }).waitFor();
  await page.frameLocator('iframe[title="Message content"]').getByText('Safe example').waitFor();
  await page.locator('iframe[title="Message content"]').scrollIntoViewIfNeeded();
  assert.equal((await control('snapshot')).provider.modifications.length, providerWritesBeforeOpen);
  assert.equal((await control('snapshot')).provider.sent.length, 0);
  await screenshot(page, 'hostile-mail-light');
  await page.getByRole('button', { name: 'Close message' }).click();
  await page.getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('button', { name: 'Mark read' }).click();
  await page.getByText(/Change confirmed/).waitFor();
  let actionSnapshot = await control('snapshot');
  const firstAction = actionSnapshot.changes.at(-1);
  assert.equal(firstAction?.action, 'mark_read');
  assert.equal(firstAction.state, 'succeeded');
  await control('syncNow');
  await until('authoritative read-state sync', async () => {
    const value = await control('snapshot');
    const row = value.rows.find((entry) => entry.externalId === 'a');
    return row?.appliedSequence > historyDone.rows.find((entry) => entry.externalId === 'a').appliedSequence &&
      new Date(row.updatedAt) > new Date(firstAction.completedAt) ? value : null;
  });
  await page.getByRole('button', { name: 'Refresh options' }).click();
  await page.getByRole('button', { name: 'Add Empty' }).click();
  await page.getByText(/Change confirmed/).waitFor();
  const changed = await control('snapshot');
  assert.equal(changed.provider.modifications.length, providerWritesBeforeOpen + 2);
  assert.ok(changed.changes.every((entry) => entry.state === 'succeeded'));
  assert.equal(changed.audits.filter((entry) => entry.action === 'mail_change_confirmed').length, 2);
  await control('syncNow');
  await until('authoritative added-label sync', async () => {
    const value = await control('snapshot');
    const row = value.rows.find((entry) => entry.externalId === 'a');
    return row?.appliedSequence > actionSnapshot.rows.find((entry) => entry.externalId === 'a').appliedSequence &&
      new Date(row.updatedAt) > new Date(changed.changes.at(-1).completedAt) ? value : null;
  });

  // Archive a different Inbox item after provider acceptance, then restart the
  // actual app process before it can record success. Browser recovery only reads.
  const inbox = changed.rows.find((entry) => entry.externalId === 'b');
  await page.goto(`${origin}/mail/thread/${changed.accountId}/${inbox.threadId}`);
  await page.getByRole('button', { name: 'Message actions' }).click();
  await control('hold', { path: '/gmail/v1/users/me/messages/b/modify' });
  await page.getByRole('button', { name: 'Archive this message' }).click({ noWaitAfter: true });
  const archiveAccepted = await until('provider accepted archive', async () => {
    const value = await control('snapshot');
    return value.provider.modifications.length === providerWritesBeforeOpen + 3 &&
      value.changes.some((entry) => entry.action === 'archive' && entry.state === 'in_flight') ? value : null;
  }, 35_000);
  const archive = archiveAccepted.changes.find((entry) => entry.action === 'archive');
  await control('killApp');
  await control('staleChange', { operationId: archive.id });
  await control('release');
  const archiveApp = await control('startApp');
  assert.notEqual(archiveAccepted.pids.app, archiveApp.pid);
  await until('restarted HTTPS app after archive', async () => (await page.request.get(`${origin}/ready`, { timeout: 3_000 })).ok());
  await page.reload();
  await page.getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('button', { name: 'Check desired state' }).click();
  await page.getByText(/Gmail currently shows the requested state/).waitFor();
  const archived = await control('snapshot');
  assert.equal(archived.provider.modifications.length, providerWritesBeforeOpen + 3);
  assert.equal(archived.changes.find((entry) => entry.id === archive.id).state, 'succeeded');
  assert.ok(archived.audits.some((entry) => entry.action === 'mail_change_observed' && entry.targetId === archive.id));
  await screenshot(page, 'archive-reconciled-light');

  await page.goto(`${origin}/mail/thread/${changed.accountId}/${changed.rows.find((entry) => entry.externalId === 'a').threadId}`);

  // A reply exercises real header provenance, a private draft and one confirmed send.
  await page.getByRole('button', { name: 'Reply' }).click();
  await expect(page.getByRole('textbox', { name: 'To' })).toHaveValue('sender@example.com');
  await page.getByRole('textbox', { name: 'Message' }).fill('Example reply from the owner.');
  await until('reply body durably saved', async () => (await control('snapshot')).drafts
    .some((entry) => entry.bodyText === 'Example reply from the owner.' && entry.revision > 1));
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  const replyUrl = page.url();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Example reply from the owner.');
  await page.locator('.mail-compose-upload input').setInputFiles({ name: 'reply.txt', mimeType: 'text/plain', buffer: Buffer.from('Owner attachment') });
  await page.getByRole('link', { name: /reply.txt/ }).waitFor();
  await until('reply attachment durably ready', async () => (await control('snapshot')).uploads
    .some((entry) => entry.filename === 'reply.txt' && entry.state === 'ready'));
  await page.reload();
  await expect(page).toHaveURL(replyUrl);
  await page.getByRole('link', { name: /reply.txt/ }).waitFor();
  await screenshot(page, 'reply-draft-light');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('heading', { name: 'Message sent' }).waitFor();
  const confirmedReply = (await control('snapshot')).provider.sent;
  assert.equal(confirmedReply.length, 1);
  assert.equal(confirmedReply[0].threadId, 'ta');
  assert.equal(confirmedReply[0].inReplyTo, '<a@example.com>');
  assert.ok(confirmedReply[0].references?.includes('<a@example.com>'));
  assert.ok(confirmedReply[0].attachments.some((entry) => entry.filename === 'reply.txt' &&
    entry.digest === createHash('sha256').update('Owner attachment').digest('hex')));

  // Provider acceptance precedes durable app success; the provider process survives.
  // Hold the fresh page's account context so a click cannot silently select an
  // empty account before the request completes.
  let contextRequested = false;
  let releaseContext;
  const contextReleased = new Promise((resolve) => { releaseContext = resolve; });
  await page.route('**/api/mail/context', async (route) => {
    contextRequested = true;
    await contextReleased;
    await route.continue();
  });
  try {
    await page.goto(`${origin}/mail`);
    await until('fresh mail context requested', async () => contextRequested, 5_000);
    await expect(page.getByRole('button', { name: 'New message' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  } finally {
    releaseContext();
  }
  await expect(page.getByRole('button', { name: 'New message' })).toBeEnabled();
  await page.unroute('**/api/mail/context');
  await page.getByRole('button', { name: 'New message' }).click();
  try {
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  } catch (error) {
    await screenshot(page, 'new-message-start-failure').catch(() => {});
    throw error;
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'To' }).fill('recipient@example.com');
  await page.getByRole('textbox', { name: 'Subject' }).fill('Example unknown send');
  await page.getByRole('textbox', { name: 'Message' }).fill('Exactly one provider submission.');
  await until('new send body durably saved', async () => (await control('snapshot')).drafts
    .some((entry) => entry.bodyText === 'Exactly one provider submission.' && entry.revision > 1));
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  await control('hold', { path: '/gmail/v1/users/me/messages/send' });
  await page.getByRole('button', { name: 'Send message' }).click({ noWaitAfter: true });
  const accepted = await until('provider accepted second send', async () => {
    const value = await control('snapshot');
    return value.provider.sent.length === 2 && value.sends.some((entry) => entry.state === 'in_flight') ? value : null;
  }, 35_000);
  const operation = accepted.sends.find((entry) => entry.state === 'in_flight');
  await control('killApp');
  await control('staleSend', { operationId: operation.id });
  await control('release');
  const restarted = await control('startApp');
  assert.notEqual(accepted.pids.app, restarted.pid);
  await until('restarted HTTPS app', async () => (await page.request.get(`${origin}/ready`, { timeout: 3_000 })).ok());
  await page.reload();
  await page.getByRole('heading', { name: 'Send needs attention' }).waitFor();
  await page.getByRole('button', { name: 'Check Sent' }).click();
  await page.getByRole('heading', { name: 'Message sent' }).waitFor();
  assert.equal((await control('snapshot')).provider.sent.length, 2);
  await screenshot(page, 'reconciled-send-light');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${origin}/mail`);
  await page.waitForFunction(() => globalThis.document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  await screenshot(page, 'mail-dark-mobile');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  assert.equal((await page.request.get(`${origin}/api/mail/context`)).status(), 401);
  const afterLogout = (await control('snapshot')).provider;
  assert.equal(afterLogout.sent.length, 2);
  assert.equal(afterLogout.modifications.length, providerWritesBeforeOpen + 3);
  await context.close();
  process.stdout.write('Integrated TLS browser, OAuth, durable sync, safe reading, actions, reply and send recovery passed.\n');
} finally { await browser.close(); }
