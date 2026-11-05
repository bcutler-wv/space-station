const cases = new Set(['prestart', 'lost-return', 'false-ack', 'held-timeout']);
const methods = new Set(['none', 'pending-read', 'binding-write', 'public-stage',
  'adapter-factory', 'verify-owner', 'capture-owner', 'recheck-owner',
  'recheck-infrastructure', 'volume-absent', 'preflight', 'check-volume',
  'create-volume', 'run-transfer', 'run-apply', 'fence-transfer', 'fence-apply',
  'cleanup-remote', 'cleanup-private', 'containers-absent']);
const phases = new Set(['owner', 'transfer', 'apply', 'cleanup']);
const commands = new Set(['none', 'compose-config', 'compose-create', 'compose-ps',
  'container-inspect', 'container-start', 'container-wait', 'container-logs',
  'container-rm', 'volume-inspect', 'volume-create', 'volume-rm', 'other']);
const outcomes = new Set(['none', 'returned-zero', 'returned-nonzero', 'signaled', 'threw']);
const states = new Set(['created', 'other']);
const flags = new Set(['true', 'false', 'other']);
const timestamps = new Set(['zero', 'nonzero', 'missing', 'other']);
const networks = new Set(['empty', 'none', 'admin-internal', 'other']);
const fields = new Set(['empty', 'other']);
const exactKeys = (value, names) => value !== null && typeof value === 'object' &&
  Reflect.ownKeys(value).length === names.length && names.every(name =>
    Object.hasOwn(value, name) &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, name), 'value'));
const count = value => value === 'many' ||
  (Number.isInteger(value) && value >= 0 && value <= 2);

/** Fixture-only nested method trace. A failing inner call remains the active label. */
export function writerDeliveryMethodTracker(diagnostic) {
  let depth = 0;
  return async (label, action) => {
    if (!methods.has(label) || typeof action !== 'function')
      throw Error('Writer mapping delivery method');
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

export function writerDeliveryTrace(value) {
  const keys = ['caseName', 'method', 'phase', 'command', 'outcome', 'last',
    'create', 'inspect', 'fence', 'start'];
  if (!exactKeys(value, keys) || !cases.has(value.caseName) ||
      !methods.has(value.method) || !phases.has(value.phase) ||
      !commands.has(value.command) || !outcomes.has(value.outcome) ||
      !methods.has(value.last) ||
      ![value.create, value.inspect, value.fence, value.start].every(count))
    throw Error('Mapping delivery trace');
  return `Mapping delivery trace case=${value.caseName} method=${value.method} phase=${value.phase} ` +
    `command=${value.command} outcome=${value.outcome} last=${value.last} ` +
    `create=${value.create} inspect=${value.inspect} fence=${value.fence} start=${value.start}.`;
}

export function writerDeliveryShape(value) {
  const keys = ['caseName', 'phase', 'state', 'running', 'started', 'finished', 'network',
    'stateFields', 'networkFields'];
  if (!exactKeys(value, keys) || !cases.has(value.caseName) ||
      !['transfer', 'apply'].includes(value.phase) || !states.has(value.state) ||
      !flags.has(value.running) || !timestamps.has(value.started) ||
      !timestamps.has(value.finished) || !networks.has(value.network) ||
      !fields.has(value.stateFields) ||
      !new Set(['empty', 'nonempty', 'unknown']).has(value.networkFields))
    throw Error('Mapping delivery shape');
  return `Mapping delivery shape case=${value.caseName} phase=${value.phase} state=${value.state} ` +
    `running=${value.running} started=${value.started} finished=${value.finished} ` +
    `network=${value.network} statefields=${value.stateFields} ` +
    `networkfields=${value.networkFields}.`;
}

export function isWriterDeliveryTraceLine(line) {
  const match = /^Mapping delivery trace case=([a-z-]+) method=([a-z-]+) phase=([a-z-]+) command=([a-z-]+) outcome=([a-z-]+) last=([a-z-]+) create=(0|1|2|many) inspect=(0|1|2|many) fence=(0|1|2|many) start=(0|1|2|many)\.$/.exec(line);
  if (!match) return false;
  try { return writerDeliveryTrace({ caseName: match[1], method: match[2], phase: match[3],
    command: match[4], outcome: match[5], last: match[6],
    create: match[7] === 'many' ? 'many' : Number(match[7]),
    inspect: match[8] === 'many' ? 'many' : Number(match[8]),
    fence: match[9] === 'many' ? 'many' : Number(match[9]),
    start: match[10] === 'many' ? 'many' : Number(match[10]) }) === line; }
  catch { return false; }
}

export function isWriterDeliveryShapeLine(line) {
  const match = /^Mapping delivery shape case=([a-z-]+) phase=(transfer|apply) state=([a-z-]+) running=([a-z-]+) started=([a-z-]+) finished=([a-z-]+) network=([a-z-]+) statefields=([a-z-]+) networkfields=(empty|nonempty|unknown)\.$/.exec(line);
  if (!match) return false;
  try { return writerDeliveryShape({ caseName: match[1], phase: match[2], state: match[3],
    running: match[4], started: match[5], finished: match[6], network: match[7],
    stateFields: match[8], networkFields: match[9] }) === line; }
  catch { return false; }
}
