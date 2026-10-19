# Deployment

## Requirements

- A Linux host or VM with Docker and Docker Compose.
- About 4 GB of RAM for a single user with a few accounts (the embedding model and Tika are the largest consumers), more for very large mailboxes.
- Disk for mail bodies, attachments, and indexes. Plan on 1.5 to 2 times the size of the mailboxes being synced.
- A hostname with HTTPS, served by your own reverse proxy.

## M0.2 runtime validation

This milestone is a runtime scaffold, not a usable or authenticated deployment. On a disposable Linux host with Docker, run:

```
node scripts/init-env.mjs
docker compose up -d --build postgres migrate
docker compose up -d --build --wait app worker
curl --fail http://127.0.0.1:8080/ready
```

The init script writes a new `.env` with 0600 permissions, does not print secrets, and never overwrites an existing file. To set values manually, copy the tracked template to the private file with `cp .env.example .env`, run `chmod 600 .env`, then edit `.env`. Keep and back up `.env`; never put secrets in `.env.example`. The app serves the built placeholder page and health endpoints. Authentication and the setup wizard come in later M0 steps.

Compose binds the app to `127.0.0.1` by default. A reverse proxy on another host cannot reach that binding. When the authenticated release is ready for deployment, bind the app port to an explicitly chosen private interface in `compose.yaml` and restrict access at the host firewall and proxy. Do not publish the database or worker ports.

`migrate` is a one-shot service. It takes an advisory lock, enables pgvector, applies generated Drizzle migrations, and prepares pg-boss. App and worker start only after it succeeds. On updates, rebuild and run `migrate` before starting the app and worker, as in the commands above. Run `docker compose up -d --force-recreate migrate` explicitly if a migration must be retried without an image change. A failed migration blocks app and worker startup.

The worker health check requires a live pg-boss heartbeat from this container with the probe consumer registered, then verifies that the consumer completes a fresh probe within ten seconds. A stopped or stalled consumer becomes unhealthy. Completed probe jobs are retained for one hour. CI also queues a probe while the worker is stopped and verifies that the worker completes it after restart.

## Reverse proxy

Any proxy works (Nginx Proxy Manager, Caddy, Traefik). Point it at the `app` container. Settings that matter:

- **WebSockets on** (used for live updates).
- **Larger request bodies** for attachments, for example `client_max_body_size 50m;` in Nginx.
- **Long read timeouts** for live connections and streamed CAPCOM answers, for example `proxy_read_timeout 3600s;`.
- **No caching** on this host.

## Private access

Station does not need to be reachable from the internet. Every connector works outbound only. A common setup:

- DNS record pointing at a LAN or Tailscale address.
- A certificate from your proxy using a DNS challenge.
- Optionally, Cloudflare Tunnel with Cloudflare Access in front if you want access from outside your network.

Google and Microsoft only need a valid HTTPS hostname for OAuth redirects. They never connect to it.

## Backups

Back up:
- The Postgres database (`pg_dump` on a schedule).
- The data volume (mail bodies and attachments).
- The `.env` file, especially `STATION_MASTER_KEY`. Without it, stored credentials cannot be decrypted.

Meilisearch and embeddings can be rebuilt from the database, so backing them up is optional.

## Updates

```
git pull
docker compose stop app worker
docker compose pull postgres
docker compose build --pull migrate app worker
docker compose up -d postgres
docker compose up -d --force-recreate migrate
docker compose up -d --force-recreate --wait app worker
```

Migrations run in the controlled `migrate` service before app and worker startup.

Backups contain sensitive message content and metadata even though application-level encryption protects provider credentials only. Restrict access and encrypt backup storage. Use disposable data for automated restore checks in CI; do not use the production host for build tests.
