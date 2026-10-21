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

M1.1 was accepted with local checks and Ubuntu CI runtime gates on 2026-10-19 (commit `9d8a482`, run `39354841946`). M1.2a backend and fixture work was Astra-reviewed and accepted after Ubuntu CI run `39357352441` passed (commit `e64add3`). M1.2b guided setup and browser continuation were accepted after Ubuntu CI run `39360383613` passed (commit `e13effa`); continuation and connected screens were visually checked in light/dark and desktop/mobile captures. M1.3a isolated MIME parsing was accepted after Ubuntu CI run `39466415976` passed (commit `fcb06c4`). M1.3b ingestion HTML sanitation was accepted after Ubuntu CI run `39471963090` passed its mixed-cgroup parser gate and browser jobs (commit `0bda48b`). The unchanged parser gate later timed out on run `39474165355`; the reviewed one-core capacity correction passed three consecutive mixed workload pairs in Ubuntu CI run `39476144537` (commit `357bb4f`). M1.3c credential refresh and reconnect backend and UI were accepted in that same run, including migration, PostgreSQL concurrency/recovery fixtures and HTTPS browser gates; Gmail sync, reader re-sanitation, image proxying, and mail reading remain pending.

The private file store was accepted after Ubuntu CI run `39477808140` (commit `8f33cb5`). Normalized mail persistence and its generated migration were accepted after Ubuntu CI run `39480965786` (commit `21c2997`), including PostgreSQL page replay, concurrency, crash cleanup and privacy fixtures. The bounded Gmail read adapter and rejected-token recovery were accepted after Ubuntu CI run `39483819868` (commit `964edae`). No Gmail polling or mail reading is enabled by these foundations.

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

M1.3e durable Gmail ingestion was accepted for version 0.17.0 after Astra review and Ubuntu CI run `39499651586` (commit `fcca80f`). Review corrected job cancellation and the terminal list-page crash boundary. See [the ingestion record](sessions/gmail-sync-runner.md). Progress events and mail reading remain separate pending tasks.

M1 sync-progress REST and durable SSE backend were accepted for version 0.18.0 after Astra review and Ubuntu CI run `39504035570` (commit `1358c84`). Replay uses a consistent snapshot and commit-ordered journal; passive reads preserve idle expiry, and stream authorization and database waits are bounded. See [the event backend record](sessions/sync-events-backend.md). Browser progress presentation remains pending.

M1 sync-progress presentation is implemented and Astra-reviewed for version 0.19.0, with integration acceptance in Ubuntu run `39511814998`. One authenticated stream updates bounded private progress reads without extending idle expiry. Review corrected stale request reuse across reconnect and bounded request deadlines. See [the progress UI record](sessions/sync-progress-ui.md). Mail reading is the next task.

The private mail-reader backend is implemented and Astra-reviewed for version 0.20.0, with integration acceptance in Ubuntu run `39511814998`. It covers bounded owner-only account/Orbit conversations, labels, literal subject search, message metadata, separate bodies and attachment downloads. The browser mail view, HTML re-sanitation, remote-image proxy and provider actions remain pending. See [the reader backend record](sessions/mail-reader-backend.md).

Progress UI run `39508369068` passed the scaffold, Compose database fixtures and dedicated Google browser flow, but failed the final runtime authenticator-replay test (first login returned 403). That failed run is superseded by the green repair run `39511814998`.

Version 0.20.1 corrects exhausted rate-limit responses to HTTP 429 and separates runtime authentication/browser test traffic into fresh request windows. Astra accepted the repair without changing the 120/minute API or five/minute login limits. The original CI 403 chain remains inferred. The reader PostgreSQL 16 fixture passed in run `39510364104`. Full Ubuntu run `39511814998` passed at commit `948a4aa`, accepting the progress UI, private reader backend and rate-limit repair, including Compose integration and browser gates. Safe body display and the mail browser interface remain pending.

The authenticated image backend is implemented and Astra-reviewed for version 0.21.0. It provides scoped CID loading, explicit remote consent and claimed-sender preferences, bounded raster normalization, and a pinned isolated go-camo service. Review corrected database deadlines, AVIF decoding, aggregate failure accounting, exact placeholder sets and fixture isolation. The actual Ubuntu proxy runtime gate is pending. The reusable browser body component is next.

The reusable safe message body is implemented for version 0.22.0 with render-time sanitization, sandbox isolation, explicit image controls, scoped cancellation and a dedicated Strict Mode regression gate. Source review corrected logout/mutation races and development effect replay. The per-message consent override is an intentional product clarification. Full Ubuntu integration acceptance is pending. See [the body component record](sessions/mail-body-component.md). Full mail navigation follows.

The image backend/runtime and gate repair were accepted after full Ubuntu run `39516183186` passed at commit `4317f22` (0.21.1), including the actual pinned proxy container, PostgreSQL 16 HTTP fixtures and browser gates.

The reusable safe body, consent override and preview-isolation repair were accepted after full Ubuntu run `39518772561` passed at `8a3008c` (0.22.1), including production and development browser gates and PostgreSQL 16/Compose integration. Mail navigation remains in source review.

Live mail navigation is implemented and Astra-reviewed for version 0.23.0: scoped account/Orbit conversations, labels, subject search, lazy thread bodies/attachments, pagination, keyboard navigation and manual event refresh. Review corrected invalid URL scope fallback and mobile entry. Full Ubuntu acceptance is pending. See [the navigation record](sessions/mail-navigation.md). Durable local drafts and reply context are next.

