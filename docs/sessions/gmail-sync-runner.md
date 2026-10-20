# Durable Gmail ingestion

Date: 2026-10-20

Version 0.17.0 adds the worker's initial backfill, history catch-up, minute polling, completed-scan reconciliation, and bounded orphan cleanup. The fixed cutoff and pre-list history anchor survive restart. Message persistence and cursor advancement commit together; labels and provider Sent metadata retain the accepted privacy and direction boundaries. One-second request pacing survives restarts and honors longer provider Retry-After values. Permission failures pause until credential generation changes.

Astra requested two corrections before source acceptance: cancellation and elapsed-time limits for queue jobs, and recovery from a crash after the final list message. The final implementation propagates cancellation through parsing and page persistence, releases only its own lease, and commits terminal phase advancement with the final message. Regression fixtures cover both initial and reconciliation terminal cursors, provider/parser/pacing/budget cancellation, unchanged offsets, and subsequent resumption.

Local lint, typecheck, all 59 tests, build, color and license gates passed. The fake-provider database fixture passed against disposable PostgreSQL 15.19 with the committed schema; that server was stopped. Astra independently ran nine private-store tests and accepted the corrected source. PostgreSQL 16, Compose runtime, and browser gates remain pending in GitHub Actions. No Docker gate ran on agent-dev and no production deployment occurred.

Operational rules are recorded in decision 0008. UI progress, SSE, mail reading, image proxying, and external actions are not part of this change.
