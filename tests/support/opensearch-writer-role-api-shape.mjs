const fail = () => { throw Error('Invalid private writer role response shape'); };
const role = /^station_indexer_[0-9a-f]{32}$/;
function values(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).sort().join('|') !== [...keys].sort().join('|')) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key]))) fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

/** Finite, redacted measurements for retained CI logs. Never forwards a response value. */
export function writerRoleShapeLine(phase, envelope, target, counts) {
  if (!['first', 'update'].includes(phase) || typeof target !== 'string' || !role.test(target)) fail();
  const bounded = values(envelope, ['body', 'statusCode', 'bytes']);
  const attempts = values(counts, ['producer', 'connection']);
  if (bounded.statusCode !== (phase === 'first' ? 201 : 200) ||
      !Number.isInteger(bounded.bytes) ||
      bounded.bytes < 1 || bounded.bytes > 32_768 ||
      attempts.producer !== 1 || attempts.connection !== 1) fail();
  const body = bounded.body;
  if (!body || Object.getPrototypeOf(body) !== Object.prototype) fail();
  const keys = Reflect.ownKeys(body);
  if (keys.some(key => typeof key !== 'string')) fail();
  keys.sort();
  const schema = keys.join('|') === 'message|status' ? 'status-message' :
    keys.join('|') === 'status' ? 'status-only' : fail();
  const descriptors = Object.getOwnPropertyDescriptors(body);
  if (keys.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key]))) fail();
  const expectedStatus = phase === 'first' ? 'CREATED' : 'OK';
  if (descriptors.status.value !== expectedStatus) fail();
  const message = schema === 'status-only' ? 'none' :
    descriptors.message.value === `'${target}' ${phase === 'first' ? 'created' : 'updated'}.` ?
      `quoted-target-${phase === 'first' ? 'created' : 'updated'}` : fail();
  return `Writer role API shape phase=${phase} http=${bounded.statusCode} ` +
    `schema=${schema} status=${expectedStatus} message=${message} bytes=${bounded.bytes} ` +
    'producer=1 connection=1';
}

export function writerRoleAmbiguousLine(counts, observed) {
  const attempts = values(counts, ['producer', 'connection']);
  if (attempts.producer !== 1 || attempts.connection !== 1 || observed !== true) fail();
  return 'Writer role API shape phase=ambiguous original-return-lost observed-role=true ' +
    'producer=1 connection=1';
}
