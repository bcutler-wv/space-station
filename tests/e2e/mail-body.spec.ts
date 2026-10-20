import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const account = '11111111-1111-4111-8111-111111111111';
const item = '33333333-3333-4333-8333-333333333333';
const cid = 'a'.repeat(32);
const remote = 'b'.repeat(32);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64');
const visualPng = readFileSync('tests/fixtures/mail-body-image.png');
const html = `<script src="https://evil.example.com/script.js"></script><style>@import url(https://evil.example.com/style.css)</style><img src="https://evil.example.com/pixel" onerror="fetch('https://evil.example.com/event')"><picture><source srcset="https://evil.example.com/srcset"></picture><link rel="preload" href="https://evil.example.com/preload"><svg><image href="https://evil.example.com/svg"></image></svg><math><mtext href="https://evil.example.com/math">x</mtext></math><form action="https://evil.example.com/form"><input name="x"></form><a href="javascript:alert(1)">Unsafe</a><a href="https://example.com/safe">Safe link</a><span data-station-image-ref="${cid}">[CID]</span><span data-station-image-ref="${remote}">[Remote]</span>`;

test('hostile body stays inert, CID loads, remote consent and revocation work', async ({ page, baseURL, context }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  const outside: string[] = [];
  page.on('request', request => { if (request.url().includes('evil.example.com') || request.url().includes('/fixture/probe')) outside.push(request.url()); });
  let messageEnabled = false;
  let cidLoads = 0;
  let remoteLoads = 0;
  const sameOriginHostile = '<img src="/fixture/probe?img"><iframe src="/fixture/probe?frame"></iframe><object data="/fixture/probe?object"></object><video poster="/fixture/probe?poster"><source src="/fixture/probe?source"></video><link rel="preload" href="/fixture/probe?preload"><style>@import url(/fixture/probe?css)</style>';
  await page.route('**/fixture/probe**', route => route.fulfill({ status: 200, body: 'unexpected resource load' }));
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status: 'available', text: 'Plain fallback', html: html + sameOriginHostile, htmlPolicyVersion: 1, imageRefs: [cid, remote] } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled, messageChoice: messageEnabled ? true : null, effectiveRemoteEnabled: messageEnabled, senderEnabled: false, senderAddress: 'sender@example.com', refs: [{ refId: cid, kind: 'cid' }, { refId: remote, kind: 'remote' }] } }));
  await page.route('**/api/mail/items/*/images/consent', async route => { messageEnabled = Boolean((route.request().postDataJSON() as { enabled: boolean }).enabled); await route.fulfill({ json: { enabled: messageEnabled } }); });
  await page.route('**/api/mail/items/*/images/fetch', route => {
    const ref = (route.request().postDataJSON() as { refId: string }).refId;
    if (ref === cid) cidLoads++; else remoteLoads++;
    return route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  const navigation = await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  expect(navigation?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.locator('iframe[title="Message content"]')).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  await expect(page.getByRole('button', { name: 'Load images in this message' })).toBeVisible();
  await expect.poll(() => cidLoads).toBe(1);
  await expect.poll(() => page.frameLocator('iframe[title="Message content"]').locator('img').first()
    .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(remoteLoads).toBe(0);
  await expect(page.frameLocator('iframe[title="Message content"]').getByText('Safe link')).toBeVisible();
  expect(outside).toEqual([]);
  await expect(page.frameLocator('iframe[title="Message content"]').locator('body script,body style,form,svg,math,picture,source,link')).toHaveCount(0);
  await expect(page.frameLocator('iframe[title="Message content"]').getByText('Unsafe')).not.toHaveAttribute('href', /javascript/);
  await context.route('https://example.com/safe', route => route.fulfill({ contentType: 'text/html', body: '<p>Safe link fixture</p>' }));
  const popupPromise = context.waitForEvent('page');
  await page.frameLocator('iframe[title="Message content"]').getByRole('link', { name: 'Safe link' }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL('https://example.com/safe');
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await popup.close();
  await page.getByRole('button', { name: 'Load images in this message' }).click();
  await expect.poll(() => remoteLoads).toBe(1);
  await expect.poll(() => page.frameLocator('iframe[title="Message content"]').locator('img').last()
    .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/mail-body-html-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Block images in this message' }).click();
  await expect(page.getByRole('button', { name: 'Load images in this message' })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Message content"]').locator('img')).toHaveCount(1);
  expect(outside).toEqual([]);
});

test('bounded image queue discards stale item responses', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  const refs = Array.from({ length: 6 }, (_, index) => index.toString(16).padStart(32, '0'));
  const second = '44444444-4444-4444-8444-444444444444';
  const orbit = '22222222-2222-4222-8222-222222222222';
  let active = 0, peak = 0, started = 0;
  let orbitReads = 0;
  await page.route('**/api/mail/items/*/body?**', route => {
    const isSecond = route.request().url().includes(second);
    if (route.request().url().includes(`orbitId=${orbit}`)) orbitReads++;
    return route.fulfill({ json: { itemId: isSecond ? second : item, status: 'available', text: null,
      html: isSecond ? '<p>Second item</p>' : refs.map(ref => `<span data-station-image-ref="${ref}">[Image]</span>`).join(''),
      htmlPolicyVersion: 1, imageRefs: isSecond ? [] : refs } });
  });
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false, messageChoice: null, effectiveRemoteEnabled: false, senderEnabled: false,
    senderAddress: null, refs: route.request().url().includes(second) ? [] : refs.map(refId => ({ refId, kind: 'cid' })) } }));
  await page.route('**/api/mail/items/*/images/fetch', async route => {
    active++; started++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 200));
    active--;
    await route.fulfill({ status: 200, contentType: 'image/png', body: png }).catch(() => undefined);
  });
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await expect.poll(() => started).toBe(4);
  expect(peak).toBe(4);
  await page.evaluate((url) => { history.pushState(null, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }, `/mail/body/${account}/${second}`);
  await expect(page.frameLocator('iframe[title="Message content"]').getByText('Second item')).toBeVisible();
  await expect(page.frameLocator('iframe[title="Message content"]').locator('img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Always load images from this sender' })).toHaveCount(0);
  await page.evaluate((url) => { history.pushState(null, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }, `/mail/body/${account}/${second}?orbitId=${orbit}`);
  await expect.poll(() => orbitReads).toBe(1);
});

