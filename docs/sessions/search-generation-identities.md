# Offline search generation identities

Version 0.46.0 adds a create-only offline signer using the existing OpenSSL command and private CA. An explicit generation UUID produces separate writer/query client certificates in a private generation directory. Existing identities must verify; incomplete or altered files are never silently replaced. The public result preserves the exact UUID text and contains only principal names and certificate fingerprints.

Astra review corrected configurable output paths that could overlap the frozen v1 directory. Canonical separation is now checked before creating any output. The signer enforces exact client-only certificate usage, chain/key/identity checks, private permissions and bounded subprocesses. Exclusive directory creation prevents competing callers from replacing a generation's keys. A crash during publication may leave a protected partial directory requiring explicit recovery.

The adversarial local fixture and full check passed, including 110 unit tests. Independent review also tested dual-use/CA-enabled certificates and additional normalized or symlink-aliased output paths. The new signer fixture and all five integration jobs passed in Ubuntu run `39825331924` at `88a3d1e`, accepting this offline signer slice. OpenSSL provenance is recorded in `THIRD_PARTY.md`; no package dependency or copied upstream implementation was added.

This task does not prove engine permissions or hidden-role visibility. Those require a separate disposable proof on the pinned OpenSearch image. No database, role grant, runtime transition, publishing or serving path is enabled by the signer.
