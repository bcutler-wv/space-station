import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: 'tests/e2e/mail-body-dev.spec.ts',
  use: { baseURL: 'http://127.0.0.1:5175' },
  webServer: {
    command: 'corepack pnpm --filter @station/web exec vite --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: !process.env.CI,
  },
});
