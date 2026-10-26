# Offline attestor input transfer

Version 0.61.0 adds an independently Astra-reviewed fixed offline transfer command. It copies only one verifier password, invocation, prepared manifest and exact public certificate list into an initially empty private destination for UID/GID 1000. The command has no database, network, signer or launch capability. It never receives the credential directory or any signing key. The offline manifest check validates shape and derived filenames; only the later combined verifier can validate the digest against fresh database evidence.

Full Ubuntu workflow `39873032548` passed at `7b1d49a`, verified by Astra on 2026-10-26. This accepts the source fixture and existing regression gates. Actual root transfer capabilities, mount topology and both owner-pair deliveries remain required in C4.

The three source files use exact single-file binds under fixed root-owned 0755 container parents. Their original private modes and coherent owner identity remain required; the public-only source tree stays private. Exclusive destination creation, bounded no-follow reads, descriptor and parent identity checks, exact inventories, byte comparison and file/directory sync protect the copy. Failure retains partial output for the future owner workflow instead of deleting uncertain paths.

Six transfer tests, the existing pure/command fixtures and the full local repository check passed. Review added after-build CI wiring and secret-safe failure assertions, with an independently verified captured-child leak scan. Actual root capabilities, UID-1000 ownership transfer, source mount isolation and both owner-pair delivery gates remain C4 work. No live search gate or production deployment is enabled.
