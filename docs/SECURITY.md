# Security

Station holds a person's entire working life: every email, chat, and calendar event across every organization. Treat it accordingly.

## Threat model

| Threat | Main controls |
|---|---|
| Malicious email content (XSS, tracking, exploits in parsing) | Sanitized rendering, sandboxed iframe, image proxy, isolated MIME parsing |
| Prompt injection through any message | No AI action tools, direction rules, schema-only output (see AI.md) |
| Someone reaching the web app | Not exposed publicly by default, strong auth, rate limits |
| Theft of the database or backups | Provider credentials encrypted at rest; restricted file permissions and encrypted backups for message contents and metadata |
| Supply chain (npm) | Short, pinned dependency list, lockfile, audit and license checks in CI |
| Data sent to AI providers | Exclusion rules, per-Orbit AI policy, local model option, no AI required |

## Rendering email

- Sanitize HTML with DOMPurify, with a mail-specific config. SnappyMail's sanitizer rules (AGPL-3.0, compatible) are a good reference for email-specific edge cases.
- Render inside a sandboxed iframe (no scripts, no same-origin, no forms) with a strict content security policy.
- All remote images go through go-camo. Remote images are blocked by default with a "Load images" button, per message and per sender.
- Proxying hides the client IP, but fetching a unique tracking URL can still reveal that a message was opened. Do not describe the proxy as preventing tracking.
- Links show their real destination on hover and open with `rel="noopener noreferrer"`.
- Re-sanitize at render time even though content was sanitized at ingest.

## Parsing

- MIME parsing runs in a separate process/container with cgroup memory and CPU limits, input-size caps, and a wall-clock timeout. Node worker-thread limits alone do not cap external buffers. A malformed message fails alone.
- M1.3a accepts at most 12 MiB raw MIME, 8 MiB total decoded attachments, 4 MiB combined text/HTML, 16 MiB JSON output, 64 KiB aggregate headers, 128 parts, 16 MIME levels, three nested RFC822 levels, 100 recipients, and 64 attachments. Each parse has a three-second deadline and two concurrent requests per parser service. The raw cap supports roughly 8 MiB of base64 attachments; larger messages are unsupported. Limit failures are classified and must become visible unsupported records during later sync; cursors must not silently skip them. Parsed HTML is explicitly untrusted and cannot be persisted or rendered as trusted content before the reviewed DOMPurify ingest and display work. The reader re-sanitizes at display time.
- Attachment text extraction runs in the Tika container, never in the app process.
- Attachments are served with `Content-Disposition: attachment` and a safe content type unless they are images shown inline through the proxy.

## Authentication

- Passkeys, or password plus TOTP. Optional OIDC. Passwords use a one-way Argon2id hash with per-password salt and versioned parameters, never reversible encryption. TOTP seeds are encrypted; recovery codes are hashed and one-time use.
- First-run owner creation is a one-time transaction guarded by a bootstrap token delivered through a local setup command, never a log. Disable the bootstrap endpoint after ownership exists. Require a second factor for credential reset; provide one-time recovery codes at enrollment. No email-only recovery path.
- Sessions in HTTP-only, Secure, SameSite=Strict cookies.
- Store only hashed session tokens server-side; rotate after login or privilege changes and revoke on logout. Expire idle and absolute sessions. CSRF protection on every state-changing request, including same-site deployments.
- Rate limits on login and on the API.

M0.4 requires an exact configured HTTPS `APP_ORIGIN` for state-changing requests, in addition to per-session CSRF tokens. Local development uses a private localhost TLS certificate; reverse proxy deployments name one trusted proxy source IP. Password-plus-recovery-code access is restricted to a new confirmed TOTP seed; it cannot read or change private settings before confirmation. A forgotten password can be replaced with both a current TOTP code and an unused recovery code. If both are lost, there is no account recovery path. Recovery of a passkey-only account consumes a code and requires user verification on a new passkey. Replacing any credential increments the owner auth generation, invalidates pending old logins and recovery attempts, revokes prior sessions, and rotates recovery codes.

## Secrets

- OAuth tokens, client secrets, IMAP passwords, and AI keys are encrypted with a master key (AES-256-GCM, envelope encryption) from `STATION_MASTER_KEY` in the environment. Password hashes are separate and never decryptable.
- Losing the master key means re-connecting every account. The docs and the wizard say this plainly.
- Secrets are never logged. Logs redact tokens, addresses in query strings, and message bodies.
- Mail bodies, attachments, metadata, and indexes are sensitive even though application-level encryption covers credentials only. Limit volume permissions and encrypt backups/storage where the host supports it; test restore without printing private content.

## Privacy precedence and retention

- Before sync starts, the wizard asks for global and first-Orbit indexing/AI exclusions. For each item, combine the account Orbit, routed Orbits, and global rules; the most restrictive applicable effect wins. `no_index` excludes lexical and vector indexes. `no_ai` excludes all model requests, embedding providers, AI-derived summaries, briefings, extraction, proposals, and citations. A local embedding service still follows the configured no-AI rule.
- M1.1 stores explicit global and first-Orbit defaults plus bounded exact account-email, sender-email, and provider-label-name exclusions. Empty Orbit membership or a missing Orbit policy denies indexing and AI. The versioned setup marker must gate later account connection and sync. There is no synced or derived content to purge in M1.1; later processing must enforce the policy and invalidation rules below.
- Enforce policy when scheduling work and again when serving search/CAPCOM or constructing provider requests. Attachments and OCR inherit the parent item's policy. Summaries and answers inherit the most restrictive policy of their sources.
- When policy tightens or routing changes, block access immediately and queue deletion/invalidation for search documents, chunks and embeddings, extraction output, attachment extracted text if prohibited, summaries, briefings, citations, and cached answers. Rebuild only under the new policy. Record the purge job and surface failures until repaired.

## OAuth and network requests

- Build redirect URIs from the configured public origin, allowlist exact origins and provider authorization/token endpoints, and bind each OAuth callback to a short-lived server-side state record and the initiating authenticated session. Use PKCE where supported; reject replay and mismatched state before token exchange.
- A cross-site OAuth return may omit the Strict session cookie. Validate state and retain the callback result briefly on the server, then redirect to a clean same-origin continuation page. Its authenticated confirmation request must verify the original session before exchanging the code or linking credentials. Expire pending results, consume state once, and never log callback codes or put them in the continuation URL.
- Server-side URL fetches (autoconfig, attachments, proxying, AI-compatible endpoints) need scheme/port allowlists, DNS and redirect validation, private/link-local/metadata IP blocking where the target is untrusted, response size/time limits, and no forwarding of internal credentials. Document any explicitly trusted LAN model endpoint exception.

## Outbound actions

- Sending, archiving, deleting, and posting only happen from an explicit user action in the UI.
- Every outbound action is written to `audit_log`.

## Network

- Station runs fine with no public exposure (LAN or tailnet).
- Only the app container is published. The default binding is loopback. The other containers have no published ports; the Compose bridge permits outbound requests needed by later connectors.

## Dependencies

- Prefer fewer, well-maintained packages.
- Lockfile committed. CI runs `pnpm audit` and a license check that fails on GPL-2.0-only or unknown licenses.
- Copied third-party code keeps its header and is listed in THIRD_PARTY.md.

## Reporting

A `SECURITY.md` at the repo root (to add before the first public release) should give a private reporting address.