test('plain, unsupported, unavailable and mobile theme states', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  let status: 'available' | 'unsupported' | 'unavailable' = 'available';
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status,
    text: status === 'available' ? 'Plain message from Example.' : null,
    html: null, htmlPolicyVersion: null, imageRefs: [] } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false, messageChoice: null, effectiveRemoteEnabled: false,
    senderEnabled: false, senderAddress: null, refs: [] } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('station-theme-mode', 'dark'));
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await expect(page.getByText('Plain message from Example.')).toBeVisible();
  await page.screenshot({ path: 'test-results/mail-body-dark-mobile.png', fullPage: true });
  status = 'unsupported';
  await page.reload();
  await expect(page.getByText('This message format is unsupported.')).toBeVisible();
  status = 'unavailable';
  await page.reload();
  await expect(page.getByText('This message is unavailable. Try again later.')).toBeVisible();
  await page.addInitScript(() => localStorage.setItem('station-theme-mode', 'light'));
  status = 'available';
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.screenshot({ path: 'test-results/mail-body-light-desktop.png', fullPage: true });
});

test('oversize image responses never enter the frame', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status: 'available', text: null,
    html: `<span data-station-image-ref="${cid}">[Image]</span>`, htmlPolicyVersion: 1, imageRefs: [cid] } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false, messageChoice: null, effectiveRemoteEnabled: false,
    senderEnabled: false, senderAddress: null, refs: [{ refId: cid, kind: 'cid' }] } }));
  let finished = false;
  await page.route('**/api/mail/items/*/images/fetch', async route => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]) });
    finished = true;
  });
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await expect.poll(() => finished).toBe(true);
  await expect(page.frameLocator('iframe[title="Message content"]').locator('img')).toHaveCount(0);
});

