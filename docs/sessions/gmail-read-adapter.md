# Bounded Gmail reads

M1 adds explicit profile, label, message and history reads through the pinned Google SDK. The future runner owns cursor checkpoints. Requests use the fixed Gmail endpoint, reject redirects, enforce byte limits before JSON parsing and keep an abort deadline through body consumption. Raw MIME support matches the parser's 12 MiB limit.

Astra review found that a refresh lease generation could be mistaken for a published token, including after a failed or crashed refresh. Rejected-token recovery now compares token value and generation. A read can retry once after a 401; a second rejection requires reconnection. Permission failures are distinct from quota failures, continuation tokens stay opaque, and retry hints do not shorten ordinary provider delays. No send or modification path uses these read retries.

The review also expanded success/error body, byte-boundary, cancellation, authorization-header, redirect, metadata and actual-database race fixtures. Local full checks passed with 59 tests; Astra independently reran 14 SDK fixtures. The final raw-limit correction passed those fixtures, lint and typecheck. Updated credential PostgreSQL fixtures require Ubuntu CI before runtime acceptance.

Architecture decision 0007 replaces the illustrative iterable connector contract with explicit bounded pages. Provider payload schemas live in the shared package, and Gaxios provenance points to its maintained Google monorepo. No scheduler, automatic ingestion, reader or external action is enabled by this step.
