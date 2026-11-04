import { readFileSync, statSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const steps = Object.freeze({
  setup: ['input', 'postgres-resolve', 'postgres-inspect', 'postgres-network-count', 'postgres-networks',
    'default-launch', 'default-inspect', 'outer-launch', 'outer-inspect', 'default-positive', 'outer-positive'],
  verifier: ['hold-launch', 'inspect-user-resources', 'admin-network', 'password-mount', 'environment',
    'uid', 'gid', 'default-denial', 'outer-denial', 'hold-removal'],
  transition: ['hold-launch', 'inspect-user-resources', 'admin-network', 'password-mount', 'environment',
    'uid', 'gid', 'default-denial', 'outer-denial', 'hold-removal'],
  final: ['default-positive', 'outer-positive', 'held-cleanup', 'default-cleanup', 'outer-cleanup'],
});
const prefix = 'DB job boundary failure role=';
export function dbJobDiagnostic(role, step) {
  if (!Object.hasOwn(steps, role) || !steps[role].includes(step)) throw new TypeError('Invalid DB job checkpoint');
  return `${prefix}${role} step=${step}.`;
}

export function parseDbJobDiagnostic(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 256 * 1024) return null;
  let found = null;
  for (const line of input.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const match = /^DB job boundary failure role=(setup|verifier|transition|final) step=([a-z-]+)\.$/.exec(line);
    if (!match) return null;
    let canonical;
    try { canonical = dbJobDiagnostic(match[1], match[2]); } catch { return null; }
    if (found !== null) return null;
    found = canonical;
  }
  return found;
}

if (process.argv[1]?.endsWith('/search-admin-db-diagnostic.mjs') && process.argv.length === 4) {
  const [, , file, statusText] = process.argv;
  const status = Number(statusText);
  if (!Number.isInteger(status) || status < 1 || status > 255) process.exit(1);
  try {
    if (statSync(file).size <= 256 * 1024) {
      const line = parseDbJobDiagnostic(readFileSync(file, 'utf8'));
      if (line) process.stderr.write(`${line}\n`);
    }
  } catch { /* A missing or malformed private log must never reach public output. */ }
  process.exitCode = status;
}
