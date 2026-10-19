# 0001: Foundation scaffold boundaries

## Context

M0.1 needs a runnable and testable package layout before database, authentication, and the designed shell exist.

## Options

- Add the complete runtime stack now.
- Add only workspace structure, a health API, a minimal page, and checks.

## Decision

Use pnpm workspaces with project references and exact dependency versions. The API has one zod-backed `/health` response. The web page only proves React/Vite and token-based light/dark rendering. The worker announces that no jobs are registered. Database, queue, auth, and Material theme generation remain in their scheduled M0 steps.

## Consequences

The scaffold can validate package boundaries in CI without implying the product is ready for deployment. The small initial dependency set keeps license review focused. `tsc -b` emits to each package's ignored `dist/` directory.
