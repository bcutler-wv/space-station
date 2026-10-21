# Draft attachment backend

Version 0.26.0 adds draft-owned upload, metadata listing, removal and private download. Dedicated attachment intents reserve quota before immutable publication and fence attachment against the current draft revision. The worker collects stale or detached files without inventing mail sync ownership. Text autosave must echo the current attachment IDs; removal and discard advance the revision and detach files.

The storage contract allows 64 files and 8 MiB total per draft, with four active upload handlers. Verification means peak application buffers are approximately 64 MiB across those handlers plus incoming chunks. Cancellation is cooperative; slots remain held until handlers settle. Upload-key replay lasts while the attachment row exists. Later send work must freeze owned content and extend retention before introducing outbound operations.

Sol implemented the slice and Astra reviewed it before integration. Review corrected scope preflight before byte consumption, discard reference cleanup, concurrent-buffer lifetime, deterministic quota testing, Unicode filename limits and memory/deadline documentation. No new dependency or provider action was added. The attachment contract is recorded in [the ownership decision](../decisions/0010-draft-attachments.md).

Local lint, typecheck, 68 unit tests, build, color and license checks passed. Sol and Astra independently ran a fresh PostgreSQL 15 authenticated HTTP/private-filesystem fixture covering scope and CSRF, quota and held-writer cleanup, restart, replay, unsafe filenames and links, removal and discard. Astra additionally paused publication while autosave advanced the draft revision, verified a conflict, and collected the orphan. Both disposable databases were stopped. Local SQL migration execution omits the unavailable pgvector extension wrapper and does not establish runtime queue migration or Docker permissions.

Ubuntu PostgreSQL 16/Compose validation is wired using the application's private volume and configured UID/GID, and remains pending for this commit. Send, compose, provider actions and M1 integrated acceptance remain separate work.

Version 0.26.1 repairs a fixture bootstrap failure in Ubuntu run `39525762004`: the fixture attempted to create `/app/.cache` even when CI supplied its writable private-volume root. Default directory creation is now conditional; container permissions and attachment assertions are unchanged. Sol ran the full PostgreSQL 15 fixture with an explicit root from a read-only working directory and with the repo-local default. Astra independently executed both setup branches and accepted the narrow repair. Full Ubuntu acceptance remains pending.

Full Ubuntu run `39526973691` passed at `8de3f30` (0.26.1), accepting attachment storage and the fixture repair. The PostgreSQL 16 migration, application UID/GID private-volume fixture and remaining browser gates all passed.
