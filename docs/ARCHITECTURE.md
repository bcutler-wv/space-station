# Architecture

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript everywhere, Node LTS | One language for client, server, and worker. Shared types. |
| Repo layout | pnpm workspaces monorepo | See layout below |
| Web client | React + Vite, built as a PWA | Plain CSS with design tokens. No CSS framework. |
| Client data | TanStack Query and TanStack Router | M1.1 uses URL routes for setup and the sample shell. See decision 0005. |
| Drag and drop | dnd-kit | Touch and keyboard support |
| API server | Fastify | REST for requests; SSE selected for later M1 live updates in decision 0005. |
| Database | PostgreSQL 16+ with pgvector | Drizzle ORM and Drizzle migrations |
| Job queue | pg-boss | Postgres-backed, so no Redis container |
| Validation | zod | Every API payload and every AI output |
| Lexical search | Meilisearch Community Edition | Typo tolerance, prefix search, facets |
| Embeddings | Local embedding service in its own container | Evaluate Hugging Face text-embeddings-inference and Ollama before M6 semantic search. OpenAI embeddings as an option. |
| Attachment text | Apache Tika server, with Tesseract for OCR | |
| Remote images | go-camo | Proxies remote images and hides the client IP; images remain blocked by default because unique URLs can reveal opens |
| Theme | @material/material-color-utilities | Seed extraction and scheme generation |
| Tests | Vitest for units, Playwright for end to end | |

Settle evaluated choices before implementing the feature that uses them. M0.3 records scoped deferrals for routing, live transport, and embeddings in decision 0003; M1 and M6 own the resulting decisions.

## Containers

```
                         reverse proxy (user's own: NPM, Caddy, Traefik)
                                        |
                                   [ app ]  web client + API     <- only exposed service
                                        |
     +---------------+------------------+------------------+---------------+
     |               |                  |                  |               |
 [ worker ]    [ postgres ]      [ meilisearch ]     [ embeddings ]   [ tika ]   [ camo ]
 sync, parse,   data, queue,      lexical index       local model      text, OCR   image proxy
 extract        vectors
```

- **app** serves the built web client and the API. Stateless.
- **app** and **worker** share the `private_blobs` named volume for future sanitized HTML bodies and attachments. `mime-parser` has no access to it. The `blob-init` one-shot service only provisions its directory and receives no runtime secrets.
- **worker** runs sync, MIME parsing, indexing, embedding, rules, and AI extraction from the job queue. It can run as several processes. MIME parsing runs in a separate process/container with hard memory, CPU, input-size, and wall-clock limits. Node worker-thread `resourceLimits` do not cap external buffers.
- **mime-parser** is an internal-only service shared with the worker. It receives raw RFC822 bytes at a fixed address, spawns one killable child per request, and returns a bounded schema. Its service container has cgroup memory/CPU and PID limits, an unprivileged read-only filesystem, and no runtime secrets or persistent mounts. It has no published port and no outbound provider network. The worker may use the parser only after privacy gating.
  The same child now sanitizes decoded HTML with DOMPurify and jsdom before returning it. It returns policy-versioned HTML and inert image placeholders plus separately bounded image metadata. It never returns raw HTML. The reader must re-sanitize with the shared policy before display. The backend image route resolves only stored opaque references and signs URLs internally for an isolated go-camo service; the browser body component remains later work.
  The parser health endpoint reports service liveness; CI and worker calls exercise child parsing. A 512 MiB memory cgroup and 64 PID limit leave room for the service, two children, and a health probe; a one-core CPU quota limits sustained CPU use while the eight-second child deadline bounds elapsed parsing time. The whole HTTP request has an 8.5-second limit, and the worker client has a ten-second timeout. The quota was raised from half a core after an unchanged two-child near-cap HTML workload passed once and then timed out on another Ubuntu runner. CI repeats that workload three times and checks recovery, health, OOM counts, and restarts.
- Everything except **app** has no published ports. Containers share a Compose bridge so future connectors can make outbound provider requests; ingress remains limited to the app's configured host binding.

## Repo layout

