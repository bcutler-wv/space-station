# 0005: URL routing and live updates

Status: Routing implemented in M1.1; live transport backend implemented in M1.3. Browser wiring remains pending.

## Context

The M0 sample shell used component state for navigation. Mail and setup need direct URLs, browser history, and refresh. Incoming sync events only travel from the server to a signed-in browser; user actions remain REST requests.

## Options

For routing, keep custom History API handling or adopt TanStack Router. For live updates, use WebSocket or server-sent events (SSE). The Fastify team's `@fastify/sse` is maintained for Fastify 5 and MIT licensed; its route hooks and replay support fit the event stream. Version 0.6.1's tagged API and license were checked on 2026-10-20 and the package was pinned when the backend was implemented.

## Decision

Use pinned TanStack Router 1.170.41 for explicit client routes and deep links. Keep the sample Mission Control at `/` and sample Orbits under `/demo/orbits/:orbitId`; first Orbit setup is `/setup`. Server static fallback serves the app for known client paths while `/api/*` remains API-only.

Use one authenticated, read-only SSE channel for M1 live sync. Send small event names and IDs only; clients invalidate TanStack Query caches and re-fetch through the private REST API. Use same-origin secure cookies, session generation checks, no-store responses, connection limits and heartbeat. Reconnect with a bounded event ID/replay window and fall back to a full refetch after a replay gap. No content bodies or credentials belong in events.

## Consequences

The app has stable, refreshable setup and sample URLs. SSE avoids a second bidirectional protocol for this one-way stream. The backend endpoint, plugin pin, cross-process event journal, replay persistence and integration fixture are part of the M1 sync task. The browser EventSource consumer remains a later review task.

The M1 backend uses `@fastify/sse` 0.6.1 with its built-in heartbeat disabled. A bounded sender writes small event names, IDs and account UUIDs only. A journal ID is allocated by updating one singleton PostgreSQL row inside the same transaction as the mail page or progress change; its row lock stays held through commit, so replay IDs follow commit order. A read-only repeatable-read snapshot keeps the journal head, oldest retained ID and replay rows consistent when another writer prunes events. The journal keeps the most recent 512 events. A stale, ahead-of-head, or over-limit cursor receives `sync-reset` and must refetch private REST state. An independent watcher checks the stored session and owner generation every two seconds even during replay, closes on a session-check timeout after 1.5 seconds, and does not extend idle time; normal active requests still touch sessions. Its authorization and replay read transactions set local PostgreSQL statement and lock timeouts of 1.25 and 1 second, respectively, to release blocked database clients. The stream polls PostgreSQL without holding a client between polls and closes after revocation, expiry, disconnect, or slow output.
