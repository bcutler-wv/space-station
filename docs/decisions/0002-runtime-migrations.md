# 0002: Controlled runtime migrations

## Context

M0.2 needs durable schema and queue setup before multiple app or worker processes can start. Provider-facing services will later need outbound network access.

## Options

- Let every app and worker instance migrate on startup.
- Run one migration service before app and worker startup.

## Decision

Use one Compose `migrate` service. It takes a PostgreSQL advisory lock, enables pgvector, applies the committed Drizzle migration, then lets pg-boss create or update its own schema and the probe queue. The app and worker depend on successful completion. Their pg-boss instances use `migrate: false`, so a version mismatch fails startup. The initial Drizzle migration creates only `settings`; identity and mail tables belong to later milestones. The generated SQL and snapshot are committed together and are not edited after merge.

Compose has a normal bridge network for future outbound provider traffic. Only the app publishes a port, bound to loopback by default. Meilisearch, embeddings, Tika, and camo are deferred until the milestones that use them; adding idle containers now would increase memory and license scope without testing product behavior.

## Consequences

Fresh boot and restart follow one migration path. A failed migration blocks app and worker startup. The database volume retains schema and jobs. Worker health requires a fresh pg-boss heartbeat with its consumer registered; CI exercises actual job completion. This runtime is not ready for production until authentication and the remaining M0 gates exist.
