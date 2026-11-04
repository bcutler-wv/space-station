import { Buffer } from 'node:buffer';

const cases = new Set(['prestart', 'lost-return', 'false-ack', 'held-timeout']);
const phases = new Set(['transfer', 'apply']);
// cr/ed: exact progress; wn: wrong name; co: other container line;
// or/wa: warning; an: ANSI; ot: other; bl: blank.
const kindCodes = { creating: 'cr', created: 'ed', 'wrong-name': 'wn',
  'container-other': 'co', orphan: 'or', warning: 'wa', ansi: 'an',
  other: 'ot', blank: 'bl' };
const kinds = new Set(Object.values(kindCodes));
const measures = new Set(['na', 'zero', 'one', 'two', 'many', 'mixed']);
const exact = (object, names) => object !== null && typeof object === 'object' &&
  Reflect.ownKeys(object).length === names.length && names.every(name => {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    return descriptor && Object.hasOwn(descriptor, 'value');
  });
const bucket = value => value === 0 ? 'zero' : value === 1 ? 'one' :
  value === 2 ? 'two' : 'many';
const aggregate = values => values.length === 0 ? 'na' :
  values.every(value => value === values[0]) ? values[0] : 'mixed';
const size = bytes => bytes === 0 ? 'zero' : bytes <= 256 ? 'small' :
  bytes <= 4096 ? 'medium' : bytes <= 256 * 1024 ? 'large' : 'over';

/** Test-only view of the original Compose response. No dynamic value is emitted. */
export function writerDeliveryCreateOutput(input) {
  if (!exact(input, ['caseName', 'phase', 'response', 'expectedName']) ||
      !cases.has(input.caseName) || !phases.has(input.phase) ||
      input.expectedName !== null &&
        (typeof input.expectedName !== 'string' ||
          !/^[A-Za-z0-9_.-]{1,256}$/.test(input.expectedName)) ||
      !exact(input.response, ['code', 'signal', 'stdout', 'stderr']))
    throw Error('Writer create output diagnostic input');
  const { code, signal, stdout, stderr } = input.response;
  if (typeof stdout !== 'string' || typeof stderr !== 'string')
    throw Error('Writer create output diagnostic response');
  const envelope = code === 0 && signal === null &&
    Buffer.byteLength(stdout) <= 256 * 1024 &&
    Buffer.byteLength(stderr) <= 256 * 1024 ? 'valid' : 'invalid';
  const rawLines = stderr.split('\n');
  let blank = 0;
  if (stderr === '' || stderr.endsWith('\n')) rawLines.pop();
  while (rawLines.length && rawLines.at(-1) === '') {
    rawLines.pop();
    blank++;
  }
  const lineCount = rawLines.length;
  const labels = [], leads = [], gaps = [], tails = [];
  for (const raw of rawLines.slice(0, 4)) {
    if (raw.includes('\x1b')) { labels.push('ansi'); continue; }
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const progress = /^( *)Container (.*?)( +)(Creating|Created)( *)$/.exec(line);
    if (progress) {
      labels.push(progress[2] === input.expectedName ?
        progress[4] === 'Creating' ? 'creating' : 'created' : 'wrong-name');
      leads.push(bucket(progress[1].length));
      gaps.push(bucket(progress[3].length));
      tails.push(bucket(progress[5].length));
    } else if (line.includes('orphan containers')) labels.push('orphan');
    else if (line.startsWith('WARN') || line.startsWith('time=')) labels.push('warning');
    else if (line.startsWith('Container ')) labels.push('container-other');
    else labels.push(line === '' ? 'blank' : 'other');
  }
  const eol = stderr === '' ? 'none' : !stderr.includes('\n') && stderr.includes('\r') ?
    'cr-only' : stderr.includes('\r\n') ?
    stderr.replaceAll('\r\n', '').includes('\n') ? 'mixed' : 'crlf' :
    stderr.endsWith('\n') ? 'lf' : 'no-final-lf';
  const lineKinds = labels.length ? labels.map(label => kindCodes[label]).join(',') : 'none';
  const line = `Writer delivery create-output case=${input.caseName} phase=${input.phase} ` +
    `expected=${input.expectedName === null ? 'missing' : 'known'} ` +
    `envelope=${envelope} stdout=${stdout === '' ? 'empty' : 'nonempty'} ` +
    `stderrbytes=${size(Buffer.byteLength(stderr))} lines=${bucket(lineCount)} ` +
    `eol=${eol} blank=${bucket(blank)} kinds=${lineKinds} ` +
    `lead=${aggregate(leads)} gap=${aggregate(gaps)} tail=${aggregate(tails)}.`;
  if (!isWriterDeliveryCreateOutputLine(line)) throw Error('Writer create output diagnostic size');
  return line;
}

export function isWriterDeliveryCreateOutputLine(line) {
  if (typeof line !== 'string' || line.length > 240) return false;
  const match = /^Writer delivery create-output case=([a-z-]+) phase=(transfer|apply) expected=(known|missing) envelope=(valid|invalid) stdout=(empty|nonempty) stderrbytes=(zero|small|medium|large|over) lines=(zero|one|two|many) eol=(none|lf|crlf|mixed|cr-only|no-final-lf) blank=(zero|one|two|many) kinds=([a-z,-]+) lead=(na|zero|one|two|many|mixed) gap=(na|zero|one|two|many|mixed) tail=(na|zero|one|two|many|mixed)\.$/.exec(line);
  if (!match || !cases.has(match[1]) || !phases.has(match[2]) ||
      !(match[10] === 'none' || match[10].split(',').length <= 4 &&
        match[10].split(',').every(kind => kinds.has(kind))) ||
      !measures.has(match[11]) || !measures.has(match[12]) ||
      !measures.has(match[13])) return false;
  return true;
}
