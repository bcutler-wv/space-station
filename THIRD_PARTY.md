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
| @fastify/sse 0.6.1 | https://github.com/fastify/sse/tree/v0.6.1 | MIT | `ae49e82bc998` | Authenticated sync event stream; tagged release API and license inspected 2026-10-20 |
| zod 4.6.7 | https://github.com/colinhacks/zod | MIT | `3f1189b28e38` | Shared response, browser URL, and worker cursor schemas |
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

## Historical M2 engine foundation (retired from current Compose)

On 2026-10-21, verified the official Community release v1.55.0, its tagged MIT license and distinct Enterprise assets, the official Docker Hub Community image and immutable multi-platform index digest, and a checksum-verified Community Linux amd64 binary running with telemetry disabled. The exact SDK 0.62.0 npm tarball, installed MIT license, Node compatibility, named `Meilisearch` export and fixture APIs were inspected and exercised against that binary. The former lockfile pinned the SDK, and the historical image digest pinned the container. No source or index data is copied from upstream.

| Package/image version | Upstream repository | License and integrity evidence | Use |
|---|---|---|---|
| getmeili/meilisearch CE v1.55.0 | https://github.com/meilisearch/meilisearch/tree/v1.55.0 | MIT [tagged license](https://github.com/meilisearch/meilisearch/blob/v1.55.0/LICENSE-MIT); Docker Hub image index `sha256:ff546679970126f8822e15d1b6a06bfbff1f2ce2e43f810cfb5258012f92de5c`; official Linux amd64 Community binary SHA-256 `7e33f5889235f14290074a19a6d3574bd9b10fb2ee8731eabb7dafd0714b0513` | Historical fake engine proof; no live ingestion was enabled |
| meilisearch JS SDK 0.62.0 | https://github.com/meilisearch/meilisearch-js/tree/v0.62.0 | MIT installed LICENSE SHA-256 prefix `f38718a82ebe`; npm tarball SHA-512 `fc44c35bb9a6588d8d7129ad25d4cf85b8ec21bb3755cb9aa6ccd7e57e8985d1c1d176ecccf3a1a9ddc40766c4ca52f41caedd83087fe19dcc772bb271655fe4` | Historical bounded transport/bootstrap and fake engine fixture; no longer installed by current lock |

## M2 OpenSearch comparison and private runtime candidate

