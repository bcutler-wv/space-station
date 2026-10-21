# Local drafts and reply context

## Context

A draft must survive restarts and concurrent browser tabs without creating a provider draft. Existing ingested mail had parsed RFC reply headers but did not persist them. Existing attachment blobs are owned by sync pages, so a draft cannot safely reference them or accept an arbitrary blob key.

## Options

We considered provider drafts during autosave, local drafts with provider reads for older reply headers, and local drafts using only verified stored context for this slice. We also considered reusing sync-page blob keys for draft attachments, which would bypass their ownership and collection lifecycle.

## Decision

Store drafts locally with a fixed owner and account, a client UUID creation key, a complete request digest, and atomic revision compare-and-swap. Keep plaintext bodies and empty attachment references. A new draft may select its account Orbit. A reply draft may select a routed Orbit if its live parent item belongs to it. List requests return bounded summaries; one-draft reads return the body. Persist bounded RFC headers and address completeness/count evidence during future ingestion, before invalid identities are dropped. On user reply, return context only for one complete, unambiguous sender or Reply-To address and a syntactically valid stored Message-ID chain. The browser must show these untrusted header destinations before a later send. Missing or malformed legacy headers return a clear unavailable response in this backend slice.

## Consequences

No autosave path writes to Gmail, and concurrent tabs receive a conflict instead of silently replacing text. Attachment upload needs its own durable ownership and cleanup work before it can be accepted. Older stored messages need bounded official Gmail metadata repair on user reply or validated targeted resync before M1 acceptance. The later send path must validate all draft fields and RFC headers again and persist a separate outbound operation before any provider action.

The follow-up uses a separate nullable reply metadata snapshot for legacy items. A user reply-context request first checks the exact account, live item and optional Orbit, then makes one bounded Gmail metadata read through the official SDK. It validates the RFC identifier chain and a single From or Reply-To address, compares the parsed address with the stored normalized identity rows, and conditionally saves the snapshot against the current item revision, scope and credential generation. Ingestion clears this snapshot when it replaces an item. The repair does not change sender identity rows, direction or privacy evidence. Provider changes or ambiguous headers require another user request or a new message; the app does not guess a reply target.