test('explicit message block wins over an enabled sender preference', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  let choice: boolean | null = null;
  let loads = 0;
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status: 'available', text: null,
    html: `<span data-station-image-ref="${remote}">[Remote]</span>`, htmlPolicyVersion: 1, imageRefs: [remote] } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: {
    messageEnabled: choice === true, messageChoice: choice, senderEnabled: true,
    effectiveRemoteEnabled: choice ?? true, senderAddress: 'sender@example.com', refs: [{ refId: remote, kind: 'remote' }],
  } }));
  await page.route('**/api/mail/items/*/images/consent', route => {
    choice = (route.request().postDataJSON() as { enabled: boolean }).enabled;
    return route.fulfill({ json: { enabled: choice } });
  });
  await page.route('**/api/mail/items/*/images/fetch', route => { loads++; return route.fulfill({ contentType: 'image/png', body: png }); });
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await expect.poll(() => loads).toBe(1);
  await page.getByRole('button', { name: 'Block images in this message' }).click();
  await expect(page.getByRole('button', { name: 'Load images in this message' })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Message content"]').locator('img')).toHaveCount(0);
  expect(choice).toBe(false);
  expect(loads).toBe(1);
});

test('HTML frame uses selected dark tokens and local Rubik on a light OS', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('station-theme-mode', 'dark'));
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status: 'available',
    text: null, html: '<p>Example message content.</p>', htmlPolicyVersion: 1, imageRefs: [] } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false,
    messageChoice: null, effectiveRemoteEnabled: false, senderEnabled: false, senderAddress: null, refs: [] } }));
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await expect(page.frameLocator('iframe[title="Message content"]').getByText('Example message content.')).toBeVisible();
  await expect.poll(() => page.frameLocator('iframe[title="Message content"]').locator('html')
    .evaluate(() => document.styleSheets[0]?.cssRules[0]?.cssText.includes('@font-face') ?? false)).toBe(true);
  const fonts = await page.frameLocator('iframe[title="Message content"]').locator('html').evaluate(async () => {
    await document.fonts.ready;
    return { check: document.fonts.check('15px MailRubik'), faces: Array.from(document.fonts, face => ({ family: face.family, status: face.status })) };
  });
  expect(fonts.check, JSON.stringify(fonts)).toBe(true);
  const frame = await page.frameLocator('iframe[title="Message content"]').locator('html').evaluate(element => ({
    scheme: getComputedStyle(element).colorScheme, color: getComputedStyle(element).color,
  }));
  const token = await page.evaluate(() => { const sample = document.createElement('div'); sample.style.color = 'var(--on-surface)';
    document.body.append(sample); const value = getComputedStyle(sample).color; sample.remove(); return value; });
  expect(frame.scheme).toBe('dark');
  expect(frame.color).toBe(token);
  await page.screenshot({ path: 'test-results/mail-body-html-dark.png', fullPage: true });
});

test('body deadline ends a stalled read without an automatic retry loop', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  let reads = 0;
  await page.route('**/api/mail/items/*/body?**', async route => {
    reads++;
    await new Promise(resolve => setTimeout(resolve, 12_000));
    await route.fulfill({ json: { itemId: item, status: 'available', text: 'Too late', html: null,
      htmlPolicyVersion: null, imageRefs: [] } }).catch(() => undefined);
  });
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false,
    messageChoice: null, effectiveRemoteEnabled: false, senderEnabled: false, senderAddress: null, refs: [] } }));
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await expect(page.getByText('Message is unavailable. Try again.')).toBeVisible({ timeout: 12_000 });
  expect(reads).toBe(1);
});

