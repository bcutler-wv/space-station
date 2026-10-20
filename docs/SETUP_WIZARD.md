# Setup wizard

The first run is a guided, graphical flow. A non-developer should be able to finish it with only a browser and their provider admin consoles.

## Steps

1. **Create your login.** Passkey, or password plus TOTP. Optional OIDC (Authentik, Keycloak, and similar) can be added later in Settings.
2. **Check the address.** Detect the base URL the browser is using and confirm HTTPS works. OAuth redirects require HTTPS on a real domain (or localhost), so block the account steps until this passes and explain how to fix it.
3. **Create your first Orbit.** Name, color, and a sentence or two of context ("What is this part of your work?").
4. **Set privacy rules.** Choose global and first-Orbit exclusions for indexing and AI by account, sender, label, or matched rule. Explain the most-restrictive policy when an item belongs to several Orbits. This happens before any content sync or processing.
5. **Dock an account.** Pick a provider, then follow its guided steps (below). Authentication can be tested without starting content sync.
6. **Choose the backfill window.** 30 days, 1 year, or everything, with an estimate of time and storage. Only now start sync and show live progress.
7. **Set up AI (optional, skippable).** Provider, API key with a test call, fast and strong models, monthly spend cap. The test call contains no synced content. Review privacy rules before enabling processing.
8. **Done.** Land on Mission Control with an "Add another account" prompt.

## Provider steps

Every provider step has numbered instructions, a screenshot or short clip per step, copy buttons for every value the user must paste into the provider's console (redirect URIs, scopes, app manifests), a link to the provider's current docs, and validation that runs before moving on.

### Google
1. Create a Google Cloud project.
2. Enable the Gmail API. Calendar and Pub/Sub setup belong to later connector steps.
3. Configure the consent screen audience for the intended account. Explain that External Testing refresh grants generally expire after seven days, that Internal and personal-use verification exceptions may apply, and that publishing or verification requirements depend on Google's current policy. Link the official guidance.
4. Create an OAuth client (web application) with the redirect URI shown.
5. Paste the client ID and secret, then sign in with Google.

### Microsoft
1. Create an Entra app registration with the right supported account types.
2. Add the redirect URI shown and create a client secret. Record its expiry.
3. Add the delegated permissions listed (Teams permissions only if the user wants Teams).
4. Grant admin consent if required. Detect the consent error and explain it.
5. Paste the IDs and secret, then sign in with Microsoft.

### IMAP and SMTP
1. Enter the email address. Auto-discovery fills servers and ports.
2. Enter the password or app password.
3. Test Connection: shows IMAP login, IDLE, CONDSTORE and QRESYNC, and SMTP results.

### Slack
1. Choose indexed or live mode. Default to live and explain the difference and the Slack terms note.
2. Station generates an app manifest. The user creates an internal app from it in their workspace.
3. Paste the app-level token (for Socket Mode) and install the app to get the user token.
4. Permission check.

## Rules

- Never ask for a password to a Google or Microsoft account. Those always go through OAuth.
- Validate every pasted value (format, length) before calling a provider.
- Every error message says what happened and how to fix it.
- M1 ships a minimal version of steps 1 through 6 for one Google account. M3 expands provider guidance and Orbit management; it does not defer the safety-critical privacy choice until after first sync.
- M1.1 completes only steps 2 through 4 after M0 owner login. It confirms the configured `APP_ORIGIN`, creates one Orbit, and atomically stores global and Orbit indexing/AI defaults and exact account-email, sender-email, or provider-label-name exclusions. If `APP_ORIGIN` changes later, the owner must confirm the new exact HTTPS origin before account connection proceeds. The sample shell remains available separately. Google connection, backfill and actual content sync follow in later M1 tasks and require the versioned setup completion marker and matching confirmed origin.
