# Foundation scaffold

The reviewed specification is the baseline for a single-user communications client. External changes require explicit user action; internal task completion is opt-in with evidence and undo. Privacy uses the most restrictive applicable policy.

Sol implemented M0.1 and Astra reviewed it. The review required strict type checks for build configuration and browser tests, plus verification of actual dependency license texts and upstream repositories. Both fixes passed re-review.

The workspace now has a minimal Fastify health API, shared zod schema, React/Vite page, worker entry, and lint, type, unit, build, color, license, audit, and browser checks. Local checks passed, including two light/dark browser smoke tests. The GitHub Actions workflow runs these gates on push; Docker integration belongs to the next task and has not run locally.

Next: database and runtime, then theme/shell, authentication, and integrated M0 acceptance. No production deployment or real account connection has occurred. The prototype remains the layout reference; the current page only exercises the toolchain.