test('claimed-sender preference is explicit, account scoped and reversible', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  let senderEnabled = false;
  let fetches = 0;
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status: 'available', text: null,
    html: `<span data-station-image-ref="${remote}">[Remote]</span>`, htmlPolicyVersion: 1, imageRefs: [remote] } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false,
    messageChoice: null, effectiveRemoteEnabled: senderEnabled, senderEnabled,
    senderAddress: 'sender@example.com', refs: [{ refId: remote, kind: 'remote' }] } }));
  await page.route('**/api/mail/items/*/images/sender-preference', route => {
    const request = route.request();
    expect(request.headers()['x-csrf-token']).toBe('fixture-token');
    expect((request.postDataJSON() as { accountId: string }).accountId).toBe(account);
    senderEnabled = (request.postDataJSON() as { enabled: boolean }).enabled;
    return route.fulfill({ json: { enabled: senderEnabled, senderAddress: 'sender@example.com' } });
  });
  await page.route('**/api/mail/items/*/images/fetch', route => { fetches++; return route.fulfill({ contentType: 'image/png', body: png }); });
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  expect(fetches).toBe(0);
  await page.getByRole('button', { name: 'Always load images from this sender' }).click();
  await expect.poll(() => fetches).toBe(1);
  await page.getByRole('button', { name: 'Stop loading images from this sender' }).click();
  await expect(page.frameLocator('iframe[title="Message content"]').locator('img')).toHaveCount(0);
  expect(senderEnabled).toBe(false);
});

test('logout clears body and stops queued CID work before held responses finish', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  const refs = Array.from({ length: 6 }, (_, index) => `c${index.toString(16).padStart(31, '0')}`);
  let starts = 0;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const firstFour = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status: 'available', text: 'Private fixture body',
    html: refs.map(ref => `<span data-station-image-ref="${ref}">[Image]</span>`).join(''), htmlPolicyVersion: 1, imageRefs: refs } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false,
    messageChoice: null, effectiveRemoteEnabled: false, senderEnabled: false, senderAddress: null,
    refs: refs.map(refId => ({ refId, kind: 'cid' })) } }));
  await page.route('**/api/mail/items/*/images/fetch', async route => {
    starts++;
    if (starts === 4) started();
    await held;
    await route.fulfill({ contentType: 'image/png', body: png }).catch(() => undefined);
  });
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await firstFour;
  await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
  await expect(page.getByLabel('Message body')).toHaveCount(0);
  release();
  await page.waitForTimeout(200);
  expect(starts).toBe(4);
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByText('Private fixture body')).toHaveCount(0);
});

test('logout invalidates held body and sender mutation completions', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  let holdBody = false;
  let releaseBody!: () => void;
  let bodyStarted!: () => void;
  const bodyHeld = new Promise<void>(resolve => { releaseBody = resolve; });
  const bodyStart = new Promise<void>(resolve => { bodyStarted = resolve; });
  await page.route('**/api/mail/items/*/body?**', async route => {
    if (holdBody) { bodyStarted(); await bodyHeld; }
    await route.fulfill({ json: { itemId: item, status: 'available', text: 'Private body',
      html: `<span data-station-image-ref="${remote}">[Remote]</span>`, htmlPolicyVersion: 1, imageRefs: [remote] } }).catch(() => undefined);
  });
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false,
    messageChoice: null, effectiveRemoteEnabled: false, senderEnabled: false,
    senderAddress: 'sender@example.com', refs: [{ refId: remote, kind: 'remote' }] } }));
  let releaseMutation!: () => void;
  let mutationStarted!: () => void;
  const mutationHeld = new Promise<void>(resolve => { releaseMutation = resolve; });
  const mutationStart = new Promise<void>(resolve => { mutationStarted = resolve; });
  await page.route('**/api/mail/items/*/images/sender-preference', async route => {
    mutationStarted(); await mutationHeld;
    await route.fulfill({ json: { enabled: true, senderAddress: 'sender@example.com' } }).catch(() => undefined);
  });
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await page.getByRole('button', { name: 'Always load images from this sender' }).click();
  await mutationStart;
  holdBody = true;
  await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
  releaseMutation();
  await page.waitForTimeout(100);
  await expect(page.getByLabel('Message body')).toHaveCount(0);
  await expect(page.getByText('Image setting could not be saved.')).toHaveCount(0);
  // A second mount exercises a held initial body read; the first instance stays closed.
  await page.reload();
  await bodyStart;
  await page.evaluate(() => window.dispatchEvent(new Event('station:logout')));
  releaseBody();
  await page.waitForTimeout(100);
  await expect(page.getByText('Private body')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('revoking consent aborts a pending remote raster', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  let enabled = true;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetchStart = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status: 'available', text: null,
    html: `<span data-station-image-ref="${remote}">[Remote]</span>`, htmlPolicyVersion: 1, imageRefs: [remote] } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: enabled,
    messageChoice: enabled, effectiveRemoteEnabled: enabled, senderEnabled: false,
    senderAddress: 'sender@example.com', refs: [{ refId: remote, kind: 'remote' }] } }));
  await page.route('**/api/mail/items/*/images/consent', route => { enabled = false; return route.fulfill({ json: { enabled } }); });
  let fetches = 0;
  await page.route('**/api/mail/items/*/images/fetch', async route => {
    fetches++; started(); await held;
    await route.fulfill({ contentType: 'image/png', body: visualPng }).catch(() => undefined);
  });
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await fetchStart;
  await page.getByRole('button', { name: 'Block images in this message' }).click();
  release();
  await expect(page.getByRole('button', { name: 'Load images in this message' })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Message content"]').locator('img')).toHaveCount(0);
  expect(fetches).toBe(1);
});

