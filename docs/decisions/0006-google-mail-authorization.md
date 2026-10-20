# Google mail authorization (2026-10-19)

## Context

M1 connects one Google mailbox after owner login and first Orbit privacy setup. SameSite=Strict omits the owner cookie on a cross-site Google return, so the callback cannot safely exchange the code immediately.

## Options

Use a shared OAuth app, or require the owner to enter a Google web client. Exchange at callback, or retain the callback and require an authenticated same-origin continuation.

## Decision

Use the owner's web client and official `google-auth-library`/`@googleapis/gmail` SDKs. Request only `gmail.modify` and offline refresh. Bind a random hashed state to the initiating hashed session and auth generation, with SDK PKCE S256 and a ten-minute lifetime. The public callback stores only an encrypted code and redirects to a clean same-origin path. A current owner session and CSRF-protected confirmation claims the attempt once, exchanges it, reads the Gmail profile, and links under database locks. The account's backfill window is recorded separately; no sync job starts in M1.2.

Secrets use a versioned AES-256-GCM envelope: a new random data key per field is wrapped by the station master key, and both layers authenticate table, row ID, field, and version. Losing or rotating the master key without rewrapping makes stored grants unreadable; reconnect those accounts. Google refresh tokens can be revoked or expire. External Testing grants generally expire after seven days, while personal and Internal use may have verification exceptions; app ownership alone is no blanket exemption.

## Consequences

The callback works with Strict cookies, while replay, recovery resets, stale origin and late provider responses fail before linking. M1.2b must provide setup guidance and the continuation/backfill UI. M1.3 must implement refresh failure handling and mail sync only after the saved backfill choice.

Official references reviewed 2026-10-19: https://developers.google.com/identity/protocols/oauth2/web-server , https://developers.google.com/identity/protocols/oauth2 , https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification , https://developers.google.com/workspace/gmail/api/auth/scopes , https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile .
