# 0005: URL routing and live updates

Status: Routing implemented in M1.1; live transport chosen for later M1 sync work.

## Context

The M0 sample shell used component state for navigation. Mail and setup need direct URLs, browser history, and refresh. Incoming sync events only travel from the server to a signed-in browser; user actions remain REST requests.

## Options

For routing, keep custom History API handling or adopt TanStack Router. For live updates, use WebSocket or server-sent events (SSE). The Fastify team's `@fastify/sse` is maintained for Fastify 5 and MIT licensed; its route hooks, heartbeats, and replay support fit the later event stream. Its current upstream API and license were checked on 2026-10-19. No SSE package is added until an event stream is implemented.

## Decision

Use pinned TanStack Router 1.170.41 for explicit client routes and deep links. Keep the sample Mission Control at `/` and sample Orbits under `/demo/orbits/:orbitId`; first Orbit setup is `/setup`. Server static fallback serves the app for known client paths while `/api/*` remains API-only.

Use one authenticated, read-only SSE channel when live sync arrives later in M1. Send small event names and IDs only; clients invalidate TanStack Query caches and re-fetch through the private REST API. Use same-origin secure cookies, session generation checks, no-store responses, connection limits and heartbeat. Reconnect with a bounded event ID/replay window and fall back to a full refetch after a replay gap. No content bodies or credentials belong in events.

## Consequences

The app has stable, refreshable setup and sample URLs now. SSE avoids a second bidirectional protocol for this one-way stream. The actual SSE endpoint, plugin pin, cross-process event fanout, replay persistence and integration tests belong to the later M1 sync task.
