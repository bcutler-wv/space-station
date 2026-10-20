# Private mail storage foundation

M1 adds a bounded file store for later sanitized HTML and attachment persistence. Generated immutable keys replace filenames in storage paths. Files publish atomically after syncing, reads reject symlinks and special files, and deletion tolerates retries. No mail ingestion or read route is added by this step.

The app and worker share a private named volume through a dedicated group. An isolated initialization service provisions only that volume without application secrets. The parser has no mount. Ubuntu CI checks app UID 1001 against worker UID 1000, shared access, parser isolation and restart persistence.

Astra review reproduced concurrent deletion failures and a trailing-slash bypass of root symlink checks. Both were fixed with regression tests. Full local checks pass with 39 tests, including seven storage tests. The new Compose gate is pending Ubuntu CI.

The storage contract now explicitly defers crash-orphan deletion until database references and coordination with in-flight writers exist. No age-only cleanup can remove an active write. Root ancestors are trusted administrator paths; containers sharing the volume group are trusted with its contents. Keep the configured group stable until an ownership migration is planned.

Prior credential refresh, reconnect and parser capacity work passed all gates in Ubuntu run `39476144537` on `357bb4f`. Gmail sync and reading remain pending.

Ubuntu CI run `39477808140` on commit `8f33cb5` passed all gates, including shared volume permissions across app UID 1001 and worker UID 1000, restart persistence, parser isolation and existing authentication/Google browser regressions. The storage foundation is runtime-accepted.
