# Guided Google connection

M1.2b adds Google setup instructions, copyable redirect and scope values, credential entry, a clean authenticated callback continuation, and explicit backfill selection. The page shows saved Orbit and account metadata. No mail sync runs yet.

Sol implemented the bounded task and Astra reviewed it. Review found a browser-history state issue: a restored form could retain its busy state after leaving for Google. The fix clears the secret and restores the button on a persisted pageshow event. Astra accepted the revision for CI.

Local lint, types, 27 unit tests, build, color and license gates pass. The full preview suite passed ten tests with four runtime-only skips; the focused Google preview passed again after the lifecycle fix. Root inspected fake-data light desktop and dark mobile screenshots. The separate Ubuntu HTTPS fixture must still prove the cross-site cookie-free callback, explicit confirmation, persistence, replay and cancellation against PostgreSQL before M1.2 acceptance.

The fixture runs a separate server entrypoint with the real application, database and authentication and a code-injected Google SDK transport. Production has no provider endpoint override or test authentication bypass. Browser interception supplies a fake Google consent document; no live Google account is used.

Contract clarifications: M3 adds maintained per-step console screenshots/clips to the full wizard. Quantified backfill estimates wait for a provider-backed estimate; the current UI states that wider windows need more time and storage. M1.3 adds refresh/reconnect and ingestion after the saved choice.

CI run `39359509019` passed scaffold, Compose startup, and database security fixtures, then stopped because the browser fixture matched both an input and its Copy button. Exact label matching fixes the redirect and scope selectors; preview assertions exercise both values. Sol local checks and Astra review passed. The HTTPS gate is being rerun.
