# Third-party code

Station is AGPL-3.0. It plans to use maintained upstream packages instead of implementing provider protocols from scratch. Every dependency's license must be compatible with AGPL-3.0. Check the actual package version and license text before adoption; this table is a candidate list, not a completed legal review.

For every adopted dependency, record package/version, official repository URL, license and verification date, and the feature using it. Pin versions in the committed lockfile. Prefer provider-maintained SDKs, libraries with active maintenance and security response, and official documentation. Re-evaluate packages whose licenses, APIs, or maintenance status change. Keep custom glue narrow.

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
| React, Vite, Fastify, Drizzle, pg-boss, zod | Core stack | MIT |

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
