import { readFileSync } from 'node:fs';
import process from 'node:process';
import Transport from '@opensearch-project/opensearch/lib/Transport.js';
import Connection from '@opensearch-project/opensearch/lib/Connection.js';
import { installWriterMappingDeliveryProbe } from '../../../scripts/search-writer-mapping-delivery-transport.mjs';

const mode = readFileSync('/app/writer-mapping-delivery-fixture-mode', 'utf8');
const marker = name => process.stderr.write(`WRITER_MAPPING_DELIVERY_FIXTURE:${name}\n`);
installWriterMappingDeliveryProbe(Transport, Connection, mode, marker);
export * from './opensearch-runtime-original.js';
