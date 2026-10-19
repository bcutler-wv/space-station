import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
import { chromium } from "@playwright/test";
import { generate } from "otplib";

const baseURL = process.env.STATION_PASSWORD_BASE_URL;
const tokenPath = process.env.STATION_PASSWORD_BOOTSTRAP_PATH;
if (!baseURL || !tokenPath)
  throw new Error("Password test origin and private token path are required.");
const password = "Example-only-password-123!";
const replacementPassword = "Example-only-new-password-123!";
const browser = await chromium.launch();
const nextStep = async () =>
  new Promise((resolve) => setTimeout(resolve, 30_500 - (Date.now() % 30_000)));
const secretOf = async (page) => {
  const uri = await page.getByLabel("Authenticator setup URI").inputValue();
  const secret = new URL(uri).searchParams.get("secret");
  assert.ok(secret);
  return secret;
};
const codesOf = async (page) =>
  page.locator(".recovery-list code").allTextContents();
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(baseURL);
  await page.getByRole("heading", { name: "Create your login" }).waitFor();
  const validToken = (await readFile(tokenPath, "utf8")).trim();
  await page.getByLabel("One-time setup token").fill("x".repeat(43));
  await page.getByLabel("Your name").fill("Example Owner");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create password login" }).click();
  await page.getByRole("alert").waitFor();
  await page.getByLabel("One-time setup token").fill(validToken);
  await page.getByRole("button", { name: "Create password login" }).click();
  await page
    .getByRole("heading", { name: "Connect your authenticator" })
    .waitFor();
  await page.getByRole("button", { name: "Start setup again" }).click();
  await page.getByRole("heading", { name: "Create your login" }).waitFor();
  await page.getByLabel("One-time setup token").fill(validToken);
  await page.getByRole("button", { name: "Create password login" }).click();
  const initialSecret = await secretOf(page);
  await page
    .getByLabel("Six-digit code")
    .fill(await generate({ secret: initialSecret }));
  await page.getByRole("button", { name: "Confirm code" }).click();
  await page
    .getByRole("heading", { name: "Save your recovery codes" })
    .waitFor();
  const initialCodes = await codesOf(page);
  assert.equal(initialCodes.length, 10);
  await page.getByRole("button", { name: "I saved my codes" }).click();
  await page
    .getByRole("heading", { name: "Mission Control" })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await nextStep();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByLabel("Authenticator code")
    .fill(await generate({ secret: initialSecret }));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Mission Control" })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Recovery code", { exact: true }).fill(initialCodes[0]);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Replace your authenticator" })
    .waitFor();
  assert.equal(
    (await page.request.get(`${baseURL}/api/appearance`)).status(),
    401,
  );
  const restrictedStatus = await (
    await page.request.get(`${baseURL}/api/auth/status`)
  ).json();
  assert.equal(
    (
      await page.request.put(`${baseURL}/api/appearance`, {
        headers: {
          Origin: baseURL,
          "X-CSRF-Token": restrictedStatus.csrfToken,
        },
        data: { mode: "light", showWallpaper: true },
      })
    ).status(),
    401,
  );
  await page.getByRole("button", { name: "Start reset" }).click();
  const replacementSecret = await secretOf(page);
  await page
    .getByLabel("Six-digit code")
    .fill(await generate({ secret: replacementSecret }));
  await page.getByRole("button", { name: "Confirm new authenticator" }).click();
  await page
    .getByRole("heading", { name: "Save your recovery codes" })
    .waitFor();
  const replacementCodes = await codesOf(page);
  await page.getByRole("button", { name: "I saved my codes" }).click();
  await page
    .getByRole("heading", { name: "Mission Control" })
    .first()
    .waitFor();
  assert.equal(
    (await page.request.get(`${baseURL}/api/appearance`)).status(),
    200,
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await nextStep();
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page
    .getByLabel("Recovery code", { exact: true })
    .fill(replacementCodes[0]);
  await page
    .getByLabel("Authenticator code")
    .fill(await generate({ secret: replacementSecret }));
  await page.getByRole("button", { name: "Reset forgotten password" }).click();
  await page.getByRole("heading", { name: "Set a new password" }).waitFor();
  await page
    .getByLabel("New password", { exact: true })
    .fill(replacementPassword);
  await page.getByLabel("Confirm new password").fill(replacementPassword);
  await page.getByRole("button", { name: "Set new password" }).click();
  await page
    .getByRole("heading", { name: "Save your recovery codes" })
    .waitFor();
  await page.getByRole("button", { name: "I saved my codes" }).click();
  await page
    .getByRole("heading", { name: "Mission Control" })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await nextStep();
  await page.getByLabel("Password", { exact: true }).fill(replacementPassword);
  await page
    .getByLabel("Authenticator code")
    .fill(await generate({ secret: replacementSecret }));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Mission Control" })
    .first()
    .waitFor();
  process.stdout.write(
    "HTTPS password enrollment, login, authenticator recovery, and forgotten-password recovery passed.\n",
  );
  await context.close();
} finally {
  await browser.close();
}
