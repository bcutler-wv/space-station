import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import process from "node:process";

const baseURL = process.env.STATION_PASSKEY_BASE_URL;
const tokenPath = process.env.STATION_PASSKEY_BOOTSTRAP_PATH;
if (!baseURL || !tokenPath)
  throw new Error("Passkey test origin and private token path are required.");
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await page.goto(baseURL);
  await page.getByRole("heading", { name: "Create your login" }).waitFor();
  await page
    .getByLabel("One-time setup token")
    .fill((await readFile(tokenPath, "utf8")).trim());
  await page.getByLabel("Your name").fill("Example Owner");
  await page.getByRole("button", { name: "Create passkey login" }).click();
  await page
    .getByRole("heading", { name: "Save your recovery codes" })
    .waitFor({ timeout: 20_000 });
  const recoveryCode = await page
    .locator(".recovery-list code")
    .first()
    .textContent();
  if (!recoveryCode)
    throw new Error("Passkey enrollment did not return recovery codes.");
  await page.getByRole("button", { name: "I saved my codes" }).click();
  await page
    .getByRole("heading", { name: "Mission Control" })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await cdp.send("WebAuthn.setUserVerified", {
    authenticatorId,
    isUserVerified: false,
  });
  await page.getByRole("button", { name: "Use passkey" }).click();
  await page.getByRole("alert").waitFor();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await cdp.send("WebAuthn.setUserVerified", {
    authenticatorId,
    isUserVerified: true,
  });
  await page.getByRole("button", { name: "Use passkey" }).click();
  await page
    .getByRole("heading", { name: "Mission Control" })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page
    .getByLabel("Lost your passkey? Enter a recovery code")
    .fill(recoveryCode);
  await page.getByRole("button", { name: "Replace passkey" }).click();
  await page
    .getByRole("heading", { name: "Save your recovery codes" })
    .waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "I saved my codes" }).click();
  await page
    .getByRole("heading", { name: "Mission Control" })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page
    .getByLabel("Lost your passkey? Enter a recovery code")
    .fill(recoveryCode);
  await page.getByRole("button", { name: "Replace passkey" }).click();
  await page.getByRole("alert").waitFor();
  process.stdout.write(
    "Virtual passkey enrollment, login, and recovery passed.\n",
  );
  await context.close();
} finally {
  await browser.close();
}
