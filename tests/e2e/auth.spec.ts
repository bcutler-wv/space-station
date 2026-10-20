import { expect, request, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { generate } from "otplib";

const baseURL = process.env.STATION_E2E_BASE_URL;
test.skip(
  !baseURL,
  "Runtime authentication checks require the Compose HTTPS app.",
);
test.describe.configure({ mode: "serial" });
const password = "Example-only-password-123!";
async function context() {
  // The test runner otherwise inherits use.storageState, which contains the owner cookie.
  const isolated = await request.newContext({
    baseURL: baseURL!,
    ignoreHTTPSErrors: true,
    storageState: { cookies: [], origins: [] },
  });
  expect((await isolated.storageState()).cookies.length).toBe(0);
  return isolated;
}
async function csrf(context: Awaited<ReturnType<typeof request.newContext>>) {
  const response = await context.get("/api/auth/status");
  expect(response.status(), "CSRF bootstrap status").toBe(200);
  const data = (await response.json()) as { csrfToken: string };
  expect(data.csrfToken, "CSRF bootstrap token").toEqual(expect.any(String));
  expect(data.csrfToken.length, "CSRF bootstrap token length").toBeGreaterThan(0);
  return { Origin: baseURL!, "X-CSRF-Token": data.csrfToken };
}

test("private reads and writes require authentication, exact origin, and CSRF", async ({
  request: owner,
}) => {
  const stranger = await context();
  try {
    expect((await stranger.get("/api/appearance")).status()).toBe(401);
    expect((await stranger.get("/api/appearance/wallpaper")).status()).toBe(
      401,
    );
    expect(
      (
        await stranger.put("/api/appearance", {
          headers: await csrf(stranger),
          data: { mode: "light", showWallpaper: true },
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await owner.put("/api/appearance", {
          headers: { Origin: baseURL! },
          data: { mode: "light", showWallpaper: true },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await owner.put("/api/appearance", {
          headers: {
            ...(await csrf(owner)),
            Origin: "https://other.example.com",
          },
          data: { mode: "light", showWallpaper: true },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await stranger.dispose();
  }
});

test("used bootstrap token cannot create another owner", async () => {
  const visitor = await context();
  try {
    const bootstrapToken = (
      await readFile(process.env.STATION_E2E_BOOTSTRAP_PATH!, "utf8")
    ).trim();
    const response = await visitor.post("/api/auth/bootstrap/password", {
      headers: await csrf(visitor),
      data: { bootstrapToken, displayName: "Other Example", password },
    });
    expect(response.status()).toBe(403);
  } finally {
    await visitor.dispose();
  }
});

test("recovery code works once and logout revokes its session", async () => {
  const fixture = JSON.parse(
    await readFile("test-results/auth-fixture.json", "utf8"),
  ) as { recoveryCode: string };
  const first = await context();
  const second = await context();
  try {
    const accepted = await first.post("/api/auth/login/recovery", {
      headers: await csrf(first),
      data: { password, recoveryCode: fixture.recoveryCode },
    });
    expect(accepted.status()).toBe(200);
    expect((await first.get("/api/appearance")).status()).toBe(401);
    expect(
      (
        await first.put("/api/appearance", {
          headers: await csrf(first),
          data: { mode: "light", showWallpaper: true },
        })
      ).status(),
    ).toBe(401);
    const replay = await second.post("/api/auth/login/recovery", {
      headers: await csrf(second),
      data: { password, recoveryCode: fixture.recoveryCode },
    });
    expect(replay.status()).toBe(401);
    expect(
      (
        await first.post("/api/auth/logout", {
          headers: await csrf(first),
          data: {},
        })
      ).status(),
    ).toBe(200);
    expect((await first.get("/api/appearance")).status()).toBe(401);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("an authenticator code cannot be replayed", async () => {
  test.setTimeout(60_000);
  const fixture = JSON.parse(
    await readFile("test-results/auth-fixture.json", "utf8"),
  ) as { secret: string };
  const untilNextStep = 30_500 - (Date.now() % 30_000);
  await new Promise((resolve) => setTimeout(resolve, untilNextStep));
  const code = await generate({ secret: fixture.secret });
  const first = await context();
  const second = await context();
  try {
    const accepted = await first.post("/api/auth/login/password", {
      headers: await csrf(first),
      data: { password, code },
    });
    expect(accepted.status()).toBe(200);
    const replay = await second.post("/api/auth/login/password", {
      headers: await csrf(second),
      data: { password, code },
    });
    expect(replay.status()).toBe(401);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});
