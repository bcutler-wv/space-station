const fail = () => { throw Error('Invalid private writer mapping response shape'); };
const role = /^station_indexer_[0-9a-f]{32}$/;
const exact = (value, names) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).sort().join('|') !== [...names].sort().join('|')) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (names.some(name => !descriptors[name]?.enumerable ||
      !Object.hasOwn(descriptors[name], 'value'))) fail();
  return Object.fromEntries(names.map(name => [name, descriptors[name].value]));
};

/** Test-only finite measurement. No response value or target is emitted. */
export function writerMappingShapeLine(phase, envelope, target, counts) {
  if (!['first', 'replacement', 'ambiguous-first'].includes(phase) ||
      typeof target !== 'string' ||
      !role.test(target)) fail();
  const result = exact(envelope, ['body', 'statusCode', 'bytes']);
  const attempts = exact(counts, ['producer', 'connection']);
  if (!Number.isInteger(result.bytes) || result.bytes < 1 ||
      result.bytes > 32_768 || attempts.producer !== 1 || attempts.connection !== 1)
    fail();
  const body = result.body;
  const http = result.statusCode === 200 || result.statusCode === 201 ?
    String(result.statusCode) : 'other';
  let schema = 'malformed', status = 'other', message = 'other', keyCount = 'na';
  if (body && Object.getPrototypeOf(body) === Object.prototype) {
    const keys = Reflect.ownKeys(body);
    keyCount = keys.length <= 3 ? String(keys.length) : 'many';
    const descriptors = Object.getOwnPropertyDescriptors(body);
    const plain = keys.every(key => typeof key === 'string' &&
      descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'));
    schema = !plain ? 'accessor' :
      keys.slice().sort().join('|') === 'message|status' ? 'status-message' :
        keys.join('|') === 'status' ? 'status-only' : 'other';
    if (plain && (schema === 'status-message' || schema === 'status-only')) {
      status = ['CREATED', 'OK', 'UPDATED'].includes(descriptors.status.value) ?
        descriptors.status.value : 'other';
      const value = descriptors.message?.value;
      message = schema === 'status-only' ? 'none' :
        value === `'${target}' created.` ? 'quoted-target-created' :
          value === `'${target}' updated.` ? 'quoted-target-updated' : 'other';
    }
  }
  return `Writer mapping API shape phase=${phase} http=${http} ` +
    `schema=${schema} keys=${keyCount} status=${status} message=${message} bytes=${result.bytes} ` +
    'producer=1 connection=1';
}

/** Source-backed expectation only for this disposable proof, not a delivery parser. */
export function writerMappingExpectedShape(phase, line) {
  if (!['first', 'replacement', 'ambiguous-first'].includes(phase) ||
      typeof line !== 'string') fail();
  const expected = phase === 'replacement' ?
    / phase=replacement http=200 schema=status-message keys=2 status=OK message=quoted-target-updated bytes=[1-9][0-9]* producer=1 connection=1$/ :
    new RegExp(` phase=${phase} http=201 schema=status-message keys=2 status=CREATED message=quoted-target-created bytes=[1-9][0-9]* producer=1 connection=1$`);
  return line.startsWith('Writer mapping API shape') && expected.test(line);
}

export function writerMappingAmbiguousLine(counts, observed) {
  const attempts = exact(counts, ['producer', 'connection']);
  if (attempts.producer !== 1 || attempts.connection !== 1 || observed !== true) fail();
  return 'Writer mapping API shape phase=ambiguous original-return-lost observed-mapping=true ' +
    'producer=1 connection=1';
}