The official `@opensearch-project/opensearch` 3.9.0 client is pinned both as a
`@station/search` runtime dependency and as a root dev dependency for the
independent manual fake-data proof. The private mTLS runtime is pending Ubuntu
acceptance; no live consumer uses it. Its published Apache-2.0
`LICENSE.txt` SHA-256 is
`43070e2d4e532684de521b885f385d0841030efa2b1a20bafb76133a5e1379c1`;
the committed pnpm lock pins npm integrity
`sha512-ksIEi0wyIjVncfRwaxt5v6H4qL1aQO2eE3MxKyXGCLnR70YTSCDp+JGhdx2LpyMjtCFvr71DWtYQg9SK3pcNnA==`.
The [official client release](https://github.com/opensearch-project/opensearch-js/releases/tag/3.9.0)
and [tagged license](https://raw.githubusercontent.com/opensearch-project/opensearch-js/3.9.0/LICENSE.txt)
were checked on 2026-10-21.

`packages/search/src/opensearch-static-action-groups.ts` is a narrow
projection of the pinned Security plugin's [3.9.0.0 static action-group
data](https://github.com/opensearch-project/security/blob/3.9.0.0/src/main/resources/static_config/static_action_groups.yml)
under Apache-2.0. The source YAML SHA-256 is
`0e0b87756f49cb31eaa1adb435da900335832bd77e9037753d241c6c8f9d8a54`.
The tagged repository's `LICENSE.txt` and `NOTICE.txt` are retained at
`packages/search/vendor/opensearch-security-LICENSE` and
`packages/search/vendor/opensearch-security-NOTICE` (SHA-256
`c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`
and `2dc932397aef59f151b238e35ae9e94ecd0b5f1567e088d8317cba6b10eab806`).
It lets retained-security verification reject any custom action group,
including a group shadowing a literal role action. No plugin code is copied.

The manual proof and optional private Compose profile pin the official OpenSearch 3.9.0 Linux image index
`sha256:adfa61f85025d06b4aeb562e7e74fde7e31c437039c93c3862c17e9acebd6c7c`.
Its [tagged release](https://github.com/opensearch-project/OpenSearch/releases/tag/3.9.0)
and [Apache-2.0 license](https://raw.githubusercontent.com/opensearch-project/OpenSearch/3.9.0/LICENSE.txt)
were checked on 2026-10-21. The pinned image passed the manual fake-data
Ubuntu proof `39667416208` within its stated resource budget, and OpenSearch
is selected as the intended future lexical engine. The private-runtime
candidate is still awaiting actual Ubuntu isolation, security and retention
validation. No image is pulled on agent-dev, and there is no live search
consumer yet.

## Planned dependencies

| Package | Use | License (verify when adding) |
|---|---|---|
| imapflow | IMAP client | MIT |
| postal-mime | MIME parsing | MIT-0 |
| Nodemailer | Bounded RFC 822 composition for Gmail send; SMTP later | MIT-0 |
| googleapis | Gmail and Calendar APIs | Apache-2.0 |
| @azure/msal-node, @microsoft/microsoft-graph-client | Microsoft Graph | MIT |
| @slack/bolt, @slack/web-api | Slack | MIT |
| tsdav | CalDAV | MIT |
| go-camo | Image proxy (container) | MIT |
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
| `packages/search/src/generated-parser.js`, `generated-parser.d.ts`, and `vendor/peggy-LICENSE` | https://github.com/peggyjs/peggy | v5.1.0 tag | MIT; generated from Station's own grammar using pinned Peggy, with the upstream generated-code header and full license retained |

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

## Adopted in M1.2a

On 2026-10-19, checked the current package releases, installed TypeScript APIs, package manifests, and official upstream source/documentation. The exact versions below are pinned in `pnpm-lock.yaml`. Both declare Apache-2.0; the auth package includes a LICENSE file, while the Gmail API package omits one from its tarball but its upstream repository carries Apache-2.0. No provider source was copied. `google-auth-library-nodejs` is archived because its source moved into the Google Node repositories; the npm package remains published and documented.

| Package/version | Upstream repository | License evidence | Use |
|---|---|---|---|
| google-auth-library 11.3.1 | https://github.com/googleapis/google-cloud-node/tree/main/core/packages/google-auth-library-nodejs | Apache-2.0; installed LICENSE SHA-256 prefix `cfc7749b96f6` | OAuth2Client web flow, official PKCE S256, token exchange and refresh. Refresh event and returned-token behavior checked against current upstream and installed source on 2026-10-20. |
| @googleapis/gmail 22.0.2 | https://github.com/googleapis/google-api-nodejs-client | Apache-2.0; installed manifest and upstream LICENSE, no bundled LICENSE | Gmail profile identity, bounded read pages, filtered reply metadata and explicit message-label changes |

For M1.3d on 2026-10-20, checked installed `gaxios` 8.3.1 source against https://github.com/googleapis/google-cloud-node/tree/main/core/packages/gaxios and its Apache-2.0 LICENSE (`cfc7749b96f6`). It is pinned transitively by the Google SDK in `pnpm-lock.yaml`. Its `maxContentLength` checks a response header before parsing but does not enforce a body byte limit for every fetch response, so the read adapter caps the stream in its fetch transport. The installed SDK path and Gmail REST methods were verified with fixture requests. `zod` 4.6.7, previously adopted in M0.1, remains a direct connector dependency for typed validation; provider response schemas live in `@station/shared`.

The Google SDK dependency tree includes `url-template` 2.0.8 from https://github.com/bramstein/url-template. Its npm manifest says `BSD` without a precise SPDX identifier; the installed LICENSE has the three-clause BSD text (SHA-256 prefix `70723b90e3f2`). The license gate allows only this exact package/version as a reviewed exception.

## Adopted in M1.3a

On 2026-10-20, checked the published PostalMime 4.0.11 package, its TypeScript options (`maxNestingDepth`, `maxHeadersSize`, `maxPartCount`, `maxRfc822NestingDepth`, `maxForwardedAddresses`), package manifest, and bundled license. Its upstream is https://github.com/postalsys/postal-mime; the license is MIT-0 (bundled `LICENSE.txt` SHA-256 prefix `831ad54932cb`). The exact version is pinned in `pnpm-lock.yaml` and has an exact exception in the license gate. No upstream source was copied.

The legacy reply repair reuses that pinned PostalMime address parser in the server for the small, filtered From and Reply-To header values. The installed `addressParser` export was checked on 2026-10-20; no new upstream package or copied parser was added.

## Adopted in M1.3b

On 2026-10-20, checked the upstream DOMPurify and jsdom repositories, current package manifests and server usage guidance, published Node engine range, and installed license texts. DOMPurify recommends a current jsdom because old DOM implementations have had sanitizer bypasses. jsdom 30.1.3 supports Node 22.23.2. Exact versions are pinned in `pnpm-lock.yaml`; no upstream source was copied.

| Package/version | Upstream repository | License evidence | Use |
|---|---|---|---|
| dompurify 3.4.17 | https://github.com/cure53/DOMPurify | Apache-2.0 OR MPL-2.0; installed LICENSE SHA-256 prefix `cfc7749b96f6` | Conservative mail HTML sanitizer in the parser child and browser reader |
| jsdom 30.1.3 | https://github.com/jsdom/jsdom | MIT; installed LICENSE.txt SHA-256 prefix `242d37e7cab2` | DOM for server sanitation without scripts or resource loading |
| @types/jsdom 27.0.0 | https://github.com/DefinitelyTyped/DefinitelyTyped | MIT; installed LICENSE SHA-256 prefix `c2cfccb812fe` | Strict TypeScript types |
| @csstools/color-helpers 6.1.2, @csstools/css-syntax-patches-for-csstree 1.1.15 | https://github.com/csstools/postcss-plugins | MIT-0; both installed LICENSE.md SHA-256 prefix `947e32047a16` | jsdom transitives, exact version exceptions in the license gate |

## Adopted for the M1 mail image backend

Checked the tagged [go-camo v2.7.7 source and documentation](https://github.com/cactus/go-camo/tree/v2.7.7) and [tagged MIT license](https://github.com/cactus/go-camo/blob/v2.7.7/LICENSE.md) on 2026-10-20. Compose pins the GHCR OCI index `ghcr.io/cactus/go-camo:v2.7.7@sha256:5a62e8af42cee15fd47b486d4e4df3ecfed3c7fc0e9e4c625f3816ba17c65677`; the public registry manifest lists Linux amd64 `sha256:f466baec043cf973af9f5ddef31f5ec4ba981e98aa527528a92146787d934894` and Linux arm64 `sha256:1f5f75d685d97f2754a3af9ba622fd7704680ce6035abdeeaf40385ff305cca0`. The amd64 OCI image config declares `/bin/go-camo` as its entrypoint and `nobody` as its default user; Compose overrides the user with the configured non-root UID/GID. The upstream README describes HMAC-SHA1 hex URLs, the response-size limit in KiB, request timeout, redirect cap, and proxy environment variables. Tagged source confirms IP filtering at the actual dial and that zero redirects disables following. The maintained container is upstream-built but upstream calls it untested; Station's Ubuntu Compose fixture is required before acceptance. No source was copied.

The already pinned [sharp 0.35.5](https://github.com/lovell/sharp) processes permitted raster input into stripped PNG output with `limitInputPixels`; its official [constructor](https://sharp.pixelplumbing.com/api-constructor/), [input metadata](https://sharp.pixelplumbing.com/api-input/) and [output](https://sharp.pixelplumbing.com/api-output/) documentation were checked on 2026-10-20. AVIF is reported as HEIF with AV1 compression and `image/avif` media type, all three of which the adapter checks. The documented Sharp timeout begins when libvips opens an input, not during native-thread queue wait. Its bundled license remains as recorded for the existing dependency.

## Adopted for M1 Gmail send

Checked [Nodemailer MailComposer's documented stream and `keepBcc` API](https://nodemailer.com/extras/mailcomposer), [Gmail's raw send endpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), and the installed Nodemailer 10.1.7 ESM exports/types on 2026-10-20. The upstream repository is [nodemailer/nodemailer](https://github.com/nodemailer/nodemailer); the exact package is pinned in `pnpm-lock.yaml`. Its package manifest reports MIT-0 and bundled `LICENSE` SHA-256 is `4f814dcacd2da618d62829ea1f6238701cf421f18a6b36c91c5d8212245e2c78`. The exact MIT-0 license-gate exception is recorded. The installed package is newer than the [jsonTransport path-access advisory's patched 8.0.9](https://github.com/nodemailer/nodemailer/security/advisories/GHSA-wqvq-jvpq-h66f); this implementation uses direct MailComposer with only owned buffers, not jsonTransport. `pnpm audit --prod --audit-level high` reported no vulnerabilities at verification. No upstream source was copied.

## Adopted for the M2 operator parser

On 2026-10-21, verified [Peggy 5.1.0's tagged package manifest](https://github.com/peggyjs/peggy/blob/v5.1.0/package.json), [tagged MIT license](https://github.com/peggyjs/peggy/blob/v5.1.0/LICENSE), [official CLI and type-generation documentation](https://peggyjs.org/documentation.html), and the installed package. The manifest requires Node >=20 and supports `--format es`, `--dts` and named rule return types; the installed `LICENSE` SHA-256 is `f7225e298740519666c3e35f58d2e5be3cd940b6b2ce2f9b4d1b7a6194568d9a`. The exact npm tarball integrity is recorded in `pnpm-lock.yaml` (`sha512-IEo5aYRZ...`). Peggy is a build-only dependency of `@station/search`; no grammar is generated at runtime. The checked-in generated ESM parser and declaration are reproducible with `pnpm --filter @station/search generate:parser`, verified by `check:parser`, and accompanied by the full installed MIT notice in `packages/search/vendor/peggy-LICENSE`. The grammar is Station-authored; no upstream example grammar was copied.
