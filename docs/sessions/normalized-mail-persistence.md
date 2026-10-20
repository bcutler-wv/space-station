# Normalized mail persistence

M1 adds account-scoped threads, items, labels, identities, recipients, attachments, sync pages and blob intents. The worker-facing page operation commits normalized records, deletion tombstones and its cursor together after checking setup, scope, backfill, credential generation, lease and sequence. Provider revisions remain opaque strings. No provider polling or mail reader is enabled yet.

Blob intents precede file publication and remain coordinated with page commit and cleanup. Interrupted writes can be reclaimed without scanning the mailbox directory or removing active or referenced files. Privacy evaluation includes all sender identities, label names and Orbit memberships; unresolved metadata denies indexing and AI.

Astra review required fixes to generated foreign-key ordering, replay identity across fresh HTML sanitation, aggregate resource limits, cleanup cost, stale unresolved labels and concurrency evidence. The revised migration uses inline unique constraints. Replay ignores random image reference IDs and local observation time while retaining source content. Prepared pages have a 24 MiB aggregate limit, bounded structure, flags and cursor data. Database fixtures exercise simultaneous submissions, interrupted publication, cleanup, credential changes, replay, rollback and privacy boundaries.

Full local checks pass with 45 tests. Astra independently ran 15 focused tests and applied all generated SQL to a disposable PostgreSQL 15 standalone database. That diagnostic does not replace the required PostgreSQL 16/Compose gate, which is pending Ubuntu CI.

The provider adapter must supply authenticated Sent provenance, stable page identities and ordered pages. The later runner must schedule orphan cleanup. Indexing, AI, source actions and reading remain outside this step.

Ubuntu CI run `39480965786` on commit `21c2997` passed every gate, including PostgreSQL 16 migration/page transaction/concurrency/crash fixtures and browser regressions. Normalized mail persistence is runtime-accepted; Gmail sync and reading remain pending.
