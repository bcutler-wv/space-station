# Disabled search generation foundation

The v2 lexical profile and database generation controls are source-reviewed. The v1 mapping, compiler and private runtime remain unchanged. No live writer, index transition, scheduled reconciliation or result-serving route is enabled.

The v2 compiler adds an authoritative outer `live:true` filter. Bounded document constructors validate UUID identity, revision, canonical dates and serialized size. Content-free fences retain only operational identity and version fields. A later publisher must still supply a coherent, deterministically ordered projection and validate source permissions.

Migration 0017 seeds a permanent disabled control row, reserves generation names and tokens in retained history, and adds acknowledgement generation/disposition fields. Both publication and serving are forbidden by database constraints in this slice. Transaction-only helpers lock that same control row before future epoch/ledger work and apply checked, expected-state updates. A future runtime transition requires separate review and migration.

Astra accepted the implementation after correcting the CI upgrade mount path and adding finite migration query/lock deadlines. The full local check passed 110 tests. Independent review verified v1 equivalence across 28 cases, v2 Boolean/scope filters, bounded envelope behavior, fresh and upgrade PostgreSQL fixtures, invalid-acknowledgement rollback, old-snapshot serialization, forced-failure cleanup and direct rejection of both enable flags. Local checks use PostgreSQL 15; the new Ubuntu PostgreSQL 16 and container gates remain pending.

The restore rule is explicit: a future live installation must disable publication and serving after either database or engine restore and rebuild a new physical generation from PostgreSQL. Matching old names or UUIDs do not prove that restored systems agree. This is a product-contract clarification, not implemented live recovery in this foundation.
