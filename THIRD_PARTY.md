# Third-party code

Station is AGPL-3.0. It plans to use maintained upstream packages instead of implementing provider protocols from scratch. Every dependency's license must be compatible with AGPL-3.0. Check the actual package version and license text before adoption; this table is a candidate list, not a completed legal review.

For every adopted dependency, record package/version, official repository URL, license and verification date, and the feature using it. Pin versions in the committed lockfile. Prefer provider-maintained SDKs, libraries with active maintenance and security response, and official documentation. Re-evaluate packages whose licenses, APIs, or maintenance status change. Keep custom glue narrow.

## Adopted in M0.1

On 2026-10-19, we checked each pinned package's installed `LICENSE` or `LICENSE.md`/`LICENSE.txt` text, confirmed its MIT permission grant or Apache-2.0 heading, and opened the corresponding upstream source repository. The hash column is the first 12 hexadecimal characters of the installed license file's SHA-256 digest, to make the exact text reviewed identifiable. Package versions, Node requirements, and peer ranges were also checked against npm metadata. The lockfile pins transitive versions. `pnpm check:licenses` scans the installed dependency tree; its reviewed license set is in `scripts/check-licenses.mjs`.

| Package/version | Upstream repository | License | License file hash | Use |
|---|---|---|---|---|
| pnpm 10.34.7 | https://github.com/pnpm/pnpm | MIT | `e0a867ff513e` | Workspace package manager |
| TypeScript 5.9.3 | https://github.com/microsoft/TypeScript | Apache-2.0 | `a7d00bfd5452` | Strict typecheck; 8.72.0 typescript-eslint supports TypeScript below 6.1 |
| ESLint 10.13.0, @eslint/js 10.0.1 | https://github.com/eslint/eslint | MIT | `3b6be04f862a` (both) | Lint |
| typescript-eslint 8.72.0 | https://github.com/typescript-eslint/typescript-eslint | MIT | `2eb5c7a0bba9` | TypeScript lint rules |
| React, React DOM 19.3.1 | https://github.com/react/react | MIT | `da6d3703ed11` (both) | Minimal web client |
| @types/react, @types/react-dom 19.3.0; @types/node 22.15.30 | https://github.com/DefinitelyTyped/DefinitelyTyped | MIT | `c2cfccb812fe` (all) | Type definitions |
| Vite 8.3.4 | https://github.com/vitejs/vite | MIT | `a47172e44a86` | Web build and preview |
| @vitejs/plugin-react 6.1.2 | https://github.com/vitejs/vite-plugin-react | MIT | `29b68325fe02` | React transform |
| Fastify 5.12.7 | https://github.com/fastify/fastify | MIT | `23c918638591` | API server and health check |
| zod 4.6.7 | https://github.com/colinhacks/zod | MIT | `3f1189b28e38` | Shared response schema |
| Vitest 5.0.5 | https://github.com/vitest-dev/vitest | MIT | `78fbac9e571c` | Unit test runner |
| @playwright/test 1.64.1 | https://github.com/microsoft/playwright | Apache-2.0 | `45873d00a0dd` | Browser smoke tests |
| spdx-expression-parse 5.0.0 | https://github.com/jslicense/spdx-expression-parse.js | MIT | `7edb57f70653` | License expression validation |

## Adopted in M0.2

Checked pinned package versions and repository links against npm metadata and opened the upstream repositories on 2026-10-19. Read the installed license texts where the package included them. Drizzle's published packages omit license files: the ORM package declares Apache-2.0, the Kit package declares MIT, and the upstream repository contains an Apache-2.0 LICENSE. Both declared licenses are compatible with this project, but the missing Kit license text in its tarball is a packaging gap to revisit before a public release. The images use exact version tags; registry queries returned HTTP 200 for both tags on 2026-10-19.

