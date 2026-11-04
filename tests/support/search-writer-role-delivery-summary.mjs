import { readFileSync, statSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const cases = ['positive', 'prestart', 'lost-return', 'false-ack', 'held-timeout'];
const pairs = ['default', 'runner'];
const valid = value => typeof value === 'string' && /^[a-z-]{1,32}$/.test(value);
export function writerRoleDeliverySummary(raw, mode, pair) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16 * 1024 * 1024 ||
      !valid(mode) || !cases.includes(mode) || !valid(pair) || !pairs.includes(pair))
    throw Error('Writer delivery summary input');
  const matching = raw.split('\n').filter(line => line.startsWith('Writer role delivery '));
  const summary = matching.filter(line => line.startsWith('Writer role delivery summary '));
  const versions = matching.filter(line => line.startsWith('Writer role delivery versions '));
  const shape = matching.filter(line => line.startsWith('Writer role delivery created-shape '));
  if (matching.length !== (mode === 'positive' ? 2 : 3) || summary.length !== 1 ||
      versions.length !== 1 || shape.length !== (mode === 'positive' ? 0 : 1))
    throw Error('Writer delivery summary count');
  const s = /^Writer role delivery summary case=(positive|prestart|lost-return|false-ack|held-timeout) pair=(default|runner) revision=(0|3|5) create=(unobserved|2) start=(unobserved|1|2) put=(inferred-one|zero|one) checked=true\.$/.exec(summary[0]);
  const v = /^Writer role delivery versions docker=(\d+\.\d+\.\d+) api=(\d+\.\d+) compose=(v?\d+\.\d+\.\d+) opensearch=(3\.9\.0)\.$/.exec(versions[0]);
  if (!s || !v || s[1] !== mode || s[2] !== pair) throw Error('Writer delivery summary shape');
  const expected = mode === 'positive' ? ['5', 'unobserved', 'unobserved', 'inferred-one'] :
    mode === 'prestart' ? ['0', '2', '1', 'zero'] : ['3', '2', '2', 'one'];
  if (s.slice(3, 7).join('|') !== expected.join('|')) throw Error('Writer delivery summary case');
  if (mode !== 'positive' && !/^Writer role delivery created-shape transfer=(empty|none) apply=admin-internal fence=(1|2)\.$/.test(shape[0]))
    throw Error('Writer delivery created shape');
  if (mode === 'prestart' && !shape[0].endsWith('fence=1.') ||
      mode !== 'positive' && mode !== 'prestart' && !shape[0].endsWith('fence=2.'))
    throw Error('Writer delivery fence count');
  return [...summary, ...versions, ...shape].join('\n');
}

if (process.argv[1]?.endsWith('/search-writer-role-delivery-summary.mjs') && process.argv.length === 5) {
  try {
    const [, , file, mode, pair] = process.argv;
    if (statSync(file).size > 16 * 1024 * 1024) throw Error('size');
    process.stdout.write(`${writerRoleDeliverySummary(readFileSync(file, 'utf8'), mode, pair)}\n`);
  } catch { process.stderr.write('Writer delivery sanitized summary unavailable.\n');
    process.exitCode = 1; }
}