Live mail navigation was accepted after full Ubuntu run `39520638316` passed at `8de0232` (0.23.0). Reading, scoped subject search, labels and keyboard/mobile navigation are integrated; local drafts, compose/provider actions and M1 integrated acceptance remain.

The local draft backend is implemented and Astra-reviewed for version 0.24.0, pending Ubuntu integration. It provides creation replay, revision conflicts, bounded metadata listing, durable edits/discard and conservative reply context. Review corrected recipient ambiguity after invalid identity filtering. See [the draft record](sessions/local-draft-backend.md). Legacy reply metadata repair, draft attachment lifecycle, compose and provider actions remain required before M1 acceptance.

Legacy reply metadata repair is implemented and Astra-reviewed for version 0.25.0, pending Ubuntu integration. It uses a bounded official Gmail read and a separate syntax-validated snapshot without changing identity or privacy evidence. Review corrected malformed mailbox extraction and corrupt snapshot validation. See [the repair record](sessions/reply-metadata-repair.md). Draft attachment storage is next.

The local draft backend was accepted after full Ubuntu run `39522612572` passed at `9203432` (0.24.0), including PostgreSQL 16/Compose and browser gates. The 0.25.0 legacy reply repair is separately awaiting its integration run.

Draft attachment storage is implemented and Astra-reviewed for version 0.26.0, pending Ubuntu integration. Dedicated intents, scoped revision-checked endpoints and worker cleanup cover bounded upload and owned file retention. Review corrected Unicode limits and verified concurrent publication/autosave cleanup. See [the attachment record](sessions/draft-attachments.md). Durable send and reconciliation are next.

Legacy reply metadata repair was accepted after full Ubuntu run `39524137665` passed at `f4aaa3d` (0.25.0), including PostgreSQL 16/Compose and browser gates. Attachment integration is separately pending.

Attachment run `39525762004` failed during fixture directory creation, before attachment assertions. Version 0.26.1 makes repo-local artifact creation conditional when CI supplies a writable volume root; Astra accepted the narrow fix after explicit-root/read-only-cwd and default-root checks. Full integration remains pending.

Durable Gmail send and reconciliation are implemented and Astra-reviewed for version 0.27.0, pending Ubuntu integration. Frozen MIME and a durable one-attempt claim prevent automatic resend after unknown outcomes. Independent review corrected credential database deadlines and verified provider evidence and crash recovery. See [the send record](sessions/gmail-send-backend.md). Compose UI and unresolved-send discovery are next.

Draft attachment storage and its fixture repair were accepted after full Ubuntu run `39526973691` passed at `8de3f30` (0.26.1), including PostgreSQL 16 migration, configured private-volume permissions, HTTP/filesystem assertions and browser gates. Send integration is separately pending.

Durable Gmail send and reconciliation were accepted after full Ubuntu run `39528557367` passed at `a99f6b8` (0.27.0), including PostgreSQL 16/Compose send, recovery and reconciliation fixtures and browser gates. Compose UI, provider-action controls and integrated M1 acceptance remain.

Compose and reply UI are implemented and Astra-reviewed for version 0.28.0, pending Ubuntu integration. Server drafts, owned attachments, explicit send, current-attempt recovery and bounded unresolved-send discovery are integrated into Mail. Independent review corrected reconnect data loss, failed-send attachment visibility and out-of-order status responses. See [the compose record](sessions/mail-compose-ui.md). Explicit archive/read/label actions and final M1 acceptance remain.

Compose and reply were accepted after full Ubuntu run `39549194471` passed at `b2fae8e` (0.28.0), including production/development browser gates and PostgreSQL 16/Compose integration. Explicit message actions and the integrated M1 acceptance journey remain.

Explicit Gmail message changes are implemented and Astra-reviewed for version 0.29.0, pending Ubuntu integration. One-message archive/read/unread/user-label actions have durable one-attempt claims, exact-key recovery and read-only reconciliation. Review corrected cross-sequence concurrency and scope checks around reconciliation. See [the message-change record](sessions/mail-change-backend.md). Authoritative action metadata, browser controls and integrated M1 acceptance remain.

Read-only mail action options are implemented and Astra-reviewed for version 0.30.0, pending Ubuntu integration. Current provider label type/name and canonical read/Inbox state drive safe presentation; original operation scope supports recovery from another Orbit. Independent review verified handler limits through cancellation and settlement. See [the options record](sessions/mail-action-options.md). Browser message controls are next.

Durable Gmail message changes were accepted after full Ubuntu run `39613863788` passed at `4da9634` (0.29.0), including PostgreSQL 16/Compose migration, authenticated action/recovery fixtures and browser gates. Action-options integration, browser controls and final M1 acceptance remain.

Read-only mail action options were accepted after full Ubuntu run `39616109952` passed at `3e07722` (0.30.0), including PostgreSQL 16/Compose options fixtures and browser gates. Browser message controls remain in review; label-catalog repair, process-restart recovery and integrated M1 acceptance follow.

Message action controls and pending-change recovery are implemented and Astra-reviewed for version 0.31.0, pending Ubuntu integration. Review corrected exact Orbit filtering, stale recovery guidance, message context and confirmation wording. Independent browser and PostgreSQL fixtures passed. See [the controls record](sessions/mail-message-controls.md). Complete label-catalog persistence, process-restart fixtures and integrated M1 acceptance follow.