| Package/image version | Upstream repository | License evidence | Use |
|---|---|---|---|
| drizzle-orm 0.45.4 | https://github.com/drizzle-team/drizzle-orm | Apache-2.0; package manifest and upstream LICENSE, no bundled LICENSE | Database schema and migrator |
| drizzle-kit 0.31.11 | https://github.com/drizzle-team/drizzle-orm | MIT in package manifest; upstream root LICENSE is Apache-2.0; no bundled LICENSE | Generate migrations in development |
| pg 8.23.1 | https://github.com/brianc/node-postgres | MIT; installed LICENSE SHA-256 prefix `192b8f5c9690` | PostgreSQL driver |
| @types/pg 8.23.1 | https://github.com/DefinitelyTyped/DefinitelyTyped | MIT; installed LICENSE SHA-256 prefix `c2cfccb812fe` | Driver types |
| pg-boss 12.38.0 | https://github.com/timgit/pg-boss | MIT; installed LICENSE SHA-256 prefix `51ad77d65578` | Durable job queue |
| @fastify/static 10.1.6 | https://github.com/fastify/fastify-static | MIT; installed LICENSE SHA-256 prefix `ba9677e5a34c` | Built web assets |
| pgvector/pgvector:0.8.7-pg16-bookworm | https://github.com/pgvector/pgvector | PostgreSQL; upstream LICENSE | PostgreSQL 16 and vector extension |
| node:22.23.2-bookworm-slim | https://github.com/nodejs/docker-node | MIT for image build repo; Node and Debian component licenses also apply | Build and runtime base image |

## Planned dependencies

| Package | Use | License (verify when adding) |
|---|---|---|
| imapflow | IMAP client | MIT |
| postal-mime or mailparser | MIME parsing | MIT |
| Nodemailer | SMTP | MIT-0 or MIT |
| googleapis | Gmail and Calendar APIs | Apache-2.0 |
| @azure/msal-node, @microsoft/microsoft-graph-client | Microsoft Graph | MIT |
| @slack/bolt, @slack/web-api | Slack | MIT |
| tsdav | CalDAV | MIT |
| DOMPurify | HTML sanitizing | Apache-2.0 or MPL-2.0 |
| go-camo | Image proxy (container) | MIT |
| Meilisearch Community Edition | Lexical search (container) | MIT |
| pgvector | Vector search (Postgres extension) | PostgreSQL |
| Apache Tika, Tesseract | Attachment text and OCR (containers) | Apache-2.0 |
| @material/material-color-utilities | Theme generation | Apache-2.0 |
| dnd-kit | Drag and drop | MIT |
| rrule | Recurrence | BSD-3-Clause |
| React, Vite, Fastify, Drizzle, pg-boss, zod | Core stack | MIT or Apache-2.0 |

## References (ideas only, no code copied)

| Project | What we learn from it | License |
|---|---|---|
| Caelestia shell | Visual direction | GPL-3.0 |
| Inbox Zero | AI rule UX | AGPL-3.0 with additional terms. Do not copy code. |
| Thunderbird, Roundcube, Mailspring | Real-world email edge cases, threading | MPL-2.0, GPL-3.0 |

## Copied code

When code is copied from another project, keep its original header, add a row here with the source repo, path, commit, and license.

| File in this repo | Source | Commit | License |
|---|---|---|---|
| (none yet) | | | |

## Adopted in M0.3

Checked npm version and repository metadata, the installed license text where present, and the upstream repositories on 2026-10-19. The listed SHA-256 prefixes identify the installed LICENSE text. `@img/sharp-libvips-linux-x64` ships a native binary without a bundled license file; its npm manifest declares LGPL-3.0-or-later, while the packaging repository's root LICENSE is Apache-2.0 and the libvips project itself is LGPL-2.1-or-later. The license gate has an exact package/version exception for this binary and Rubik's OFL font rather than allowing those license families for arbitrary future packages. Preserve upstream notices and review native binary redistribution obligations before a public release.

