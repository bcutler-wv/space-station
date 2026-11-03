// Disposable-image-only return interceptor. It forwards the real pinned SDK
// call and its abort handle; no transport, request body or GET is mocked.
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { Readable } from 'node:stream';
import Connection from '@opensearch-project/opensearch/lib/Connection.js';
import { createLiteralV2IndexOnce as original } from './opensearch-create-index-original.js';
import { installHeldCreateResponse } from './opensearch-create-fixture-transport.js';

const mode = readFileSync('/app/create-apply-fixture-mode', 'utf8');
const marker = name => process.stderr.write(`CREATE_APPLY_FIXTURE:${name}\n`);
if (mode === 'transport-held' || mode === 'transport-timeout') {
  installHeldCreateResponse(Connection, { marker,
    heldPath: '/tmp/create-apply-transport-held',
    releasePath: '/tmp/create-apply-transport-release' });
}
function forward(call, transform) {
  const result = call.then(transform);
  result.abort = () => call.abort();
  return result;
}
async function originalAcknowledgement(response, index) {
  if (response?.statusCode !== 200 || !response.body ||
      typeof response.body[Symbol.asyncIterator] !== 'function')
    throw Error('Fixture did not receive the real streamed SDK response');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 32_768) throw Error('Fixture real response exceeded bound');
    chunks.push(Buffer.from(chunk));
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (parsed.acknowledged !== true || parsed.shards_acknowledged !== true ||
      parsed.index !== index) throw Error('Fixture lacked original true acknowledgement');
  marker('SDK_ORIGINAL_TRUE_ACK');
  return parsed;
}
export async function createLiteralV2IndexOnce(indices, index) {
  let creates = 0, gets = 0;
  const wrapped = {
    create: (...args) => {
      if (++creates !== 1) throw Error('Fixture duplicate create');
      const actual = indices.create(...args);
      marker('SDK_CREATE_SENT');
      return forward(actual, async response => {
        marker('SDK_CREATE_REAL_RESPONSE');
        if (['false-ack', 'partial-ack', 'lost-response'].includes(mode)) {
          const parsed = await originalAcknowledgement(response, index);
          if (mode === 'lost-response') throw Error('Fixture lost actual SDK response');
          const changed = { ...parsed, [mode === 'false-ack' ? 'acknowledged' :
            'shards_acknowledged']: false };
          const bytes = Buffer.from(JSON.stringify(changed));
          return { ...response, body: Readable.from([bytes]), headers: {
            ...response.headers, 'content-length': String(bytes.length) } };
        }
        return response;
      });
    },
    get: (...args) => {
      if (++gets !== 1) throw Error('Fixture duplicate GET');
      const actual = indices.get(...args);
      marker('SDK_GET_SENT');
      return forward(actual, response => {
        marker('SDK_GET_REAL_RESPONSE'); return response;
      });
    },
  };
  return original(wrapped, index);
}
