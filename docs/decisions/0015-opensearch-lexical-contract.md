# OpenSearch lexical query contract

## Decision

OpenSearch 3.9.0 is the intended M2 live lexical engine. The pinned manual
Ubuntu fake-data proof `39667416208` passed native Boolean complement,
negative-only, mixed text/filter OR, phrase, substring, multilingual,
pagination and version tests under a 2 GiB container/1 GiB heap/two-CPU
budget. Cold readiness was 21.157 seconds; the four fixture p95 classes were
3.58–11.22 ms and sampled container memory peaked at 1,498,943,586 bytes.
These are engine-fixture measurements, not live indexing, privacy, latency or
production-runtime acceptance. The [passing manual Ubuntu run](https://github.com/bcutler-wv/space-station/actions/runs/39667416208)
and [upstream engine release](https://github.com/opensearch-project/OpenSearch/releases/tag/3.9.0)
provide the pinned evidence.

The earlier [Meilisearch foundation](0014-meili-runtime-contract.md) remains
historical accepted evidence but is superseded as the intended live engine:
its native negative text form did not complement positive fuzzy/prefix matches.
No live engine has switched in this compiler slice. Existing optional Meili
runtime remains until a separate reviewed replacement.

## Pure compiler profile

`compileSearchQuery` accepts a raw query and a trusted, bounded authorization
and name-resolution snapshot, calls the public bounded Peggy parser, and
returns only the `station-mail-v1` OpenSearch DSL plan or an explicit empty,
error or unsupported result. There is no public AST compiler entry point.
The snapshot is an input from a future authenticated caller, not a grant
created by this function. It requires an owner and at least one allowed
account. `accounts` scope searches those accounts without requiring Orbit
membership; `selected-orbits` additionally requires nonempty selected Orbit
IDs that are a subset of authorized IDs. Missing/unknown scope fails closed.
Owner, account and optional selected-Orbit filters wrap the entire expression,
outside every OR and NOT. Future retrieval must revalidate source policy and
scope before serving; a compiled query never substitutes for that check.

Account and Orbit operators resolve **exact normalized names** only within
the authorized snapshot. NFKC, trimming and lowercasing are used. Missing,
unauthorized and ambiguous names return the same resolution error. A label
name may resolve in several authorized accounts; the compiler ORs paired
`accountId` plus `labelId` filters, rejecting ambiguity within one account.
None of these operators accepts raw caller filter syntax or widens the
external scope.

The immutable `station-mail-v1` mapping declaration contains keyword owner,
account, Orbit and label IDs; text `searchText`; wildcard subject, participant
and filename values; typed mailboxes/kind/flags; and UTC `sentAt`. A future
indexer must construct this field set from eligible source data, including
the explicit searched-text aggregate, and verify profile identity/mapping
before publishing. `subject:`, `from:`, `to:`, `cc:` and `filename:` use
case-insensitive literal substring matching on wildcard fields with `*`, `?`
and backslash escaped. Quotes around a structured value group its literal
characters; they do not request analyzed phrases.

An unquoted free-text leaf is a native OR of `match` (AND of analyzed tokens,
edit distance one, fuzzy expansion cap 50) and `match_bool_prefix` (AND of
analyzed tokens, final term as a prefix). Both sides remain one identical
composite leaf under NOT. The prefix side has no blanket prefix-expansion
count guarantee; request/resource deadlines still apply, and no universal
typo or stemming promise is made. A quoted free-text leaf is `match_phrase`
with zero slop: ordered analyzed tokens, not byte-exact punctuation.
Analysis producing no terms is a nonmatching leaf; negating that leaf means
the scoped complement. Each user OR sets `minimum_should_match: 1`.
[Upstream bool](https://docs.opensearch.org/latest/query-dsl/compound/bool/),
[match](https://docs.opensearch.org/latest/query-dsl/full-text/match/),
[boolean prefix](https://docs.opensearch.org/latest/query-dsl/full-text/match-bool-prefix/),
[wildcard](https://docs.opensearch.org/latest/query-dsl/term/wildcard/).

`before:` is exclusive and `after:` inclusive at UTC midnight. Relative
`older_than:`/`newer_than:` compare to the exact injected UTC instant minus
days or clamped calendar months/years; invalid clocks and year underflow
error. This intentionally differs from Gmail API's PST midnight.
`is:needs-reply` is explicitly unsupported even under NOT until a trustworthy
source field is specified; it never infers an AI answer.

Parser limits remain 4,096 UTF-8 input bytes, 128 nodes/lexemes, 64 leaves,
eight nesting and unary levels, and 256 Unicode code points per value. The
compiler additionally bounds context IDs/name records and the emitted DSL
to 65,536 UTF-8 bytes and 1,024 structural clauses/nodes after name
expansion. It emits no query for an empty or incomplete input.

## Consequences

This slice does not install an OpenSearch runtime for Station, publish an
index, expose an endpoint, serve a result, or retire Meilisearch. The new
compiled DSL requires actual pinned-engine verification in the separate
fake-data manual Ubuntu gate. Later index and read consumers need source
eligibility, generation/deletion fences, private runtime/credentials,
mapping/version checks, complete-result handling, cutoff/timeout bounds and
use-time policy revalidation. The proof's 10,000 fake-document latency is not
an end-to-end typing result.
