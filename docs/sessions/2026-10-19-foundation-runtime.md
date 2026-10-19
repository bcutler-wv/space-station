# Foundation runtime

Sol implemented the M0.2 runtime and Astra reviewed it. The app serves the built client, PostgreSQL provides settings storage and pgvector, Drizzle owns generated migrations, and pg-boss runs the initial probe queue. A one-shot migrator serializes schema changes with an advisory lock before app and worker start.

Review fixes corrected private `.env` setup instructions, documented rebuilding local images for updates, and made worker health verify both live registration and fresh probe completion. Runtime configuration rejects invalid values without logging secrets. The local init command writes a private `.env` and never overwrites it.

Local lint, typecheck, build, license/color checks, six unit tests, and two browser smoke tests passed. The Docker CI test covers boot, built assets, migration idempotency, and queued work surviving worker/database restarts. Docker is unavailable on the development host; the initial remote run is required before runtime acceptance.

Search, OCR, images, and embedding containers remain for the milestones that use them. Authentication and the full shell remain for M0.3/M0.4. Nothing has been deployed to production or connected to real accounts. The audit reports one moderate transitive development-tool advisory, recorded with dependency provenance.

The first Docker CI run built all images and brought PostgreSQL, the app, and worker to healthy state. The test then failed because the runner did not include `rg`. Sol replaced those test-script calls with standard `grep`/`sed`, added safe phase diagnostics, and Astra approved the correction for rerun.
