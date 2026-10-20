# M0 acceptance

The current deliverable is a private, authenticated development shell with sample data. It does not connect real mail, calendar, or chat accounts. The fresh-clone command is `bash scripts/start-dev.sh` on a disposable Linux host with Node.js 22.12+, OpenSSL, Docker Compose, and a running Docker daemon. Owner setup is a separate explicit step in [DEPLOYMENT.md](DEPLOYMENT.md).

M0.1 through M0.4 passed Astra review and GitHub Actions. Run `39344188832` passed both jobs: lint, typecheck, unit and fixture tests, build, license and CSS color gates, shell browser tests in light and dark modes, fresh Compose build and restart, real-PostgreSQL authentication races, virtual-passkey and password/recovery browser flows, and the combined 12-test runtime end-to-end suite. The shell browser tests use sample data; no provider integration is claimed.

M0.5 wires the documented command into the Compose smoke script, which the runtime CI job runs from checkout. Astra accepted this implementation after shell syntax, prerequisite-failure, and documentation checks. A green Ubuntu CI run including this exact startup command establishes M0 acceptance; [CI results](https://github.com/bcutler-wv/space-station/actions/workflows/ci.yml) are the live acceptance record. Agent-dev has no Docker; no Compose gate is claimed from that host.

Scoped decisions remain in [decision 0003](decisions/0003-theme-shell.md): client routing and live transport are due before M1 Mail deep links and live sync, and the embedding engine is due before M6 semantic search. The local Material Symbols font is about 5.4 MB before caching and needs a performance pass before a public release. Search, OCR, AI, and provider adapters are future milestones.