test('streamed image over cap and stalled image body are cancelled', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  let mode: 'oversize' | 'stall' = 'oversize';
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status: 'available', text: null,
    html: `<span data-station-image-ref="${cid}">[CID]</span>`, htmlPolicyVersion: 1, imageRefs: [cid] } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false,
    messageChoice: null, effectiveRemoteEnabled: false, senderEnabled: false, senderAddress: null,
    refs: [{ refId: cid, kind: 'cid' }] } }));
  let requests = 0;
  await page.route('**/api/mail/items/*/images/fetch', route => {
    requests++;
    return route.continue({ url: `${baseURL}/fixture/mail-image-stream/${mode}` });
  });
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await expect.poll(() => requests).toBe(1);
  await page.waitForTimeout(500);
  await expect(page.frameLocator('iframe[title="Message content"]').locator('img')).toHaveCount(0);
  mode = 'stall';
  await page.reload();
  await expect.poll(() => requests).toBe(2);
  await page.waitForTimeout(10_500);
  await expect(page.frameLocator('iframe[title="Message content"]').locator('img')).toHaveCount(0);
  expect(requests).toBe(2);
});

test('aggregate displayed PNG bytes stop at 32 MiB', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  const refs = Array.from({ length: 18 }, (_, index) => `d${index.toString(16).padStart(31, '0')}`);
  const padded = Buffer.concat([visualPng, Buffer.alloc(1_900_000 - visualPng.length)]);
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status: 'available', text: null,
    html: refs.map(ref => `<span data-station-image-ref="${ref}">[Image]</span>`).join(''), htmlPolicyVersion: 1, imageRefs: refs } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false,
    messageChoice: null, effectiveRemoteEnabled: false, senderEnabled: false, senderAddress: null,
    refs: refs.map(refId => ({ refId, kind: 'cid' })) } }));
  let requests = 0;
  await page.route('**/api/mail/items/*/images/fetch', route => { requests++; return route.fulfill({ contentType: 'image/png', body: padded }); });
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await expect.poll(() => requests, { timeout: 20_000 }).toBe(18);
  await expect.poll(() => page.frameLocator('iframe[title="Message content"]').locator('img').count(), { timeout: 20_000 }).toBe(17);
  const displayed = await page.frameLocator('iframe[title="Message content"]').locator('img').count();
  expect(displayed * padded.length).toBeLessThanOrEqual(32 * 1024 * 1024);
});

