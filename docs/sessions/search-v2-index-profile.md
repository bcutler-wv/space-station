# Frozen v2 index profile source

The inactive `station-mail-v2` profile now has one search-owned pure definition. `createV2IndexBody()` copies its fixed settings and existing v2 mapping for a validated literal generation index name. `verifyV2IndexProfile()` bounds and compares an index GET response against those constants, with only the engine-generated UUID, creation date, provided name and created/optional upgraded version metadata permitted. It rejects aliases, extra keys and changed semantics. A nullable expected UUID permits validation immediately after an acknowledged create; a non-null bound UUID must match exactly. Neither function sends an SDK request or grants permission to create an index.

The disposable generation proof uses both functions. The current database dispatch intent binds the profile marker and generation metadata, not the full SDK request body; a future administration adapter still needs separate review of its exact send/acknowledgment protocol. V1 behavior and both disabled SQL gates are unchanged. The pinned Ubuntu proof has not run on this source diff yet.

The pure profile is independently Astra-reviewed in 0.57.0. Review corrected scalar coercion and bounded traversal before serialization; independent callback and shared-reference probes plus focused tests passed. The definition preserves the previously tested fixture settings and mapping. Actual pinned Ubuntu regression acceptance remains pending.

Accepted at `d82d66e` after Ubuntu run `39864769078` passed all seven jobs. Engine job `120125526409` exercised the shared profile in the pinned two-generation TLS proof, followed by retained bootstrap and deleted-v1 denial regressions. This accepts the profile helper, not a publisher or enabled search path.
