# Sync progress and event backend

Date: 2026-10-20

Version 0.18.0 adds private owner-only sync progress and an SSE event stream using official @fastify/sse 0.6.1. Events contain fixed names, event IDs and account UUIDs; clients refetch private state. A PostgreSQL counter lock orders journal IDs through transaction commit. Mail-page replay and rollback emit no duplicate or uncommitted events. The journal retains 512 events and replays at most 128 before requesting a reset.

Astra review corrected a concurrent-pruning replay race and delayed revocation during slow replay. Reads now use a consistent snapshot. An independent authorization watcher preserves idle expiry and checks revocation during replay, with a 1.5-second client deadline. Root requested bounded database cleanup as well: SSE reads use transaction-local one-second lock and 1.25-second statement timeouts. Fixtures verified blocked backends return to idle while conflicting locks remain held. These limits do not change normal authentication queries or global pool settings.

Local lint, typecheck, 59 tests, build, color and license gates passed. PostgreSQL 15 diagnostics covered actual HTTP streams, passive session expiry, recovery restrictions, generation reset, cross-process revocation, slow clients, connection limits, concurrent journal pruning, commit order, retention, and actual mail-page/runner publication. The local database was stopped. Astra accepted the corrected source, and PostgreSQL 16 Compose and browser gates passed in GitHub Actions run `39504035570` (commit `1358c84`). No production deployment occurred.

The security contract now explicitly distinguishes passive sync requests from ordinary session activity. Total network partitions remain subject to driver/operating-system transport behavior; database lock waits are bounded server-side. Browser EventSource wiring and themed progress presentation are the next separate reviewed task.
