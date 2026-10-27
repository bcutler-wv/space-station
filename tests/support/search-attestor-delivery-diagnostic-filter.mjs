import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';

const bool = /^(?:true|false)$/;
const count = /^(?:-1|[0-9]{1,2})$/;
const availability = /^(?:true|false|unavailable)$/;
const phases = new Set(['setup', 'network-proof', 'complete-cli', 'legacy-cli',
  'lost-prepare-response', 'preexisting-volume', 'lost-volume-create-response',
  'ambiguous-post-create-inspect', 'replaced-artifact', 'lost-transfer-response',
  'partial-transfer', 'replaced-volume', 'lost-attestor-response', 'postflight-drift',
  'outstanding-reference', 'cleanup-refusal', 'fresh-rejection',
  'unintroduced-rejection', 'incomplete-rejection']);

function allowed(name, value) {
  if (name === 'lock-stage') return /^(?:absent|unreadable|preflight|other|(?:prepare|transfer|attestor)-(?:dispatched|confirmed))$/.test(value);
  if (['invocation-roots', 'public-roots', 'invocation-volumes'].includes(name))
    return count.test(value) || value === 'unavailable' && name === 'invocation-volumes';
  if (name === 'owner-installation') return /^(?:valid|invalid)$/.test(value);
  if (name === 'credential-metadata-match') return bool.test(value);
  if (name === 'scoped-config') return /^(?:valid|invalid|command-failed)$/.test(value);
  if (/^(?:network-[12]|volume-[12]|image-[123])-identity$/.test(name)) return availability.test(value);
  const phase = /^phase-([123])-(.+)$/.exec(name);
  if (!phase) return false;
  const field = phase[2];
  if (['count', 'mount-count', 'tmpfs-count', 'network-count'].includes(field)) return count.test(value);
  if (field === 'exit') return /^(?:unknown|[0-9]{1,3})$/.test(value) &&
    (value === 'unknown' || Number(value) <= 255);
  if (field === 'state') return /^(?:created|running|exited|dead|other)$/.test(value);
  if (field === 'inspection') return value === 'unavailable';
  if (field === 'image-match') return availability.test(value);
  return ['user-match', 'command-match', 'labels-match', 'host-policy-match',
    'cap-add-match', 'cap-drop-match', 'resources-match', 'host-safety-match', 'isolation-match',
    'tmpfs-match', 'mount-targets-match', 'host-mount-targets-match',
    'network-names-match'].includes(field) && bool.test(value);
}

export function filteredDeliveryDiagnostics(log) {
  if (typeof log !== 'string' || log.length > 8 * 1024 * 1024) return [];
  const lines = [];
  const seen = new Set();
  for (const line of log.split('\n')) {
    if (line.length > 160) continue;
    const checkpoint = /^Attestor delivery fixture failed at ([a-z-]+)\.$/.exec(line);
    if (checkpoint && phases.has(checkpoint[1])) {
      if (!seen.has('checkpoint')) lines.push(line);
      seen.add('checkpoint');
      continue;
    }
    const match = /^Attestor delivery diagnostic ([a-z0-9-]+)=([a-z0-9-]+)\.$/.exec(line);
    if (!match || !allowed(match[1], match[2]) || seen.has(match[1])) continue;
    seen.add(match[1]);
    lines.push(line);
    if (lines.length >= 80) break;
  }
  return lines;
}

if (process.argv.length === 3 && process.argv[1]?.endsWith('/search-attestor-delivery-diagnostic-filter.mjs')) {
  try {
    if (process.argv.length !== 3 || (await stat(process.argv[2])).size > 8 * 1024 * 1024) process.exitCode = 1;
    else process.stdout.write(`${filteredDeliveryDiagnostics(await readFile(process.argv[2], 'utf8')).join('\n')}\n`);
  } catch { process.exitCode = 1; }
}
