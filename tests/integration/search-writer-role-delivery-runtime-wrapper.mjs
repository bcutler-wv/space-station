import { readFileSync } from 'node:fs';
import process from 'node:process';
import Transport from '@opensearch-project/opensearch/lib/Transport.js';
import Connection from '@opensearch-project/opensearch/lib/Connection.js';
import { installWriterDeliveryProbe } from '../../../scripts/search-writer-role-delivery-transport.mjs';

const mode = readFileSync('/app/writer-delivery-fixture-mode', 'utf8');
const marker = name => process.stderr.write(`WRITER_DELIVERY_FIXTURE:${name}\n`);
installWriterDeliveryProbe(Transport, Connection, mode, marker);
export * from './opensearch-runtime-original.js';
