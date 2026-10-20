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
