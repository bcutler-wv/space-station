# 0016: Private OpenSearch runtime foundation

**Status:** accepted at `721e462` (0.41.2) after independent Astra review and full Ubuntu run `39706724818`.

## Decision

The intended M2 lexical engine is the official OpenSearch 3.9.0 image pinned by
digest in Compose. The optional `search` profile keeps it on a dedicated
internal network with no host port, 2 GiB memory, 1 GiB heap and two CPUs.
The image retains its security plugin; demo initialization, anonymous auth and
TLS verification bypasses are disabled. A create-only private CA issues
different node, bootstrap administrator, query and indexer certificates.
The node receives no CA private key or ordinary client identity. The app and
worker receive no search credentials or network attachment in this slice.

One networkless root init copies only the required role identities into
group-restricted private volumes. First security initialization uses the
official `securityadmin.sh` with a durable phase marker. A retained run checks
authenticated security availability and never reapplies the YAML. A bounded
administrator bootstrap verifies the client-certificate auth domain, intended
roles, all role mappings, the pinned built-in action groups with no custom
groups, engine version and complete fixed index
mapping plus relevant semantic settings before it creates or accepts
`station-mail-v1`. Unknown or altered state fails closed; repair is explicit.
The index profile explicitly pins `index.replication.type=DOCUMENT`, which
OpenSearch 3.9.0 otherwise stamps from its cluster default during creation;
retained verification requires that exact value alongside the other fixed
settings and mapping.
The five wildcard fields explicitly pin `doc_values=true`. The pinned
[OpenSearch 3.9.0 wildcard mapper](https://github.com/opensearch-project/OpenSearch/blob/3.9.0/server/src/main/java/org/opensearch/index/mapper/WildcardFieldMapper.java#L106)
serializes this default even when the create
request omits it, so an exact retained mapping check must include it. This
records the engine's existing field representation; it does not change the
query or field behavior. Missing, false or additional mapping parameters
still fail the complete profile comparison.

`@station/search` wraps the official JavaScript SDK with fixed-index,
role-specific methods. The wrapper enforces an absolute request deadline
through body decoding, SDK abort, a response byte cap, fatal UTF-8, no retry,
no redirect/compression acceptance and complete-result checks. Its raw client
is not exported. The current indexer methods only support the fake contract;
future live publication needs source eligibility, version and deletion fences.

## Limits

The manual fake OpenSearch semantics/resource proof passed Ubuntu run
[`39667416208`](https://github.com/bcutler-wv/space-station/actions/runs/39667416208).
The separate private-image gate passed
[`39706724818`](https://github.com/bcutler-wv/space-station/actions/runs/39706724818)
at `721e462` (0.41.2): security-enabled startup, isolation, mTLS role
restrictions, initial and retained fake-data contracts, restart, and rejection
of settings, action-group and role drift. No live indexer, search API, serving
permission or M2 acceptance is implied.
