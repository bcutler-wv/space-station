import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";

const csrfByContext = new WeakMap<APIRequestContext, string>();
async function headers(request: APIRequestContext) {
  const origin = process.env.STATION_E2E_BASE_URL;
  if (!origin) return {};
  const cached = csrfByContext.get(request);
  if (cached) return { Origin: origin, "X-CSRF-Token": cached };
  const response = await request.get("/api/auth/status");
  expect(response.status(), "CSRF bootstrap status").toBe(200);
  const status = await response.json();
  expect(status.csrfToken, "CSRF bootstrap token").toEqual(expect.any(String));
  expect(status.csrfToken.length, "CSRF bootstrap token length").toBeGreaterThan(0);
  csrfByContext.set(request, status.csrfToken as string);
  return { Origin: origin, "X-CSRF-Token": status.csrfToken as string };
}

async function reset(request: APIRequestContext) {
  await request.delete("/api/appearance/wallpaper", {
    headers: await headers(request),
  });
  await request.put("/api/appearance", {
    headers: await headers(request),
    data: { mode: "system", showWallpaper: true },
  });
}

test.describe.configure({ mode: "serial" });

for (const mode of ["light", "dark"] as const) {
  test(`Mission Control renders in ${mode} mode`, async ({ page, request }) => {
    await reset(request);
    await request.put("/api/appearance", {
      headers: await headers(request),
      data: { mode, showWallpaper: true },
    });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await expect(page.getByText("All Orbits · Sample data")).toBeVisible();
    for (const heading of [
      "Mission Control",
      "Today across all Orbits",
      "Needs you",
      "Up next",
      "Review tray",
      "Promises",
      "Recently auto-cleared",
      "This week",
    ]) {
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
    }
    await expect(
      page.getByText("Client network review (Consulting) overlaps"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Glassworks" }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/mission-${mode}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Glassworks" }).click();
    await expect(
      page.getByRole("heading", { name: "Glassworks", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Inbox and chat" }),
    ).toBeVisible();
  });
}

test("system mode follows device changes and settings persist", async ({
  page,
  request,
}) => {
  await reset(request);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Mission Control" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  try {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  } catch (error) {
    const browser = await page.evaluate(() => ({
      mediaDark: matchMedia("(prefers-color-scheme: dark)").matches,
      cachedMode: localStorage.getItem("station-theme-mode"),
      theme: document.documentElement.dataset.theme,
    }));
    const server = await (await request.get("/api/appearance")).json();
    throw new Error(
      `System theme diagnostic: ${JSON.stringify({ browser, server })}`,
      { cause: error },
    );
  }
  await page.getByRole("button", { name: "Settings" }).click();
  await page.screenshot({ path: "test-results/settings.png" });
  await page
    .getByRole("group", { name: "Theme" })
    .getByRole("button", { name: "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(
    page
      .getByRole("group", { name: "Theme" })
      .getByRole("button", { name: "Dark" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("wallpaper is processed, can be hidden, persists, and resets", async ({
  page,
  request,
}) => {
  await reset(request);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#wall-file").setInputFiles({
    name: "wallpaper.png",
    mimeType: "image/png",
    buffer: await readFile("tests/fixtures/wallpaper.png"),
  });
  await expect(page.locator(".app-frame")).toHaveClass(/has-wallpaper/);
  const image = await request.get("/api/appearance/wallpaper");
  expect(image.ok()).toBe(true);
  expect(image.headers()["content-type"]).toContain("image/webp");
  await page
    .getByRole("switch", { name: "Show wallpaper between panels" })
    .click();
  await expect(page.locator(".app-frame")).not.toHaveClass(/has-wallpaper/);
  await page.reload();
  await expect(page.locator(".app-frame")).not.toHaveClass(/has-wallpaper/);
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("switch", { name: "Show wallpaper between panels" })
    .click();
  await expect(page.locator(".app-frame")).toHaveClass(/has-wallpaper/);
  await page.getByRole("button", { name: "Use default" }).click();
  await expect(page.locator(".app-frame")).not.toHaveClass(/has-wallpaper/);
  expect((await request.get("/api/appearance/wallpaper")).status()).toBe(404);
});

test("mobile frame, reduced motion, and CAPCOM focus work", async ({
  page,
  request,
}) => {
  await reset(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const bar = await page
    .getByRole("navigation", { name: "Main" })
    .boundingBox();
  expect(bar).not.toBeNull();
  expect(bar!.y).toBeGreaterThan(760);
  await page.screenshot({
    path: "test-results/mission-mobile.png",
    fullPage: true,
  });
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "CAPCOM" })).toBeVisible();
  await expect(page.getByText("Demo preview")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close CAPCOM" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Search or ask CAPCOM" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Personal" }).click();
  await expect(
    page.getByRole("heading", { name: "Personal", level: 1 }),
  ).toBeVisible();
});

test("cached mode survives hydration until delayed server settings arrive", async ({
  page,
  request,
}) => {
  await reset(request);
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() =>
    localStorage.setItem("station-theme-mode", "dark"),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/appearance", async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "light",
        showWallpaper: true,
        seed: 4284762788,
        hasWallpaper: false,
      }),
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Mission Control" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  release();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(() => localStorage.getItem("station-theme-mode")),
  ).toBe("light");
});

test("appearance save succeeds when browser storage is denied", async ({
  page,
  request,
}) => {
  await reset(request);
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("storage denied");
    };
    Storage.prototype.setItem = () => {
      throw new Error("storage denied");
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("group", { name: "Theme" })
    .getByRole("button", { name: "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(
      async () => (await (await request.get("/api/appearance")).json()).mode,
    )
    .toBe("dark");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("CAPCOM shortcut stays inside Settings until the dialog closes", async ({
  page,
  request,
}) => {
  await reset(request);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "CAPCOM" })).toHaveCount(0);
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      document
        .querySelector("dialog.settings-dialog")
        ?.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "CAPCOM" })).toBeVisible();
});
