# Legacy reply metadata repair

Version 0.25.0 adds a bounded, owner-triggered Gmail metadata read for incoming legacy messages that lack stored reply headers. It stores a separate validated reply snapshot after checking account, Orbit, provider message/thread/revision, credential generation and current normalized addresses. Ingestion clears the snapshot. Sender identity, privacy evidence and trusted direction are unchanged; syntax validation is not sender authentication.

Sol implemented the slice and Astra reviewed it before integration. Review corrected permissive malformed address extraction, strict bounds and exact keys for stored snapshots, and inconsistent mailbox validation. Conservative unsupported or ambiguous addresses remain unavailable. Existing official Gmail SDK and pinned PostalMime and Zod packages are reused; no provider write path was added.

Local lint, typecheck, 68 unit tests, build, color and license gates passed. The SDK fixture passed 15 tests. Fresh PostgreSQL 15 authenticated HTTP fixtures passed scope denial, repair and reply creation, malformed and corrupt metadata rejection, and concurrent credential, revision and Orbit changes. Astra independently reproduced and rechecked the validation findings. The local database was stopped after testing.

Ubuntu PostgreSQL 16/Compose and browser integration remain pending for this commit. Draft attachments, send, compose and M1 integrated acceptance remain separate work.

Full Ubuntu run `39524137665` passed at `f4aaa3d` (0.25.0), accepting the repair with PostgreSQL 16/Compose and browser gates.
