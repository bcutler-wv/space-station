// Disposable-image-only observation of real pinned SDK transport requests.
import process from 'node:process';
import Connection from '@opensearch-project/opensearch/lib/Connection.js';
import { installWriterPrepareRequestProbe } from './search-writer-role-prepare-fixture-probe.mjs';

installWriterPrepareRequestProbe(Connection, method =>
  process.stderr.write(`WRITER_PREPARE_FIXTURE:${method}\n`));
await import('./search-writer-role-prepare-original.mjs');