| Package/version | Upstream repository | License evidence | Use |
|---|---|---|---|
| @material/material-color-utilities 0.3.0 | https://github.com/material-foundation/material-color-utilities | Apache-2.0, installed LICENSE `8ded460ad5b` | Quantization, scoring, tonal schemes, harmonized Orbit slots. 0.4.0 failed direct Node 22 ESM import due extensionless relative imports. |
| @fontsource/rubik 5.3.0 | https://github.com/fontsource/font-files and https://github.com/googlefonts/rubik | OFL-1.1, installed LICENSE `46a250495a96`; upstream Rubik OFL.txt | Locally served Rubik Latin fonts |
| material-symbols 0.48.0 | https://github.com/marella/material-symbols | Apache-2.0, installed LICENSE `cfc7749b96f6` | Locally served rounded icon font |
| @tanstack/react-query 5.104.5 | https://github.com/TanStack/query | MIT, installed LICENSE `a405ee70c632` | Appearance API cache and mutations |
| sharp 0.35.5 | https://github.com/lovell/sharp | Apache-2.0, installed LICENSE `73ba74dfaa52` | Bounded raster decode and WebP reencode |
| @img/sharp-libvips-linux-x64 1.3.4 | https://github.com/lovell/sharp-libvips and https://github.com/libvips/libvips | LGPL-3.0-or-later in installed package manifest; no bundled LICENSE; upstream packaging and libvips licenses reviewed | Native image processing binary on Ubuntu/Linux x64 |
| Prettier 3.9.10 | https://github.com/prettier/prettier | MIT, installed LICENSE `b0f241719988` | Reviewable source formatting |

## Adopted in M0.4

Checked pinned npm metadata, installed license text, and upstream documentation/repositories on 2026-10-19. The SHA-256 prefixes identify installed license files. These dependencies are pinned in `pnpm-lock.yaml`; the native `@node-rs/argon2` binding is provided by the same upstream project under MIT. `tslib` 1.14.1 and 2.8.1 entered transitively; both carry the 0BSD text with installed LICENSE SHA-256 prefix `210b19e54313`, reviewed against https://github.com/microsoft/tslib/blob/main/LICENSE.txt. The license gate allows only those exact 0BSD package/version pairs.

| Package/version | Upstream repository | License and installed license hash | Use |
|---|---|---|---|
| @fastify/cookie 11.1.3 | https://github.com/fastify/fastify-cookie | MIT `ba9677e5a34c` | Cookie parsing and serialization |
| @fastify/session 11.1.5 | https://github.com/fastify/session | MIT `169bc32eeedd` | Opaque rotating sessions with a PostgreSQL adapter storing SHA-256 IDs |
| @fastify/csrf-protection 8.0.2 | https://github.com/fastify/csrf-protection | MIT `5ad64d5d248e` | Per-session CSRF tokens |
| @fastify/rate-limit 11.2.1 | https://github.com/fastify/fastify-rate-limit | MIT `d24d2e5bdc50` | API and authentication rate limits; 11.2.1 includes the upstream IPv6 bypass fix |
| @simplewebauthn/server 14.0.3, @simplewebauthn/browser 14.0.0 | https://github.com/MasterKale/SimpleWebAuthn | MIT `bd9e3f456964` | WebAuthn registration and assertion verification |
| @node-rs/argon2 2.2.2 | https://github.com/napi-rs/node-rs | MIT `c748f2e7f93f` | Versioned Argon2id password hashing |
| otplib 13.5.0 | https://github.com/yeojz/otplib | MIT `e143fd4930d8` | TOTP enrollment, verification, and test fixture generation |

## Adopted in M1.1

Checked the current TanStack Router quickstart, upstream repository and release, and installed license text on 2026-10-19. The pinned package is `@tanstack/react-router` 1.170.41, MIT, from https://github.com/TanStack/router; its installed LICENSE SHA-256 prefix is `a405ee70c632`. It provides URL navigation and deep links. The router brings in `isbot` 5.2.2 from https://github.com/omrilotan/isbot. Its installed LICENSE is the Unlicense public-domain dedication; the license gate permits this exact package/version, rather than allowing the license family broadly. No upstream source code was copied.
