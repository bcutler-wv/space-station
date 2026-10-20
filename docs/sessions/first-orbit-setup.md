# First Orbit and privacy setup

M1.1 adds authenticated `/setup` with exact HTTPS origin confirmation, one real Orbit, explicit global and Orbit privacy defaults, and exact-match exclusions. A transaction commits the setup marker, Orbit and rules together; concurrent completion has one winner. A changed deployment origin requires confirmation again before later account connection.

The shared privacy evaluator denies processing when Orbit membership or policy is missing, combines restrictions across all memberships, and makes embeddings follow both search and AI exclusions. There is no synced content yet. Processing integration and derived-data invalidation remain in their later milestones.

TanStack Router provides direct URLs and browser history. ADR 0005 selects authenticated SSE for later sync events. The sample shell remains separate from real setup; no connected account is claimed.

Astra reviewed Sol's bounded implementation and found no blocking defects. Independent local checks passed lint, types, 21 unit tests, build, colors and licenses; nine local browser shell/navigation tests passed. The setup page was visually inspected. PostgreSQL transaction/reopen and authenticated HTTPS setup gates run in GitHub Actions; this record does not claim a local Docker pass.

Contract clarifications: exact account-email, sender-email and label-name matching; missing-Orbit denial; versioned setup and current-origin confirmation before OAuth or sync. Dependency versions, upstream sources and licenses are recorded in `THIRD_PARTY.md`.
