# Writer mapping offline binding, v0.101.0

The mapping-preparation runtime gate passed exact-commit Ubuntu run `41971956372` at `d440c81` with all 29 jobs successful and Astra acceptance. This version adds an uncalled offline binding boundary; its own exact-commit CI run remains pending.

The caller supplies nine nonsecret approval fields, including the independently approved canonical mapping-pending SHA. The binder pins five fixed original files, verifies their create and role links, captures only the original CA and candidate writer public PEM, checks the sealed mapping request structure, and writes one exclusive mode-0400 consumed binding under a fresh mapping-apply lock. The original preparation invocation ID is unavailable after cleanup; the new lock invocation is used only for structural nine-ID distinctness, never as reconstructed historical authority. A clean prebinding failure can release after checked cleanup. Any uncertain scratch/source/binding attempt retains the original lock when it still exists, and the exclusive binding denies replay even if that lock is later lost. The public capture does not read candidate key content or prove key possession.

The binding writer pins a newly created output directory before syncing its parent and checks that original inode through final readback. Its result uses a private copy of the approved tuple even if a fixture callback mutates the copy it received.

This boundary cannot authenticate the approval source or current registry/engine state. The later execution path must independently check those, rebuild a genuine constructor-issued contract, and apply its own one-shot CAS/send rules. It does not write a certificate fingerprint, mapping, or readiness gate.
