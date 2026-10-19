# Deployment

## Requirements

- A Linux host or VM with Docker and Docker Compose.
- About 4 GB of RAM for a single user with a few accounts (the embedding model and Tika are the largest consumers), more for very large mailboxes.
- Disk for mail bodies, attachments, and indexes. Plan on 1.5 to 2 times the size of the mailboxes being synced.
- A hostname with HTTPS, served by your own reverse proxy.

## Quick start

```
git clone <repo>
cd <repo>
cp .env.example .env        # set POSTGRES_PASSWORD and STATION_MASTER_KEY
docker compose up -d
```

Then open the hostname in a browser and follow the setup wizard.

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
docker compose pull
docker compose up -d
```

Migrations run automatically on app start.

Backups contain sensitive message content and metadata even though application-level encryption protects provider credentials only. Restrict access and encrypt backup storage. Use disposable data for automated restore checks in CI; do not use the production host for build tests.
