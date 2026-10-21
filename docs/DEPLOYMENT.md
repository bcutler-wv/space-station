# Deployment

OAuth callbacks can carry a short-lived authorization code and state in the query string. Configure the reverse proxy to omit query strings from access logs for `/api/google/callback`; do not log request bodies or authorization headers. The application returns `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on the callback redirect.

## Requirements

- For the current development shell: a disposable Linux host or VM with Node.js 22.23.2 or newer in the Node 22 line, OpenSSL, Docker with the Compose plugin, and access to its running daemon.
- For connected Gmail mailboxes: about 4 GB of RAM for a single user with a few accounts, more for very large mailboxes. The embedding model and Tika are planned for later milestones.
- For connected Gmail mailboxes: disk for mail bodies and attachments. Plan on 1.5 to 2 times the size of the mailboxes being synced; later search indexes need additional capacity.
- For a deployment beyond localhost: a hostname with HTTPS, served by your own reverse proxy.

## Development startup

The current build has a sample Mission Control shell and live Gmail Mail after owner setup, an explicit first-Orbit privacy choice, authorization with your own Google web client, and a saved backfill window. After cloning the repository on a disposable Linux host, run this command from the repository root:

```
bash scripts/start-dev.sh
```

The script also works when invoked by absolute path from another directory. It checks the prerequisites, creates the private development environment, builds and starts Postgres and the one-shot migration, then builds and waits for healthy app and worker containers. It does not create an owner. Check readiness and create an owner setup token separately from the repository root:

```
curl --insecure --fail https://localhost:8080/ready
mkdir -p -m 700 .cache/bootstrap
docker compose run --rm -T --no-deps --user "$(id -u):$(id -g)" -v "$PWD/.cache/bootstrap:/run/bootstrap" app node apps/server/dist/bootstrap-cli.js /run/bootstrap/token
```

The init step writes a new `.env` with 0600 permissions, does not print secrets, and never overwrites an existing file. It creates a private seven-day localhost TLS certificate and renews it when less than a day remains. Your browser will ask you to trust that temporary certificate. It sets `APP_ORIGIN=https://localhost:8080` for development. Set `APP_ORIGIN` to the exact HTTPS origin browsers use before serving a real hostname. To set values manually, copy the tracked template to the private file with `cp .env.example .env`, run `chmod 600 .env`, then edit `.env`. Keep and back up `.env`; never put secrets in `.env.example`.

The setup command writes a 0600 token file without printing its contents. It expires after 15 minutes. Open `APP_ORIGIN`, paste the token, and choose a passkey or a password of at least 12 characters. Password setup must be completed with a six-digit TOTP code before owner creation commits. Save the ten recovery codes shown once. Delete the local token file after setup with `rm .cache/bootstrap/token`; to create another token before an owner exists, remove the expired file first and rerun the command. The command fails once an owner exists. Appearance settings and wallpaper persist in PostgreSQL and require login.

Compose binds the app to `127.0.0.1` by default. A reverse proxy on another host cannot reach that binding. To serve another host, bind the app port to an explicitly chosen private interface in `compose.yaml` and restrict access at the host firewall and proxy. The reverse proxy must terminate HTTPS at the configured public origin. Clear `APP_TLS_KEY_PATH` and `APP_TLS_CERT_PATH` when the proxy talks HTTP to the app, and set `APP_TRUSTED_PROXY_IP` to the proxy's exact source IP as seen by the app; the proxy must set `X-Forwarded-Proto: https`. Do not publish the database or worker ports.

`migrate` is a one-shot service. It takes an advisory lock, enables pgvector, applies generated Drizzle migrations, and prepares pg-boss. App and worker start only after it succeeds. On updates, rebuild and run `migrate` before starting the app and worker, as in the commands above. Run `docker compose up -d --force-recreate migrate` explicitly if a migration must be retried without an image change. A failed migration blocks app and worker startup.

`blob-init` is a separate one-shot service that creates the `private_blobs` named volume directory as `root:APP_GID` with mode `2770`. It receives only `APP_GID` and no database or encryption secrets. The app runs as `APP_UID:APP_GID`; the worker remains UID 1000 and joins `APP_GID` as a supplementary group. Both can read and write private files, including when the host uses `APP_UID=1001` and `APP_GID=1001`. The MIME parser cannot mount the volume. Back up this named volume with the database and master key. Do not change ownership or permissions broadly on the host.

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
# Mail image proxy secret

`scripts/init-env.mjs` creates `.cache/go-camo.env` with a dedicated random signing key. It leaves an existing file unchanged on restart. Back up this private file alongside the deployment secrets; loss rotates the proxy key and makes only previously signed transient image URLs unusable. Compose reads the key for the app and go-camo services only. The proxy has no published port and no database or master-key environment. Keep the file mode at 0600.

The optional M2 search-engine foundation creates `.cache/meilisearch.env` with a separate 0600 engine master key. Back it up with the search volume; losing it invalidates engine API keys. The `search` Compose profile starts the pinned private Community engine after a volume-permission init, then a one-shot bootstrap enables the version-pinned substring filter. The engine has no published port, and the current app and worker have no engine key or query path. On a disposable host, the foundation can be started with `docker compose --profile search up -d --build --wait meilisearch` followed by `docker compose --profile search run --rm -T --no-deps meili-bootstrap`. This is an engine contract foundation, not live M2 search or a replacement for current Mail subject filtering.
