const methods = new Set(['none', 'owner', 'verify-owner', 'capture-owner',
  'preflight', 'create-volume', 'run-transfer', 'run-prepare',
  'fence-transfer', 'fence-prepare', 'recheck-owner', 'recheck-infrastructure',
  'check-volume', 'cleanup-remote', 'volume-absent']);
const phases = new Set(['owner', 'transfer', 'prepare', 'cleanup']);
const commands = new Set(['none', 'compose-config', 'compose-create', 'compose-ps',
  'container-inspect', 'container-start', 'container-wait', 'container-logs',
  'container-rm', 'volume-inspect', 'volume-create', 'volume-rm', 'other']);
const outcomes = new Set(['none', 'returned-zero', 'returned-nonzero', 'signaled', 'threw']);
const exact = (value, keys) => value && typeof value === 'object' &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key =>
    Object.hasOwn(value, key) &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const count = value => value === 'many' ||
  Number.isInteger(value) && value >= 0 && value <= 2;

export function mappingPrepareCommandKind(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string'))
    return 'other';
  const name = argv[0] === 'compose' ?
    ['create', 'config', 'ps'].find(value => argv.includes(value)) :
    ['container', 'volume'].includes(argv[0]) ? argv[1] : null;
  const kind = name && argv[0] === 'compose' ? `compose-${name}` :
    name ? `${argv[0]}-${name}` : 'other';
  return commands.has(kind) ? kind : 'other';
}

/** A failed nested fence keeps the inner reached method. */
export function mappingPrepareMethodTracker(diagnostic) {
  let depth = 0;
  return async (label, action) => {
    if (!methods.has(label) || typeof action !== 'function') throw Error('Mapping method');
    const enclosing = diagnostic.method;
    depth++;
    diagnostic.method = label;
    try {
      const value = await action();
      diagnostic.last = label;
      if (depth > 1) diagnostic.method = enclosing;
      return value;
    } finally { depth--; }
  };
}

export function mappingPrepareTrace(value) {
  const keys = ['method', 'phase', 'command', 'outcome', 'last',
    'create', 'inspect', 'fence', 'start'];
  if (!exact(value, keys) || !methods.has(value.method) ||
      !phases.has(value.phase) || !commands.has(value.command) ||
      !outcomes.has(value.outcome) || !methods.has(value.last) ||
      ![value.create, value.inspect, value.fence, value.start].every(count))
    throw Error('Mapping trace');
  return `Writer mapping preparation trace method=${value.method} phase=${value.phase} ` +
    `command=${value.command} outcome=${value.outcome} last=${value.last} ` +
    `create=${value.create} inspect=${value.inspect} fence=${value.fence} start=${value.start}.`;
}

export function isMappingPrepareTraceLine(line) {
  const match = /^Writer mapping preparation trace method=([a-z-]+) phase=([a-z-]+) command=([a-z-]+) outcome=([a-z-]+) last=([a-z-]+) create=(0|1|2|many) inspect=(0|1|2|many) fence=(0|1|2|many) start=(0|1|2|many)\.$/.exec(line);
  if (!match) return false;
  try {
    return mappingPrepareTrace({ method: match[1], phase: match[2],
      command: match[3], outcome: match[4], last: match[5],
      create: match[6] === 'many' ? 'many' : Number(match[6]),
      inspect: match[7] === 'many' ? 'many' : Number(match[7]),
      fence: match[8] === 'many' ? 'many' : Number(match[8]),
      start: match[9] === 'many' ? 'many' : Number(match[9]) }) === line;
  } catch { return false; }
}
