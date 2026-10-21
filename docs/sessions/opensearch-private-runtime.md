# Private OpenSearch runtime foundation

On 2026-10-21, source review accepted the private OpenSearch replacement in `8605a07` (0.40.0). The official pinned engine and SDK replace the optional Meilisearch foundation. No live indexing or search endpoint is enabled.

Separate mTLS identities, an isolated internal network, narrow roles and retained-configuration verification protect the runtime. Review corrected security bootstrap inputs, private listener binding, a built ESM import cycle, malformed result checks and independent configuration-drift tests. A final source-backed review added exact pinned action-group verification because custom groups can expand otherwise unchanged role permissions. Upstream data provenance and license notices are retained.

Local checks passed 105 tests. Independent review verified configuration rejection probes, built imports and upstream data. Actual security-enabled startup, container isolation, permissions and retained restart remain pending: [Ubuntu run 39678108802](https://github.com/bcutler-wv/space-station/actions/runs/39678108802) passed container inspection but failed startup because the engine user could not write `logs/gc.log` in the log tmpfs; the earlier security-disabled comparison does not prove these controls. See [decision 0016](../decisions/0016-opensearch-private-runtime.md).

Before live indexing, the next prerequisite separates durable authorization evidence from routine token-refresh concurrency generations. Existing eligibility currently conflates these, causing large quiet mailboxes to lose derived eligibility at ordinary refresh. Reconnect, revocation, effective scope changes and message-action causality must remain restrictive. Durable indexing and serving validation follow separately.

The Astra-reviewed 0.40.1 repair assigns the log tmpfs to engine UID/GID 1000 with mode 0700 and adds an actual engine-user write probe. Resource limits, read-only root, noexec/nosuid and network isolation remain unchanged. Fresh Ubuntu validation is required.

Ubuntu run 39679542841 proved the log repair, verified admin mTLS and a green engine cluster, then found a missing `nodes_dn.yml` in bootstrap. The source-reviewed 0.40.2 repair supplies the complete pinned seven-file manifest and checks it before changing initialization state or uploading. Optional policies remain absent, and startup errors use fixed phase/kind diagnostics. A fresh runtime gate remains required.

Ubuntu run 39681084023 completed security initialization, then rejected the serialized security profile. The Astra-reviewed 0.40.3 repair checks the exact pinned plugin defaults and omits an ignored deprecated input. Fixed diagnostic subphases identify future mismatches without logging configuration. All 108 local tests and independent rejection probes passed; the security-enabled Ubuntu gate still must pass before runtime acceptance.

Ubuntu run 39682842641 passed all security verification and then rejected the index profile. Version 0.40.4 explicitly requests and checks the pinned engine default `index.replication.type=DOCUMENT`, which was missing from the exact settings expectation. Astra review and all 108 local tests passed. Actual index-profile, permissions and restart validation remain pending a fresh Ubuntu run.