```
apps/
  web/              React client
  server/           Fastify API
  worker/           job runners
packages/
  shared/           zod schemas, types, constants (including PRODUCT_NAME)
  db/               Drizzle schema and migrations
  connectors/       gmail, graph, imap, caldav, slack (one folder each, one interface)
  ai/               provider adapters, prompts, tools, extraction
  search/           Meilisearch and pgvector query layer
  theme/            tokens, scheme generation
design/
  wireframe.html    reference design, open it in a browser
docs/
```

## Data flow

```
connector sync
  -> page provider changes using a durable per-collection cursor
  -> parse (isolated process/container for mail)
  -> normalize into items, threads, people
  -> Tier 1 rules (deterministic labels, bulk mail detection, Orbit routing)
  -> compute effective privacy across all matching Orbits
  -> commit normalized page and cursor atomically
  -> index in Meilisearch
  -> embed into pgvector
  -> Tier 2 extraction (if not bulk and not excluded)
  -> derived records: proposals, promises, entities, task updates
  -> push live update to the client
```

Each step is its own job type, so any step can be retried or re-run for history (for example, re-running extraction after a prompt improves).

Sync is at-least-once. Each provider object has a stable key scoped by account and collection; upserts and downstream jobs deduplicate by that key and provider revision. Commit a cursor only after its page and deletion tombstones are durable. A crash replays the page safely. Treat provider cursor expiry as a bounded rescan with reconciliation; remove or tombstone provider-deleted items and invalidate their search/AI derivatives. Retry transient failures with capped exponential backoff and jitter; persist permanent permission errors for user repair. Initial backfill and incremental catch-up must converge without gaps.

Outbound sends and provider changes start from an authenticated user action. Sends use `outbound_operations`; Gmail message-label changes use a separate `mail_change_operations` table because they have no draft, MIME or recipients. Claim one operation per idempotency key. If a send times out after submission, mark `outcome_unknown`; reconcile Sent/provider IDs before offering a manual retry. Never automatically replay an unknown provider write. Only a confirmed send produces a sent item or completion evidence.

The M1 Gmail change route freezes one exact message and explicit desired add/remove labels before one `messages.modify` call. It checks account, Orbit, item revision and applied sequence, credential generation, live Gmail DRAFT absence and USER label type before the claim. A claimed change with an unknown outcome can only be reconciled by a read of current provider labels. Direct response confirmation and later observed desired state are distinct historical outcomes; neither changes local labels. Existing Gmail history/polling sync updates the local snapshot. M2 must require an authoritative item read initiated after action settlement before derived indexing or AI use, including after a zero-write observed no-op; sequence and local update timestamps alone cannot establish provider-read order. M1 has no derived consumer yet.

## Connector interface

Connector operations are explicit and bounded. The M1 Gmail read adapter returns one validated provider page per call so a durable runner can own the cursor, lease, and transaction:

```ts
interface GmailReadPages {
  getProfile(accountId: string): Promise<GmailProfile>; // history anchor
  listLabels(accountId: string): Promise<GmailLabelPage>;
  listMessageIds(accountId: string, input: ListInput): Promise<GmailMessagePage>;
  getMessageRaw(accountId: string, messageId: string): Promise<GmailRawMessage>;
  getMessageMinimal(accountId: string, messageId: string): Promise<GmailMessageMetadata>;
  listHistory(accountId: string, input: HistoryInput): Promise<GmailHistoryPage>;
}
```

The runner will persist each page and continuation cursor atomically. Sending and changes require separate APIs called only from a user action; the AI layer has no path to them. Other providers should use the same bounded-page and durable-cursor rule without assuming Gmail's page fields.

## Live updates

When live updates are implemented in M1, the server will push small events (`item.created`, `task.updated`, `proposal.created`) over one SSE or WebSocket channel. Decide that transport in M1. The client invalidates matching TanStack Query keys; it does not poll for live changes.

## Configuration

- `.env` holds only deployment bootstrap values listed in `.env.example`: Postgres password, master encryption key, app port, and exact public origin. The database URL is assembled inside the Compose network with URL-safe encoding; do not duplicate its password in a separate variable.
- OAuth client IDs, client secrets, tokens, IMAP passwords, and AI API keys are entered in the setup wizard and stored encrypted in the database.
- `PRODUCT_NAME` lives in `packages/shared/src/constants.ts`. Never hard-code the product name anywhere else.
