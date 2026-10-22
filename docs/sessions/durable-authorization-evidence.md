# Durable authorization evidence

Version 0.41.0 separates mailbox authorization identity from routine token-refresh concurrency. Previously, rotating credentials invalidated completed mail observations and queued a mailbox-wide reread. The new authorization generation remains stable for unchanged grants and advances on reconnect, effective scope change or definitive denial. Credential generation still fences active refreshes, reads, actions and sends.

The generated migration leaves historical observations without authorization evidence. They become eligible only after the existing bounded, paced provider reread. Current-grant worker denial revokes the account atomically; an old worker cannot revoke a replacement grant. The ARCHITECTURE, DATA_MODEL, SEARCH and SECURITY contracts record these intentional rule changes.

Sol implementation and independent Astra review passed. Local checks include 108 unit tests, fresh PostgreSQL migration and historical upgrade, credential/sync/page races, action/send recovery, no provider-data fetch after revocation and integer-overflow rollback. A fixture transport hold left by a prior reset test was corrected; it did not indicate a provider SDK defect.

Ubuntu PostgreSQL 16 Compose and end-to-end gates remain required. This prerequisite adds no indexer, query route or derived-data serving authority. Durable publication and current-policy validation remain the next search tasks.

Ubuntu run 39685399497 at 0.41.1 passed scaffold, PostgreSQL 16 runtime integration, browser and process-recovery jobs, validating this authorization slice. The overall workflow remained red because the separate OpenSearch fixture command omitted a required Compose profile; that failure does not establish search runtime acceptance.
