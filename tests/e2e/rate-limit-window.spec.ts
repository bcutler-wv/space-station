import { test } from '@playwright/test';

test.skip(!process.env.STATION_E2E_BASE_URL, 'Only the shared runtime app needs a rate-limit window.');

// Runtime browser phases share one IP and the production 120-request window.
// Let the auth phase's fixture requests expire before the browser phase starts.
test('allows the global request window to clear', async () => {
  test.setTimeout(70_000);
  await new Promise((resolve) => setTimeout(resolve, 61_000));
});