test('representative HTML is readable with controls, links, long mail and images in both themes and sizes', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  const paragraphs = Array.from({ length: 18 }, (_, index) => `<p>Example update ${index + 1}. The project notes are ready for review, with a clear next step and a short explanation that wraps on a narrow screen.</p>`).join('');
  const content = `<h2>Example project update</h2><p>Please review the <a href="https://example.com/review">shared review page</a>.</p><span data-station-image-ref="${cid}">[Related diagram]</span>${paragraphs}<span data-station-image-ref="${remote}">[Remote illustration]</span>`;
  await page.route('**/api/mail/items/*/body?**', route => route.fulfill({ json: { itemId: item, status: 'available', text: null,
    html: content, htmlPolicyVersion: 1, imageRefs: [cid, remote] } }));
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: true,
    messageChoice: true, effectiveRemoteEnabled: true, senderEnabled: false,
    senderAddress: 'sender@example.com', refs: [{ refId: cid, kind: 'cid' }, { refId: remote, kind: 'remote' }] } }));
  await page.route('**/api/mail/items/*/images/fetch', route => route.fulfill({ contentType: 'image/png', body: visualPng }));
  for (const mode of ['light', 'dark'] as const) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseURL}/mail/body/${account}/${item}`);
    await page.evaluate(value => localStorage.setItem('station-theme-mode', value), mode);
    await page.reload();
    await expect(page.frameLocator('iframe[title="Message content"]').locator('img')).toHaveCount(2);
    await expect.poll(() => page.frameLocator('iframe[title="Message content"]').locator('img').last()
      .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(240);
    await expect(page.getByText(/Remote images can tell the sender/)).toBeVisible();
    await expect(page.getByText('Claimed sender: sender@example.com')).toBeVisible();
    await expect(page.frameLocator('iframe[title="Message content"]').getByRole('link', { name: 'shared review page' })).toBeVisible();
    await page.screenshot({ path: `test-results/mail-body-full-${mode}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Show more' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: `test-results/mail-body-full-${mode}-mobile.png`, fullPage: true });
  }
});

test('old sender mutation cannot affect a new same-document item and Orbit', async ({ page, baseURL }) => {
  test.skip(Boolean(process.env.STATION_E2E_BASE_URL), 'Preview fixture only.');
  const nextItem = '55555555-5555-4555-8555-555555555555';
  const orbit = '22222222-2222-4222-8222-222222222222';
  let newReads = 0;
  await page.route('**/api/mail/items/*/body?**', route => {
    const next = route.request().url().includes(nextItem);
    if (next) newReads++;
    return route.fulfill({ json: { itemId: next ? nextItem : item, status: 'available', text: null,
      html: next ? `<p>New scoped item</p><span data-station-image-ref="${remote}">[Image]</span>` : `<span data-station-image-ref="${remote}">[Image]</span>`,
      htmlPolicyVersion: 1, imageRefs: [remote] } });
  });
  await page.route('**/api/mail/items/*/images/consent?**', route => route.fulfill({ json: { messageEnabled: false,
    messageChoice: null, effectiveRemoteEnabled: false, senderEnabled: false,
    senderAddress: 'sender@example.com', refs: [{ refId: remote, kind: 'remote' }] } }));
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const mutationStart = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/mail/items/*/images/sender-preference', async route => {
    started(); await held;
    await route.fulfill({ status: 503, json: { error: 'Fixture failure' } }).catch(() => undefined);
  });
  await page.goto(`${baseURL}/mail/body/${account}/${item}`);
  await page.getByRole('button', { name: 'Always load images from this sender' }).click();
  await mutationStart;
  await page.evaluate((url) => { history.pushState(null, '', url); window.dispatchEvent(new PopStateEvent('popstate')); },
    `/mail/body/${account}/${nextItem}?orbitId=${orbit}`);
  await expect(page.frameLocator('iframe[title="Message content"]').getByText('New scoped item')).toBeVisible();
  release();
  await page.waitForTimeout(200);
  expect(newReads).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Always load images from this sender' })).toBeEnabled();
});
