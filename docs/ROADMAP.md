# Roadmap to v1.0.0

> **Status:** approved baseline for build. Revisit decisions when provider evidence or implementation reveals a conflict.

Each milestone ends with a working, tested app. Keep milestones small enough to finish, test, and demo one at a time. Do not start a milestone until the previous one meets its definition of done.

For every bounded implementation task, Astra assigns scope and acceptance criteria to a Sol agent, reviews the result, requests fixes, and accepts it before another task begins. See `AGENTS.md`. Agent-dev has no Docker. GitHub Actions Ubuntu runners perform Compose integration and Playwright end-to-end gates; the production Docker VM is not a test environment. The orchestrator may run local checks available before CI exists, but must not claim an unavailable gate passed.

## M0: Foundations

Each substep ends with Astra review and fixes before the next begins:

1. **Scaffold and CI.** pnpm monorepo, strict TypeScript, shared schemas, pinned lockfile, unit-test harness, license and stray-color gates, GitHub Actions Ubuntu jobs. Record upstream repository and license provenance.
2. **Database and runtime.** Postgres/pgvector, migrations, queue, Compose services and health checks, config validation, durable migration strategy. Test fresh boot and restart on the CI runner.
3. **Theme and shell.** Material Color Utilities tokens, light/dark/system modes, wallpaper upload, local fonts/icons, shell with fake data matching the wireframe. Test contrast, reduced motion, and responsive layouts.
4. **Authentication.** One-time owner bootstrap, passkey or Argon2id password plus TOTP, recovery codes, sessions, CSRF, rate limiting. Test setup replay and unauthorized access.
5. **Integrated acceptance.** Full fresh-clone Compose startup, Playwright smoke in both themes, lint, typecheck, unit/fixture tests, license and CSS token gates. Record decisions for evaluated choices.

**Done when:** GitHub Actions brings up a fresh clone with one documented command, authentication protects the shell, the shell matches the reference layout with readable dark/light text, and every M0 gate is green.

## M1: Gmail and the mail view

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
