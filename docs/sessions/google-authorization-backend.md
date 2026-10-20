# Google authorization backend

M1.2a adds the backend for Google mail connection after first-Orbit setup. It uses pinned official Google SDKs, mail-only consent, PKCE, hashed state and session binding, encrypted callback continuation, and an explicit authenticated confirmation. Account linking rechecks the current owner generation, live session, attempt expiry and configured origin under database locks. A separate backfill choice does not start sync yet.

Provider credentials use authenticated envelope encryption with a random data key per field. Temporary attempts expire, orphan app secrets are removed, and successful connection writes an audit record in the account transaction. API responses expose connection metadata only.

Sol implemented the bounded backend and Astra reviewed it twice, then verified the final fixture corrections. Review required additional session-isolation, credential-reset, provider-error and disposal tests, corrected CSRF expectations, and accurate implemented data-model documentation. The integration fixture uses the existing exact trusted-proxy path to preserve Secure session cookies; it adds no production authentication bypass.

Local checks pass lint, types, 27 unit tests, build, colors and licenses. The final fixture passes syntax and lint checks. PostgreSQL migration and session/race integration are CI gates on Ubuntu, not local Docker results. Runtime acceptance requires that run to pass.

Contract changes clarify Google verification exceptions, Testing refresh expiry, and mail-only scopes. The implemented account and attempt fields are documented in DATA_MODEL. The guided browser flow is M1.2b; refresh, reconnect and ingestion remain M1.3. M1.2 is incomplete until its UI and browser gates pass.
