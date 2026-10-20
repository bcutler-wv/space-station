# Connectors

Every user registers their own OAuth apps. Station never ships a shared client ID. Each install is independent; Google policy and verification requirements still depend on the app's audience and use.

Provider policies change. Every connector's wizard step links to the provider's current documentation, and these notes should be checked against it during the build.

At each connector milestone, verify required permissions, rate limits, distribution terms, redirect requirements, and API behavior against current official provider documentation. Record the documentation URL and review date in a decision note. Treat the specific scopes and policy notes below as implementation hypotheses until checked. Prefer official SDKs and maintained upstream libraries; record repository, version, and license in `THIRD_PARTY.md`.

No connector needs a public inbound endpoint. Everything below works with Station reachable only on a LAN or a tailnet.

## Gmail and Google Workspace

- **Library:** official `google-auth-library` and `@googleapis/gmail` packages for the mail-only M1 connection.
- **Auth:** OAuth 2.0 web flow with the user's own Google Cloud project.
  - Workspace apps with an Internal audience may qualify for a verification exception. Refresh grants can still be revoked or expire.
  - External apps in Testing mode issue refresh tokens that expire after seven days unless only basic identity scopes are requested. Publishing and verification obligations depend on audience, scope, and use; the owner must review Google's current guidance.
- **M1 scope:** `https://www.googleapis.com/auth/gmail.modify` only. Gmail `users.getProfile` supplies the account email; Calendar authorization follows in M5. The grant must include mail access and offline refresh.
- **M1.2a storage:** OAuth app, account, and short-lived attempt rows are durable. A callback retains its code encrypted for at most ten minutes, then an authenticated same-origin confirmation exchanges it. Three outstanding attempts per owner session are allowed. Expired attempt secrets and unlinked app secrets are removed. A recovery reset invalidates pending attempts; existing account credentials remain encrypted under the station master key and should be reconnected if the owner rotates or loses that key.
- **Mail sync:** initial sync pages through `messages.list` within the chosen backfill window. Incremental sync uses the History API (`history.list` from the stored `historyId`). If the history ID is too old, fall back to a full resync.
- **Push:** Gmail `watch` publishes to a Google Pub/Sub topic. Station uses a **pull** subscription, so nothing needs to reach in. Renew the watch daily. If Pub/Sub isn't configured, poll history every 60 seconds.
- **Labels and threads** map directly. Gmail labels are Station labels.
- **Send:** `messages.send` with the thread ID for replies.
- **Reliability:** persist Gmail history cursor per mailbox, deduplicate by provider message ID and revision, and recover an expired history cursor by bounded rescan. Reconcile send results against Sent before retrying an unknown outcome.
- **Calendar:** Google Calendar API with sync tokens for incremental sync.

## Microsoft 365, Outlook.com, and Teams

- **Libraries:** @azure/msal-node, @microsoft/microsoft-graph-client.
- **Auth:** the user's own Entra app registration.
  - Supported account types: single tenant for their own organization, or personal Microsoft accounts for Outlook.com.
  - Redirect URI shown by the wizard with a copy button.
  - Client secrets expire. Store the expiry date and warn 30 days ahead.
  - Some tenants require admin consent. The wizard detects the error and explains it.
- **Delegated scopes:** `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `User.Read`, `offline_access`. For Teams: `Chat.Read`, `ChannelMessage.Read.All` (needs admin consent), `Team.ReadBasic.All`, `Channel.ReadBasic.All`.
- **Mail and calendar sync:** delta queries. Poll the delta endpoints every 30 to 60 seconds. Graph change notifications need a public HTTPS endpoint, so they are optional and off by default.
- **Folders and categories** map to Station labels.
- **Teams:** poll the standard per-chat and per-channel message endpoints. Microsoft classes some bulk Teams message APIs as protected or metered and requires approval for them; do not use those. As a guest in another tenant, visibility is limited. The wizard should run a permission check and say plainly what it can and can't read.
- **Send:** `sendMail`, or `createReply` plus `send` for replies.
- **Reliability:** persist delta links per folder/calendar, handle removed entries, and reconcile sent mail after ambiguous timeouts. A successful HTTP response is not the only possible delivery outcome.

## IMAP and SMTP

- **Libraries:** imapflow (IMAP), postal-mime or mailparser (MIME), Nodemailer (SMTP).
- **Auth:** username and password or app password. XOAUTH2 where a provider supports it.
- **Auto-discovery:** from the email address, check Mozilla's autoconfig database, DNS SRV records, and the domain's own autoconfig file to prefill servers and ports.
- **Test Connection:** verifies IMAP login, IDLE, CONDSTORE and QRESYNC support, and SMTP auth, and shows which ones are available.
- **Sync:** IMAP IDLE on INBOX for push. CONDSTORE and QRESYNC for cheap incremental sync when available, otherwise UID comparison. Handle UIDVALIDITY changes by resyncing that folder.
- **Threading:** build threads from Message-ID, In-Reply-To, and References using the JWZ algorithm.
- **Folders** map to labels.
- **Send:** SMTP, then IMAP APPEND to the Sent folder (IMAP servers do not do this automatically).
- **Reliability:** persist UIDVALIDITY and UID per folder. SMTP timeout after DATA may have delivered the message; mark outcome unknown and reconcile by Message-ID before manual retry. Sent APPEND is a separate idempotent/reconcilable operation.

## CalDAV

- **Library:** tsdav.
- **Sync:** sync-collection (RFC 6578) where supported, otherwise ctag and etag comparison. Poll every few minutes.
- Preserve each calendar's IANA time zone, recurrence masters, overrides, and cancellation tombstones. Track whether a change was initiated by the user; receiving an invitation cannot prove a user scheduled a meeting.

## Slack

- **Library:** @slack/bolt in Socket Mode, plus @slack/web-api.
- **Auth:** the user creates their own **internal** Slack app in each workspace from a manifest that Station generates. Socket Mode delivers events over an outbound WebSocket.
- **Rate limits:** since 2025, Slack limits `conversations.history` and `conversations.replies` heavily for commercially distributed apps outside the Marketplace. Internal customer-built apps keep the normal limits. Station's per-user internal app is the supported path.
- **Terms:** Slack's 2025 API terms restrict third-party apps from keeping bulk copies, archives, or indexes of Slack data, or using it with LLMs. A later clarification says the distribution terms apply to apps distributed beyond your organization, not custom internal ones. The README must tell users to read Slack's current terms for their situation. Station supports two modes per workspace:
  - **Indexed mode:** for workspaces the user owns or administers. Full sync, indexing, and extraction, like email.
  - **Live mode (default):** nothing is stored long-term. CAPCOM queries Slack at question time (search and history calls), and results are held only for the life of that request. Live mode items do not appear in Mission Control lists.
- **User token scopes (indexed mode):** `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`, `users:read.email`, `search:read`, `chat:write` (for replies the user sends).
- **Send:** `chat.postMessage` as the user, only from a user action.

## Adding a connector

Implement the `Connector` interface in `packages/connectors/<name>`, add a wizard step, add fixture-based tests that replay recorded API responses, and document it here.
