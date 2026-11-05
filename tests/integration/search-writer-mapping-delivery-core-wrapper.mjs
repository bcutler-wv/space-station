import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { withSearchAdminDatabase, readSearchAdminRegistrySnapshot } from
  '../packages/db/dist/search-admin-connection.js';
import { makeWriterMappingConsumer as original } from './search-writer-mapping-consumer-core-original.mjs';

const marker = name => process.stderr.write(`WRITER_MAPPING_DELIVERY_FIXTURE:${name}\n`);
const database = Object.freeze({ role: 'station_search_transition', host: 'postgres', port: 5432,
  database: 'station', passwordFile: '/run/search-writer-mapping-apply/transition.password' });
export function makeWriterMappingConsumer(context, deps) {
  let offset = 0;
  let originalArmTime = null;
  const mappingTime = snapshot => snapshot.exactTimestamps?.dispatch?.find(item =>
    item.generationToken === context.approval.candidateToken &&
    item.operation === 'writer_mapping')?.createdAt;
  return original(context, { ...deps,
    cas: async (kind, before, operation) => {
      const next = await deps.cas(kind, before, operation);
      assert.equal(next.control.revision, context.approval.revision + ++offset);
      marker(`CAS_${kind.toUpperCase()}_R${offset}`);
      if (kind === 'arm') {
        originalArmTime = mappingTime(next);
        assert.match(originalArmTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
        marker('ARM_TIMESTAMP_PINNED');
      } else if (['send', 'confirm', 'attest'].includes(kind)) {
        assert.equal(mappingTime(next), originalArmTime);
        marker('ARM_TIMESTAMP_MATCHED');
      }
      return next;
    },
    openSender: async contract => {
      const sender = await deps.openSender(contract);
      return { sendOnce: async () => {
        const intent = JSON.parse(readFileSync('/run/search-writer-mapping-apply/intent.json', 'utf8'));
        const snapshot = await withSearchAdminDatabase(database,
          db => readSearchAdminRegistrySnapshot(db, 'station_search_transition'));
        const row = snapshot.dispatch.find(item => item.generationToken === intent.candidateToken &&
          item.operation === 'writer_mapping');
        assert.equal(snapshot.control.revision, intent.revision + 3);
        assert.equal(snapshot.control.stage, 'writer_mapping_requested');
        assert.equal(row?.state, 'sent_unknown');
        assert.equal(row?.dispatchId, intent.dispatchId);
        assert.equal(row?.ownerId, intent.ownerId);
        assert.equal(row?.target, intent.target);
        assert.equal(row?.bodyIdentity, intent.bodyIdentity);
        marker('DB_SENT_UNKNOWN_AT_PUT');
        assert.equal(mappingTime(snapshot), originalArmTime);
        marker('ARM_TIMESTAMP_AT_PUT');
        return sender.sendOnce();
      }, close: () => sender.close() };
    },
  });
}
