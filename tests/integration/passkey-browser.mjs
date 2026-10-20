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
  const authStatus = await (await page.request.get(`${baseURL}/api/auth/status`)).json();
  const fixtureSetup = { version: 1, confirmedOrigin: baseURL, orbit: { name: 'Example work', colorSlot: 2, context: 'Example work context.' }, globalDefaults: { index: 'allow', ai: 'exclude' }, orbitDefaults: { index: 'exclude', ai: 'allow' }, exclusions: [] };
  if ((await page.request.post(`${baseURL}/api/setup`, { headers: { Origin: 'https://other.example.com', 'X-CSRF-Token': authStatus.csrfToken }, data: fixtureSetup })).status() !== 403) throw new Error('Wrong-origin setup was allowed.');
  if ((await page.request.post(`${baseURL}/api/setup`, { headers: { Origin: baseURL }, data: fixtureSetup })).status() !== 403) throw new Error('Setup without CSRF was allowed.');
  if ((await page.request.put(`${baseURL}/api/setup/origin`, { headers: { Origin: 'https://other.example.com', 'X-CSRF-Token': authStatus.csrfToken }, data: { confirmedOrigin: baseURL } })).status() !== 403) throw new Error('Wrong-origin reconfirmation was allowed.');
  await page.goto(`${baseURL}/setup`);
  await page.getByRole('heading', { name: 'Set up your first Orbit' }).waitFor();
  await page.getByLabel('I confirm this is the address I will use').check();
  await page.getByLabel('Orbit name').fill('Example work');
  await page.getByLabel('What is this part of your work?').fill('Example work context.');
  await page.getByLabel('Color 2').check();
  await page.getByRole('group', { name: 'Global' }).getByLabel('Search indexing').selectOption('allow');
  await page.getByRole('group', { name: 'Global' }).getByLabel('AI processing').selectOption('exclude');
  await page.getByRole('group', { name: 'First Orbit' }).getByLabel('Search indexing').selectOption('exclude');
  await page.getByRole('group', { name: 'First Orbit' }).getByLabel('AI processing').selectOption('allow');
  await page.getByRole('button', { name: 'Add exclusion' }).click();
  await page.getByLabel('Value').fill('private@example.com');
  await page.getByRole('button', { name: 'Save Orbit and privacy choices' }).click();
  await page.getByText('Your Orbit and privacy choices are saved.').waitFor();
  await page.reload();
  await page.getByText('Your Orbit and privacy choices are saved.').waitFor();
  const savedSetup = await (await page.request.get(`${baseURL}/api/setup`)).json();
  if (savedSetup.orbit.name !== 'Example work' || savedSetup.globalDefaults.ai !== 'exclude' || savedSetup.orbitDefaults.index !== 'exclude' || savedSetup.exclusions.length !== 1) throw new Error('Setup choices were not persisted.');
  await page.getByRole('link', { name: 'View sample Mission Control' }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  if ((await page.request.get(`${baseURL}/api/setup`)).status() !== 401) throw new Error('Anonymous setup access was allowed.');
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
