import { expect, test } from '@playwright/test';

test('sample Orbit URLs survive navigation and reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Glassworks' }).click();
  await expect(page).toHaveURL(/\/demo\/orbits\/glassworks$/);
  await expect(page.getByRole('heading', { name: 'Glassworks' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Glassworks' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Mission Control' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('an idle authenticated page keeps background requests bounded', async ({ page }) => {
  test.skip(!process.env.STATION_E2E_BASE_URL, 'Requires the real HTTPS runtime app.');
  const counts = { status: 0, events: 0, progress: 0 };
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/status') counts.status++;
    if (path === '/api/sync/events') counts.events++;
    if (path === '/api/sync/progress') counts.progress++;
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Mission Control' })).toBeVisible();
  await page.waitForTimeout(1_000);
  const initialProgressReads = counts.progress;
  await page.waitForTimeout(3_000);
  expect(counts.status).toBeLessThanOrEqual(1);
  expect(counts.events).toBeLessThanOrEqual(1);
  expect(counts.progress).toBeLessThanOrEqual(2);
  expect(counts.progress - initialProgressReads).toBeLessThanOrEqual(1);
});
