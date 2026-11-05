import process from 'node:process';
import Connection from '@opensearch-project/opensearch/lib/Connection.js';
import { installWriterMappingPrepareRequestProbe } from
  './search-writer-mapping-prepare-fixture-probe.mjs';

process.stderr.write('WRITER_MAPPING_PREPARE_FIXTURE:LOADED\n');
installWriterMappingPrepareRequestProbe(Connection, method =>
  process.stderr.write(`WRITER_MAPPING_PREPARE_FIXTURE:${method}\n`));
await import('./search-writer-mapping-prepare-original.mjs');
