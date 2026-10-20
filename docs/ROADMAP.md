# Roadmap to v1.0.0

> **Status:** approved baseline for build. Revisit decisions when provider evidence or implementation reveals a conflict.

Each milestone ends with a working, tested app. Keep milestones small enough to finish, test, and demo one at a time. Do not start a milestone until the previous one meets its definition of done.

For every bounded implementation task, Astra assigns scope and acceptance criteria to a Sol agent, reviews the result, requests fixes, and accepts it before another task begins. See `AGENTS.md`. Agent-dev has no Docker. GitHub Actions Ubuntu runners perform Compose integration and Playwright end-to-end gates; the production Docker VM is not a test environment. The orchestrator may run local checks available before CI exists, but must not claim an unavailable gate passed.

## M0: Foundations

M0.1 through M0.5 are implemented, Astra-reviewed, and accepted. The single-command fresh-clone startup and all M0 gates passed in GitHub Actions run `39345200185`. See [the acceptance record](M0_ACCEPTANCE.md) and [CI results](https://github.com/bcutler-wv/space-station/actions/workflows/ci.yml). The sample shell requires an owner login but is not yet a mail client.

Each substep ends with Astra review and fixes before the next begins:

1. **Scaffold and CI.** pnpm monorepo, strict TypeScript, shared schemas, pinned lockfile, unit-test harness, license and stray-color gates, GitHub Actions Ubuntu jobs. Record upstream repository and license provenance.
2. **Database and runtime.** Postgres/pgvector, migrations, queue, Compose services and health checks, config validation, durable migration strategy. Test fresh boot and restart on the CI runner.
3. **Theme and shell.** Material Color Utilities tokens, light/dark/system modes, wallpaper upload, local fonts/icons, shell with fake data matching the wireframe. Test contrast, reduced motion, and responsive layouts.
4. **Authentication.** One-time owner bootstrap, passkey or Argon2id password plus TOTP, recovery codes, sessions, CSRF, rate limiting. Test setup replay and unauthorized access.
5. **Integrated acceptance.** Full fresh-clone Compose startup, Playwright smoke in both themes, lint, typecheck, unit/fixture tests, license and CSS token gates. Record choices and scoped deferrals. Resolve routing and live transport by M1; resolve embedding engine by M6 before those features are implemented.

**Done when:** GitHub Actions brings up a fresh clone with one documented command, authentication protects the shell, the shell matches the reference layout with readable dark/light text, and every M0 gate is green.

## M1: Gmail and the mail view

Each M1 substep gets separate implementation, checks, Astra review and acceptance before the next begins:

1. **First Orbit, privacy and navigation.** Confirm configured HTTPS origin, save one Orbit and explicit global/Orbit defaults and exclusions before any connector or sync; implement URL routing and decide live transport. Preserve the sample shell separately. Local checks and CI setup persistence/security gates apply.
2. **Google OAuth.** User-supplied app credentials, bound state and PKCE, secure callback continuation, exact redirect, and setup-completion gate. No content sync until a backfill window is chosen.

3. **Isolated MIME and Gmail sync/live updates.** Bounded parser, initial and incremental sync, idempotent cursors, policy gates, polling or Pub/Sub pull, and the selected SSE stream.
4. **Mail reading and safe display.** Threads, labels, subject search, safe HTML with remote-image proxy and keyboard navigation.
5. **Compose, actions and integrated acceptance.** Draft, reply and send with unknown-outcome handling, restart and reliability tests, Compose integration and Playwright gates. Split further as needed for bounded review.

M1.1 was accepted with local checks and Ubuntu CI runtime gates on 2026-10-19 (commit `9d8a482`, run `39354841946`). M1.2a backend and fixture work was Astra-reviewed and accepted after Ubuntu CI run `39357352441` passed (commit `e64add3`). M1.2b guided setup and browser continuation are in implementation review. M1.2 remains incomplete until the UI and browser gates pass.

- Decide client routing and live-update transport before implementing Mail deep links and live sync events.
- Data model for accounts, Orbits, threads, items, people, labels, attachments.
- Minimal owner-to-first-Orbit setup and privacy rules before sync, account connection, and backfill choice. M3 expands this wizard.
- Google OAuth (user-supplied client), Gmail initial sync with a backfill window, History API incremental sync, Pub/Sub pull or polling.
- Isolated MIME parsing.
- Mail view: conversation list, thread view, safe HTML rendering (DOMPurify, sandboxed iframe, go-camo), keyboard shortcuts, labels, archive, read state.
- Compose, reply, and send.

**Done when:** a new user sets privacy rules before connecting one Gmail account; initial and incremental sync survive restart without duplicates; one account can be read, searched by subject, and replied to; unknown send outcomes do not resend automatically; sanitization and parser tests cover hostile sample emails. Compose integration and Playwright gates run in CI.

## M2: Search

- Meilisearch indexing, the operator parser, instant search in the top strip.
- Attachment text with Tika and Tesseract.

**Done when:** parser/operator fixture tests pass, search returns permitted results while typing, excluded and deleted items disappear from lexical and attachment results, and CI verifies reindex after restart.

## M3: Wizard, Orbits, and people

- Full setup wizard for Google.
- Orbit management, routing rules, exclusion rules.
- People and org graph with identity resolution by email and manual merge.

**Done when:** a user can manage multiple Orbits and routing, the most restrictive policy wins for shared items, policy tightening purges derived data, and provider identity collisions across accounts stay separate until manual merge. Tests cover these cases.

## M4: Microsoft and IMAP

- Graph mail connector with delta sync. IMAP and SMTP connector with auto-discovery, IDLE, JWZ threading, Sent append.
- Wizard steps for both.

**Done when:** Graph delta and IMAP folder sync recover after interrupted pages and removals; draft/send flows reconcile ambiguous outcomes; provider fixture tests and CI integration flows pass; current official permission and policy checks are recorded.

## M5: Calendars

- Google Calendar, Graph calendar, and CalDAV.
- Today's timeline on Mission Control with cross-Orbit conflicts.

**Done when:** multiple calendars per account render in one timeline with correct time zones, all-day dates, recurrence overrides, and conflicts; invitation receipt does not count as a user scheduling action. Calendar fixture and UI tests pass.

## M6: AI foundation and CAPCOM

- Choose the local embedding engine before implementing semantic search.
- Provider adapters (Anthropic, OpenAI, OpenAI-compatible), wizard step, spend cap, usage tracking.
- Local embeddings and semantic search with rank fusion.
- CAPCOM with read tools, server-side scoping, citations, step display.

**Done when:** the app still works without an AI provider, a configured provider respects budget and exclusions, CAPCOM returns only permitted cited results, and tool/permission tests pass in CI.

## M7: Extraction, Needs you, Promises

- Tier 1 rules and bulk detection. Tier 2 extraction with the schema and code-enforced rules from AI.md.
- Review tray. Needs you. Promises. Prompt fixture tests.

**Done when:** direction rules reject incoming commitment/completion claims, extracted tasks enter review before creation, evidence spans validate, and prompt/hostile-content fixtures pass.

## M8: Tasks

- Tasks, tags with parents, filters, recurrence, week board with dnd-kit and meeting load.
- Auto-completion matcher, Recently auto-cleared with undo, task event log.

**Done when:** completion defaults to suggest, opt-in auto needs verified user-originated evidence, undo restores the prior state, and invitations cannot close tasks. Unit and UI tests cover all modes.

## M9: Briefings and Flight Plan

- Meeting briefs and Up next. Daily briefing. Plan my day.
- CAPCOM proposal tools.

**Done when:** briefs and Flight Plans cite permitted sources, proposed time blocks make no provider changes until user action, and scheduling/permission UI tests pass.

## M10: Slack and Teams

- Slack internal app via manifest, Socket Mode, indexed and live modes.
- Teams chats and channels via Graph.

**Done when:** permission checks explain real access, Slack live mode persists no long-term content, indexed mode respects policy, and provider fixture tests plus CI smoke flows pass.

## M11: v1.0.0 polish

- Light and dark mode polish, accessibility pass (keyboard, screen reader, contrast), mobile layout.
- Blackout, notifications.
- Backup and restore docs tested end to end. Security review against SECURITY.md.
- Public README screenshots using fake data.

**Done when:** accessibility and security gates pass, backup and restore is exercised on disposable CI data, release docs match the built app, and the v1.0.0 tag is ready for review.
