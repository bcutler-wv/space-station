# Station

Station is a self-hosted mission control for your work. It brings your email, calendars, Slack, and Teams into one place, groups them into **Orbits** (one per company, client, or area of life), and uses an AI model you choose to sort what comes in, track what you owe people, and answer questions across everything.

> **Status:** pre-alpha. The build specification is approved as a starting baseline. Nothing here is usable yet.
>
> **Name:** "Station" is a working name. The product name lives in one config constant so it can change later.

## What it does

- **Mission Control.** A morning briefing, today's meetings from every calendar on one timeline (with cross-account conflicts flagged), a ranked list of what needs you and why, a prep sheet for your next meeting, and a weekly task board.
- **Orbits.** Group accounts into focused workspaces. A work Orbit might hold a Google Workspace mailbox, a Slack workspace, and a calendar. Each Orbit has its own context, filters, and privacy rules.
- **Mail modeled on Gmail.** Conversations, labels, keyboard shortcuts, and Gmail-style search operators, across Gmail, Microsoft 365, and any IMAP account.
- **Search that finds things.** Instant keyword search with operators, meaning-based search, and attachment contents (including scanned PDFs).
- **CAPCOM.** Ask questions in plain language. CAPCOM searches, reads, and cites the exact messages its answer came from.
- **Living tasks.** Tasks found in your mail and chat land in a review tray. Completion suggestions show evidence; automatic internal completion is opt-in per condition and can be undone.
- **Your colors.** Upload a wallpaper and the whole interface re-themes around it, in light and dark.

## Principles

1. **The AI proposes, you decide.** Provider actions always require your action. You can opt into evidence-backed internal task completion with undo.
2. **Your data stays yours.** Self-hosted, no telemetry, your own OAuth apps, and per-Orbit rules for what an AI provider may see. Works with a local model, or with no AI at all.
3. **Bring your own AI.** Anthropic, OpenAI, or any OpenAI-compatible endpoint.

## Supported sources (planned for v1.0.0)

| Source | Connects through |
|---|---|
| Gmail and Google Workspace | Gmail API, Google Calendar API |
| Microsoft 365 and Outlook.com | Microsoft Graph (mail, calendar, Teams) |
| Any IMAP and SMTP host | IMAP, SMTP, CalDAV |
| Slack | Your own internal Slack app, Socket Mode |

## Running it

Docker Compose on any Linux host. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). A first-run wizard walks you through creating your OAuth apps and connecting each account.

M0.1 provides a development scaffold only. With Node 22.12+ and Corepack, run `corepack pnpm install --frozen-lockfile`, then `corepack pnpm check`. `corepack pnpm --filter @station/server start` serves a development `/health` endpoint after `corepack pnpm build`. `corepack pnpm --filter @station/web dev` opens a minimal React page. The database, queue, authentication, and deployable Compose stack are scheduled for later M0 steps.

Provider permissions and data-use terms can change. Verify current official documentation when enabling each connector, especially Slack indexed mode. The default Slack mode is live and stores no long-term content.

## Documentation

| Doc | What's in it |
|---|---|
| [VISION](docs/VISION.md) | What Station is and isn't |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Services, stack, data flow |
| [DATA_MODEL](docs/DATA_MODEL.md) | Tables and relationships |
| [CONNECTORS](docs/CONNECTORS.md) | Each source, its auth, and its sync strategy |
| [SEARCH](docs/SEARCH.md) | The three search layers |
| [AI](docs/AI.md) | Extraction tiers, schemas, CAPCOM tools, safety rules |
| [TASKS](docs/TASKS.md) | Tasks, tags, recurrence, auto-completion |
| [DESIGN](docs/DESIGN.md) | Visual language, theming, the reference wireframe |
| [SETUP_WIZARD](docs/SETUP_WIZARD.md) | First-run flow |
| [SECURITY](docs/SECURITY.md) | Threat model and controls |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Hosting, reverse proxy, backups |
| [ROADMAP](docs/ROADMAP.md) | Milestones to v1.0.0 |

## License

AGPL-3.0. See [LICENSE](LICENSE). Third-party code and its licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
