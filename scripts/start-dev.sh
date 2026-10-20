#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22.12 or newer is required. Install Node.js before starting Station.' >&2
  exit 1
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' >/dev/null 2>&1; then
  echo 'Node.js 22.12 or newer is required. Upgrade Node.js before starting Station.' >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo 'OpenSSL is required to create the local HTTPS certificate. Install OpenSSL before starting Station.' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo 'Docker with the Compose plugin is required. Install Docker Compose before starting Station.' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo 'The Docker daemon is unavailable. Start Docker and check that your user can access it.' >&2
  exit 1
fi

node scripts/init-env.mjs
docker compose up -d --build postgres migrate
docker compose up -d --build --wait app worker mime-parser
