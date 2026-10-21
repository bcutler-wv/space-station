# Search

Search has to be excellent. It runs in three layers that work together, plus CAPCOM for questions that need judgment.

## 1. Instant lexical search

- Meilisearch, updated by the worker as items arrive only when the effective policy across all matching Orbits permits indexing.
- Typo tolerance, prefix matching while typing, stemming, exact phrases in quotes.
- Results appear as the user types, target under 100 ms.
- Indexed fields: subject, body text, sender and recipient names and addresses, attachment filenames, attachment text, labels, Orbit, account, kind (email or chat).
- Sent mail is indexed with the same weight as received mail.

## 2. Operators

Gmail-compatible syntax, parsed into Meilisearch filters before the text query runs:

| Operator | Example |
|---|---|
| `from:` `to:` `cc:` | `from:dana`, `to:@example.com` |
| `subject:` | `subject:"rate sheet"` |
| `has:attachment` | |
| `filename:` | `filename:pdf`, `filename:invoice` |
| `label:` | `label:vendors` |
| `orbit:` | `orbit:glassworks` |
| `account:` | `account:work` |
| `in:` | `in:sent`, `in:inbox`, `in:chat` |
| `is:` | `is:unread`, `is:starred`, `is:needs-reply` |
| `before:` `after:` `older_than:` `newer_than:` | `after:2026/09/01`, `newer_than:7d` |
| `-` negation, `OR`, parentheses | `from:dana -label:archive` |

The M2 operator parser lives in `packages/search` with a generated, build-time Peggy grammar and bounded unit fixtures. It currently emits an engine-independent Boolean AST only; the live subject filter remains the active search UI. Parser success does not authorize scope, indexing or serving, and no Meilisearch lowering is included yet.

This is the listed Gmail-like subset, not every Gmail operator. Uppercase `OR` has lower precedence than whitespace AND; prefix `-` binds to one term/filter or parenthesized group. Parentheses group expressions. `AND` and Gmail brace OR syntax are not implemented; uppercase `AND` is an error. Unknown `name:value` operators, unsupported values and malformed dates are errors, never ignored. Text and known-field values accept quotes, escaped punctuation and Unicode. An unescaped colon in a bare term is treated as an operator attempt; a known field value may contain additional colons. `is:needs-reply` is parsed for a future field but does not infer or call a model now.

Date input is exactly `YYYY/MM/DD`. Station's later lowerer must interpret `after:` as inclusive UTC midnight and `before:` as exclusive UTC midnight. Relative `d`, `m`, and `y` values are positive integers; later lowering must use an injected UTC clock and calendar-month/year subtraction clamped to the last valid day. The parser stores typed date/duration values without reading a clock. This differs from the [Gmail API's midnight PST interpretation](https://developers.google.com/workspace/gmail/api/guides/filtering). A search is limited to 4,096 UTF-8 bytes, eight levels of parenthesis nesting, eight unary prefixes, 128 lexemes and AST nodes, 64 leaves and 256 Unicode code points per decoded value. Escaped or quoted parentheses and braces are literal. Empty and typing-incomplete queries have explicit results.

## 3. Semantic search

- Item text is chunked and embedded by the local embedding service only when effective indexing and AI policies permit it, stored in pgvector.
- Used when the user presses Enter on a query, or when lexical results are thin.
- Lexical and semantic results are merged with reciprocal rank fusion.

## Ranking

After fusion, boost by:
- Recency.
- Sender affinity: people the user replies to often rank higher.
- Thread activity: threads the user took part in rank higher.
- Current Orbit, when searching from inside one.

Every search and CAPCOM retrieval rechecks effective scope and policy server-side, including attachment text and cached citations. A tightened rule blocks reads immediately while stale derived data is purged. Deletion and routing changes invalidate both indexes and embedding chunks.

The first M2 prerequisite provides only a restrictive, current PostgreSQL eligibility snapshot for a normalized mail item: complete setup, active account, supported and live content, a post-action provider observation at the current credential generation, no unresolved message change, and effective source privacy across all Orbits, sender identities and resolved labels. It returns no durable grant. Later index writers must revalidate before publication, and every search or retrieval path must revalidate before serving. The Meilisearch, embedding, attachment extraction and purge consumers remain future work.

## Natural language queries

If the query reads like a sentence, pressing Enter offers a CAPCOM rewrite: the model turns it into operators plus a semantic query, and the UI shows the rewritten query so the user can edit it. Typing never waits on the model.

## CAPCOM

For questions that need several searches and reading (the case where an agent beats any search box), see the CAPCOM section in [AI.md](AI.md).

## Attachments

Tika extracts text from PDF, Office, and other formats. Images and scanned PDFs go through Tesseract. Extracted text is indexed in both layers and is available to CAPCOM through `get_attachment_text`.
