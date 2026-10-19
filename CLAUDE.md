# CLAUDE.md

Instructions for Claude Code working in this repo.

## Start here

1. Read `README.md`, then every file in `docs/`, then open `design/wireframe.html` in a browser.
2. Check `docs/ROADMAP.md` for the current milestone. Work on one milestone at a time, in order.
3. If `LOCAL.md` exists, read it. It holds instance-specific details (hostnames, accounts) and is never committed.

## What we're building

A self-hosted, single-user mission control: mail, calendars, Slack, and Teams grouped into Orbits, with an AI layer that reads, extracts, and proposes. The docs are the spec. Resolve routine implementation details within the spec and record consequential decisions; raise true product ambiguities.

## Non-negotiables

These come from the spec. Do not work around them, even if it seems faster.

1. **External actions require a user action.** No code path from `packages/ai` to connector `send` or `applyChange`. AI output becomes proposals. Internal task completion may run only for a condition the user explicitly enables, with evidence, audit history, and undo. The default is suggest only. See `docs/TASKS.md`.
2. **Direction rules.** Incoming items can't create commitments or complete tasks. Enforced in code after schema validation. See `docs/AI.md`.
3. **Scope and privacy are enforced server-side.** Apply the most restrictive policy across every Orbit containing an item before indexing, embedding, extraction, retrieval, or generation. On a rule change, invalidate restricted derived data. See `docs/SECURITY.md`.
4. **Untrusted content.** Every message, attachment, and event description is hostile until proven otherwise. Sanitize HTML with DOMPurify, render in a sandboxed iframe, proxy images through go-camo, parse MIME in a process with enforced resource limits.
5. **Secrets.** Reversible provider credentials are encrypted at rest with the master key. Login passwords are one-way hashed. Never log secrets. `.env` contains only the deployment values in `.env.example`.
6. **No shared OAuth apps.** Users bring their own Google, Microsoft, and Slack apps.
7. **Colors only from tokens.** No hex values outside the token file. Components use Material 3 role names (see `docs/DESIGN.md`).
8. **Product name only from `PRODUCT_NAME`** in `packages/shared/src/constants.ts`.
9. **Works without AI.** Every feature that isn't inherently AI must work with no provider configured.

## Conventions

- TypeScript strict mode everywhere. No `any` without a comment explaining why.
- zod schemas in `packages/shared` for every API payload and every AI output. Types are inferred from schemas.
- Drizzle for all database access. Migrations are generated and committed, never edited after merge.
- One connector per folder in `packages/connectors`, all implementing the same interface.
- Prompts in `packages/ai/prompts/`, versioned, each with fixture tests.
- Prefer maintained upstream libraries and official SDKs over custom implementations. Check the current official documentation, repository, release status, and license before adding one; pin it and record its provenance in `THIRD_PARTY.md`.
- Copied third-party code keeps its original header and gets a row in `THIRD_PARTY.md`.
- Record significant decisions in `docs/decisions/`.

## Testing

- Vitest for units. Connectors are tested against recorded provider responses (fixtures), never live accounts in CI.
- A library of hostile sample emails (script tags, CSS tricks, tracking pixels, malformed MIME, huge attachments) must pass the sanitizer and parser tests.
- Playwright for end-to-end flows, run in both light and dark mode.
- Each milestone's definition of done in `docs/ROADMAP.md` must be met with tests, not just manual checks.

## Writing

Applies to UI copy, docs, commit messages, and code comments.

- Plain, direct language. Sentence case. No filler.
- No em dashes.
- Theme words (Mission Control, Orbit, CAPCOM, Flight Plan, Blackout) in names and headings only. Buttons say what they do.
- Error messages say what happened and how to fix it.
- Repo content uses fake data and example.com addresses only. Never real accounts, people, or companies.

## Workflow

- Small commits with clear messages, grouped by milestone.
- Run lint, typecheck, and tests before every commit.
- When a spec doc turns out to be wrong or incomplete, propose the change to the doc in the same PR as the code, and flag it in the summary.
- At the end of each milestone, update `docs/ROADMAP.md` with status and anything deferred.
- Follow `AGENTS.md` for the Astra/Sol build and review handoff.
