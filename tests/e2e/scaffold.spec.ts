import { expect, test } from '@playwright/test';
import { PRODUCT_NAME } from '../../packages/shared/src/constants.js';

for (const theme of ['light', 'dark'] as const) {
  test(`scaffold renders in ${theme} mode`, async ({ page }) => {
    await page.goto(`/?theme=${theme}`);
    await expect(page.getByRole('heading', { name: PRODUCT_NAME })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const background = await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(background).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(32, 33, 36)');
  });
}
