import { defineConfig } from "@playwright/test";

const external = process.env.STATION_E2E_BASE_URL;
export default defineConfig({
  testDir: "./tests/e2e",
  ...(external ? { globalSetup: './tests/support/auth-setup.mjs', globalTeardown: './tests/support/auth-teardown.mjs' } : {}),
  use: { baseURL: external ?? "http://127.0.0.1:4173", ...(external ? { storageState: 'test-results/auth-state.json', ignoreHTTPSErrors: true } : {}) },
  ...(external ? { projects: [
    { name: 'auth', testMatch: /auth\.spec\.ts/ },
    { name: 'rate-limit-window', testMatch: /rate-limit-window\.spec\.ts/, dependencies: ['auth'] },
    { name: 'browser', testIgnore: [/auth\.spec\.ts/, /rate-limit-window\.spec\.ts/], dependencies: ['rate-limit-window'] },
  ] } : {}),
  ...(external
    ? {}
    : {
        webServer: {
          command: "node tests/support/preview-server.mjs",
          url: "http://127.0.0.1:4173",
          reuseExistingServer: !process.env.CI,
        },
      }),
});
