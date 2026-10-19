import { defineConfig } from "@playwright/test";

const external = process.env.STATION_E2E_BASE_URL;
export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: external ?? "http://127.0.0.1:4173" },
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
