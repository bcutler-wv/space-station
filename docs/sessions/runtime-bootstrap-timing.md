# Runtime browser setup token timing

Ubuntu run `39816360674` passed the new search generation PostgreSQL 16 fixtures and four other jobs, then failed owner enrollment in the final runtime browser suite. The smoke setup token was created at 16:51:46 UTC and enrollment ran at 17:08:33, beyond its 15-minute lifetime. This timing explains the observed 403 without exposing token values.

The runtime job now creates a fresh setup token immediately before the final browser suite using the existing CLI and private bind directory. Its distinct create-only file preserves the earlier smoke token-file permission check. Token expiry, one-use enforcement, owner checks and rate limits are unchanged. The existing database fixture still rejects expired tokens.

Astra reviewed the exact two-line workflow change separately from the unintegrated search transition registry. The full local check passed 110 tests; Docker and final Ubuntu acceptance remain pending. No product rule changed.
