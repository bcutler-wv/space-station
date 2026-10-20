# Google credential lifecycle backend

M1.3c adds a reusable server/worker credential service and explicit reconnect backend. Refresh uses the pinned Google SDK, persists rotated refresh tokens, and fences writes with a finite database lease and credential generation. Reconnect binds a target to the OAuth attempt, requires the original authenticated confirmation and matching mailbox, preserves account ID/Orbit/backfill, and audits the credential replacement. Existing v1 envelope format and AAD are unchanged after moving the implementation into connectors.

Astra review found SDK nested retries still active despite the top-level flag, stale permanent failures reported after successful reconnect, inconsistent unreadable-credential handling, and missing transport tests. All were fixed and re-reviewed. Real Gaxios tests now prove two outer attempts, cancellation, Retry-After handling, and rejected-client repair. Database fixtures cover stale success and permanent failures, rotation, missing scope, unreadable credentials, reconnect recovery, and expired-lease takeover.

Full local checks pass with 32 tests. Root independently reran six credential/encryption tests and Astra reran the five real-Gaxios tests. Generated migration 0004 and the expanded PostgreSQL fixture still require Ubuntu CI before runtime acceptance. The service adds no polling, send, or provider revoke; reconnect UI is a separate task.

Ingestion sanitation is accepted after CI run `39471963090` on `0bda48b`, including mixed near-cap HTML/attachment parsing under the reviewed resource limits and all browser regression gates. Gmail sync and mail reading remain pending.
